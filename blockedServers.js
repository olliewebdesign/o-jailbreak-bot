'use strict';

// Blocked servers: anyone showing they're part of one is restricted. Discord never tells a bot which servers someone is
// in, so this catches what can be seen: wearing that server's tag on their profile, or using a blocked name like
// "badserver" (checked when they join, when they chat, when they change their name or profile, every 30 seconds, and
// at startup for everyone), or posting an invite to it.

const config = require('../config');
const store = require('./store');
const restrict = require('./restrict');
const { fetchLogChannel } = require('./caseLog');
const { findInvites, lookupInvite } = require('./filters/selfPromo');
const { normalizeWord } = require('./filters/normalize');
const { isStaff, truncate, who } = require('./util');

const MAX_SWEEP = 5000;

/** Blocked servers for this server: guildId -> { name, invites }. */
function blockedList(settings) {
  settings.blockedServers ??= {};
  return settings.blockedServers;
}

/** Looks up an invite and blocks the server it belongs to. */
async function addInvite(guild, rawCode) {
  const code = String(rawCode ?? '')
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\//i, '')
    .replace(/[/?#].*$/, '');
  if (!code) return { ok: false, text: '❌ That isn’t an invite link.' };
  const info = await lookupInvite(guild.client, code);
  if (info.valid === null) return { ok: false, text: '❌ I couldn’t reach Discord to check that invite. Try again in a minute.' };
  if (!info.valid || !info.guildId) return { ok: false, text: `❌ \`${code}\` isn’t a working invite link.` };
  if (info.guildId === guild.id) return { ok: false, text: '❌ That’s an invite to this server.' };

  const list = blockedList(store.guild(guild.id));
  const entry = (list[info.guildId] ??= { name: info.guildName ?? 'Unknown server', invites: [] });
  entry.name = info.guildName ?? entry.name;
  entry.icon = info.guildIcon ?? entry.icon ?? null;
  if (!entry.invites.some((c) => c.toLowerCase() === code.toLowerCase())) entry.invites.push(code);
  store.save();
  return { ok: true, guildId: info.guildId, name: entry.name, text: `✅ Blocked **${entry.name}** (\`discord.gg/${code}\`).` };
}

/** The invites in config.js (blockedServers.invites) are blocked in every server the bot is in. */
async function prepare(guild) {
  const list = blockedList(store.guild(guild.id));
  // Servers blocked before icons were saved: look one of their invites up again to get the icon.
  for (const entry of Object.values(list)) {
    if (entry.icon !== undefined || !entry.invites.length) continue;
    const info = await lookupInvite(guild.client, entry.invites[0]);
    entry.icon = info.guildIcon ?? null;
    if (info.guildName) entry.name = info.guildName;
    store.save();
  }
  for (const code of config.blockedServers?.invites ?? []) {
    const known = Object.values(list).some((e) => e.invites.some((c) => c.toLowerCase() === code.toLowerCase()));
    if (known) continue;
    const result = await addInvite(guild, code);
    if (!result.ok) console.warn(`[blocked servers] ${guild.name}: ${code}: ${result.text.replace(/^❌ /, '')}`);
  }
}

// ----- blocked names -----

/** Shortest blocked name (in letters): a short one like "anon" would catch every "Anonymous". */
const MIN_NAME_LETTERS = 5;

/** Names nobody can use here: config.js → blockedServers.names, plus any added with /blockserver addname. */
function blockedNames(settings) {
  settings.blockedNames ??= [];
  const all = [...(config.blockedServers?.names ?? []), ...settings.blockedNames].map((n) => String(n).trim()).filter(Boolean);
  return all.filter((n, i) => all.findIndex((x) => normalizeWord(x) === normalizeWord(n)) === i);
}

/**
 * The blocked name hidden in a name, or null. Disguises count: "b4dserver", "BADSERVER", "𝓫𝓪𝓭𝓼𝓮𝓻𝓿𝓮𝓻", Russian
 * look-alike letters, "thebadserver_ru", "bad.server", "b a d s e r v e r". Two words that only run into it
 * ("Bad Serverless") don't.
 */
function blockedNameIn(name, names) {
  if (!name) return null;
  const targets = names.map((n) => ({ name: n, folded: normalizeWord(n) })).filter((t) => t.folded.length >= 3);
  if (!targets.length) return null;
  const words = String(name)
    .split(/[^\p{L}\p{N}@$!]+/u)
    .map((w) => normalizeWord(w))
    .filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let j = i; j < words.length && joined.length <= 64; j++) {
      joined += words[j];
      for (const t of targets) {
        // Inside one word: anywhere. Split across words: starting in the first one and ending with the last one.
        if (j === i ? joined.includes(t.folded) : joined.endsWith(t.folded) && joined.length - t.folded.length < words[i].length) return t.name;
      }
    }
  }
  return null;
}

