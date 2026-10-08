'use strict';

// Lockdown: when a nuke or raid is caught (and auto-lockdown is armed), hide every channel from members,
// open an alert channel with an "Alert the Owner" button, and DM the owner an Unlock button.
// The owner arms or pauses auto-lockdown from a control panel in their DMs.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../config');
const store = require('./store');
const { fetchLogChannel } = require('./caseLog');
const { exclusive, inBatches, truncate, ts } = require('./util');

const VIEW = PermissionFlagsBits.ViewChannel;
const PAUSED_FOREVER = -1;
const PAUSED_OFFER_COOLDOWN_MS = 10 * 60_000;

const raidHits = new Map(); // guildId -> Map<userId, time they were last caught>
const lastOwnerAlert = new Map(); // guildId -> time "Alert the Owner" was last pressed
const lastPausedOffer = new Map(); // guildId -> time we last DMed "auto-lockdown is paused"

function button(customId, emoji, label, style, disabled = false) {
  return new ButtonBuilder().setCustomId(customId).setEmoji(emoji).setLabel(label).setStyle(style).setDisabled(disabled);
}

// ----- armed / paused -----

function armedState(settings) {
  const until = settings.lockdown.pausedUntil;
  if (until === null) return { armed: true };
  if (until === PAUSED_FOREVER) return { armed: false, forever: true };
  if (Date.now() >= until) {
    settings.lockdown.pausedUntil = null;
    store.save();
    return { armed: true };
  }
  return { armed: false, until };
}

function arm(settings) {
  settings.lockdown.pausedUntil = null;
  store.save();
}

// hours = 0 means "until I arm it again".
function pause(settings, hours) {
  settings.lockdown.pausedUntil = hours > 0 ? Date.now() + hours * 3_600_000 : PAUSED_FOREVER;
  store.save();
}

function statusLine(settings) {
  if (settings.lockdown.active) return `🔒 **Locked right now** (since ${ts(settings.lockdown.startedAt)})`;
  const state = armedState(settings);
  if (state.armed) return '🟢 **Armed** — I’ll lock the server if I catch a nuke or a raid.';
  if (state.forever) return '⏸️ **Paused** until you arm it again.';
  return `⏸️ **Paused** — arms itself again ${ts(state.until)}.`;
}

