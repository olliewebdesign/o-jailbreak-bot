'use strict';

// Builds and posts the mod-log message for a case: proof embed, evidence file and review buttons.

const { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const store = require('./store');
const { codeBlock, truncate, ts } = require('./util');

const TYPES = {
  SLUR: { emoji: '🤬', color: 0xe02424 },
  WORD: { emoji: '🚫', color: 0xe02424 },
  PROMO: { emoji: '📢', color: 0xf59e0b },
  SPAM: { emoji: '🌊', color: 0xeab308 },
  PROMPT: { emoji: '📺', color: 0x3b8cff },
  ACCUSE: { emoji: '🗣️', color: 0xe02424 },
  MANUAL: { emoji: '🛡️', color: 0x5865f2 },
  ANTINUKE: { emoji: '🚨', color: 0x991b1b },
  BOT: { emoji: '🤖', color: 0x991b1b },
  RESTRICT: { emoji: '🚷', color: 0x747f8d },
  STAFF: { emoji: '🛑', color: 0x991b1b },
};

const STATUS_COLORS = { UNMUTED: 0x22c55e, BANNED: 0x111827, KEPT: 0x6b7280, RESTRICTED: 0x747f8d, UNRESTRICTED: 0x22c55e };
const CLOSED_STATUSES = ['UNMUTED', 'BANNED', 'RESTRICTED', 'UNRESTRICTED'];

function statusText(c) {
  const by = c.resolvedBy ? ` by <@${c.resolvedBy}> ${ts(c.resolvedAt)}` : '';
  const note = c.resolutionNote ? `\n${truncate(c.resolutionNote, 300)}` : '';
  switch (c.status) {
    case 'KEPT':
      return c.noMute ? `✅ **Reviewed — no mute**${by}` : `🔒 **Mute kept**${by}`;
    case 'UNMUTED':
      return `🔊 **Unmuted**${by}${note}`;
    case 'BANNED':
      return `🔨 **Banned**${by}${c.resolutionNote ? `\n**Reason:** ${truncate(c.resolutionNote, 400)}` : ''}`;
    case 'RESTRICTED':
      return `🚷 **Restricted instead**${by}${note}`;
    case 'UNRESTRICTED':
      return `🔓 **Unrestricted**${by}${note}`;
    default:
      if (c.type === 'RESTRICT') return '🚷 **Restricted** — they can appeal in #restricted';
      return c.type === 'BOT' ? '⏳ **Waiting for a moderator**' : '⏳ **Waiting for a moderator to review**';
  }
}

function buildCaseEmbed(c) {
  const type = TYPES[c.type] ?? TYPES.MANUAL;
  const embed = new EmbedBuilder()
    .setColor(STATUS_COLORS[c.status] ?? type.color)
    .setTitle(truncate(`${type.emoji} Case #${c.id} — ${c.label}`, 256))
    .setFooter({ text: `Case #${c.id} • User ID ${c.userId}` })
    .setTimestamp(c.createdAt);

  if (c.avatarUrl) embed.setThumbnail(c.avatarUrl);

  const description = [];
  if (c.summary) description.push(truncate(c.summary, 800));
  if (c.excerpt != null) {
    description.push(c.type === 'MANUAL' ? '**Their message (proof):**' : '**What they said (proof):**');
    description.push(codeBlock(c.excerpt, 1500));
    if (c.excerptTruncated) description.push('*Message was cut short here — the full text is in the evidence file.*');
  }
  if (description.length) embed.setDescription(description.join('\n'));

  const fields = [
    { name: c.type === 'BOT' ? 'Bot' : 'User', value: truncate(`<@${c.userId}>\n\`${c.userTag}\``, 1024), inline: true },
  ];
  if (c.channelId) fields.push({ name: 'Channel', value: `<#${c.channelId}>`, inline: true });
  if (c.moderatorId) fields.push({ name: c.type === 'RESTRICT' ? 'Restricted by' : 'Muted by', value: `<@${c.moderatorId}>`, inline: true });
  if (c.addedBy) fields.push({ name: 'Added by', value: `<@${c.addedBy}>`, inline: true });

  fields.push({ name: ['MANUAL', 'RESTRICT'].includes(c.type) ? 'Reason' : 'Why', value: truncate(c.trigger || 'Unknown', 1024) });
  if (c.details?.length) fields.push({ name: 'What happened', value: truncate(c.details.join('\n'), 1024) });
  fields.push({ name: 'Action taken', value: truncate(c.actionNote || 'None', 1024) });

  if (c.accountCreatedAt) fields.push({ name: 'Account created', value: ts(c.accountCreatedAt), inline: true });
  if (c.joinedAt) fields.push({ name: 'Joined server', value: ts(c.joinedAt), inline: true });
  if (c.priorCases?.length) {
    fields.push({ name: `Previous cases (${c.priorCases.length})`, value: truncate(c.priorCases.join('\n'), 1024), inline: true });
  }

  fields.push({ name: 'Status', value: statusText(c) });
  return embed.addFields(fields);
}

function buildCaseButtons(c) {
  const closed = CLOSED_STATUSES.includes(c.status);
  const button = (action, style, emoji, label, disabled) =>
    new ButtonBuilder().setCustomId(`oj:${action}:${c.id}`).setStyle(style).setEmoji(emoji).setLabel(label).setDisabled(disabled);

  let buttons;
  if (c.type === 'RESTRICT') {
    buttons = [button('unrestrict', ButtonStyle.Success, '🔓', 'Unrestrict', closed)];
  } else if (c.type === 'STAFF') {
    buttons = [button('unmute', ButtonStyle.Success, '🔊', 'Unmute', closed), button('keep', ButtonStyle.Secondary, '🔒', 'Keep Muted', closed || c.status === 'KEPT')];
  } else if (c.type === 'BOT') {
    buttons = [button('ban', ButtonStyle.Danger, '🔨', 'Ban Bot', closed)];
  } else if (c.noMute) {
    // Deleted and logged but not muted: the moderator decides.
    buttons = [
      button('mute', ButtonStyle.Danger, '🔇', 'Mute', closed),
      button('restrict', ButtonStyle.Primary, '🚷', 'Restrict', closed),
      button('ban', ButtonStyle.Danger, '🔨', 'Ban (admins)', closed),
      button('keep', ButtonStyle.Secondary, '✅', 'No action', closed || c.status === 'KEPT'),
    ];
  } else {
    buttons = [button('unmute', ButtonStyle.Success, '🔊', c.strippedRoles?.length ? 'Unmute + Give Roles Back' : 'Unmute', closed)];
    // Moderators can't ban; restricting is their stronger option. (Not for anti-nuke cases.)
    if (c.type !== 'ANTINUKE') buttons.push(button('restrict', ButtonStyle.Primary, '🚷', 'Restrict', closed));
    buttons.push(
      button('ban', ButtonStyle.Danger, '🔨', 'Ban (admins)', closed),
      button('keep', ButtonStyle.Secondary, '🔒', 'Keep Muted', closed || c.status === 'KEPT'),
    );
  }
  return [new ActionRowBuilder().addComponents(buttons)];
}

function formatMessageLine(m, flagged = false) {
  const time = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
  const files = [...(m.attachments?.values() ?? [])].map((a) => a.url);
  const text = (m.content || '').replace(/\r?\n/g, '\n    ');
  const line = `[${time}] ${m.author?.tag ?? 'unknown'} (${m.author?.id ?? '?'}): ${text}${files.length ? ` [files: ${files.join(' ')}]` : ''}`;
  return flagged ? `>>> ${line}   <<< FLAGGED` : `    ${line}`;
}

/**
 * Plain-text evidence file attached to the log, with the full message and the chat around it.
 */
function buildEvidenceFile(c, { guild, channelName, fullContent, flaggedMessage, context = [], extra = [] }) {
  const plain = (s) => String(s ?? '').replace(/\*\*|`/g, '').replace(/<t:(\d+):\w>/g, (_, sec) => new Date(sec * 1000).toISOString());
  const lines = [
    `O JAILBREAK — CASE #${c.id} EVIDENCE`,
    '='.repeat(48),
    `Server:      ${guild.name} (${guild.id})`,
    `User:        ${c.userTag} (${c.userId})`,
    `Rule:        ${c.label}`,
    `Why:         ${plain(c.trigger)}`,
    `Time (UTC):  ${new Date(c.createdAt).toISOString()}`,
  ];
  if (c.channelId) lines.push(`Channel:     #${channelName ?? 'unknown'} (${c.channelId})`);
  if (c.messageId) lines.push(`Message ID:  ${c.messageId}`);
  if (c.moderatorId) lines.push(`Muted by:    ${c.moderatorTag ?? c.moderatorId}`);
  lines.push(`Action:      ${plain(c.actionNote).replace(/\n/g, ' | ')}`, '');

  lines.push('----- FLAGGED MESSAGE -----', fullContent || '(no text)', '');

  if (flaggedMessage?.attachments?.size) {
    lines.push('----- ATTACHMENTS -----');
    for (const a of flaggedMessage.attachments.values()) lines.push(`${a.name} (${a.size} bytes) ${a.url}`);
    lines.push('(Copies are attached to the log message when they were small enough to re-upload.)', '');
  }

  if (extra.length) {
    lines.push('----- OTHER MESSAGES REMOVED -----');
    for (const e of extra) lines.push(`[${new Date(e.at).toISOString()}] #${e.channelId}: ${e.content || '(no text)'}`);
    lines.push('');
  }

  if (context.length || flaggedMessage) {
    lines.push(`----- CHAT BEFORE IT (last ${context.length} messages) -----`);
    for (const m of context) lines.push(formatMessageLine(m));
    if (flaggedMessage) lines.push(formatMessageLine(flaggedMessage, true));
  }

  return new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), { name: `case-${c.id}-evidence.txt` });
}

