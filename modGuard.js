'use strict';

// Moderators (the mod role in config.js → mods) can only /mute, /unmute, /restrict, /msgdelete and /cleanup (and
// right-click → Moderate / Delete Message). Everything goes through the bot: the mod role has no moderation
// powers in Discord itself (no Timeout, Delete Message, Ban...), whoever tries to add them. It gets Priority Speaker
// instead — a harmless voice permission that's only there so Discord shows moderators the bot's mod commands.
// They can't unrestrict, unban, close appeals, see the logs, add bots or change the server, and they can't delete the
// owner's or admins' messages (they can delete each other's, in case one goes rogue — it's all in #mod-watch).
//
// Everything they do goes in #mod-watch, which only the owner and admins can see. Too much at once (config.js →
// mods.limits, e.g. a 5th restrict within 5 minutes) and they're put on cooldown: the action is refused, their mod role
// is taken off until the owner lifts it (/modcooldown, or the button), and @everyone in #mod-watch is pinged — which
// only reaches the owner and admins, as nobody else can see it.
//
// Admins (Administrator or Manage Server), the owner and trusted users aren't limited, and are the only ones who can
// unrestrict or unban. Someone with the mod role is always a moderator unless they have Administrator: Manage Server
// through another role, or being on the anti-nuke trusted list, doesn't make a moderator an admin.
// Staff channels (and appeals) are for the owner and admins: anyone else given access to one personally loses it.
// Moderators can't add bots or make webhooks: the mod role never has Manage Server or Manage Webhooks (not even in one
// channel's settings), and if a moderator gets one through another role and uses it, the bot or webhook is removed
// straight away, #mod-watch is told and the owner is DMed.

const { ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, OverwriteType, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const config = require('../config');
const store = require('./store');
const staffGuard = require('./staffGuard');
const { ephemeral, truncate, ts, who } = require('./util');

const options = () => ({ roleId: null, limits: { restrict: 4, mute: 6, msgdelete: 5, cleanup: 4, delete: 15 }, windowMinutes: 5, watchChannelName: 'mod-watch', ...config.mods });
const windowMs = () => Math.max(1, Number(options().windowMinutes) || 5) * 60_000;

// What the mod role may never have, and what it needs for the mod commands to show up.
const DANGEROUS = [
  'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageWebhooks', 'ManageGuildExpressions', 'CreateGuildExpressions',
  'BanMembers', 'KickMembers', 'ViewAuditLog', 'MentionEveryone', 'ManageEvents', 'CreateEvents', 'ManageNicknames', 'ManageThreads',
  'MoveMembers', 'MuteMembers', 'DeafenMembers', 'ViewGuildInsights', 'ViewCreatorMonetizationAnalytics',
  'ModerateMembers', 'ManageMessages', 'PinMessages',
].filter((name) => P[name] !== undefined);
// The "this is a moderator" key: Discord shows the mod commands to people with it (see the commands' default permission).
const NEEDED = ['PrioritySpeaker'];
// Roles taken off a moderator on cooldown: anything that gives moderator powers.
const STAFF_PERMS = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers, P.ModerateMembers, P.ManageMessages, P.ManageWebhooks];

const MOD_COMMANDS = new Set(['mute', 'unmute', 'restrict', 'msgdelete', 'cleanup', 'Moderate', 'Delete Message']);
const EVERYONE_COMMANDS = new Set(['invites', 'rank', 'leaderboard', 'applyvip', 'applychat']);
const VERBS = { restrict: 'restrict', mute: 'mute', msgdelete: 'use /msgdelete', unmute: 'unmute', delete: 'delete a message in' };

function modsSettings(settings) {
  settings.mods ??= {};
  const m = settings.mods;
  m.watchChannelId ??= null;
  m.cooldowns ??= {}; // userId -> { at, kind, roles }
  m.hiddenChannels ??= []; // channels (or sections) moderators can't see, from /modhide
  m.hiddenSeeded ??= []; // config.js → mods.hiddenChannelIds already added (so /modhide remove sticks)
  m.memberBlocks ??= {}; // channelId -> userIds the bot blocked personally
  m.roleBlocks ??= []; // channelIds where the bot blocked the mod role
  for (const id of options().hiddenChannelIds ?? []) {
    if (m.hiddenSeeded.includes(id)) continue;
    m.hiddenSeeded.push(id);
    if (!m.hiddenChannels.includes(id)) m.hiddenChannels.push(id);
  }
  return m;
}

/** The owner, someone they trust, or an admin (Administrator / Manage Server): no limits, and can unrestrict and unban. */
const hasPerm = (member, flag) => Boolean(member.permissions?.has ? member.permissions.has(flag) : member.permissions?.any?.([flag]));

function isAdmin(member) {
  if (!member?.guild) return false;
  if (member.id === member.guild.ownerId || hasPerm(member, P.Administrator)) return true;
  // A moderator is always a moderator: Manage Server from another role, or the trusted list, doesn't change that.
  const settings = store.guild(member.guild.id);
  if (settings.modRoleId && member.roles?.cache?.has(settings.modRoleId)) return false;
  return store.isTrusted(member.guild, member.id) || hasPerm(member, P.ManageGuild);
}

