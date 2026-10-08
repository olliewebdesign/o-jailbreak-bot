'use strict';

// "Invite people, get VIP": works out which invite link each new member used, counts them up for whoever made
// the link, and gives that person the VIP role once they've brought enough people in.

const config = require('../config');
const store = require('./store');
const restrict = require('./restrict');
const { fetchLogChannel } = require('./caseLog');
const { truncate, who } = require('./util');

// guildId -> Map(code -> { uses, maxUses, inviterId })
const known = new Map();
// The server's own custom link (discord.gg/yourname, from boost level 3): guildId -> how many have used it.
const knownVanity = new Map();
// Marks someone who joined with that custom link — it belongs to the server, not to any one person.
const VANITY = 'vanity';
// Marks someone who has been in the server but whose invite couldn't be worked out (or who was here before the bot
// started counting), so that rejoining through a friend's link doesn't count as a new person.
const UNKNOWN = 'unknown';
// One-use invites are deleted the moment they're used, so remember them for a few seconds.
const justDeleted = new Map(); // guildId -> [{ inviterId, at }]
const DELETED_WINDOW_MS = 15_000;

/** How many joins VIP takes in this server: whatever /vip goal was set to, or the number in config.js. */
function joinsNeeded(settings) {
  const chosen = Number(settings?.vipJoinsNeeded);
  const wanted = Number.isFinite(chosen) && chosen > 0 ? chosen : config.vip.joinsNeeded;
  return Math.max(1, Math.round(wanted) || 1);
}

const joinsBy = (settings, userId) => settings.invites.counts[userId] ?? 0;
const isVanity = (value) => value === VANITY;
const isPerson = (value) => Boolean(value) && value !== VANITY && value !== UNKNOWN;

const warned = new Set();
function warnOnce(guild, key, text) {
  if (warned.has(`${guild.id}:${key}`)) return;
  warned.add(`${guild.id}:${key}`);
  console.warn(`[invites] ${guild.name}: ${text}`);
}

const inviteInfo = (invite) => ({ uses: invite.uses ?? 0, maxUses: invite.maxUses ?? 0, inviterId: invite.inviterId ?? invite.inviter?.id ?? null });

/** Reads every invite link in the server and remembers how many times each has been used. */
async function refresh(guild) {
  const invites = await guild.invites.fetch().catch((err) => {
    warnOnce(guild, 'fetch', `I can't read the invite links (${err.message}). Invite rewards need the Manage Server permission.`);
    return null;
  });
  if (!invites) return null;
  const counts = new Map();
  for (const invite of invites.values()) counts.set(invite.code, inviteInfo(invite));
  known.set(guild.id, counts);
  const vanity = await readVanityUses(guild);
  if (vanity !== null) knownVanity.set(guild.id, vanity);
  return counts;
}

/** How many people have joined through the server's own custom link, if it has one. */
async function readVanityUses(guild) {
  if (!guild.vanityURLCode || typeof guild.fetchVanityData !== 'function') return null;
  const data = await guild.fetchVanityData().catch((err) => {
    warnOnce(guild, 'vanity', `I can't read the custom invite link (${err.message}), so joins through it won't be recognised.`);
    return null;
  });
  return data ? (data.uses ?? 0) : null;
}

function onInviteCreate(invite) {
  // Until the server's full list has been read, a list with just this invite in it would credit the wrong people.
  const counts = invite.guild && known.get(invite.guild.id);
  if (counts) counts.set(invite.code, inviteInfo(invite));
}

function onInviteDelete(invite) {
  if (!invite.guild) return;
  const counts = known.get(invite.guild.id);
  const gone = counts?.get(invite.code);
  counts?.delete(invite.code);
  // Only a link that was one use away from its limit was (probably) deleted because someone just used it. Links
  // deleted by hand or because they expired don't count.
  if (!gone?.inviterId || !(gone.maxUses > 0 && gone.uses + 1 >= gone.maxUses)) return;
  const recent = (justDeleted.get(invite.guild.id) ?? []).filter((r) => Date.now() - r.at < DELETED_WINDOW_MS);
  recent.push({ inviterId: gone.inviterId, at: Date.now() });
  justDeleted.set(invite.guild.id, recent);
}

// Joins are worked out one at a time per server, so two people joining at once can't both be credited to one link.
const queues = new Map();
function oneAtATime(guildId, task) {
  const run = (queues.get(guildId) ?? Promise.resolve()).then(task, task);
  queues.set(guildId, run.catch(() => {}));
  return run;
}

/**
 * Which link did this person use? Works by spotting which one's use count went up. Gives back
 * { inviterId } for someone's own invite, { vanity: true } for the server's custom link, or null when it can't
 * tell (including when more than one link went up at once: better no credit than the wrong person's).
 */
