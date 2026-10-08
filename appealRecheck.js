'use strict';

// In the appeal ticket of someone restricted for a blocked server (anonymouse): a 🔄 Recheck button, for them or an admin.
// It checks whether they're still in that server — from their server list, if they've let the bot see it (a saved
// login) — and whether their profile still shows its tag or a blocked name, then posts the result in the ticket for
// both to see. With no saved login (people caught when they verified have theirs thrown away), the person themselves
// gets a one-time link to let the bot look at their server list again. The bot can only ever see WHICH servers someone
// is in, never anything inside them (messages, members) — Discord doesn't allow that.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const store = require('./store');
const blockedServers = require('./blockedServers');
const { truncate, ts } = require('./util');

const restrict = () => require('./restrict');
const verify = () => require('./verify');
const modGuard = () => require('./modGuard');

const COOLDOWN_MS = 30_000;
const pressedAt = new Map(); // `${guildId}:${userId}` -> last recheck (so the button can't be spammed)

const recheckRow = (userId) =>
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`oj:appeal-recheck:${userId}`).setStyle(ButtonStyle.Primary).setEmoji('🔄').setLabel('Recheck — still in the server?'));

/** Restricted for a blocked server (its tag, its invite, a blocked name, the blocklist, or found when they verified). */
function fromBlockedServer(settings, record) {
  return Boolean(record) && (Array.isArray(record.blockedServers) || record.reason === (config.blockedServers?.restrictReason || 'Please make a ticket'));
}

/** Posted in their ticket under the "leave that server" message. */
function recheckMessage(userId) {
  return {
    content: `Left the server? <@${userId}> (or an admin) can press **🔄 Recheck** and I’ll check straight away.\nУшли с сервера? Нажмите **🔄 Recheck**, и я сразу проверю.`,
    allowedMentions: { parse: [] },
    components: [recheckRow(userId)],
  };
}

/**
 * Checks someone now. `guildIds`: their server list if it's already known (just logged in), otherwise their saved login
 * is used. Returns { seen, inBlocked: [names], leftBlocked: [names], tag, name }.
 */
async function check(guild, userId, guildIds = null) {
  const settings = store.guild(guild.id);
  const record = settings.restricted[userId];
  const list = blockedServers.blockedList(settings);
  const ids = guildIds ?? (await verify().serverListOf(guild, userId));
  const theirs = record ? restrict().blockedServersFor(settings, record) : [];
  const inBlocked = ids ? Object.entries(list).filter(([id]) => ids.includes(id)).map(([, e]) => e.name) : [];
  const leftBlocked = ids ? theirs.filter((s) => !ids.includes(s.id)).map((s) => s.name) : [];
  const user = await guild.client.users.fetch(userId, { force: true }).catch(() => null);
  const member = await guild.members.fetch(userId).catch(() => null);
  const tag = user ? blockedServers.wearingBlockedTag(settings, user) : null;
  const name = member ? blockedServers.usingBlockedName(settings, member, user ?? member.user) : null;
  return { seen: Boolean(ids), inBlocked, leftBlocked, tag, name };
}

function resultEmbed(userId, r) {
  const lines = [];
  if (r.seen) {
    for (const name of r.inBlocked) lines.push(`❌ **Still in ${truncate(name, 80)}**`);
    for (const name of r.leftBlocked) lines.push(`✅ Not in **${truncate(name, 80)}** any more`);
    if (!r.inBlocked.length && !r.leftBlocked.length) lines.push('✅ Not in any blocked server');
  } else {
    lines.push(`❔ I can’t see their server list — they haven’t let me, or took it back. <@${userId}>: press **🔄 Recheck** yourself and I’ll show you how.`);
  }
  lines.push(r.tag ? `❌ Still wearing the **${truncate(r.tag.tag ?? '?', 20)}** tag of **${truncate(r.tag.name, 80)}**` : '✅ Not wearing a blocked server’s tag');
  lines.push(r.name ? `❌ Still using the name **${truncate(r.name.name, 40)}** (“${truncate(r.name.shown, 40)}”)` : '✅ Name is fine');
  const clear = r.seen && !r.inBlocked.length && !r.tag && !r.name;
  const verdict = clear ? '✅ **Looks like they’ve left.** An admin can press 🔓 Unrestrict.' : r.seen || r.tag || r.name ? '❌ **Not yet.**' : '❔ **Can’t tell yet.**';
  return new EmbedBuilder()
    .setColor(clear ? 0x22c55e : r.seen || r.tag || r.name ? 0xed4245 : 0x747f8d)
    .setTitle('🔄 Recheck')
    .setDescription([`<@${userId}> — checked ${ts(Date.now())}`, '', ...lines, '', verdict].join('\n'))
    .setFooter({ text: 'I can only see which servers someone is in — never anything inside them.' });
}

