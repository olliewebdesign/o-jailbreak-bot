'use strict';

// Levels: everyone earns XP for chatting, climbs levels, and can be handed roles automatically when they
// get there. Messages that broke a rule earn nothing, and neither do channels O Jailbreak ignores.

const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const store = require('./store');
const restrict = require('./restrict');
const { truncate } = require('./util');

const lastEarned = new Map(); // `${guildId}:${userId}` -> when they last earned XP

// The usual Discord-style curve: each level costs a little more than the last.
const stepFor = (level) => 5 * level * level + 50 * level + 100;

/** Level, how far into it they are, and how much that level costs. */
function levelFromXp(xp) {
  let level = 0;
  let left = Math.max(0, Math.floor(xp) || 0);
  let need = stepFor(0);
  while (left >= need) {
    left -= need;
    level += 1;
    need = stepFor(level);
  }
  return { level, into: left, need };
}

/** Total XP someone needs to reach a level from nothing. */
function xpForLevel(level) {
  let total = 0;
  for (let n = 0; n < level; n++) total += stepFor(n);
  return total;
}

const xpOf = (settings, userId) => settings.levels.xp[userId] ?? 0;

/** Everyone with XP, highest first. */
function ranking(settings) {
  return Object.entries(settings.levels.xp)
    .filter(([, xp]) => xp > 0)
    .sort((a, b) => b[1] - a[1]);
}

function rankOf(settings, userId) {
  const place = ranking(settings).findIndex(([id]) => id === userId);
  return place === -1 ? null : place + 1;
}

function progressBar(into, need, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round((into / Math.max(1, need)) * width)));
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`;
}

/** The roles someone should have for reaching this level (rewards stack, so earlier ones are kept). */
function rewardsUpTo(settings, level) {
  return Object.entries(settings.levels.rewards)
    .filter(([at]) => Number(at) <= level)
    .map(([, roleId]) => roleId);
}

async function giveRewards(member, settings, level) {
  const wanted = rewardsUpTo(settings, level).filter((roleId) => member.guild.roles.cache.get(roleId)?.editable && !member.roles.cache.has(roleId));
  if (!wanted.length) return [];
  // Restricted: a reward role could let them see channels again, so it's saved for when they're unrestricted.
  if (restrict.saveForLater(member.guild, member.id, wanted)) return [];
  try {
    await member.roles.add(wanted, `O Jailbreak: reached level ${level}`);
    return wanted;
  } catch (err) {
    console.warn(`[levels] ${member.guild.name}: couldn't give the level ${level} role(s) to ${member.user.tag}: ${err.message}`);
    return [];
  }
}

async function announce(message, member, level, gained, settings) {
  if (!settings.levels.announce) return;
  const unlocked = gained.length ? ` and unlocked ${gained.map((id) => `<@&${id}>`).join(' ')}` : '';
  const where = settings.levels.announceChannelId ? member.guild.channels.cache.get(settings.levels.announceChannelId) : message.channel;
  await where
    ?.send({ content: `🎉 <@${member.id}> is now **level ${level}**${unlocked}!`, allowedMentions: { users: [member.id] } })
    .catch(() => {});
}

/** Called for every message. Returns the new level when someone levels up. */
async function onMessage(message, { member = null } = {}) {
  const settings = store.guild(message.guildId);
  if (!settings.levels.enabled || message.author.bot) return null;

  const key = `${message.guildId}:${message.author.id}`;
  const now = Date.now();
  if (now - (lastEarned.get(key) ?? 0) < Math.max(0, config.levels.cooldownSeconds) * 1000) return null;
  lastEarned.set(key, now);

  const low = Math.max(1, Math.round(config.levels.minXp));
  const high = Math.max(low, Math.round(config.levels.maxXp));
  const before = levelFromXp(xpOf(settings, message.author.id)).level;
  settings.levels.xp[message.author.id] = xpOf(settings, message.author.id) + low + Math.floor(Math.random() * (high - low + 1));
  store.save();

  await updateBoard(message.guild).catch(() => {});

  const after = levelFromXp(xpOf(settings, message.author.id)).level;
  if (after <= before) return null;

  const who = member ?? message.member;
  if (who) {
    const gained = await giveRewards(who, settings, after);
    await announce(message, who, after, gained, settings);
  }
  return after;
}