function whoInvited(guild) {
  return oneAtATime(guild.id, async () => {
    const before = known.get(guild.id);
    const beforeVanity = knownVanity.get(guild.id);
    const after = await refresh(guild);
    if (!after) return null;
    if (before) {
      const wentUp = [...after].filter(([code, now]) => now.uses > (before.get(code)?.uses ?? 0));
      const total = wentUp.reduce((n, [code, now]) => n + now.uses - (before.get(code)?.uses ?? 0), 0);
      if (wentUp.length === 1 && total === 1) return { inviterId: wentUp[0][1].inviterId };
      if (wentUp.length) return null;
    }
    // Nobody's own link went up, so the server's custom link is the next thing to check.
    const nowVanity = knownVanity.get(guild.id);
    if (typeof beforeVanity === 'number' && typeof nowVanity === 'number' && nowVanity > beforeVanity) return { vanity: true };
    // A one-use link disappears when it's used (used up here, so it can't be credited twice).
    const recent = (justDeleted.get(guild.id) ?? []).filter((r) => Date.now() - r.at < DELETED_WINDOW_MS);
    justDeleted.set(guild.id, recent.length === 1 ? [] : recent);
    return recent.length === 1 ? { inviterId: recent[0].inviterId } : null;
  });
}

/**
 * Gives someone the VIP role once an admin has approved their application (see vipApply.js).
 * Returns true when given, 'saved' when they're restricted (they get it when unrestricted), or false if it failed.
 */
async function giveVip(guild, member, settings, count, { approvedBy = null } = {}) {
  const role = guild.roles.cache.get(settings.vipRoleId);
  if (!role) {
    warnOnce(guild, 'missing', 'the VIP role was deleted. Run /vip set again.');
    return false;
  }
  if (!role.editable) {
    warnOnce(guild, 'position', `I can't give @${role.name} — drag my role above it in Server Settings → Roles.`);
    return false;
  }
  if (member.roles.cache.has(role.id)) return true;
  const by = approvedBy ? ` (approved by <@${approvedBy.id}>)` : '';

  // Restricted: VIP would let them see the VIP channels again, so it's saved for when they're unrestricted.
  if (restrict.saveForLater(guild, member.id, [role.id])) {
    const log = await fetchLogChannel(guild);
    await log
      ?.send({ content: `🌟 ${who(member)} got VIP${by}, but they’re restricted, so they’ll get **${role.name}** when they’re unrestricted.`, allowedMentions: { parse: [] } })
      .catch(() => {});
    return 'saved';
  }

  try {
    await member.roles.add(role, `O Jailbreak: brought ${count} people into the server${approvedBy ? `, approved by ${approvedBy.tag}` : ''}`);
  } catch (err) {
    warnOnce(guild, 'add', `couldn't give @${role.name} to ${member.user.tag}: ${err.message}`);
    return false;
  }
  await member
    .send(`🌟 **Your VIP application in ${truncate(guild.name, 80)} was approved!** You now have ${role.name}. Thanks for growing the server!`)
    .catch(() => {});
  const log = await fetchLogChannel(guild);
  await log?.send({ content: `🌟 ${who(member)} got the **${role.name}** role${by} — ${count} people joined with their invite links.`, allowedMentions: { parse: [] } }).catch(() => {});
  return true;
}

/** How old a Discord account is, worked out from the ID itself. */
function accountAgeMs(userId) {
  try {
    return Date.now() - Number((BigInt(userId) >> 22n) + 1420070400000n);
  } catch {
    return Infinity;
  }
}

const minAccountAgeMs = () => Math.max(0, config.vip.minAccountAgeDays) * 86_400_000;

/**
 * Counts a new member towards whoever invited them, and hands out VIP when they reach the target.
 * Brand-new accounts are still recorded (so you can see who brought them), but they don't count towards VIP.
 */
