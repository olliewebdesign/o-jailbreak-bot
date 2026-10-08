'use strict';

// Watches the audit log for someone wrecking the server (mass channel/role deletes, mass bans,
// webhook spam, handing out Administrator...) and shuts them down before they finish.

const { AuditLogEvent, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const config = require('../config');
const store = require('./store');
const { buildCaseEmbed, postCaseLog } = require('./caseLog');
const lockdown = require('./lockdown');
const { TIMEOUT_MS, durationText, truncate } = require('./util');

const WATCHED = {
  [AuditLogEvent.ChannelDelete]: { key: 'channelDelete', verb: 'Deleted channel' },
  [AuditLogEvent.ChannelCreate]: { key: 'channelCreate', verb: 'Created channel' },
  [AuditLogEvent.RoleDelete]: { key: 'roleDelete', verb: 'Deleted role' },
  [AuditLogEvent.RoleCreate]: { key: 'roleCreate', verb: 'Created role' },
  [AuditLogEvent.MemberBanAdd]: { key: 'ban', verb: 'Banned' },
  [AuditLogEvent.MemberKick]: { key: 'kick', verb: 'Kicked' },
  [AuditLogEvent.WebhookCreate]: { key: 'webhookCreate', verb: 'Created webhook' },
  [AuditLogEvent.EmojiDelete]: { key: 'emojiDelete', verb: 'Deleted emoji' },
};

// Permissions that are an instant red flag when someone gives them to @everyone.
const DANGEROUS =
  PermissionFlagsBits.Administrator |
  PermissionFlagsBits.ManageGuild |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.BanMembers |
  PermissionFlagsBits.KickMembers |
  PermissionFlagsBits.ManageWebhooks |
  PermissionFlagsBits.MentionEveryone;

const activity = new Map(); // `${guildId}:${userId}` -> { [actionKey]: [{ at, targetId, name }] }
const handling = new Set(); // people being dealt with right now, so one attack makes one alert

setInterval(() => {
  const windowMs = config.antiNuke.windowSeconds * 1000;
  for (const [id, actions] of activity) {
    const live = Object.values(actions).some((list) => list.some((e) => Date.now() - e.at < windowMs));
    if (!live) activity.delete(id);
  }
}, 5 * 60_000).unref();

function track(guildId, userId, key, event) {
  const id = `${guildId}:${userId}`;
  const windowMs = config.antiNuke.windowSeconds * 1000;
  const actions = activity.get(id) ?? {};
  const list = (actions[key] ?? []).filter((e) => event.at - e.at < windowMs);
  list.push(event);
  actions[key] = list;
  activity.set(id, actions);
  return list;
}

function describeTarget(entry) {
  const nameChange = entry.changes?.find((c) => c.key === 'name');
  const name = entry.target?.name ?? entry.target?.tag ?? nameChange?.old ?? nameChange?.new;
  return name ? `${name} (${entry.targetId})` : `${entry.targetId ?? 'unknown'}`;
}

function alertPing(guild, settings) {
  const roles = settings.modRoleId ? [settings.modRoleId] : [];
  return {
    content: `🚨 **ANTI-NUKE TRIGGERED** ${roles.map((id) => `<@&${id}>`).join(' ')} <@${guild.ownerId}>`,
    allowedMentions: { roles, users: [guild.ownerId] },
  };
}

async function sendAlert(guild, settings, c) {
  const posted = await postCaseLog(guild, c, { ping: alertPing(guild, settings) });
  if (posted) return;
  // No mod log (or it was deleted in the attack): DM the owner instead.
  const owner = await guild.fetchOwner().catch(() => null);
  await owner
    ?.send({ content: `🚨 **Anti-nuke triggered in ${guild.name}** (the mod log channel is missing, so the review buttons aren't available — run /setup again).`, embeds: [buildCaseEmbed(c)] })
    .catch(() => {});
}

/**
 * Removes the attacker's roles and times them out (or kicks them if they're a bot), then alerts the mods.
 */
async function neutralize(guild, settings, userId, { reason, details = [], webhookIds = [] }) {
  const lockKey = `${guild.id}:${userId}`;
  if (handling.has(lockKey)) return;
  handling.add(lockKey);
  setTimeout(() => handling.delete(lockKey), 60_000).unref();
  activity.delete(lockKey);

  const auditReason = truncate(`O Jailbreak anti-nuke: ${reason}`, 512);
  const actions = [];
  const problems = [];
  let strippedRoles = [];
  let timedOut = false;

  let member = await guild.members.fetch(userId).catch(() => null);
  const user = member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));

  if (!member) {
    problems.push('They are no longer in the server.');
  } else if (member.user.bot) {
    if (member.kickable) {
      await member.kick(auditReason).then(
        () => actions.push('👢 Kicked the bot'),
        (err) => problems.push(`Couldn't kick the bot: ${err.message}`),
      );
    } else {
      problems.push("Couldn't kick the bot — its role is above mine. **Drag my role to the top!**");
    }
  } else {
    const removable = member.roles.cache.filter((r) => r.id !== guild.id && !r.managed && r.editable);
    const stuck = member.roles.cache.filter((r) => r.id !== guild.id && !r.editable && (r.permissions.bitfield & DANGEROUS) !== 0n);

    if (removable.size) {
      try {
        member = await member.roles.remove([...removable.keys()], auditReason);
        strippedRoles = [...removable.keys()];
        actions.push(`🧹 Removed ${removable.size} role(s): ${removable.map((r) => r.name).join(', ')}`);
      } catch (err) {
        problems.push(`Couldn't remove their roles: ${err.message}`);
      }
    }
    if (stuck.size) {
      problems.push(`Couldn't remove **${stuck.map((r) => r.name).join(', ')}** — above my role. **Drag my role to the top!**`);
    }

    if (member.moderatable) {
      try {
        await member.timeout(TIMEOUT_MS, auditReason);
        timedOut = true;
        actions.push(`🔇 Timed out for ${durationText()}`);
      } catch (err) {
        problems.push(`Couldn't time them out: ${err.message}`);
      }
    } else {
      problems.push("Couldn't time them out (they still have Administrator, or a role above mine).");
    }
  }

  let webhooksDeleted = 0;
  for (const id of webhookIds) {
    const hook = await guild.client.fetchWebhook(id).catch(() => null);
    if (hook && (await hook.delete(auditReason).then(() => true, () => false))) webhooksDeleted++;
  }
  if (webhooksDeleted) actions.push(`🪝 Deleted ${webhooksDeleted} webhook(s) they made`);

  const c = store.createCase(guild.id, {
    type: 'ANTINUKE',
    label: 'Anti-nuke',
    userId,
    userTag: user?.tag ?? userId,
    avatarUrl: user?.displayAvatarURL({ size: 128 }) ?? null,
    summary: `**<@${userId}> looks like they're trying to nuke the server.** Their roles were removed so they can't do more damage.`,
    trigger: reason,
    details,
    actionNote: [...actions, ...problems.map((p) => `⚠️ ${p}`)].join('\n') || 'Nothing could be done.',
    strippedRoles,
    timedOut,
    timeoutUntil: timedOut ? Date.now() + TIMEOUT_MS : null,
    accountCreatedAt: user?.createdTimestamp ?? null,
  });
  console.warn(`[anti-nuke] ${guild.name}: stopped ${user?.tag ?? userId} — ${reason}`);
  await sendAlert(guild, settings, c);
  await lockdown.onNuke(guild, `${user?.tag ?? userId}: ${reason}`);
}