/**
 * The blocked name this member is using (their username, display name or nickname here): { name, shown, serverIds }
 * or null. `serverIds` are blocked servers going by that name, so their appeal can ask them to leave it.
 */
function usingBlockedName(settings, member, user = member.user) {
  const names = blockedNames(settings);
  if (!names.length) return null;
  for (const shown of [user?.username, user?.globalName, member.nickname].filter(Boolean)) {
    const name = blockedNameIn(shown, names);
    if (!name) continue;
    const serverIds = Object.entries(blockedList(settings))
      .filter(([, e]) => [e.name, ...(e.invites ?? [])].some((s) => s && normalizeWord(s).includes(normalizeWord(name))))
      .map(([id]) => id);
    return { name, shown, serverIds };
  }
  return null;
}

/** The blocked server whose tag this user is wearing, if any. */
function wearingBlockedTag(settings, user) {
  const tag = user?.primaryGuild;
  if (!tag?.identityGuildId || tag.identityEnabled === false) return null;
  const entry = blockedList(settings)[tag.identityGuildId];
  return entry ? { guildId: tag.identityGuildId, name: entry.name, tag: tag.tag } : null;
}

const handled = new Set(); // so one person isn't restricted twice while the first one is still going through
const warnedAt = new Map(); // staff / couldn't-restrict warnings: at most once a day each (the checks run every 30 seconds)
const WARN_EVERY_MS = 24 * 3_600_000;

/** What restricted people are told (config.js → blockedServers.restrictReason). */
const restrictReason = () => config.blockedServers?.restrictReason || 'Please make a ticket';

async function warnOnceADay(guild, key, content) {
  if (Date.now() - (warnedAt.get(key) ?? 0) < WARN_EVERY_MS) return;
  warnedAt.set(key, Date.now());
  const log = await fetchLogChannel(guild);
  await log?.send({ content: truncate(content, 2000), allowedMentions: { parse: [] } }).catch(() => {});
}

/**
 * Restricts a member for being part of a blocked server, with the reason "Please make a ticket" (they can open an
 * appeal ticket from #restricted). The mod log is told what was found. Staff are never restricted: the owner is told.
 */
async function restrictAssociated(member, why, blockedIds = [], { exact = false } = {}) {
  const guild = member.guild;
  const settings = store.guild(guild.id);
  if (member.user.bot || settings.restricted[member.id]) return null;
  const key = `${guild.id}:${member.id}`;
  if (handled.has(key)) return null;
  handled.add(key);
  try {
    if (store.isTrusted(guild, member.id) || isStaff(member, settings)) {
      await warnOnceADay(guild, `staff:${key}`, `⚠️ Staff member ${who(member)} is ${why}. I didn’t restrict them because they’re staff.`);
      return null;
    }
    const result = await restrict.restrictMember({ guild, member, moderator: guild.client.user, reason: restrictReason(), appealTicket: false });
    if (!result.ok) {
      await warnOnceADay(guild, `fail:${key}`, `⚠️ ${who(member)} is ${why}, but I couldn’t restrict them: ${result.text.replace(/^[❌ℹ️\s]+/u, '')}`);
      return result;
    }
    // Which server it was for, so their appeal ticket can ask them to leave it (see restrict.js).
    const list = blockedList(settings);
    const record = settings.restricted[member.id];
    // `exact`: only these servers, even none (a blocked name that isn't a blocked server's).
    if (record && (blockedIds.length || exact)) {
      record.blockedServers = blockedIds.filter((id) => list[id]).map((id) => ({ id, name: list[id].name, icon: list[id].icon ?? null }));
      store.save();
    }
    // Their appeal ticket, now it knows which server to ask them to leave.
    await restrict.openTicketFor(guild, member);
    const log = await fetchLogChannel(guild);
    await log?.send({ content: truncate(`🚷 Restricted ${who(member)}: ${why}. They were told “${restrictReason()}”.`, 2000), allowedMentions: { parse: [] } }).catch(() => {});
    return result;
  } finally {
    setTimeout(() => handled.delete(key), 60_000).unref();
  }
}