/** A moderator (the mod role, Timeout Members or Manage Messages) who isn't an admin: mod commands only, with limits. */
function isLimitedMod(member, settings = store.guild(member.guild.id)) {
  if (!member?.guild || member.user?.bot || isAdmin(member)) return false;
  if (settings.modRoleId && member.roles?.cache.has(settings.modRoleId)) return true;
  return Boolean(member.permissions?.any([P.ModerateMembers, P.ManageMessages]));
}

const onCooldown = (guild, userId) => Boolean(modsSettings(store.guild(guild.id)).cooldowns[userId]);
// What moderators are told never mentions #mod-watch, the owner being told, or the exact limits.
const COOLDOWN_TEXT = '🛑 Your moderator powers are paused for now.';

/** Before any slash command: null if they can use it, otherwise what to tell them. */
function commandProblem(interaction) {
  if (EVERYONE_COMMANDS.has(interaction.commandName)) return null;
  const member = interaction.member;
  if (!member?.guild || isAdmin(member)) return null;
  if (onCooldown(interaction.guild, member.id)) return COOLDOWN_TEXT;
  if (isLimitedMod(member) && !MOD_COMMANDS.has(interaction.commandName)) {
    return '🚫 Moderators can only use `/mute`, `/unmute`, `/restrict`, `/msgdelete` and `/cleanup` (and right-click → Apps → Moderate / Delete Message).';
  }
  return null;
}

// ----- #mod-watch -----

async function watchChannel(guild) {
  const id = modsSettings(store.guild(guild.id)).watchChannelId;
  const channel = id ? guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null)) : null;
  return channel?.isTextBased?.() ? channel : null;
}

/** Posts something a moderator did in #mod-watch. */
async function logAction(guild, mod, text, { files = [] } = {}) {
  const channel = await watchChannel(guild);
  await channel?.send({ content: truncate(`${who(mod)} ${text}`, 2000), files, allowedMentions: { parse: [] } }).catch(() => {});
}

/** Trusted users (who can lift a cooldown) can see #mod-watch even without Administrator — never a moderator. */
async function letTrustedSee(guild, channel) {
  for (const userId of store.guild(guild.id).trusted ?? []) {
    if (channel.permissionOverwrites?.cache.get(userId)?.allow.has(P.ViewChannel)) continue;
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    if (!member || isLimitedMod(member)) continue;
    await channel.permissionOverwrites.edit(userId, { ViewChannel: true, ReadMessageHistory: true }, { reason: 'O Jailbreak: trusted users see #mod-watch', type: OverwriteType.Member }).catch(() => {});
  }
}