function panelMessage(guild) {
  const settings = store.guild(guild.id);
  const { armed } = armedState(settings);
  const locked = settings.lockdown.active;

  const embed = new EmbedBuilder()
    .setColor(locked ? 0x991b1b : armed ? 0x22c55e : 0x6b7280)
    .setTitle(truncate(`🛡️ Auto-lockdown · ${guild.name}`, 256))
    .setDescription(
      [
        statusLine(settings),
        '',
        'Pause it while you’re online. Arm it before you go offline.',
        'While paused, nukes are still stopped and logged — channels just won’t be hidden.',
      ].join('\n'),
    )
    .setFooter({ text: 'Tip: pin this message so it’s easy to find.' });

  const rows = [
    new ActionRowBuilder().addComponents(
      button(`ojdm:arm:${guild.id}`, '🟢', 'Arm', ButtonStyle.Success, armed),
      button(`ojdm:pause:${guild.id}:1`, '⏸️', 'Pause 1h', ButtonStyle.Secondary),
      button(`ojdm:pause:${guild.id}:8`, '⏸️', 'Pause 8h', ButtonStyle.Secondary),
      button(`ojdm:pause:${guild.id}:0`, '⏸️', 'Pause until I arm it', ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      button(`ojdm:lock:${guild.id}`, '🔒', 'Lock Now', ButtonStyle.Danger, locked),
      button(`ojdm:unlock:${guild.id}`, '🔓', 'Unlock', ButtonStyle.Primary, !locked),
    ),
  ];
  return { embeds: [embed], components: rows };
}

async function sendPanel(guild, user) {
  return user.send(panelMessage(guild)).then(
    () => true,
    () => false,
  );
}

// ----- locking -----

function lockableChannels(guild, settings) {
  return [...guild.channels.cache.values()].filter(
    (ch) => ch.permissionOverwrites && ch.id !== settings.logChannelId && ch.id !== settings.lockdown.alertChannelId,
  );
}

function saveOverwrites(channel) {
  return channel.permissionOverwrites.cache.map((o) => ({
    id: o.id,
    type: o.type,
    allow: o.allow.bitfield.toString(),
    deny: o.deny.bitfield.toString(),
  }));
}

// Everyone loses View Channel. Admins can always see everything, and staff channels your mod role
// was already allowed into stay visible to mods.
function hiddenOverwrites(channel, guild, settings) {
  const next = channel.permissionOverwrites.cache.map((o) => ({
    id: o.id,
    type: o.type,
    allow: o.id === settings.modRoleId ? o.allow.bitfield : o.allow.bitfield & ~VIEW,
    deny: o.id === guild.id ? o.deny.bitfield | VIEW : o.deny.bitfield,
  }));
  if (!channel.permissionOverwrites.cache.has(guild.id)) {
    next.push({ id: guild.id, type: OverwriteType.Role, allow: 0n, deny: VIEW });
  }
  return next;
}

function alertChannelMessage(reason) {
  const embed = new EmbedBuilder()
    .setColor(0x991b1b)
    .setTitle('🔒 This server is locked')
    .setDescription(
      [
        'O Jailbreak spotted something suspicious, so every channel is hidden for now to keep everyone safe.',
        '',
        `**Why:** ${truncate(reason, 500)}`,
        '',
        'The owner has been told, and the channels will come back as soon as it’s safe.',
        'If it’s urgent, press **Alert the Owner**.',
      ].join('\n'),
    )
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    button('oj:lockdown-alert', '🚨', 'Alert the Owner', ButtonStyle.Danger),
    button('oj:lockdown-unlock', '🔓', 'Unlock (owner only)', ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

async function createAlertChannel(guild, reason) {
  const channel = await guild.channels.create({
    name: config.lockdown.alertChannelName,
    type: ChannelType.GuildText,
    position: 0,
    reason: 'O Jailbreak lockdown',
    permissionOverwrites: [
      {
        id: guild.id,
        type: OverwriteType.Role,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.CreatePrivateThreads,
          PermissionFlagsBits.SendMessagesInThreads,
        ],
      },
    ],
  });
  await channel.send(alertChannelMessage(reason));
  return channel;
}

function lockedEmbed(guild, { reason, lockedBy, hidden, failed }) {
  const lines = [
    `**Server:** ${guild.name}`,
    `**Why:** ${truncate(reason, 500)}`,
    `**Locked by:** ${lockedBy ? `<@${lockedBy}>` : 'O Jailbreak (automatic)'}`,
    `**Channels hidden:** ${hidden}`,
  ];
  if (failed.length) lines.push(`⚠️ **Couldn't hide ${failed.length}:** ${truncate(failed.join(', '), 600)}`);
  lines.push('', 'Press **Unlock Server** when it’s safe. Every channel goes back exactly how it was.');
  return new EmbedBuilder().setColor(0x991b1b).setTitle('🔒 Lockdown active').setDescription(lines.join('\n')).setTimestamp();
}

function unlockRow(guildId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    button(`ojdm:unlock:${guildId}`, '🔓', disabled ? 'Unlocked' : 'Unlock Server', ButtonStyle.Success, disabled),
  );
}

async function modLogPing(guild, settings, payload) {
  const log = await fetchLogChannel(guild);
  if (!log) return false;
  const roles = settings.modRoleId ? [settings.modRoleId] : [];
  const content = `${payload.content} <@${guild.ownerId}>${roles.map((id) => ` <@&${id}>`).join('')}`;
  return log
    .send({ ...payload, content, allowedMentions: { users: [guild.ownerId], roles } })
    .then(() => true, () => false);
}

/**
 * Hides every channel. lockedBy is the user ID for manual locks, or null when automatic.
 */
function lockServer(guild, { reason, lockedBy = null }) {
  return exclusive(guild.id, async () => {
    const settings = store.guild(guild.id);
    const ld = settings.lockdown;
    if (ld.active) return { ok: false, text: '🔒 The server is already locked.' };

    // 1. Save every channel's permissions to disk BEFORE touching anything, so they can always be restored.
    const channels = lockableChannels(guild, settings);
    const snapshot = Object.fromEntries(channels.map((ch) => [ch.id, saveOverwrites(ch)]));
    Object.assign(ld, { active: true, reason, startedAt: Date.now(), lockedBy, snapshot, alertChannelId: null, failed: [], dm: null });
    store.flush();

    // 2. Hide them.
    const auditReason = truncate(`O Jailbreak lockdown: ${reason}`, 512);
    const failed = [];
    await inBatches(channels, 5, async (ch) => {
      try {
        await ch.permissionOverwrites.set(hiddenOverwrites(ch, guild, settings), auditReason);
      } catch (err) {
        failed.push(`#${ch.name} (${err.message})`);
      }
    });
    ld.failed = failed;

    // 3. A channel everyone can see, explaining what's going on.
    const alert = await createAlertChannel(guild, reason).catch((err) => {
      console.error(`[lockdown] Couldn't create the alert channel in ${guild.name}: ${err.message}`);
      return null;
    });
    ld.alertChannelId = alert?.id ?? null;
    store.save();

    // 4. Tell the owner (DM with an Unlock button) and the mods.
    const info = { reason, lockedBy, hidden: channels.length - failed.length, failed };
    const embed = lockedEmbed(guild, info);
    const owner = await guild.fetchOwner().catch(() => null);
    const dm = await owner?.send({ content: '🚨 **Your server was locked down.**', embeds: [embed], components: [unlockRow(guild.id)] }).catch(() => null);
    if (dm) {
      ld.dm = { channelId: dm.channelId, messageId: dm.id };
      store.save();
    }
    await modLogPing(guild, settings, { content: '🔒 **Server locked.**', embeds: [embed] });

    console.warn(`[lockdown] ${guild.name}: locked (${reason})`);
    return { ok: true, text: `🔒 Locked the server — ${info.hidden} channel(s) hidden.${failed.length ? ` ⚠️ ${failed.length} couldn't be hidden.` : ''}` };
  });
}

/**
 * Puts every channel's permissions back exactly how they were, and removes the alert channel.
 */
function unlockServer(guild, user) {
  return exclusive(guild.id, async () => {
    const settings = store.guild(guild.id);
    const ld = settings.lockdown;
    if (!ld.active) return { ok: false, text: 'ℹ️ The server isn’t locked.' };

    const auditReason = truncate(`O Jailbreak lockdown lifted by ${user.tag}`, 512);
    const saved = Object.entries(ld.snapshot ?? {});
    const failed = [];

    await inBatches(saved, 5, async ([channelId, overwrites]) => {
      const channel = guild.channels.cache.get(channelId);
      if (!channel?.permissionOverwrites) return; // deleted while locked

      const restore = overwrites
        .filter((o) => o.type === OverwriteType.Member || guild.roles.cache.has(o.id))
        .map((o) => ({ id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }));
      try {
        await channel.permissionOverwrites.set(restore, auditReason);
      } catch {
        // Usually a member-specific permission for someone who has left: retry without them.
        const present = [];
        for (const o of restore) {
          if (o.type === OverwriteType.Role || (await guild.members.fetch(o.id).then(() => true, () => false))) present.push(o);
        }
        await channel.permissionOverwrites.set(present, auditReason).catch((err) => failed.push(`#${channel.name} (${err.message})`));
      }
    });

    if (ld.alertChannelId) await guild.channels.cache.get(ld.alertChannelId)?.delete(auditReason).catch(() => {});
    const dm = ld.dm;
    Object.assign(ld, { active: false, reason: null, startedAt: null, lockedBy: null, snapshot: null, alertChannelId: null, failed: [], dm: null });
    store.save();

    const restored = saved.length - failed.length;
    const text = `🔓 **Lockdown lifted** by <@${user.id}> — ${restored} channel(s) put back.${failed.length ? `\n⚠️ Couldn't restore: ${truncate(failed.join(', '), 800)}` : ''}`;
    const log = await fetchLogChannel(guild);
    await log?.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});

    if (dm) {
      const owner = await guild.client.users.fetch(guild.ownerId).catch(() => null);
      const channel = await owner?.createDM().catch(() => null);
      const message = await channel?.messages.fetch(dm.messageId).catch(() => null);
      await message?.edit({ content: `✅ **${guild.name} is unlocked.**`, components: [unlockRow(guild.id, true)] }).catch(() => {});
    }

    console.warn(`[lockdown] ${guild.name}: unlocked by ${user.tag}`);
    return { ok: true, text: `🔓 Unlocked — ${restored} channel(s) put back.${failed.length ? ` ⚠️ ${failed.length} couldn't be restored (listed in the mod log).` : ''}` };
  });
}

// ----- automatic triggers -----

async function autoLock(guild, reason) {
  const settings = store.guild(guild.id);
  if (settings.lockdown.active) return;

  if (armedState(settings).armed) {
    await lockServer(guild, { reason });
    return;
  }

  // Paused: don't hide anything, but give the owner a one-tap way to lock.
  const last = lastPausedOffer.get(guild.id) ?? 0;
  if (Date.now() - last < PAUSED_OFFER_COOLDOWN_MS) return;
  lastPausedOffer.set(guild.id, Date.now());
  const owner = await guild.fetchOwner().catch(() => null);
  await owner
    ?.send({
      content: `⚠️ **Suspicious activity in ${guild.name}**, but auto-lockdown is paused so I didn't hide the channels.\n**What happened:** ${truncate(reason, 500)}`,
      components: [new ActionRowBuilder().addComponents(button(`ojdm:lock:${guild.id}`, '🔒', 'Lock Server Now', ButtonStyle.Danger))],
    })
    .catch(() => {});
}

function onNuke(guild, reason) {
  if (!config.lockdown.onNuke) return Promise.resolve();
  return autoLock(guild, `Nuke attempt — ${reason}`);
}

// Called whenever automod mutes someone; lots of different people in a short time looks like a raid.
function recordRuleBreak(guild, userId) {
  const { raid } = config.lockdown;
  if (!raid.enabled) return;

  const now = Date.now();
  const hits = raidHits.get(guild.id) ?? new Map();
  hits.set(userId, now);
  for (const [id, at] of hits) if (now - at > raid.seconds * 1000) hits.delete(id);
  raidHits.set(guild.id, hits);

  if (hits.size >= raid.people) {
    const count = hits.size;
    raidHits.delete(guild.id);
    autoLock(guild, `Raid — ${count} different people broke the rules within ${raid.seconds} seconds`).catch((err) =>
      console.error('[lockdown] auto-lock failed:', err),
    );
  }
}

// ----- buttons -----

function reply(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } };
  if (interaction.inGuild()) payload.flags = MessageFlags.Ephemeral;
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