/**
 * Checks someone's profile for a blocked server's tag or a blocked name. `fresh` asks Discord for their latest profile
 * first. Returns the restrict result, or null if there was nothing (or they're staff / already restricted).
 */
async function checkMember(member, { fresh = false } = {}) {
  if (!member || member.user?.bot) return null;
  const settings = store.guild(member.guild.id);
  if (!Object.keys(blockedList(settings)).length && !blockedNames(settings).length) return null;
  const user = fresh ? await member.client.users.fetch(member.id, { force: true }).catch(() => member.user) : member.user;
  const hit = wearingBlockedTag(settings, user);
  if (hit) return restrictAssociated(member, `wearing the **${hit.tag ?? '?'}** tag of **${hit.name}**`, [hit.guildId]);
  const named = usingBlockedName(settings, member, user);
  if (named) return restrictAssociated(member, `using the name **${named.name}** (“${truncate(named.shown, 40)}”)`, named.serverIds, { exact: true });
  return null;
}

/** A message with an invite to a blocked server. Returns true if they were restricted (the message is deleted). */
async function checkMessage(message, member, text) {
  const settings = store.guild(message.guildId);
  const list = blockedList(settings);
  if (!Object.keys(list).length || !text) return false;
  for (const { code } of findInvites(text)) {
    const known = Object.entries(list).find(([, e]) => e.invites.some((c) => c.toLowerCase() === code.toLowerCase()));
    const guildId = known?.[0] ?? (await lookupInvite(message.client, code)).guildId;
    const entry = guildId && list[guildId];
    if (!entry) continue;
    await message.delete().catch(() => {});
    await restrictAssociated(member, `posting an invite to **${entry.name}** (\`${code}\`)`, [guildId]);
    return true; // dealt with (even if they were already restricted): no other filter should punish it again
  }
  return false;
}

/**
 * Everyone in the server who's wearing a blocked server's tag or using a blocked name. `fromCache` uses the member list the bot already keeps
 * up to date (for the 30-second checks) instead of asking Discord for the whole list again.
 */
async function sweep(guild, { fromCache = false } = {}) {
  const settings = store.guild(guild.id);
  if (!Object.keys(blockedList(settings)).length && !blockedNames(settings).length) return 0;
  const members = fromCache ? guild.members.cache : await guild.members.fetch().catch(() => null);
  let caught = 0;
  for (const member of [...(members?.values() ?? [])].slice(0, MAX_SWEEP)) {
    if (settings.restricted[member.id] || member.user?.bot) continue;
    if (!wearingBlockedTag(settings, member.user) && !usingBlockedName(settings, member)) continue;
    if ((await checkMember(member))?.ok) caught++;
  }
  return caught;
}

/** Someone changed their profile (e.g. put a tag on): check them in every server they share with the bot. */
async function onUserUpdate(client, user) {
  for (const guild of client.guilds.cache.values()) {
    const member = guild.members.cache.get(user.id);
    if (member) await checkMember(member);
  }
}

module.exports = { addInvite, prepare, blockedList, blockedNames, blockedNameIn, usingBlockedName, MIN_NAME_LETTERS, wearingBlockedTag, restrictAssociated, restrictReason, checkMember, checkMessage, sweep, onUserUpdate };