/** Makes #mod-watch if it's missing: only the owner, admins and trusted users can see it, never the mod role. */
async function ensureWatchChannel(guild) {
  const settings = store.guild(guild.id);
  const m = modsSettings(settings);
  const existing = await watchChannel(guild);
  if (existing) {
    await letTrustedSee(guild, existing);
    return existing;
  }
  const modRole = settings.modRoleId && guild.roles.cache.has(settings.modRoleId) ? settings.modRoleId : null;
  const channel = await guild.channels
    .create({
      name: options().watchChannelName,
      type: ChannelType.GuildText,
      topic: 'Everything moderators do. Only the owner and admins can see this.',
      reason: 'O Jailbreak: watching what moderators do',
      permissionOverwrites: [
        { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
        ...(modRole ? [{ id: modRole, type: OverwriteType.Role, deny: [P.ViewChannel] }] : []),
      ],
    })
    .catch((err) => {
      console.warn(`[mod watch] ${guild.name}: couldn't make #${options().watchChannelName}: ${err.message}`);
      return null;
    });
  if (!channel) return null;
  m.watchChannelId = channel.id;
  store.save();
  await letTrustedSee(guild, channel);
  await channel
    .send(
      [
        '👮 **Mod watch** — everything moderators do shows up here: mutes, unmutes, restricts and `/msgdelete` (with the deleted messages), plus timeouts done in Discord itself.',
        `If a moderator does too much at once (more than ${Object.entries(options().limits).map(([k, n]) => `${n} ${k}s`).join(', ')} in ${options().windowMinutes} minutes), their mod role is taken off and @everyone here is pinged — only the owner and admins can see this channel.`,
      ].join('\n'),
    )
    .catch(() => {});
  return channel;
}

const powerWarned = new Set(); // `${guildId}:${roleId}`

/**
 * Moderators do everything through the bot, so another role they have that gives Discord's own moderation powers
 * (a shared "Staff" role, say) is reported in #mod-watch, once. So is @everyone or the member role having Priority
 * Speaker (then everyone would see the mod commands — they still couldn't use them).
 */
async function checkModPowers(guild) {
  const settings = store.guild(guild.id);
  if (!settings.modRoleId) return;
  const MOD_POWERS = [P.ModerateMembers, P.ManageMessages, P.BanMembers, P.KickMembers, P.ManageRoles, P.ManageChannels, P.ManageGuild, P.ManageWebhooks, P.Administrator];
  // Including a moderator with Administrator through another role: they can do anything, so the owner should know.
  const mods = [...guild.members.cache.values()].filter((m) => m.roles?.cache.has(settings.modRoleId) && m.id !== guild.ownerId);
  const roles = new Map();
  for (const m of mods) for (const r of m.roles.cache.values()) if (r.id !== settings.modRoleId && r.id !== guild.id && r.permissions?.any(MOD_POWERS)) roles.set(r.id, r);
  for (const role of roles.values()) {
    const key = `${guild.id}:${role.id}`;
    if (powerWarned.has(key)) continue;
    powerWarned.add(key);
    await logAction(guild, guild.client.user, `⚠️ some moderators also have <@&${role.id}>, which gives them Discord’s own moderation powers (so they can skip the bot’s limits). Take those permissions off that role, or the role off them.`);
  }
  const key = `${guild.id}:everyone-priority`;
  const everyone = guild.roles.cache.get(guild.id);
  if (!powerWarned.has(key) && everyone?.permissions?.has?.(P.PrioritySpeaker, false)) {
    powerWarned.add(key);
    await logAction(guild, guild.client.user, '⚠️ @everyone has **Priority Speaker**, so everyone can see the mod commands in the / menu (they can’t use them). Turn it off for @everyone in Server Settings → Roles.');
  }
}

/**
 * Channels moderators must never see: the logs, the mod log, #mod-watch, #ban-list, and the ones added with /modhide
 * (config.js → mods.hiddenChannelIds are added the first time). A section (category) means every channel in it too.
 */
function hiddenChannelIds(guild) {
  const settings = store.guild(guild.id);
  const m = modsSettings(settings);
  const appeals = [settings.restrict?.categoryId, ...(settings.restrict?.extraCategoryIds ?? [])];
  const ids = [settings.logChannelId, config.logs?.channelId, m.watchChannelId, settings.banList?.channelId, ...appeals, ...m.hiddenChannels].filter(Boolean);
  const all = new Set();
  for (const id of ids) {
    all.add(id);
    for (const ch of guild.channels.cache.values()) if (ch.parentId === id) all.add(ch.id);
  }
  return [...all];
}

/**
 * Hides those channels from moderators. The mod role is blocked, and so is each moderator personally: Discord lets
 * any role that's *allowed* into a channel (a shared "Staff" role, say) beat one that's blocked, but a block on the
 * person beats every role. When someone stops being a moderator (or a channel comes off the list), the bot's own
 * blocks come off again.
 */
async function hideLogsFromMods(guild) {
  const settings = store.guild(guild.id);
  const roleId = settings.modRoleId;
  if (!roleId || !guild.roles.cache.has(roleId)) return { hidden: 0, people: 0 };
  const m = modsSettings(settings);
  const mods = [...guild.members.cache.values()].filter((mem) => !mem.user?.bot && isLimitedMod(mem, settings));
  const modIds = new Set(mods.map((mem) => mem.id));
  const reason = 'O Jailbreak: moderators can’t see this channel';
  const hidden = hiddenChannelIds(guild);
  let people = 0;
  for (const id of hidden) {
    const channel = guild.channels.cache.get(id);
    if (!channel?.permissionOverwrites) continue;
    if (!channel.permissionOverwrites.cache.get(roleId)?.deny.has(P.ViewChannel)) {
      const ok = await channel.permissionOverwrites.edit(roleId, { ViewChannel: false }, { reason, type: OverwriteType.Role }).then(
        () => true,
        (err) => {
          console.warn(`[mod watch] ${guild.name}: couldn't hide #${channel.name} from moderators: ${err.message}`);
          return false;
        },
      );
      if (ok && !m.roleBlocks.includes(id)) m.roleBlocks.push(id);
    }
    const blocked = new Set(m.memberBlocks[id] ?? []);
    for (const mod of mods) {
      if (settings.restricted?.[mod.id]?.ticketChannelId === id) continue; // their own appeal
      if (channel.permissionOverwrites.cache.get(mod.id)?.deny.has(P.ViewChannel)) continue;
      if (channel.permissionsFor && !channel.permissionsFor(mod)?.has(P.ViewChannel)) continue; // can't see it anyway
      const ok = await channel.permissionOverwrites.edit(mod.id, { ViewChannel: false }, { reason, type: OverwriteType.Member }).then(
        () => true,
        () => false,
      );
      if (ok) {
        blocked.add(mod.id);
        people++;
      }
    }
    // Not a moderator any more (or an admin now): the bot's block on them comes off.
    for (const userId of [...blocked]) {
      if (modIds.has(userId)) continue;
      await channel.permissionOverwrites.edit(userId, { ViewChannel: null }, { reason: 'O Jailbreak: not a moderator any more', type: OverwriteType.Member }).catch(() => {});
      blocked.delete(userId);
    }
    if (blocked.size) m.memberBlocks[id] = [...blocked];
    else delete m.memberBlocks[id];
  }
  // Channels taken off the list (/modhide remove): the bot's blocks come off.
  const stillHidden = new Set(hidden);
  for (const [id, users] of Object.entries(m.memberBlocks)) {
    if (stillHidden.has(id)) continue;
    const channel = guild.channels.cache.get(id);
    for (const userId of users) await channel?.permissionOverwrites.edit(userId, { ViewChannel: null }, { reason: 'O Jailbreak: moderators can see this again', type: OverwriteType.Member }).catch(() => {});
    delete m.memberBlocks[id];
  }
  for (const id of [...m.roleBlocks]) {
    if (stillHidden.has(id)) continue;
    await guild.channels.cache.get(id)?.permissionOverwrites.edit(roleId, { ViewChannel: null }, { reason: 'O Jailbreak: moderators can see this again', type: OverwriteType.Role }).catch(() => {});
    m.roleBlocks = m.roleBlocks.filter((x) => x !== id);
  }
  store.save();
  return { hidden: hidden.length, people };
}

// Someone was given (or lost) the mod role: their channel blocks are sorted a few seconds later.
const recheckSoon = new Map(); // guildId -> timer
function onMemberUpdate(oldMember, member) {
  const roleId = store.guild(member.guild.id).modRoleId;
  if (!roleId || (!oldMember.partial && oldMember.roles?.cache.has(roleId) === member.roles?.cache.has(roleId))) return;
  clearTimeout(recheckSoon.get(member.guild.id));
  recheckSoon.set(
    member.guild.id,
    setTimeout(() => hideLogsFromMods(member.guild).catch(() => {}), 5000),
  );
  recheckSoon.get(member.guild.id).unref?.();
}

let roleWarned = new Set();
/** The mod role gets Timeout Members + Manage Messages and nothing dangerous. `by` = who changed it (for the log). */
async function secureModRole(guild, { by = null } = {}) {
  const settings = store.guild(guild.id);
  if (!settings.modRoleId) return null;
  // Fresh from Discord: the audit log entry can arrive before the role change itself.
  const role = (await guild.roles.fetch?.(settings.modRoleId, { force: true }).catch(() => null)) ?? guild.roles.cache.get(settings.modRoleId);
  if (!role || role.id === guild.id || role.managed) return null; // never @everyone or a bot's own role
  const current = role.permissions;
  const remove = DANGEROUS.filter((name) => current.has(P[name], false));
  const add = NEEDED.filter((name) => !current.has(P[name], false));
  if (!remove.length && !add.length) return null;
  if (!role.editable) {
    if (!roleWarned.has(guild.id)) {
      roleWarned.add(guild.id);
      await logAction(guild, guild.client.user, `can’t change the **${role.name}** role’s permissions — drag **O Jailbreak** above it in Server Settings → Roles. It has: ${remove.join(', ') || 'nothing dangerous'}.`);
    }
    return null;
  }
  const next = new PermissionsBitField(current.bitfield).remove(remove.map((n) => P[n])).add(add.map((n) => P[n]));
  const ok = await role.setPermissions(next, 'O Jailbreak: moderators do everything through the bot').then(
    () => true,
    (err) => {
      console.warn(`[mod watch] ${guild.name}: couldn't change the mod role: ${err.message}`);
      return false;
    },
  );
  if (!ok) return null;
  const channel = await watchChannel(guild);
  await channel
    ?.send({
      content: truncate(
        [
          by ? `↩️ <@${by}> changed the **${role.name}** role. Moderators can’t have dangerous permissions, so I set it back.` : `🛡️ Set up the **${role.name}** role for moderators.`,
          remove.length ? `Removed: ${remove.join(', ')}` : null,
          add.length ? `Added: ${add.join(', ')} (harmless — it's how Discord knows to show moderators the bot's mod commands)` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        2000,
      ),
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
  return { remove, add };
}

/** At startup: the mod role from config.js, its permissions, #mod-watch, and the logs hidden from moderators. */
async function prepare(guild) {
  const settings = store.guild(guild.id);
  const roleId = options().roleId;
  if (roleId && guild.roles.cache.has(roleId) && settings.modRoleId !== roleId) {
    settings.modRoleId = roleId;
    store.save();
    console.log(`[mod watch] ${guild.name}: the mod role is ${guild.roles.cache.get(roleId).name} (from config.js).`);
  }
  await recheck(guild);
  // Checked again every 10 minutes (a log channel changed with /setup, the role let back in somewhere).
  if (!rechecking.has(guild.id)) {
    rechecking.add(guild.id);
    setInterval(() => recheck(guild).catch(() => {}), 600_000).unref();
  }
}
const rechecking = new Set();

async function recheck(guild) {
  await guardStaffChannels(guild).catch((err) => console.warn(`[mod watch] ${guild.name}: couldn't check the staff channels: ${err.message}`));
  if (!store.guild(guild.id).modRoleId) return;
  await ensureWatchChannel(guild);
  await secureModRole(guild);
  await secureModOverwrites(guild);
  await hideLogsFromMods(guild);
  await checkModPowers(guild);
}

/**
 * Staff channels (the logs, mod log, #mod-watch, #ban-list, /modhide channels) are for the owner and admins: anyone
 * else given access to one personally — by hand, or by an older version — loses it, and appeals are locked down too
 * (restrict.lockAppeals). What was taken away goes in the mod log. Access through a role is left alone (/access shows
 * it), as the owner may have set that up on purpose. Runs at startup and every 10 minutes.
 */
async function guardStaffChannels(guild) {
  const restrict = require('./restrict');
  const settings = store.guild(guild.id);
  const removed = await restrict.lockAppeals(guild).catch((err) => {
    console.warn(`[restrict] ${guild.name}: couldn't lock down the appeals: ${err.message}`);
    return [];
  });
  const appeals = new Set(restrict.appealCategoryIds(settings.restrict));
  for (const id of hiddenChannelIds(guild)) {
    const ch = guild.channels.cache.get(id);
    if (!ch?.permissionOverwrites?.cache || appeals.has(ch.id) || appeals.has(ch.parentId)) continue;
    for (const o of [...ch.permissionOverwrites.cache.values()]) {
      if (o.type !== OverwriteType.Member || !o.allow?.has(P.ViewChannel) || o.id === guild.client.user.id) continue;
      const member = guild.members.cache.get(o.id);
      if (!member || member.user?.bot || isAdmin(member)) continue;
      const ok = await ch.permissionOverwrites.edit(o.id, { ViewChannel: null }, { reason: 'O Jailbreak: staff channels are for admins only', type: OverwriteType.Member }).then(
        () => true,
        () => false,
      );
      if (ok) removed.push(`<@${o.id}> from ${ch}`);
    }
  }
  if (removed.length) {
    const log = await require('./caseLog').fetchLogChannel(guild);
    await log
      ?.send({
        content: truncate(`🔒 Staff channels and appeals are only for the owner and admins, so I took away access: ${removed.join(', ')}. \`/access\` shows who else can see them.`, 2000),
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }
  return removed;
}

// ----- limits and the cooldown -----

const history = new Map(); // `${guildId}:${userId}` -> [{ kind, target, at }]

/**
 * A moderator is about to do something (`kind`: restrict, mute, msgdelete, unmute). Returns null to go ahead, or what
 * to tell them — they're on cooldown, or this would take them past the limit (and now they're on cooldown).
 */
async function check(guild, member, kind, target = null, weight = 1) {
  if (!member || isAdmin(member)) return null;
  if (onCooldown(guild, member.id)) return COOLDOWN_TEXT;
  if (!isLimitedMod(member)) return null;
  const key = `${guild.id}:${member.id}`;
  const now = Date.now();
  const recent = (history.get(key) ?? []).filter((h) => now - h.at < windowMs());
  const limit = options().limits?.[kind];
  const used = recent.filter((h) => h.kind === kind).reduce((n, h) => n + (h.weight ?? 1), 0);
  if (limit != null && used + weight > limit) {
    history.set(key, recent);
    await startCooldown(guild, member, kind, recent);
    return '🛑 That’s too much at once, so it wasn’t done and your moderator powers are paused for now. If a raid is happening, tell an admin.';
  }
  recent.push({ kind, target, at: now, weight });
  history.set(key, recent);
  return null;
}

// What admins do only goes through staff watch when it's a punishment (not unmuting or tidying messages).
const PUNISHMENTS = new Set(['mute', 'restrict', 'ban', 'unrestrict'])

/** A moderator trying to unmute another moderator: only admins and the owner can do that. Returns why, or null. */
async function unmuteModProblem(guild, moderator, userId) {
  if (!moderator || !isLimitedMod(moderator)) return null;
  const target = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  const settings = store.guild(guild.id);
  const targetIsStaff = target && (isLimitedMod(target, settings) || (settings.modRoleId && target.roles?.cache.has(settings.modRoleId)));
  return targetIsStaff ? '🚫 Only admins and the owner can unmute a moderator.' : null;
}

/** For slash commands and buttons: replies and returns true when they've been stopped. Admins go through staff watch. */
async function blocked(interaction, kind, target = null) {
  const member = interaction.member;
  if (!isLimitedMod(member) && !onCooldown(interaction.guild, member.id)) return PUNISHMENTS.has(kind) ? staffGuard.blocked(interaction, kind) : false;
  const problem = await check(interaction.guild, member, kind, target);
  if (!problem) return false;
  await ephemeral(interaction, problem);
  return true;
}

const liftButton = (guildId, userId) =>
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ojmod:lift:${guildId}:${userId}`).setStyle(ButtonStyle.Success).setEmoji('✅').setLabel('Lift cooldown (give mod back)'));

async function startCooldown(guild, member, kind, recent) {
  const settings = store.guild(guild.id);
  const m = modsSettings(settings);
  if (m.cooldowns[member.id]) return;
  const powered = member.roles.cache.filter((r) => r.id !== guild.id && (r.id === settings.modRoleId || r.permissions?.any(STAFF_PERMS)));
  const staffRoles = powered.filter((r) => !r.managed && r.editable !== false);
  const stuck = powered.filter((r) => r.managed || r.editable === false);
  m.cooldowns[member.id] = { at: Date.now(), kind, roles: [...staffRoles.keys()] };
  store.flush();
  const removed = staffRoles.size
    ? await member.roles.remove([...staffRoles.keys()], `O Jailbreak: moderator on cooldown (too many ${kind}s at once)`).then(
        () => true,
        () => false,
      )
    : true;

  const limit = options().limits?.[kind];
  const did = recent.map((h) => `• ${VERBS[h.kind] ?? h.kind}${h.target ? ` ${h.target}` : ''} ${ts(h.at)}`);
  const embed = new EmbedBuilder()
    .setColor(0x991b1b)
    .setTitle(truncate(`🛑 Moderator on cooldown — ${member.user.tag}`, 256))
    .setDescription(
      truncate(
        [
          `${who(member)} tried to **${VERBS[kind] ?? kind}** more than **${limit}** times in ${options().windowMinutes} minutes. That one wasn’t done.`,
          removed
            ? staffRoles.size
              ? `🔒 Took off ${staffRoles.map((r) => `**${r.name}**`).join(', ')} until you lift the cooldown.`
              : '🔒 Their moderator commands are blocked until you lift the cooldown.'
            : '⚠️ I couldn’t take their mod role off — their commands are still blocked. Take it off by hand.',
          stuck.size
            ? `⚠️ I can’t take off ${stuck.map((r) => `**${r.name}**`).join(', ')} (above my role), so they can still use Discord’s own Timeout / Delete Message. Take it off by hand.`
            : null,
          '',
          `**What they did in the last ${options().windowMinutes} minutes:**`,
          ...(did.length ? did : ['• (nothing else)']),
          '',
          'If this wasn’t them, their account may be hacked. Undo anything above with `/unmute` / `/unrestrict`.',
          'Lift it with the button below or `/modcooldown lift`.',
        ]
          .filter((line) => line !== null)
          .join('\n'),
        4000,
      ),
    )
    .setFooter({ text: `Moderator ID ${member.id}` })
    .setTimestamp();

  const channel = await watchChannel(guild);
  await channel?.send({ content: '@everyone', embeds: [embed], components: [liftButton(guild.id, member.id)], allowedMentions: { parse: ['everyone'] } }).catch(() => {});
  const owner = await guild.fetchOwner().catch(() => null);
  await owner?.send({ content: `🛑 **A moderator was put on cooldown in ${truncate(guild.name, 80)}**`, embeds: [embed], components: [liftButton(guild.id, member.id)] }).catch(() => {});
  for (const userId of settings.trusted ?? []) {
    if (userId === guild.ownerId) continue;
    const user = await guild.client.users?.fetch(userId).catch(() => null);
    await user?.send({ content: `🛑 **A moderator was put on cooldown in ${truncate(guild.name, 80)}**`, embeds: [embed], components: [liftButton(guild.id, member.id)] }).catch(() => {});
  }
  console.warn(`[mod watch] ${guild.name}: ${member.user.tag} put on cooldown (${kind}).`);
}

/** Lifts a cooldown: their roles come back. Owner or trusted only (checked by the caller). */
async function liftCooldown(guild, userId, by) {
  const m = modsSettings(store.guild(guild.id));
  const record = m.cooldowns[userId];
  if (!record) return { ok: false, text: `ℹ️ <@${userId}> isn’t on cooldown.` };
  const member = await guild.members.fetch(userId).catch(() => null);
  const saved = (record.roles ?? []).map((id) => guild.roles.cache.get(id)).filter(Boolean);
  const back = saved.filter((r) => r.editable !== false && !r.managed).map((r) => r.id);
  const cant = saved.filter((r) => r.editable === false || r.managed);
  if (member && back.length) await member.roles.add(back, `O Jailbreak: cooldown lifted by ${by.tag ?? by.id}`).catch(() => {});
  delete m.cooldowns[userId];
  history.delete(`${guild.id}:${userId}`);
  store.save();
  const channel = await watchChannel(guild);
  await channel?.send({ content: `✅ <@${by.id}> lifted <@${userId}>’s cooldown${back.length ? ' — they have their mod role back' : ''}.`, allowedMentions: { parse: [] } }).catch(() => {});
  const note = cant.length ? ` ⚠️ I can’t give back ${cant.map((r) => `**${r.name}**`).join(', ')} (above my role) — give it back by hand.` : '';
  return { ok: true, text: `✅ Lifted <@${userId}>’s cooldown${member ? (back.length ? ' and gave their roles back' : '') : ' (they’ve left the server)'}.${note}` };
}

/** The "Lift cooldown" button, in #mod-watch or the owner's DMs. */
async function liftButtonPressed(interaction) {
  const [, , guildId, userId] = interaction.customId.split(':');
  const guild = interaction.client.guilds.cache.get(guildId);
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  if (!guild) return reply('❌ I’m not in that server any more.');
  if (!store.isTrusted(guild, interaction.user.id)) return reply('🚫 Only the server owner (or someone they trust) can lift a cooldown.');
  const result = await liftCooldown(guild, userId, interaction.user);
  return reply(result.text);
}

// ----- a moderator breaking the rules -----

/**
 * A moderator broke a rule (calling the owner a scammer, spam, self-promotion, a scam link, a slur): in case they've
 * gone rogue (or been hacked), their message (and any spam) is deleted, every role comes off — saved, so /unrestrict
 * gives them all back — and they're restricted. The owner is DMed straight away, and it goes in #mod-watch.
 * Returns 'rogue-mod-restricted', or null if they couldn't be restricted (then they're dealt with like anyone else).
 */
async function rogueModerator(message, member, { label, trigger, text = '', entries = [] }) {
  const guild = message.guild;
  const restrict = require('./restrict');
  const { deleteEntries, deleteMessage } = require('./punish');
  const result = await restrict.restrictMember({
    guild,
    member,
    moderator: guild.client.user,
    reason: `Broke the rules: ${label}`,
    proof: { excerpt: text || null, channelId: message.channelId },
  });
  if (result.ok) {
    // Cleaning up never stops the owner hearing about it.
    await deleteMessage(message).catch(() => {});
    if (entries.length > 1) await deleteEntries(guild, entries, message.id).catch(() => 0);
  }

  const embed = new EmbedBuilder()
    .setColor(0x991b1b)
    .setTitle(truncate(result.ok ? `🚨 A moderator broke the rules — I restricted them` : `🚨 A moderator broke the rules — I couldn’t restrict them`, 256))
    .setDescription(
      truncate(
        [
          `${who(member)} in **${truncate(guild.name, 80)}**`,
          `**${label}** in <#${message.channelId}>: ${truncate(trigger ?? '', 300)}`,
          text ? `>>> ${truncate(text, 800)}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        4000,
      ),
    )
    .addFields({
      name: 'What I did',
      value: result.ok
        ? 'Deleted the message, took **every role** off them (including the mod role) and restricted them. Their roles are saved — `/unrestrict` them if this was a mistake and they get everything back.'
        : `Nothing yet: ${truncate(result.text ?? 'restricting failed', 300)} They’re being dealt with like anyone else. Take their roles off by hand.`,
    })
    .setFooter({ text: `Moderator ID ${member.id}` })
    .setTimestamp();
  const owner = await guild.fetchOwner?.().catch(() => null);
  await owner?.send({ embeds: [embed] }).catch(() => {});
  await logAction(guild, member, `🚨 broke a rule: **${label}** in <#${message.channelId}> — ${result.ok ? 'every role taken off and restricted' : 'couldn’t be restricted'}`);
  return result.ok ? 'rogue-mod-restricted' : null;
}

// ----- bots, webhooks and channel settings -----

/**
 * A channel's own settings can hand out powers the mod role doesn't have (Manage Webhooks, Manage Messages, Manage
 * Channels...), so those are taken back off the mod role and any moderator personally, in every channel. Runs with
 * the other checks, and straight away when someone changes a channel's permissions. Returns what was taken off.
 */
async function secureModOverwrites(guild, channels = [...guild.channels.cache.values()], { by = null } = {}) {
  const settings = store.guild(guild.id);
  const roleId = settings.modRoleId;
  if (!roleId) return [];
  const modIds = new Set([...guild.members.cache.values()].filter((m) => !m.user?.bot && isLimitedMod(m, settings)).map((m) => m.id));
  const fixed = [];
  for (const ch of channels) {
    for (const o of [...(ch?.permissionOverwrites?.cache?.values() ?? [])]) {
      if (o.id !== roleId && !modIds.has(o.id)) continue;
      const bad = DANGEROUS.filter((name) => o.allow?.has(P[name], false));
      if (!bad.length) continue;
      const ok = await ch.permissionOverwrites
        .edit(o.id, Object.fromEntries(bad.map((name) => [name, null])), { reason: 'O Jailbreak: moderators do everything through the bot', type: o.type })
        .then(() => true, () => false);
      if (ok) fixed.push(`${o.id === roleId ? 'the mod role' : `<@${o.id}>`} in ${ch}: ${bad.join(', ')}`);
    }
  }
  if (fixed.length) {
    await logAction(guild, guild.client.user, `${by ? `↩️ <@${by}> gave moderators` : '🛡️ moderators had'} Discord’s own powers in a channel’s settings, so I took them back off — ${fixed.join('; ')}`);
  }
  return fixed;
}

/**
 * A moderator added a bot or made a webhook (they'd need Manage Server or Manage Webhooks from another role or a
 * channel's settings): it's removed straight away, #mod-watch is told and the owner is DMed. Nuke bots get in this way,
 * and webhooks post fake announcements and scams under any name and picture, so even one is too many.
 */
async function undoModAddition(entry, guild, mod) {
  let text;
  if (entry.action === AuditLogEvent.BotAdd) {
    const bot = await guild.members.fetch(entry.targetId).catch(() => null);
    const name = bot?.user?.tag ?? entry.target?.tag ?? entry.targetId;
    // Anti-nuke may have kicked it already.
    const gone = !bot || (await bot.kick('O Jailbreak: moderators can’t add bots').then(() => true, () => false));
    text = `🚨 added a bot (**${name}**) — ${gone ? 'I kicked it' : 'I couldn’t kick it (its role is above mine), kick it by hand'}`;
  } else {
    const hook = await guild.client.fetchWebhook(entry.targetId).catch(() => null);
    const channelId = hook?.channelId ?? entry.target?.channelId ?? entry.changes?.find((c) => c.key === 'channel_id')?.new;
    const name = hook?.name ?? entry.target?.name ?? entry.changes?.find((c) => c.key === 'name')?.new ?? 'a webhook';
    const gone = !hook || (await hook.delete('O Jailbreak: moderators can’t make webhooks').then(() => true, () => false));
    text = `🚨 made a webhook (**${name}**)${channelId ? ` in <#${channelId}>` : ''} — ${gone ? 'I deleted it' : 'I couldn’t delete it, delete it by hand (channel settings → Integrations)'}`;
  }
  await logAction(guild, mod, `${text}. Moderators can’t add bots or webhooks; check which role gave them the permission.`);
  const owner = await guild.fetchOwner?.().catch(() => null);
  await owner?.send(truncate(`${text.replace(/^🚨 /, `🚨 Moderator **${mod.user.tag}** in **${guild.name}** `)}. Moderators can’t add bots or webhooks — \`/access user:@${mod.user.username}\` shows which role gave them the permission.`, 2000)).catch(() => {});
}

// ----- things moderators do in Discord itself -----

/** Timeouts a moderator gives in Discord (not with /mute) count too, and changes to the mod role are undone. */
async function onAuditLogEntry(entry, guild) {
  const { executorId } = entry;
  if (!executorId || executorId === guild.client.user.id) return;
  const settings = store.guild(guild.id);
  if (!settings.modRoleId) return;

  if (entry.action === AuditLogEvent.RoleUpdate && entry.targetId === settings.modRoleId) {
    await secureModRole(guild, { by: executorId });
    return;
  }
  if (entry.action === AuditLogEvent.BotAdd || entry.action === AuditLogEvent.WebhookCreate) {
    const mod = await guild.members.fetch(executorId).catch(() => null);
    if (mod && isLimitedMod(mod, settings)) await undoModAddition(entry, guild, mod);
    return;
  }
  // A channel made, or its permissions changed: no moderator powers for the mod role or a moderator in it.
  if ([AuditLogEvent.ChannelCreate, AuditLogEvent.ChannelOverwriteCreate, AuditLogEvent.ChannelOverwriteUpdate].includes(entry.action)) {
    const channel = guild.channels.cache.get(entry.targetId);
    if (channel) await secureModOverwrites(guild, [channel], { by: executorId });
    return;
  }
  if (entry.action === AuditLogEvent.MessageDelete) {
    const mod = await guild.members.fetch(executorId).catch(() => null);
    if (!mod || !(isLimitedMod(mod, settings) || onCooldown(guild, mod.id))) return;
    const count = entry.extra?.count ?? 1;
    const where = entry.extra?.channel?.id ?? entry.extra?.channelId;
    await check(guild, mod, 'delete', `<@${entry.targetId}>`, Math.max(1, Math.min(count, 100)));
    await logAction(guild, mod, `🗑️ deleted ${count > 1 ? `${count} messages` : 'a message'} by <@${entry.targetId}>${where ? ` in <#${where}>` : ''} in Discord itself (the text is in the logs channel)`);
    return;
  }
  if (entry.action !== AuditLogEvent.MemberUpdate) return;
  const change = entry.changes?.find((c) => c.key === 'communication_disabled_until');
  if (!change) return;
  const mod = await guild.members.fetch(executorId).catch(() => null);
  if (!mod || !(isLimitedMod(mod, settings) || onCooldown(guild, mod.id))) return;
  const target = `<@${entry.targetId}>`;
  if (!change.new) {
    await logAction(guild, mod, `🔊 removed ${target}’s timeout in Discord itself${entry.reason ? ` — ${entry.reason}` : ''}`);
    return;
  }
  const problem = await check(guild, mod, 'mute', target);
  await logAction(guild, mod, `🔇 timed out ${target} in Discord itself (not with /mute) until ${ts(Date.parse(change.new))}${entry.reason ? ` — ${entry.reason}` : ''}`);
  if (problem) {
    const victim = await guild.members.fetch(entry.targetId).catch(() => null);
    const before = change.old ? Date.parse(change.old) : 0; // a mute they already had (say the bot's 7-day one)
    await victim?.timeout(before > Date.now() + 1000 ? before - Date.now() : null, 'O Jailbreak: undone — the moderator was put on cooldown').catch(() => {});
    await logAction(guild, mod, `’s timeout of ${target} was undone (they’re on cooldown).`);
  }
}

module.exports = {
  isAdmin,
  isLimitedMod,
  unmuteModProblem,
  rogueModerator,
  onCooldown,
  commandProblem,
  check,
  blocked,
  logAction,
  liftCooldown,
  liftButtonPressed,
  prepare,
  guardStaffChannels,
  secureModRole,
  secureModOverwrites,
  checkModPowers,
  hiddenChannelIds,
  onMemberUpdate,
  ensureWatchChannel,
  hideLogsFromMods,
  onAuditLogEntry,
  modsSettings,
  _history: history,
  _reset: () => (roleWarned = new Set()),
};