async function onMemberJoin(member) {
  const guild = member.guild;
  const settings = store.guild(guild.id);
  const found = await whoInvited(guild);
  if (member.user.bot) return null;
  const before = settings.invites.credited[member.id];
  // A record they can still count with: they joined through someone's link before but it didn't count then
  // (account too new, or left within a day). Anyone else who has been here before never counts again.
  const canCountAgain = isPerson(before) && Boolean(settings.invites.uncounted[member.id]);
  const remember = (value) => {
    if (!before) {
      settings.invites.credited[member.id] = value;
      store.save();
    }
  };

  if (!found) {
    remember(UNKNOWN);
    return null;
  }
  // The server's own custom link belongs to the server, not to a person, so it never counts towards VIP.
  if (found.vanity) {
    remember(VANITY);
    return { vanity: true, counted: false, reason: 'vanity' };
  }

  const inviterId = found.inviterId;
  if (!inviterId || inviterId === member.id) {
    remember(UNKNOWN);
    return null;
  }

  // Been here before (counted for someone, or joined through the server's link, or before the bot was counting):
  // leaving and rejoining never counts again.
  if (before && !canCountAgain) {
    return { inviterId, count: joinsBy(settings, inviterId), counted: false, reason: 'rejoin' };
  }

  settings.invites.credited[member.id] = inviterId;
  const tooNew = accountAgeMs(member.id) < minAccountAgeMs();
  if (tooNew) {
    settings.invites.uncounted[member.id] = 'new-account';
    store.save();
    return { inviterId, count: joinsBy(settings, inviterId), counted: false, reason: 'new-account' };
  }

  // Verification is on: they only count for whoever invited them once they've verified (see onVerified).
  const verify = settings.verify;
  if (verify?.enabled && !(verify.verifiedRoleId && member.roles?.cache.has(verify.verifiedRoleId))) {
    settings.invites.uncounted[member.id] = 'unverified';
    rememberJoin(settings, member.id);
    store.save();
    return { inviterId, count: joinsBy(settings, inviterId), counted: false, reason: 'unverified' };
  }

  delete settings.invites.uncounted[member.id];
  settings.invites.counts[inviterId] = joinsBy(settings, inviterId) + 1;
  rememberJoin(settings, member.id);
  store.save();

  const count = joinsBy(settings, inviterId);
  // Reached the goal: they're invited to apply, and an admin decides (VIP isn't handed out automatically).
  if (settings.vipRoleId && count >= joinsNeeded(settings)) {
    await require('./vipApply')
      .notifyEligible(guild, inviterId)
      .catch((err) => console.warn(`[vip] ${err.message}`));
  }
  return { inviterId, count, counted: true };
}

/**
 * Someone verified: if they joined through someone's invite and were waiting to verify, they count for that person
 * now (VIP and running giveaways they joined during). Returns { inviterId, count } if they counted.
 */
async function onVerified(member) {
  const guild = member.guild;
  const settings = store.guild(guild.id);
  if (settings.invites.uncounted[member.id] !== 'unverified') return null;
  const inviterId = settings.invites.credited[member.id];
  if (!isPerson(inviterId)) return null;
  delete settings.invites.uncounted[member.id];
  settings.invites.counts[inviterId] = joinsBy(settings, inviterId) + 1;
  store.save();
  const count = joinsBy(settings, inviterId);
  await require('./giveaway')
    .onCountedJoin(guild, inviterId, member.id, member.joinedTimestamp ?? Date.now())
    .catch((err) => console.warn(`[giveaway] ${err.message}`));
  if (settings.vipRoleId && count >= joinsNeeded(settings)) {
    await require('./vipApply')
      .notifyEligible(guild, inviterId)
      .catch((err) => console.warn(`[vip] ${err.message}`));
  }
  return { inviterId, count };
}

const mustStayMs = () => Math.max(0, config.vip.mustStayHours ?? 24) * 3_600_000;

// When each counted person joined, so leaving soon after can be undone. Only the last day or so is ever needed.
function rememberJoin(settings, userId) {
  const joinedAt = settings.invites.joinedAt;
  joinedAt[userId] = Date.now();
  for (const [id, at] of Object.entries(joinedAt)) if (Date.now() - at > mustStayMs() + 3_600_000) delete joinedAt[id];
}

/**
 * Someone left. If they counted for whoever invited them and leave within a day of joining (config: vip.mustStayHours),
 * they come back off that person's count — and if that takes an approved VIP below the goal, VIP comes off too.
 * Returns what happened, or null if nothing changed.
 */
async function onMemberLeave(member) {
  const settings = store.guild(member.guild.id);
  const inviterId = settings.invites.credited[member.id];
  if (!inviterId) {
    // Here before the bot was counting: remembered, so rejoining through a friend's link doesn't count as new.
    if (!member.user?.bot) {
      settings.invites.credited[member.id] = UNKNOWN;
      store.save();
    }
    return null;
  }
  if (!isPerson(inviterId) || settings.invites.uncounted[member.id]) return null;
  // Only the join time recorded when they counted (a rejoin that didn't count has none, so it can't be undone twice).
  const joinedAt = settings.invites.joinedAt[member.id] ?? null;
  delete settings.invites.joinedAt[member.id];
  if (!joinedAt || Date.now() - joinedAt >= mustStayMs()) {
    store.save();
    return null;
  }

  settings.invites.counts[inviterId] = Math.max(0, joinsBy(settings, inviterId) - 1);
  settings.invites.uncounted[member.id] = 'left-early';
  store.save();
  const lostVip = await takeVipIfBelow(member.guild, inviterId, { why: 'someone they invited left within a day', onlyIfApproved: true });
  return { inviterId, count: joinsBy(settings, inviterId), lostVip };
}

