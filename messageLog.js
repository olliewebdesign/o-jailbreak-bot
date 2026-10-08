'use strict';

// Message logs in their own channel (config.js → logs.channelId): deleted messages (with what they said and who
// deleted them), edits (before and after), and bulk deletes (as a file).
//
// Discord only says *which* message was deleted, not what it said, so the bot remembers the last day of messages
// itself (in memory only, capped, never saved to disk).

const { AttachmentBuilder, AuditLogEvent, EmbedBuilder } = require('discord.js');
const config = require('../config');
const store = require('./store');
const { truncate, ts, who } = require('./util');

const KEEP_MS = 24 * 3_600_000;
const MAX_REMEMBERED = 20_000;
const recent = new Map(); // messageId -> { guildId, channelId, authorId, authorTag, avatar, content, attachments, at }

function logChannelFor(guild) {
  const id = config.logs?.channelId;
  const channel = id ? guild.channels.cache.get(id) : null;
  return channel?.isTextBased?.() ? channel : null;
}

// Messages in the log channel itself (or the mod log) aren't logged, so the bot never logs its own logging.
const skipChannel = (guild, channelId) => channelId === config.logs?.channelId || channelId === store.guild(guild.id).logChannelId;

/** Remembers a new message, so its text can be shown if it's deleted later. */
function remember(message) {
  if (!message.inGuild?.() || message.author?.bot || message.webhookId || !logChannelFor(message.guild)) return;
  recent.set(message.id, {
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.author.id,
    authorTag: message.author.tag ?? message.author.username,
    avatar: message.author.displayAvatarURL?.({ size: 64 }) ?? null,
    content: message.content ?? '',
    attachments: [...(message.attachments?.values() ?? [])].map((a) => ({ name: a.name, url: a.url })),
    at: message.createdTimestamp ?? Date.now(),
  });
  if (recent.size > MAX_REMEMBERED) {
    for (const [id, m] of recent) {
      if (recent.size <= MAX_REMEMBERED * 0.9 && Date.now() - m.at < KEEP_MS) break;
      recent.delete(id);
    }
  }
}

/** What we know about a message: from discord.js if it still has it, otherwise from our own memory. */
function details(message) {
  const saved = recent.get(message.id);
  if (!message.partial && message.author) {
    return {
      authorId: message.author.id,
      authorTag: message.author.tag ?? message.author.username,
      avatar: message.author.displayAvatarURL?.({ size: 64 }) ?? saved?.avatar ?? null,
      bot: message.author.bot,
      content: message.content ?? saved?.content ?? '',
      attachments: [...(message.attachments?.values() ?? [])].map((a) => ({ name: a.name, url: a.url })),
      at: message.createdTimestamp,
    };
  }
  return saved ? { ...saved, bot: false } : null;
}

/** Who deleted it, if it wasn't the author: Discord's audit log (only records deletions by someone else). */
async function deletedBy(guild, authorId, channelId) {
  await new Promise((resolve) => setTimeout(resolve, 1500)); // the audit log is written a moment after
  const logs = await guild.fetchAuditLogs?.({ type: AuditLogEvent.MessageDelete, limit: 6 }).catch(() => null);
  const entry = logs?.entries.find((e) => e.target?.id === authorId && e.extra?.channel?.id === channelId && Date.now() - e.createdTimestamp < 30_000);
  return entry?.executorId ?? null;
}

const fileList = (attachments) => attachments.map((a) => `[${truncate(a.name, 80)}](${a.url})`).join('\n');