async function onBotAdded(entry, guild, settings, executorTrusted) {
  const botId = entry.targetId;
  if (!botId || settings.trusted.includes(botId)) return;

  if (executorTrusted) {
    // The owner or a trusted admin added it, so trust the bot too.
    settings.trusted.push(botId);
    store.save();
    return;
  }
  if (!config.antiNuke.kickUnauthorizedBots) return;

  const bot = await guild.members.fetch(botId).catch(() => null);
  let kicked = false;
  if (bot?.kickable) {
    kicked = await bot.kick('O Jailbreak anti-nuke: added by someone who is not trusted').then(() => true, () => false);
  }
  const tag = bot?.user.tag ?? entry.target?.tag ?? botId;

  const c = store.createCase(guild.id, {
    type: 'BOT',
    label: 'Unapproved bot added',
    userId: botId,
    userTag: tag,
    avatarUrl: bot?.user.displayAvatarURL({ size: 128 }) ?? null,
    addedBy: entry.executorId,
    summary: `<@${entry.executorId}> added a bot, but they aren't on the trusted list. Nuke bots are usually added this way.`,
    trigger: 'Bot added by someone who is not trusted',
    details: ['If this bot is fine: the server owner runs `/antinuke trust` on the bot (paste its ID) and adds it again.'],
    actionNote: kicked ? '👢 Bot kicked' : "⚠️ Couldn't kick the bot — its role is above mine",
  });
  await sendAlert(guild, settings, c);
}