/**
 * Takes VIP off someone whose invite count is now below the goal. `onlyIfApproved` (used when it happens by itself)
 * only touches VIPs who got it through an approved application, so a VIP you gave out yourself is never taken away
 * automatically. Their application is reset so they can apply again when they're back at the goal.
 * Returns true if VIP was taken off (or taken out of what a restricted person gets back).
 */
async function takeVipIfBelow(guild, userId, { why, onlyIfApproved = false } = {}) {
  const settings = store.guild(guild.id);
  const roleId = settings.vipRoleId;
  const apps = (settings.vipApplications ??= {});
  // The goal they were approved at, if the goal has been raised since (raising it never takes VIP off anyone).
  const goal = Math.min(joinsNeeded(settings), apps[userId]?.goal ?? Infinity);
  if (!roleId || joinsBy(settings, userId) >= goal) return false;
  if (onlyIfApproved && apps[userId]?.status !== 'approved') return false;
  if (apps[userId]) apps[userId] = { status: 'removed', removedAt: Date.now() };

  // Restricted people have VIP saved for when they're unrestricted: take it out of that.
  const saved = settings.restricted[userId]?.roles;
  const wasSaved = Boolean(saved?.includes(roleId));
  if (wasSaved) settings.restricted[userId].roles = saved.filter((id) => id !== roleId);
  store.save();
  // VIP paused until they verify: it isn't given back when they do.
  const wasPaused = await require('./verify')
    .dropPausedVip(guild, userId, roleId)
    .catch(() => false);

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member?.roles.cache.has(roleId)) return wasSaved || wasPaused;
  const role = guild.roles.cache.get(roleId);
  if (!role?.editable) {
    warnOnce(guild, 'position', `I can't take @${role?.name ?? 'VIP'} off people — drag my role above it in Server Settings → Roles.`);
    return false;
  }
  const removed = await member.roles.remove(role, truncate(`O Jailbreak: ${why}`, 512)).then(() => true, () => false);
  if (!removed) return false;
  const count = joinsBy(settings, userId);
  await member
    .send(`📉 **Your ${role.name} in ${truncate(guild.name, 80)} was removed** because your invite count went down to ${count} (it needs ${joinsNeeded(settings)}). Bring more people in and you can apply again.`)
    .catch(() => {});
  const log = await fetchLogChannel(guild);
  await log?.send({ content: `📉 Took **${role.name}** off ${who(member)} — ${why} (now ${count}, needs ${joinsNeeded(settings)}).`, allowedMentions: { parse: [] } }).catch(() => {});
  // Verified that only came free with VIP goes too.
  await require('./verify')
    .onVipLost(member)
    .catch(() => {});
  return true;
}

/** Staff taking joins off someone's count (e.g. they cheated). Returns their count before and after. */
function revokeJoins(settings, userId, amount) {
  const before = joinsBy(settings, userId);
  const after = Math.max(0, before - amount);
  settings.invites.counts[userId] = after;
  settings.invites.revoked[userId] = (settings.invites.revoked[userId] ?? 0) + (before - after);
  store.save();
  return { before, after };
}

const revokedFrom = (settings, userId) => settings.invites.revoked?.[userId] ?? 0;

/**
 * Everyone a person has brought into the server, newest last, with how old each account is and whether the
 * join counted towards VIP.
 */
function broughtBy(settings, inviterId) {
  if (!inviterId || isVanity(inviterId)) return [];
  return Object.entries(settings.invites.credited)
    .filter(([, by]) => by === inviterId)
    .map(([joinerId]) => ({
      id: joinerId,
      counted: !settings.invites.uncounted[joinerId],
      reason: settings.invites.uncounted[joinerId] ?? null,
      accountDays: Math.floor(accountAgeMs(joinerId) / 86_400_000),
    }));
}

/** Who brought this member in: their user ID, VANITY for the server's own link, or null if nobody we know of. */
function invitedBy(settings, userId) {
  const value = settings.invites.credited[userId];
  return isPerson(value) || isVanity(value) ? value : null;
}

module.exports = {
  refresh,
  onInviteCreate,
  onInviteDelete,
  onMemberJoin,
  onVerified,
  onMemberLeave,
  takeVipIfBelow,
  giveVip,
  joinsBy,
  joinsNeeded,
  revokeJoins,
  revokedFrom,
  broughtBy,
  invitedBy,
  accountAgeMs,
  minAccountAgeMs,
  isVanity,
  isPerson,
  VANITY,
  UNKNOWN,
};