// "Alert the Owner" in the lockdown channel.
async function alertOwnerButton(interaction) {
  const { guild } = interaction;
  const settings = store.guild(guild.id);
  if (!settings.lockdown.active) return reply(interaction, 'ℹ️ The server isn’t locked any more.');

  const waitMs = config.lockdown.alertOwnerCooldownSeconds * 1000 - (Date.now() - (lastOwnerAlert.get(guild.id) ?? 0));
  if (waitMs > 0) return reply(interaction, `⏳ The owner was alerted a moment ago. You can alert them again ${ts(Date.now() + waitMs)}.`);
  lastOwnerAlert.set(guild.id, Date.now());

  const owner = await guild.fetchOwner().catch(() => null);
  const sent = await owner
    ?.send({
      content: `🚨 **${interaction.user.tag}** pressed **Alert the Owner** in **${guild.name}** — it's still locked.`,
      components: [unlockRow(guild.id)],
    })
    .then(() => true, () => false);
  if (!sent) await modLogPing(guild, settings, { content: `🚨 **${interaction.user.tag}** pressed Alert the Owner, but I couldn't DM the owner.` });
  return reply(interaction, sent ? '✅ The owner has been alerted.' : "⚠️ I couldn't DM the owner, so I pinged them in the mod log instead.");
}