/** The 🔄 Recheck button in an appeal ticket: the person themselves, or an admin. */
async function recheckButton(interaction, userId) {
  const { guild } = interaction;
  const settings = store.guild(guild.id);
  const self = interaction.user.id === userId;
  if (!self && !modGuard().isAdmin(interaction.member)) {
    return interaction.reply({ content: '🚫 Only they or an admin can recheck.', flags: MessageFlags.Ephemeral });
  }
  if (!settings.restricted[userId]) return interaction.reply({ content: 'ℹ️ They’re not restricted any more.', flags: MessageFlags.Ephemeral });
  const key = `${guild.id}:${userId}`;
  const wait = (pressedAt.get(key) ?? 0) + COOLDOWN_MS - Date.now();
  if (wait > 0) return interaction.reply({ content: `⏳ Just checked — try again in ${Math.ceil(wait / 1000)} seconds.`, flags: MessageFlags.Ephemeral });
  pressedAt.set(key, Date.now());

  // Pressed by them, with no saved login: a one-time link to let me look at their server list.
  if (self && !(await verify().hasSavedLogin(guild, userId))) {
    const url = verify().recheckLink(guild, userId);
    if (!url) return interaction.reply({ content: '⚠️ Checking through Discord isn’t working right now. An admin can still press 🔄 Recheck to check your profile.', flags: MessageFlags.Ephemeral });
    return interaction.reply({
      content:
        'To check, I need to see your server list (only which servers you’re in — nothing inside them). Press the button, then **Authorize**. The result is posted here.\nЧтобы проверить, мне нужно увидеть список ваших серверов. Нажмите кнопку, затем **Authorize**.',
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Let me check').setURL(url))],
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferReply();
  const result = await check(guild, userId);
  return interaction.editReply({ embeds: [resultEmbed(userId, result)], allowedMentions: { parse: [] } });
}

/** They just authorized from the "Let me check" link: the result goes in their ticket. */
async function afterLogin(guild, userId, guildIds) {
  const record = store.guild(guild.id).restricted[userId];
  const channel = record?.ticketChannelId ? guild.channels.cache.get(record.ticketChannelId) : null;
  const result = await check(guild, userId, guildIds);
  await channel?.send({ embeds: [resultEmbed(userId, result)], allowedMentions: { parse: [] } }).catch(() => {});
  return result;
}

/** At startup: appeal tickets for blocked servers opened before this version get the button too. */
async function addToOpenTickets(guild) {
  const settings = store.guild(guild.id);
  for (const [userId, record] of Object.entries(settings.restricted)) {
    if (record.recheckPosted || !record.ticketChannelId || !fromBlockedServer(settings, record)) continue;
    const channel = guild.channels.cache.get(record.ticketChannelId);
    if (!channel) continue;
    if (await channel.send(recheckMessage(userId)).then(() => true, () => false)) {
      record.recheckPosted = true;
      store.save();
    }
  }
}

module.exports = { recheckButton, recheckMessage, fromBlockedServer, check, resultEmbed, afterLogin, addToOpenTickets, _pressedAt: pressedAt };
