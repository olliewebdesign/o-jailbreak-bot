'use strict';

const { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ThreadAutoArchiveDuration } = require('discord.js');
const config = require('../config');
const store = require('./store');
const { buildEvidenceFile, postCaseLog } = require('./caseLog');
const { TIMEOUT_MS, durationText, isTemporary, truncate, ts } = require('./util');

const MAX_PROOF_BYTES = 8 * 1024 * 1024; // stays under Discord's 10 MB upload limit with the evidence file
const MAX_PROOF_FILES = 8;
const EXCERPT_CHARS = 1500;
const REPEAT_WINDOW_MS = 60_000;

// Someone who fires off several bad messages at once gets one case; the extra messages are just deleted.
const recentlyPunished = new Map();

setInterval(() => {
  for (const [key, entry] of recentlyPunished) {
    if (Date.now() - entry.at > REPEAT_WINDOW_MS) recentlyPunished.delete(key);
  }
}, 60_000).unref();

// Message text plus anything they forwarded into the channel.
function messageText(message) {
  const parts = [message.content];
  // A poll's question and answers, and a forum post's title, are part of what they posted.
  if (message.poll) parts.push(message.poll.question?.text, ...[...(message.poll.answers?.values?.() ?? [])].map((a) => a?.text));
  if (message.channel?.isThread?.() && message.channel.id === message.id && message.channel.name) parts.push(message.channel.name);
  for (const snapshot of message.messageSnapshots?.values() ?? []) {
    if (snapshot.content) parts.push(`[forwarded] ${snapshot.content}`);
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * Deletes the message, trying again if Discord doesn't answer.
 * @returns {Promise<string | null>} null once it's gone, otherwise why it couldn't be deleted
 */
async function deleteMessage(message, { attempts = 3, delayMs = 1000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      await message.delete();
      return null;
    } catch (err) {
      if (err.code === 10008) return null; // Unknown Message: already gone
      if (isTemporary(err) && attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
        continue;
      }
      const reason =
        err.code === 50013 || err.code === 50001
          ? 'I’m missing the **Manage Messages** permission there (give O Jailbreak Administrator)'
          : truncate(err.message, 200);
      console.warn(`[automod] Couldn't delete a message in #${message.channel?.name ?? message.channelId}: ${err.message}`);
      return reason;
    }
  }
}

async function deleteEntries(guild, entries, skipId) {
  const byChannel = new Map();
  for (const e of entries) {
    if (e.id === skipId) continue;
    if (!byChannel.has(e.channelId)) byChannel.set(e.channelId, []);
    byChannel.get(e.channelId).push(e.id);
  }
  let deleted = 0;
  for (const [channelId, ids] of byChannel) {
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel?.isTextBased()) continue;
    if (ids.length === 1) {
      if (await channel.messages.delete(ids[0]).then(() => true, () => false)) deleted++;
    } else {
      const removed = await channel.bulkDelete(ids, true).catch(() => null);
      deleted += removed?.size ?? 0;
    }
  }
  return deleted;
}

async function fetchContext(message) {
  if (!config.contextMessages) return [];
  try {
    const earlier = await message.channel.messages.fetch({ limit: Math.min(config.contextMessages, 100), before: message.id });
    return [...earlier.values()].reverse();
  } catch {
    return [];
  }
}