// "Unlock (owner only)" in the lockdown channel.
async function unlockButton(interaction) {
  if (!store.isTrusted(interaction.guild, interaction.user.id)) {
    return reply(interaction, '🚫 Only the server owner (or someone they trust) can unlock the server.');
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await unlockServer(interaction.guild, interaction.user);
  // The alert channel this button was in is gone now, so this reply may not arrive — that's fine.
  await interaction.editReply(result.text).catch(() => {});
}

// Buttons in the owner's DMs: ojdm:<action>:<guildId>[:hours]
async function dmButton(interaction) {
  const [, action, guildId, hours] = interaction.customId.split(':');
  const guild = interaction.client.guilds.cache.get(guildId);
  if (!guild) return reply(interaction, "❌ I'm not in that server any more.");
  if (!store.isTrusted(guild, interaction.user.id)) return reply(interaction, '🚫 Only the server owner (or someone they trust) can do this.');

  const settings = store.guild(guild.id);
  const isPanel = interaction.message.components.some((row) => row.components.some((c) => c.customId?.startsWith('ojdm:arm:')));

  if (action === 'arm' || action === 'pause') {
    if (action === 'arm') arm(settings);
    else pause(settings, Number(hours));
    return interaction.update(panelMessage(guild));
  }

  await interaction.deferUpdate();
  const result =
    action === 'lock'
      ? await lockServer(guild, { reason: `Locked by ${interaction.user.tag} from their DMs`, lockedBy: interaction.user.id })
      : await unlockServer(guild, interaction.user);

  if (isPanel) await interaction.editReply(panelMessage(guild)).catch(() => {});
  else if (action === 'unlock' && result.ok) {
    await interaction.editReply({ content: `✅ **${guild.name} is unlocked.**`, embeds: [], components: [unlockRow(guild.id, true)] }).catch(() => {});
  } else if (action === 'lock' && result.ok) {
    await interaction.editReply({ components: [] }).catch(() => {});
  }
  return interaction.followUp({ content: result.text });
}

module.exports = {
  armedState,
  arm,
  pause,
  statusLine,
  panelMessage,
  sendPanel,
  lockServer,
  unlockServer,
  onNuke,
  recordRuleBreak,
  alertOwnerButton,
  unlockButton,
  dmButton,
};