async function fetchLogChannel(guild) {
  const { logChannelId } = store.guild(guild.id);
  if (!logChannelId) return null;
  const channel = await guild.channels.fetch(logChannelId).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

/**
 * Posts a case to the mod log. Returns the log message, or null if it couldn't be posted.
 */
async function postCaseLog(guild, c, { files = [], ping = null } = {}) {
  const channel = await fetchLogChannel(guild);
  if (!channel) return null;

  const payload = {
    content: ping?.content,
    embeds: [buildCaseEmbed(c)],
    components: buildCaseButtons(c),
    files,
    allowedMentions: ping?.allowedMentions ?? { parse: [] },
  };

  let message = await channel.send(payload).catch((err) => {
    console.error(`[mod-log] Couldn't post case #${c.id} in ${guild.name}: ${err.message}`);
    return null;
  });
  if (!message && files.length > 1) {
    // Usually an attachment over the upload limit: retry with just the evidence text file.
    message = await channel.send({ ...payload, files: files.slice(0, 1) }).catch(() => null);
  }
  if (message) store.updateCase(guild.id, c.id, { logChannelId: channel.id, logMessageId: message.id });
  return message;
}

// Re-draws the log message after a moderator acts on the case.
async function refreshCaseLog(guild, c) {
  if (!c.logChannelId || !c.logMessageId) return;
  const channel = await guild.channels.fetch(c.logChannelId).catch(() => null);
  const message = await channel?.messages?.fetch(c.logMessageId).catch(() => null);
  if (!message) return;
  await message
    .edit({ embeds: [buildCaseEmbed(c)], components: buildCaseButtons(c) })
    .catch((err) => console.error(`[mod-log] Couldn't update case #${c.id}: ${err.message}`));
}

module.exports = { TYPES, CLOSED_STATUSES, buildCaseEmbed, buildCaseButtons, buildEvidenceFile, postCaseLog, refreshCaseLog, fetchLogChannel };
