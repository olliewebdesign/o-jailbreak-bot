'use strict';

// #ban-list: a private channel only admins can see. Every ban is one line — who they are, their Discord ID,
// why they were banned — with an Unban button on the right that asks "are you sure?" before it does anything.

const {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits: P,
  SectionBuilder,
  TextDisplayBuilder,
} = require('discord.js');
const config = require('../config');
const store = require('./store');
const { fetchLogChannel } = require('./caseLog');
const { canBan, exclusive, isTemporary, truncate, ts } = require('./util');

const MAX_SYNC = 200;
const PERMISSION_FIX = 'Fix: **Server Settings → Roles → O Jailbreak** → turn on **Administrator**.';

function explain(err) {
  if (err?.friendly) return err.friendly;
  if (err?.code === 50013 || err?.code === 50001) return `I’m missing permissions. ${PERMISSION_FIX}`;
  if (isTemporary(err)) return `Discord didn’t respond (${err.message}). Try again in a minute.`;
  return err?.message ?? String(err);
}

function reply(interaction, content, components = []) {
  const payload = { content, components, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
  return interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.reply(payload);
}

// One line: 🔨 name `id` — reason — who banned them and when, with the Unban button beside it.
function banLine({ userId, userTag, reason, moderatorId, at, unbannedBy, unbannedAt }) {
  const who = `🔨 **${truncate(userTag ?? 'Unknown user', 60)}** \`${userId}\``;
  const why = `**${truncate(reason || 'No reason given', 300)}**`;
  const by = moderatorId ? ` • banned by <@${moderatorId}>` : '';
  const when = at ? ` ${ts(at)}` : '';
  const line = `${who} • ${why}${by}${when}`;
  if (!unbannedBy && !unbannedAt) return line;
  return `✅ ~~${who}~~ • ${why} • **unbanned**${unbannedBy ? ` by <@${unbannedBy}>` : ''}${unbannedAt ? ` ${ts(unbannedAt)}` : ''}`;
}

function banSection(entry) {
  const unbanned = Boolean(entry.unbannedAt || entry.unbannedBy);
  return new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(truncate(banLine(entry), 3900)))
    .setButtonAccessory(
      new ButtonBuilder()
        .setCustomId(`oj:unban:${entry.userId}`)
        .setLabel(unbanned ? 'Unbanned' : 'Unban')
        .setEmoji(unbanned ? '✅' : '🔓')
        .setStyle(unbanned ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(unbanned),
    );
}

const listMessage = (entry) => ({ flags: MessageFlags.IsComponentsV2, components: [banSection(entry)], allowedMentions: { parse: [] } });

/** Makes sure the ban list channel exists. Only roles that can ban (and admins) can see it. */
function ensureChannel(guild) {
  return exclusive(guild.id, async () => {
    const settings = store.guild(guild.id);
    const existing = settings.banList.channelId ? guild.channels.cache.get(settings.banList.channelId) : null;
    if (existing) return existing;

    const me = guild.members.me;
    if (!me?.permissions.has([P.ManageChannels, P.ViewAuditLog])) {
      const problem = `I need permission to make the **#${config.banList.channelName}** channel and read the audit log. ${PERMISSION_FIX}`;
      throw Object.assign(new Error(problem), { friendly: problem });
    }

    const admins = guild.roles.cache.filter((r) => !r.managed && r.id !== guild.id && r.permissions.any([P.Administrator, P.BanMembers]));
    const channel = await guild.channels.create({
      name: config.banList.channelName,
      type: ChannelType.GuildText,
      topic: 'Everyone who is banned, newest at the bottom. Admins only.',
      reason: 'O Jailbreak: ban list',
      permissionOverwrites: [
        { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
        { id: me.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks] },
        ...admins.map((r) => ({ id: r.id, type: OverwriteType.Role, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages] })),
      ],
    });
    settings.banList.channelId = channel.id;
    store.save();
    await channel
      .send({
        flags: MessageFlags.IsComponentsV2,
        components: [new TextDisplayBuilder().setContent('🔨 **Ban list** — everyone banned from this server. Press **Unban** on a line to undo a ban (it asks you to confirm first).')],
      })
      .catch(() => {});
    return channel;
  });
}

/** Called at startup and from /setup: creates the channel ahead of time, and says how to fix it if it can't. */
async function prepare(guild, { tellModLog = true, retries = 0, retryDelayMs = 60_000 } = {}) {
  if (!config.banList.enabled) return { ok: false, text: 'The ban list is switched off in config.js.' };
  try {
    return { ok: true, channel: await ensureChannel(guild) };
  } catch (err) {
    const text = explain(err);
    if (isTemporary(err)) {
      console.warn(`[ban-list] ${guild.name}: couldn't set up the ban list yet (${err.message}).`);
      if (retries > 0) setTimeout(() => prepare(guild, { tellModLog, retries: retries - 1, retryDelayMs }), retryDelayMs).unref?.();
      return { ok: false, text };
    }
    console.warn(`[ban-list] ${guild.name}: couldn't set up the ban list: ${err.message}`);
    if (tellModLog) {
      const log = await fetchLogChannel(guild);
      await log?.send({ content: `⚠️ **The ban list isn’t set up.** ${text}`, allowedMentions: { parse: [] } }).catch(() => {});
    }
    return { ok: false, text };
  }
}