async function checkRolePermissions(entry, guild, settings, executorId) {
  const change = entry.changes.find((c) => c.key === 'permissions');
  if (!change) return;

  const before = BigInt(change.old ?? 0);
  const added = BigInt(change.new ?? 0) & ~before;
  const isEveryone = entry.targetId === guild.id;
  const bad = added & (isEveryone ? DANGEROUS : PermissionFlagsBits.Administrator);
  if (!bad) return;

  const role = guild.roles.cache.get(entry.targetId);
  const undone = role?.editable
    ? await role.setPermissions(before, 'O Jailbreak anti-nuke: undoing a dangerous permission change').then(() => true, () => false)
    : false;
  const names = new PermissionsBitField(bad).toArray().join(', ');

  await neutralize(guild, settings, executorId, {
    reason: isEveryone ? `Gave @everyone dangerous permissions (${names})` : `Gave the "${role?.name ?? entry.targetId}" role Administrator`,
    details: [`• Role: ${role?.name ?? entry.targetId}`, `• Added: ${names}`, undone ? '• ✅ Change undone' : "• ⚠️ Couldn't undo the change"],
  });
}

async function checkRoleGrant(entry, guild, settings, executorId) {
  const added = entry.changes.find((c) => c.key === '$add')?.new ?? [];
  const adminRoles = added
    .map((r) => guild.roles.cache.get(r.id))
    .filter((r) => r?.permissions.has(PermissionFlagsBits.Administrator));
  if (!adminRoles.length || store.isTrusted(guild, entry.targetId)) return;

  const target = await guild.members.fetch(entry.targetId).catch(() => null);
  const takeBack = adminRoles.filter((r) => r.editable);
  const undone = target && takeBack.length
    ? await target.roles.remove(takeBack, 'O Jailbreak anti-nuke: undoing an Administrator grant').then(() => true, () => false)
    : false;

  await neutralize(guild, settings, executorId, {
    reason: `Gave Administrator to ${target?.user.tag ?? entry.targetId}`,
    details: [`• Role(s): ${adminRoles.map((r) => r.name).join(', ')}`, undone ? '• ✅ Role(s) taken back' : "• ⚠️ Couldn't take the role(s) back"],
  });
}

async function handleAuditLogEntry(entry, guild) {
  const { executorId } = entry;
  if (!executorId || executorId === guild.client.user.id) return;

  const settings = store.guild(guild.id);
  if (!settings.modules.antiNuke) return;

  let trusted = store.isTrusted(guild, executorId);
  if (trusted) {
    // A moderator is never trusted, even on the list (see modGuard.isAdmin): a bot they add is kicked, not trusted.
    const executor = guild.members.cache.get(executorId) ?? (await guild.members.fetch(executorId).catch(() => null));
    if (executor && require('./modGuard').isLimitedMod(executor, settings)) trusted = false;
  }
  if (entry.action === AuditLogEvent.BotAdd) return onBotAdded(entry, guild, settings, trusted);
  if (trusted) return;

  switch (entry.action) {
    case AuditLogEvent.MemberPrune:
      return neutralize(guild, settings, executorId, {
        reason: 'Pruned (mass-kicked) members',
        details: [`• Removed ${entry.extra?.removed ?? '?'} members inactive for ${entry.extra?.days ?? '?'} days`],
      });
    case AuditLogEvent.MemberRoleUpdate:
      return checkRoleGrant(entry, guild, settings, executorId);
    case AuditLogEvent.RoleCreate:
    case AuditLogEvent.RoleUpdate:
      await checkRolePermissions(entry, guild, settings, executorId);
      break;
    case AuditLogEvent.GuildUpdate: {
      const vanity = entry.changes.find((c) => c.key === 'vanity_url_code');
      if (!vanity) return;
      return neutralize(guild, settings, executorId, {
        reason: 'Changed the server invite link (vanity URL)',
        details: [`• From \`${vanity.old ?? 'none'}\` to \`${vanity.new ?? 'none'}\``],
      });
    }
  }

  const watched = WATCHED[entry.action];
  const limit = watched && config.antiNuke.limits[watched.key];
  if (!limit) return;

  const events = track(guild.id, executorId, watched.key, { at: Date.now(), targetId: entry.targetId, name: describeTarget(entry) });
  if (events.length < limit) return;

  await neutralize(guild, settings, executorId, {
    reason: `${watched.verb} ×${events.length} within ${config.antiNuke.windowSeconds} seconds`,
    details: events.map((e) => `• ${watched.verb}: ${e.name}`),
    webhookIds: watched.key === 'webhookCreate' ? events.map((e) => e.targetId).filter(Boolean) : [],
  });
}

module.exports = { handleAuditLogEntry };