// Re-upload the message's files, because Discord removes them once the message is deleted.
async function downloadAttachments(message) {
  const files = [];
  let total = 0;
  for (const attachment of message.attachments.values()) {
    if (files.length >= MAX_PROOF_FILES || total + attachment.size > MAX_PROOF_BYTES) continue;
    try {
      const res = await fetch(attachment.url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = Buffer.from(await res.arrayBuffer());
      total += data.length;
      const spoiler = attachment.name.startsWith('SPOILER_');
      const name = spoiler ? `SPOILER_proof-${attachment.name.slice(8)}` : `proof-${attachment.name}`;
      files.push(new AttachmentBuilder(data, { name }));
    } catch {
      // Proof copy failed; the evidence file still lists the original link.
    }
  }
  return files;
}

async function timeoutMember(member, reason, ms = TIMEOUT_MS) {
  if (!member) return { timedOut: false, note: '⚠️ Not timed out — they already left the server' };
  if (!member.moderatable) {
    return { timedOut: false, note: '⚠️ Not timed out — they are the owner/an admin, or their role is above mine' };
  }
  try {
    await member.timeout(ms, truncate(`O Jailbreak • ${reason}`, 512));
    const until = Date.now() + ms;
    return { timedOut: true, until, note: `🔇 Timed out for ${durationText(ms)} (ends ${ts(until)})` };
  } catch (err) {
    return { timedOut: false, note: `⚠️ Timeout failed: ${truncate(err.message, 200)}` };
  }
}

// `help` (optional) replaces the usual "the moderators have been sent what happened" with steps to follow,
// and adds a link button. It's always sent, even when dmUser is off, because the steps are the point.
async function dmUser(user, guild, c, timeoutMs, timedOut, help = null) {
  if (help ? false : !config.dmUser || !timedOut) return;
  const embed = new EmbedBuilder()
    .setColor(help ? 0x3b8cff : 0xe02424)
    .setTitle(truncate(`${timedOut ? 'You were muted' : 'Your message was removed'} in ${guild.name}`, 256))
    .setDescription(
      [
        `**Reason:** ${c.type === 'MANUAL' ? truncate(c.trigger, 500) : c.label}`,
        ...(timedOut ? [`**Length:** ${durationText(timeoutMs)} (ends ${ts(c.timeoutUntil)})`] : []),
        '',
        ...(help?.dmLines ?? ['The moderators have been sent what happened. If it was a mistake, they can unmute you early.']),
      ].join('\n'),
    )
    .setFooter({ text: `Case #${c.id}` })
    .setTimestamp();
  const components = help?.button
    ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(help.button.label).setURL(help.button.url))]
    : [];
  const payload = help ? { content: `<@${user.id}>`, embeds: [embed], components } : { embeds: [embed] };
  return user.send(payload).then(
    () => true,
    () => false, // DMs closed
  );
}

// Pings them in a private thread off the channel, so nobody else in the chat sees it (mods with Manage Threads can).
// Discord only allows "only you can see this" replies to slash commands, so a private thread is the closest thing.
async function postPrivateNotice(channel, user, timedOut, help) {
  // Private threads only exist in plain text channels (not in threads, forums or announcement channels): the DM covers those.
  if (channel?.type !== ChannelType.GuildText) return false;
  const thread = await channel.threads
    .create({
      name: truncate(`📺 ${user.username} — watch the guide`, 100),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      reason: 'O Jailbreak: sending someone to the video guide',
    })
    .catch(() => null);
  if (!thread) return false;
  await thread.members.add(user.id).catch(() => {});
  const sent = await thread.send({ content: help.notice(user.id, timedOut, help.dmSent), allowedMentions: { users: [user.id] } }).catch(() => null);
  if (!sent) {
    await thread.delete().catch(() => {});
    return false;
  }
  if (help.noticeMinutes > 0) setTimeout(() => thread.delete().catch(() => {}), help.noticeMinutes * 60_000).unref();
  return true;
}

async function postPublicNotice(channel, user, c, timedOut, timeoutMs) {
  if (!config.publicNotice || !channel?.isTextBased()) return;
  const content = timedOut
    ? `🔇 <@${user.id}> has been muted for ${durationText(timeoutMs)} (**${c.label}**). The moderators have been sent the proof.`
    : `🗑️ A message from <@${user.id}> was removed (**${c.label}**).`;
  const notice = await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
  if (notice && config.publicNoticeSeconds > 0) {
    setTimeout(() => notice.delete().catch(() => {}), config.publicNoticeSeconds * 1000).unref();
  }
}

/**
 * Deletes the offending message(s), times the user out and posts the case with proof to the mod log.
 * Returns null when the user was already dealt with moments ago.
 *
 * @param {object} opts
 * @param {import('discord.js').Guild} opts.guild
 * @param {import('discord.js').User} opts.user
 * @param {import('discord.js').GuildMember | null} opts.member
 * @param {'SLUR'|'WORD'|'ACCUSE'|'PROMO'|'SPAM'|'PROMPT'|'MANUAL'} opts.type
 * @param {string} opts.label - short rule name, e.g. "Racial slur"
 * @param {string} opts.trigger - what was detected, or the moderator's reason
 * @param {import('discord.js').Message} [opts.message] - the message that broke the rule
 * @param {Array<{ id: string, channelId: string, content: string, at: number }>} [opts.entries] - other spam messages
 * @param {import('discord.js').User} [opts.moderator] - set for manual mutes
 * @param {object} [opts.help] - steps to DM them and a ping to post instead of the usual notices (see filters/promptHelp)
 * @param {boolean} [opts.mute] - false = delete and log only; a moderator can press 🔇 Mute on the case
 */