async function onDelete(message) {
  const guild = message.guild;
  if (!guild || skipChannel(guild, message.channelId)) return;
  const log = logChannelFor(guild);
  if (!log) return;
  const m = details(message);
  recent.delete(message.id);
  if (m?.bot) return;

  const embed = new EmbedBuilder().setColor(0xed4245).setTitle('🗑️ Message deleted').setTimestamp();
  if (!m) {
    embed.setDescription(`A message in <#${message.channelId}> was deleted, but it was sent before I started remembering messages, so I don’t know what it said.`);
    return log.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
  }
  if (m.avatar) embed.setAuthor({ name: truncate(m.authorTag ?? m.authorId, 256), iconURL: m.avatar });
  embed.setDescription(m.content ? truncate(m.content, 4000) : '*(no text)*');
  const by = await deletedBy(guild, m.authorId, message.channelId);
  embed.addFields(
    { name: 'Author', value: who({ id: m.authorId, username: m.authorTag }), inline: true },
    { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
    { name: 'Sent', value: m.at ? ts(m.at) : 'Unknown', inline: true },
  );
  if (by && by !== m.authorId) embed.addFields({ name: 'Deleted by', value: `<@${by}>`, inline: true });
  if (m.attachments?.length) embed.addFields({ name: 'Attachments', value: truncate(fileList(m.attachments), 1024) });
  embed.setFooter({ text: `Message ID ${message.id} • User ID ${m.authorId}` });
  return log.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

async function onUpdate(oldMessage, newMessage) {
  const guild = newMessage.guild;
  if (!guild || skipChannel(guild, newMessage.channelId) || newMessage.author?.bot) return;
  const log = logChannelFor(guild);
  if (!log) return;
  const before = oldMessage.partial ? recent.get(newMessage.id)?.content : oldMessage.content;
  const after = newMessage.content;
  // Only real text changes (not link previews loading, pins, etc).
  if (before === undefined || after === undefined || before === after) {
    if (after !== undefined && recent.has(newMessage.id)) recent.get(newMessage.id).content = after;
    return;
  }
  if (recent.has(newMessage.id)) recent.get(newMessage.id).content = after;

  const author = newMessage.author;
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('✏️ Message edited')
    .setDescription(`[Jump to message](${newMessage.url})`)
    .addFields(
      { name: 'Before', value: truncate(before || '*(no text)*', 1024) },
      { name: 'After', value: truncate(after || '*(no text)*', 1024) },
      { name: 'Author', value: author ? who(author) : 'Unknown', inline: true },
      { name: 'Channel', value: `<#${newMessage.channelId}>`, inline: true },
    )
    .setFooter({ text: `Message ID ${newMessage.id}${author ? ` • User ID ${author.id}` : ''}` })
    .setTimestamp();
  if (author) embed.setAuthor({ name: truncate(author.tag ?? author.username, 256), iconURL: author.displayAvatarURL?.({ size: 64 }) });
  return log.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

async function onBulkDelete(messages, channel) {
  const guild = channel.guild;
  if (!guild || skipChannel(guild, channel.id)) return;
  const log = logChannelFor(guild);
  if (!log) return;
  const lines = [];
  for (const message of [...messages.values()].reverse()) {
    const m = details(message);
    recent.delete(message.id);
    if (!m) {
      lines.push(`[unknown time] (sent before I started remembering) — message ${message.id}`);
      continue;
    }
    const files = m.attachments?.length ? ` [files: ${m.attachments.map((a) => a.url).join(' ')}]` : '';
    lines.push(`[${m.at ? new Date(m.at).toISOString().replace('T', ' ').slice(0, 19) : '?'}] ${m.authorTag ?? '?'} (${m.authorId}): ${m.content || '(no text)'}${files}`);
  }
  const file = new AttachmentBuilder(Buffer.from(`Bulk delete in #${channel.name} (${channel.id})\n\n${lines.join('\n')}`, 'utf8'), { name: `bulk-delete-${channel.id}.txt` });
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('🧹 Messages bulk deleted')
    .setDescription(`**${messages.size}** messages were deleted in <#${channel.id}>. Everything I remember is in the file.`)
    .setTimestamp();
  return log.send({ embeds: [embed], files: [file], allowedMentions: { parse: [] } }).catch(() => {});
}

module.exports = { remember, onDelete, onUpdate, onBulkDelete, _recent: recent };
