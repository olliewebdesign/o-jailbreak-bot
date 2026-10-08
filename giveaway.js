'use strict';

// Giveaways: people enter by reacting 🎉 on the giveaway message. When it ends, a reaction only counts if they're a
// VIP, or they've brought enough new people into the server with their invite links (2 by default). Only joins made
// after the giveaway starts count, and if someone they invited leaves before the end, that join stops counting.

const { randomInt } = require('node:crypto');
const config = require('../config');
const store = require('./store');
const { fetchLogChannel } = require('./caseLog');
const { messageLink, truncate, ts } = require('./util');

const EMOJI = '🎉';
const DEFAULT_WINNERS = 3;
const DEFAULT_JOINS = 2;
const MIN_DURATION_MS = 60_000;
const MAX_DURATION_MS = 60 * 86_400_000;
const CHECK_EVERY_MS = 30_000;
const KEEP_ENDED = 20; // ended giveaways kept for /giveaway reroll

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** "1d 12h", "30m", "2w" → milliseconds, or null if it can't be read. */
function parseDuration(text) {
  const clean = String(text ?? '').toLowerCase().replace(/\s+/g, '');
  if (!/^(\d+[mhdw])+$/.test(clean)) return null;
  let ms = 0;
  for (const [, amount, unit] of clean.matchAll(/(\d+)([mhdw])/g)) ms += Number(amount) * UNITS[unit];
  return ms;
}

function vipRoleIds(settings) {
  return [settings.vipRoleId, config.updating?.vipRoleId].filter(Boolean);
}

function isVip(member, settings) {
  return Boolean(member) && vipRoleIds(settings).some((id) => member.roles.cache.has(id));
}

function allGiveaways(settings) {
  return Object.values(settings.giveaways.list).sort((a, b) => a.id - b.id);
}

function activeGiveaways(settings) {
  return allGiveaways(settings).filter((g) => !g.ended);
}

/** The giveaway with this number, or the newest one (running or ended, as asked) when no number is given. */
function findGiveaway(settings, id, { ended } = {}) {
  if (id) return settings.giveaways.list[id] ?? null;
  const pool = allGiveaways(settings).filter((g) => ended === undefined || g.ended === ended);
  return pool.at(-1) ?? null;
}

const joinsFor = (g, userId) => g.joins[userId] ?? [];

// ----- the giveaway message: short on purpose, the host explains the rules themselves -----

function buildContent(g) {
  const prize = truncate(g.prize, 200);
  if (!g.ended) {
    return `${EMOJI} **GIVEAWAY: ${prize}**\nReact with ${EMOJI} to enter!\n**${g.winners}** winner${g.winners === 1 ? '' : 's'} · Ends ${ts(g.endsAt)} (${ts(g.endsAt, 'f')})`;
  }
  const winners = g.winnerIds.length ? g.winnerIds.map((id) => `<@${id}>`).join(', ') : 'nobody qualified';
  return truncate(`${EMOJI} **GIVEAWAY ENDED: ${prize}**\n🏆 Winner${g.winnerIds.length === 1 ? '' : 's'}: ${winners}\nEnded ${ts(g.endedAt ?? g.endsAt, 'f')}`, 2000);
}

async function fetchMessage(guild, g) {
  const channel = guild.channels.cache.get(g.channelId);
  if (!channel?.isTextBased()) return null;
  // Always ask Discord, so the reaction list is up to date (the bot doesn't follow reactions live).
  return channel.messages.fetch({ message: g.messageId, force: true }).catch(() => null);
}

async function refreshMessage(guild, g) {
  const message = await fetchMessage(guild, g);
  await message?.edit({ content: buildContent(g), embeds: [], components: [], allowedMentions: { parse: [] } }).catch(() => {});
  return message;
}

// ----- starting, and counting invite joins -----

async function start({ guild, channel, host, prize, durationMs, winners = DEFAULT_WINNERS, joinsNeeded = DEFAULT_JOINS }) {
  const settings = store.guild(guild.id);
  const g = {
    id: settings.giveaways.nextId++,
    channelId: channel.id,
    messageId: null,
    prize,
    winners,
    joinsNeeded,
    hostId: host.id,
    startedAt: Date.now(),
    endsAt: Date.now() + durationMs,
    joins: {}, // inviterId -> [people who joined with their links during the giveaway and are still here]
    ended: false,
    endedAt: null,
    winnerIds: [],
    reactions: true,
  };
  const message = await channel.send({ content: buildContent(g), allowedMentions: { parse: [] } });
  g.messageId = message.id;
  settings.giveaways.list[g.id] = g;
  store.save();
  await message.react(EMOJI).catch(() => {});
  return { giveaway: g, message };
}