async function muteAndLog({ guild, user, member, type, label, trigger, message = null, entries = [], moderator = null, timeoutMs = TIMEOUT_MS, summary = null, help = null, mute = true }) {
  const burstKey = `${guild.id}:${user.id}`;
  const previous = recentlyPunished.get(burstKey);
  const alreadyHandled = previous && Date.now() - previous.at < REPEAT_WINDOW_MS;

  // Just dealt with: the extra messages are only deleted. (After a delete-only case, something that does mute — spam,
  // adverts — still gets its own case and mute.)
  if (!moderator && ((alreadyHandled && (previous.muted || !mute)) || member?.isCommunicationDisabled())) {
    if (message) {
      previous?.extra.push({ at: Date.now(), channelId: message.channelId, content: messageText(message) });
      await deleteMessage(message);
    }
    if (entries.length > 1) await deleteEntries(guild, entries, message?.id);
    return null;
  }
  const burst = { at: Date.now(), extra: [], muted: mute };
  recentlyPunished.set(burstKey, burst);

  // 1. Copy any files first: Discord removes them once the message is deleted.
  const proofFiles = message ? await downloadAttachments(message) : [];

  // 2. Remove the offending message(s) straight away.
  const actions = [];
  if (message) {
    const problem = await deleteMessage(message);
    actions.push(problem ? `⚠️ Couldn't delete the message: ${problem}` : '🗑️ Message deleted');
  }
  if (entries.length > 1) {
    const deleted = await deleteEntries(guild, entries, message?.id);
    actions.push(`🗑️ ${deleted} other spam message(s) deleted`);
  }

  // 3. The chat just before it, for the proof (this still works now the message itself is gone).
  const context = message ? await fetchContext(message) : [];

  // 4. Open the case and time them out.
  const fullContent = message ? messageText(message) : null;
  const priorCases = store
    .casesForUser(guild.id, user.id)
    .slice(0, 5)
    .map((p) => `#${p.id} ${p.label} ${ts(p.createdAt)}`);

  const c = store.createCase(guild.id, {
    type,
    label,
    trigger,
    userId: user.id,
    userTag: user.tag,
    avatarUrl: user.displayAvatarURL({ size: 128 }),
    channelId: message?.channelId ?? null,
    messageId: message?.id ?? null,
    moderatorId: moderator?.id ?? null,
    moderatorTag: moderator?.tag ?? null,
    excerpt: fullContent === null ? null : truncate(fullContent, EXCERPT_CHARS),
    excerptTruncated: (fullContent?.length ?? 0) > EXCERPT_CHARS,
    accountCreatedAt: user.createdTimestamp,
    joinedAt: member?.joinedTimestamp ?? null,
    summary,
    priorCases,
    noMute: !mute,
  });

  const timeout = mute
    ? await timeoutMember(member, `Case #${c.id}: ${type === 'MANUAL' ? `muted by ${moderator.tag}` : label}`, timeoutMs)
    : { timedOut: false, note: '💬 Not muted — a moderator can press 🔇 Mute below' };
  store.updateCase(guild.id, c.id, {
    timedOut: timeout.timedOut,
    timeoutUntil: timeout.until ?? null,
    actionNote: [timeout.note, ...actions].join('\n'),
  });

  // Someone being sent to the guide is told privately first, so the mod log can say whether it reached them.
  if (help) {
    const dmSent = await dmUser(user, guild, c, timeoutMs, timeout.timedOut, help);
    const threadSent = message ? await postPrivateNotice(message.channel, user, timeout.timedOut, { ...help, dmSent }) : false;
    const notes = [
      !dmSent && '⚠️ Couldn’t DM them the guide (their DMs are closed)',
      threadSent ? '🔒 Pinged them in a private thread only they can see' : '⚠️ Couldn’t open a private thread for them here',
    ].filter(Boolean);
    store.updateCase(guild.id, c.id, { actionNote: [c.actionNote, ...notes].join('\n') });
  }

  // 5. Send it to the mod log with the evidence and review buttons.
  const evidence = buildEvidenceFile(c, {
    guild,
    channelName: message?.channel?.name,
    fullContent: fullContent ?? `(no message — muted with /mute by ${moderator?.tag})`,
    flaggedMessage: message,
    context,
    extra: [...entries.filter((e) => e.id !== message?.id), ...burst.extra],
  });
  const log = await postCaseLog(guild, c, { files: [evidence, ...proofFiles] });

  // 6. Tell the user, and the channel.
  if (!help) {
    await dmUser(user, guild, c, timeoutMs, timeout.timedOut);
    if (message) await postPublicNotice(message.channel, user, c, timeout.timedOut, timeoutMs);
  }

  return { case: c, timedOut: timeout.timedOut, note: timeout.note, logged: Boolean(log) };
}

module.exports = { muteAndLog, messageText, timeoutMember, deleteMessage, deleteEntries };