/** Adds a line for a ban (does nothing if it's already listed). */
async function addBan(guild, { userId, userTag, reason, moderatorId, at = Date.now() }) {
  if (!config.banList.enabled) return null;
  const settings = store.guild(guild.id);
  const existing = settings.banList.entries[userId];
  if (existing && !existing.unbannedAt) return null;

  let channel;
  try {
    channel = await ensureChannel(guild);
  } catch (err) {
    console.warn(`[ban-list] ${guild.name}: ${explain(err)}`);
    return null;
  }

  const entry = { userId, userTag, reason, moderatorId, at };
  const message = await channel.send(listMessage(entry)).catch((err) => {
    console.warn(`[ban-list] ${guild.name}: couldn't add ${userTag ?? userId}: ${err.message}`);
    return null;
  });
  if (!message) return null;
  settings.banList.entries[userId] = { ...entry, messageId: message.id };
  store.save();
  return message;
}

/** Crosses a line out once someone is unbanned. */
async function markUnbanned(guild, userId, { byId = null, at = Date.now() } = {}) {
  const settings = store.guild(guild.id);
  const entry = settings.banList.entries[userId];
  if (!entry || entry.unbannedAt) return false;

  entry.unbannedBy = byId;
  entry.unbannedAt = at;
  store.save();

  const channel = settings.banList.channelId ? guild.channels.cache.get(settings.banList.channelId) : null;
  const message = entry.messageId ? await channel?.messages.fetch(entry.messageId).catch(() => null) : null;
  await message?.edit(listMessage(entry)).catch(() => {});
  return true;
}

/** Adds every ban Discord knows about that isn't on the list yet. */
async function syncBans(guild) {
  const settings = store.guild(guild.id);
  const bans = await guild.bans.fetch({ limit: 1000 }).catch(() => null);
  if (!bans) return { ok: false, text: '❌ I couldn’t read the ban list from Discord. Do I have the **Ban Members** permission?' };

  const missing = [...bans.values()].filter((ban) => !settings.banList.entries[ban.user.id] || settings.banList.entries[ban.user.id].unbannedAt);
  for (const ban of missing.slice(0, MAX_SYNC)) {
    await addBan(guild, { userId: ban.user.id, userTag: ban.user.tag, reason: ban.reason ?? 'No reason given (banned before I was here)', moderatorId: null, at: null });
  }
  const added = Math.min(missing.length, MAX_SYNC);
  const more = missing.length > MAX_SYNC ? ` (${missing.length - MAX_SYNC} more — run it again to carry on)` : '';
  return { ok: true, text: added ? `✅ Added ${added} ban(s) to the list${more}.` : '✅ The ban list is already up to date.' };
}

// ----- buttons -----

const confirmRow = (userId) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`oj:unban-yes:${userId}`).setEmoji('🔓').setLabel('Yes, unban them').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('oj:unban-no').setEmoji('✖️').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

async function unbanButton(interaction, action, userId) {
  if (action === 'unban-no') return reply(interaction, '👍 Left them banned.', []);
  if (!canBan(interaction) || require('./modGuard').isLimitedMod(interaction.member)) return reply(interaction, '🚫 Only admins with the **Ban Members** permission can unban people.');

  const { guild } = interaction;
  const entry = store.guild(guild.id).banList.entries[userId];
  if (action === 'unban') {
    const name = entry?.userTag ? `**${entry.userTag}** (\`${userId}\`)` : `\`${userId}\``;
    return reply(interaction, `🔓 Unban ${name}? They'll be able to rejoin with an invite.`, [confirmRow(userId)]);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const banned = await guild.bans.fetch(userId).catch(() => null);
  if (!banned) {
    await markUnbanned(guild, userId, { byId: interaction.user.id });
    return reply(interaction, 'ℹ️ They weren’t banned any more, so I’ve crossed them off the list.');
  }
  try {
    await guild.bans.remove(userId, truncate(`O Jailbreak • unbanned by ${interaction.user.tag}`, 512));
  } catch (err) {
    return reply(interaction, `❌ Couldn't unban them: ${explain(err)}`);
  }
  await markUnbanned(guild, userId, { byId: interaction.user.id });
  const log = await fetchLogChannel(guild);
  await log?.send({ content: `🔓 <@${interaction.user.id}> unbanned <@${userId}> (\`${userId}\`) from the ban list.`, allowedMentions: { parse: [] } }).catch(() => {});
  return reply(interaction, `✅ Unbanned <@${userId}>.`);
}

// ----- events -----

// Bans and unbans done anywhere (by O Jailbreak, or by an admin in Discord itself) show up on the list.
async function onAuditLogEntry(entry, guild) {
  if (!config.banList.enabled) return;
  const { targetId, executorId } = entry;
  if (!targetId) return;

  if (entry.action === AuditLogEvent.MemberBanAdd) {
    const user = entry.target ?? (await guild.client.users.fetch(targetId).catch(() => null));
    await addBan(guild, { userId: targetId, userTag: user?.tag ?? null, reason: entry.reason ?? 'No reason given', moderatorId: executorId ?? null });
  } else if (entry.action === AuditLogEvent.MemberBanRemove) {
    await markUnbanned(guild, targetId, { byId: executorId ?? null });
  }
}

// If the audit log entry doesn't arrive, the ban still gets listed a moment later.
async function onBanAdd(ban) {
  if (!config.banList.enabled) return;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const settings = store.guild(ban.guild.id);
  const listed = settings.banList.entries[ban.user.id];
  if (listed && !listed.unbannedAt) return;
  const full = ban.partial ? await ban.fetch().catch(() => ban) : ban;
  await addBan(ban.guild, { userId: ban.user.id, userTag: ban.user.tag, reason: full?.reason ?? 'No reason given', moderatorId: null });
}

async function onBanRemove(ban) {
  if (!config.banList.enabled) return;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await markUnbanned(ban.guild, ban.user.id);
}

module.exports = { prepare, ensureChannel, addBan, markUnbanned, syncBans, unbanButton, onAuditLogEntry, onBanAdd, onBanRemove };