async function dm(guild, userId, content) {
  const user = await guild.client.users.fetch(userId).catch(() => null);
  await user?.send(content).catch(() => {});
}

const giveawayLink = (guild, g) => messageLink(guild.id, g.channelId, g.messageId);

/**
 * Someone joined with an invite link and it counted towards VIP (old enough account, not a rejoin): it counts for
 * every running giveaway too.
 */
async function onCountedJoin(guild, inviterId, joinerId, joinedAt = Date.now()) {
  const settings = store.guild(guild.id);
  for (const g of activeGiveaways(settings)) {
    if (Date.now() >= g.endsAt || inviterId === joinerId || joinedAt < g.startedAt) continue;
    const list = (g.joins[inviterId] ??= []);
    if (list.includes(joinerId)) continue;
    list.push(joinerId);
    store.save();
    if (list.length === g.joinsNeeded) {
      await dm(
        guild,
        inviterId,
        `${EMOJI} **${g.joinsNeeded} people have joined ${truncate(guild.name, 80)} with your invite link**, so you qualify for the giveaway for ${truncate(g.prize, 100)}. Make sure you’ve reacted ${EMOJI} on it: ${giveawayLink(guild, g)}\nIf they leave before it ends (${ts(g.endsAt)}), they stop counting.`,
      );
    }
  }
}

/** Someone left: they stop counting for whoever invited them. */
async function onMemberLeave(member) {
  const guild = member.guild;
  const settings = store.guild(guild.id);
  for (const g of activeGiveaways(settings)) {
    for (const [inviterId, list] of Object.entries(g.joins)) {
      const at = list.indexOf(member.id);
      if (at < 0) continue;
      const qualified = list.length >= g.joinsNeeded;
      list.splice(at, 1);
      if (!list.length) delete g.joins[inviterId];
      store.save();
      if (qualified && list.length < g.joinsNeeded) {
        const inviter = guild.members.cache.get(inviterId);
        if (isVip(inviter, settings)) continue; // VIPs don't need joins
        await dm(
          guild,
          inviterId,
          `⚠️ Someone you invited left ${truncate(guild.name, 80)}, so you’re at **${list.length} of ${g.joinsNeeded}** for the giveaway for ${truncate(g.prize, 100)} and **won’t qualify** unless another person joins with your link before ${ts(g.endsAt)}.`,
        );
      }
    }
  }
}

/** Staff taking joins off someone: their newest joins stop counting in every running giveaway. */
function revokeJoins(guild, userId, amount) {
  const changed = [];
  for (const g of activeGiveaways(store.guild(guild.id))) {
    const list = g.joins[userId];
    if (!list?.length) continue;
    const before = list.length;
    list.splice(Math.max(0, before - amount));
    if (!list.length) delete g.joins[userId];
    changed.push({ id: g.id, prize: g.prize, before, after: list.length, needed: g.joinsNeeded });
  }
  if (changed.length) store.save();
  return changed;
}

/** Someone's progress in every running giveaway, for /invites. */
function progressFor(guild, userId) {
  return activeGiveaways(store.guild(guild.id)).map((g) => ({ id: g.id, prize: g.prize, joins: joinsFor(g, userId).length, needed: g.joinsNeeded, endsAt: g.endsAt }));
}

// ----- entries and drawing winners -----

/** Everyone who reacted 🎉 (not bots), plus anyone who pressed the Enter button on an older-style giveaway. */
async function reactorIds(guild, g) {
  const ids = new Set(g.vipEntries ?? []);
  const message = await fetchMessage(guild, g);
  const reaction = message?.reactions.cache.find((r) => r.emoji.name === EMOJI);
  if (reaction) {
    let after;
    for (;;) {
      const page = await reaction.users.fetch({ limit: 100, after }).catch(() => null);
      if (!page?.size) break;
      for (const user of page.values()) if (!user.bot) ids.add(user.id);
      if (page.size < 100) break;
      after = page.lastKey();
    }
  }
  return [...ids];
}

/**
 * Who reacted, split into who qualifies right now and who doesn't. Checks everyone against the member list, so people
 * who left while the bot was offline (and the joins they counted for) are left out.
 */
async function entries(guild, g, { prune = false } = {}) {
  const settings = store.guild(guild.id);
  // If Discord won't send the member list, nothing is worked out from a half-empty one (and nothing is saved).
  const members = await guild.members.fetch().catch(() => null);
  const here = (id) => (members ? members.has(id) : guild.members.cache.has(id));
  const memberOf = (id) => members?.get(id) ?? guild.members.cache.get(id);
  const stillHere = (id) => (members ? joinsFor(g, id).filter(here) : joinsFor(g, id));

  // Only when drawing winners: joins by people who have gone since are removed for good.
  if (prune && members && !g.ended) {
    for (const inviterId of Object.keys(g.joins)) {
      g.joins[inviterId] = stillHere(inviterId);
      if (!g.joins[inviterId].length) delete g.joins[inviterId];
    }
    store.save();
  }

  const qualified = [];
  const notQualified = [];
  for (const id of await reactorIds(guild, g)) {
    if (!here(id) || settings.restricted[id]) continue;
    if (isVip(memberOf(id), settings) || stillHere(id).length >= g.joinsNeeded) qualified.push(id);
    else notQualified.push(id);
  }
  return { qualified, notQualified, complete: Boolean(members) };
}

