'use strict';

// Member counter: two locked voice channels at the top of the server whose names show the numbers —
// "👥 Members: 5,231" (people, not bots) and "📈 Last 24h: +105" (people who joined minus people who left in the last
// 24 hours). Nobody can join them; everyone can see them, including people who haven't verified (restricted people only
// see #restricted). Updated every 10 minutes: Discord only lets a channel be renamed twice in 10 minutes.
// /membercount on | off. If someone deletes one of the channels, it's made again.

const { ChannelType, OverwriteType, PermissionFlagsBits: P } = require('discord.js');
const store = require('./store');

const DAY_MS = 86_400_000;
const REFRESH_MS = 600_000;

function counterSettings(settings) {
  settings.memberCounter ??= { enabled: false, membersChannelId: null, dayChannelId: null, events: [] };
  settings.memberCounter.events ??= [];
  return settings.memberCounter;
}

/** People in the server (bots don't count). */
const people = (guild) => Math.max(0, (guild.memberCount ?? guild.members.cache.size) - guild.members.cache.filter((m) => m.user?.bot).size);

/** Joined minus left in the last 24 hours. */
function lastDay(c) {
  const since = Date.now() - DAY_MS;
  c.events = c.events.filter((e) => e.at >= since);
  return c.events.reduce((sum, e) => sum + e.d, 0);
}

const membersName = (n) => `👥 Members: ${n.toLocaleString('en-US')}`;
const dayName = (n) => (n > 0 ? `📈 Last 24h: +${n.toLocaleString('en-US')}` : n < 0 ? `📉 Last 24h: −${Math.abs(n).toLocaleString('en-US')}` : '📊 Last 24h: 0');

/** A locked voice channel at the top: everyone (and people who haven't verified) can see it, nobody can join. */
function createCounter(guild, name) {
  const v = store.guild(guild.id).verify;
  return guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    position: 0,
    reason: 'O Jailbreak: member counter',
    permissionOverwrites: [
      { id: guild.id, type: OverwriteType.Role, allow: [P.ViewChannel], deny: [P.Connect] },
      // Let in on purpose, so verification leaves it visible to people who haven't verified.
      ...(v?.roleId ? [{ id: v.roleId, type: OverwriteType.Role, allow: [P.ViewChannel], deny: [P.Connect] }] : []),
      { id: guild.client.user.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.ManageChannels] },
    ],
  });
}

const busy = new Set();

/** Makes any missing counter channel and puts the latest numbers in the names. */
async function refresh(guild) {
  const settings = store.guild(guild.id);
  const c = counterSettings(settings);
  if (!c.enabled || busy.has(guild.id)) return null;
  busy.add(guild.id);
  try {
    const wanted = [
      ['membersChannelId', membersName(people(guild))],
      ['dayChannelId', dayName(lastDay(c))],
    ];
    for (const [key, name] of wanted) {
      const channel = c[key] ? guild.channels.cache.get(c[key]) : null;
      if (!channel) {
        const made = await createCounter(guild, name).catch((err) => console.warn(`[member counter] ${guild.name}: couldn't make the counter: ${err.message}`));
        if (made) c[key] = made.id;
      } else if (channel.name !== name) {
        await channel.setName(name, 'O Jailbreak: member counter').catch(() => {});
      }
    }
    store.save();
    return wanted.map(([, name]) => name);
  } finally {
    busy.delete(guild.id);
  }
}

/** Someone joined or left: counted for the last 24 hours (the names catch up at the next update). */
function record(member, d) {
  if (member.user?.bot) return;
  const c = counterSettings(store.guild(member.guild.id));
  if (!c.enabled) return;
  c.events.push({ at: Date.now(), d });
  lastDay(c); // drops anything older than a day
  store.save();
}
const onJoin = (member) => record(member, 1);
const onLeave = (member) => record(member, -1);

/** /membercount on: makes the two channels. People who joined in the last day are counted straight away. */
async function turnOn(guild) {
  const c = counterSettings(store.guild(guild.id));
  if (!c.enabled && !c.events.length) {
    const since = Date.now() - DAY_MS;
    c.events = [...guild.members.cache.values()].filter((m) => !m.user?.bot && (m.joinedTimestamp ?? 0) >= since).map((m) => ({ at: m.joinedTimestamp, d: 1 }));
  }
  c.enabled = true;
  store.save();
  return refresh(guild);
}

/** /membercount off: the channels are deleted. */
async function turnOff(guild) {
  const c = counterSettings(store.guild(guild.id));
  c.enabled = false;
  for (const key of ['membersChannelId', 'dayChannelId']) {
    if (c[key]) await guild.channels.cache.get(c[key])?.delete('O Jailbreak: member counter turned off').catch(() => {});
    c[key] = null;
  }
  c.events = [];
  store.save();
}

const started = new Set();

/** At startup: the first update once the member list has loaded, then every 10 minutes. */
function start(guild) {
  if (started.has(guild.id)) return;
  started.add(guild.id);
  setTimeout(() => refresh(guild).catch(() => {}), 60_000).unref();
  setInterval(() => refresh(guild).catch(() => {}), REFRESH_MS).unref();
}

module.exports = { refresh, onJoin, onLeave, turnOn, turnOff, start, membersName, dayName, counterSettings };