/** The /rank card. */
function rankEmbed(guild, user, settings) {
  const xp = xpOf(settings, user.id);
  const { level, into, need } = levelFromXp(xp);
  const place = rankOf(settings, user.id);
  const next = rewardsUpTo(settings, 1000).length
    ? Object.entries(settings.levels.rewards)
        .map(([at, roleId]) => [Number(at), roleId])
        .sort((a, b) => a[0] - b[0])
        .find(([at]) => at > level)
    : null;

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: truncate(user.tag ?? user.username, 80), iconURL: user.displayAvatarURL({ size: 128 }) })
    .setTitle(`Level ${level}`)
    .setDescription([`${progressBar(into, need)}  **${into} / ${need} XP**`, `🏆 **${xp}** XP in total${place ? ` · **#${place}** in ${truncate(guild.name, 40)}` : ''}`].join('\n'))
    .setFooter(next ? { text: `Level ${next[0]} unlocks a role` } : null);
}

const DEFAULT_TITLE = '🏆 Top chatters in {server}';
const DEFAULT_COLOUR = 0xfee75c;
const BOARD_EVERY_MS = 60_000; // the live board is edited at most this often

/** The leaderboard, in whatever style the server picked. */
function leaderboardEmbed(guild, settings, viewerId, { live = false } = {}) {
  const style = settings.levels.board;
  const size = Math.min(25, Math.max(5, style.size || 10));
  const all = ranking(settings);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = all.slice(0, size).map(([id, xp], i) => {
    const { level } = levelFromXp(xp);
    return `${medals[i] ?? `**${i + 1}.**`} <@${id}> — level **${level}**${style.showXp === false ? '' : ` · ${xp} XP`}`;
  });

  const embed = new EmbedBuilder()
    .setColor(style.colour ?? DEFAULT_COLOUR)
    .setTitle(truncate((style.title || DEFAULT_TITLE).replaceAll('{server}', guild.name), 250))
    .setDescription(lines.join('\n') || 'Nobody has earned any XP yet — say something!');

  if (live) return embed.setFooter({ text: `${all.length} people have XP · updates by itself` }).setTimestamp();
  const place = rankOf(settings, viewerId);
  return embed.setFooter({ text: place ? `You are #${place} of ${all.length}` : 'You haven’t earned any XP yet' });
}

/**
 * Keeps the leaderboard message in the board channel up to date (at most once a minute).
 * Posts it if it isn't there yet.
 */
async function updateBoard(guild, { force = false } = {}) {
  const settings = store.guild(guild.id);
  const board = settings.levels.board;
  if (!board.channelId) return null;
  if (!force && Date.now() - (board.updatedAt ?? 0) < BOARD_EVERY_MS) return null;

  const channel = guild.channels.cache.get(board.channelId);
  if (!channel?.isTextBased()) return null;
  board.updatedAt = Date.now();

  const payload = { embeds: [leaderboardEmbed(guild, settings, null, { live: true })], allowedMentions: { parse: [] } };
  const existing = board.messageId ? await channel.messages.fetch(board.messageId).catch(() => null) : null;
  if (existing) {
    await existing.edit(payload).catch((err) => console.warn(`[levels] ${guild.name}: couldn't update the leaderboard: ${err.message}`));
    store.save();
    return existing;
  }
  const sent = await channel.send(payload).catch((err) => {
    console.warn(`[levels] ${guild.name}: couldn't post the leaderboard: ${err.message}`);
    return null;
  });
  if (sent) {
    board.messageId = sent.id;
    store.save();
  }
  return sent;
}

module.exports = { onMessage, levelFromXp, xpForLevel, xpOf, ranking, rankOf, rankEmbed, leaderboardEmbed, updateBoard, rewardsUpTo, giveRewards, DEFAULT_TITLE };