function pickRandom(ids, count) {
  const pool = [...ids];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

async function announce(guild, g, winnerIds, { reroll = false } = {}) {
  const channel = guild.channels.cache.get(g.channelId);
  const prize = truncate(g.prize, 200);
  const content = winnerIds.length
    ? `${EMOJI} ${reroll ? '**New winner!** ' : ''}Congratulations ${winnerIds.map((id) => `<@${id}>`).join(', ')}! You won **${prize}**!`
    : `😕 The giveaway for **${prize}** ended, but nobody qualified, so there’s no winner.`;
  const message = await fetchMessage(guild, g);
  const payload = { content, allowedMentions: { users: winnerIds } };
  if (message) await message.reply(payload).catch(() => channel?.send(payload).catch(() => {}));
  else await channel?.send(payload).catch(() => {});

  const log = await fetchLogChannel(guild);
  await log
    ?.send({
      content: `${EMOJI} Giveaway #${g.id} (**${prize}**) ${reroll ? 'rerolled' : 'ended'}: ${winnerIds.length ? winnerIds.map((id) => `<@${id}>`).join(', ') : 'no winner'}.`,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

function forgetOldGiveaways(settings) {
  const ended = allGiveaways(settings).filter((g) => g.ended);
  for (const g of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) delete settings.giveaways.list[g.id];
}

const ending = new Set();
async function end(guild, g) {
  const key = `${guild.id}:${g.id}`;
  if (g.ended || ending.has(key)) return null;
  ending.add(key);
  try {
    const drawn = await entries(guild, g, { prune: true });
    // Without the full member list people could be wrongly left out: try again in 30 seconds instead.
    if (!drawn.complete) throw new Error('Discord didn’t send the member list, so I couldn’t draw fairly. Try again in a minute.');
    const winnerIds = pickRandom(drawn.qualified, g.winners);
    Object.assign(g, { ended: true, endedAt: Date.now(), winnerIds });
    forgetOldGiveaways(store.guild(guild.id));
    store.save();
    await refreshMessage(guild, g);
    await announce(guild, g, winnerIds);
    return winnerIds;
  } finally {
    ending.delete(key);
  }
}

/** Draws `count` more winners from everyone who qualified and hasn't won already. */
async function reroll(guild, g, count = 1) {
  const drawn = await entries(guild, g);
  if (!drawn.complete) throw new Error('Discord didn’t send the member list, so I couldn’t draw fairly. Try again in a minute.');
  const pool = drawn.qualified.filter((id) => !g.winnerIds.includes(id));
  const winnerIds = pickRandom(pool, count);
  if (!winnerIds.length) return winnerIds;
  g.winnerIds.push(...winnerIds);
  store.save();
  await refreshMessage(guild, g);
  await announce(guild, g, winnerIds, { reroll: true });
  return winnerIds;
}

// Giveaways started with v1.9.0's first build had a long embed and an Enter button: swap them for the short message
// and the 🎉 reaction.
async function upgradeOldMessage(guild, g) {
  if (g.reactions) return;
  const message = await refreshMessage(guild, g);
  if (!message) return;
  await message.react(EMOJI).catch(() => {});
  g.reactions = true;
  store.save();
}

/** Ends giveaways whose time is up, including any that ran out while the bot was offline. */
function startTimer(client) {
  const check = async () => {
    for (const guild of client.guilds.cache.values()) {
      for (const g of activeGiveaways(store.guild(guild.id))) {
        if (Date.now() >= g.endsAt) await end(guild, g).catch((err) => console.error(`[giveaway] #${g.id}:`, err));
        else await upgradeOldMessage(guild, g).catch(() => {});
      }
    }
  };
  check();
  return setInterval(check, CHECK_EVERY_MS);
}

module.exports = {
  EMOJI,
  DEFAULT_WINNERS,
  DEFAULT_JOINS,
  MIN_DURATION_MS,
  MAX_DURATION_MS,
  parseDuration,
  isVip,
  activeGiveaways,
  findGiveaway,
  start,
  onCountedJoin,
  onMemberLeave,
  revokeJoins,
  progressFor,
  entries,
  pickRandom,
  end,
  reroll,
  startTimer,
  buildContent,
};
