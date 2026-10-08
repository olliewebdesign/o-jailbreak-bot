'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Member counter: "👥 Members: 5,231" and "📈 Last 24h: +105" as locked voice channels at the top of the server.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-membercounter-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, Collection, PermissionFlagsBits: P } = require('discord.js');
const store = require('../src/store');
const counter = require('../src/memberCounter');

let n = 0;
function setup({ memberCount = 5233, bots = 2, joinedToday = 3 } = {}) {
  const channels = new Collection();
  const members = new Collection();
  const guild = { id: `guild-counter-${n++}`, name: 'Mine', memberCount, client: { user: { id: 'bot' } } };
  for (let i = 0; i < bots; i++) members.set(`bot${i}`, { id: `bot${i}`, guild, user: { bot: true }, joinedTimestamp: Date.now() - 3600_000 });
  for (let i = 0; i < joinedToday; i++) members.set(`new${i}`, { id: `new${i}`, guild, user: { bot: false }, joinedTimestamp: Date.now() - 3600_000 });
  members.set('old', { id: 'old', guild, user: { bot: false }, joinedTimestamp: Date.now() - 30 * 86_400_000 });
  guild.members = { cache: members };
  let made = 0;
  guild.channels = {
    cache: channels,
    create: async (opts) => {
      const ch = {
        id: `counter-${made++}`,
        name: opts.name,
        opts,
        setName: async (name) => (ch.name = name),
        delete: async () => channels.delete(ch.id),
      };
      channels.set(ch.id, ch);
      return ch;
    },
  };
  store.guild(guild.id).verify = { roleId: 'unverified-role' };
  const member = (id, bot = false) => ({ id, guild, user: { bot } });
  return { guild, channels, member };
}

const names = (channels) => [...channels.values()].map((c) => c.name);

test('/membercount on: 👥 Members (people, not bots) and 📈 Last 24h, as locked voice channels everyone can see', async () => {
  const s = setup();
  await counter.turnOn(s.guild);
  assert.deepEqual(names(s.channels), ['👥 Members: 5,231', '📈 Last 24h: +3'], 'people who joined in the last day count straight away');
  for (const ch of s.channels.values()) {
    assert.equal(ch.opts.type, ChannelType.GuildVoice);
    assert.equal(ch.opts.position, 0, 'at the top');
    const o = Object.fromEntries(ch.opts.permissionOverwrites.map((x) => [x.id, x]));
    assert.deepEqual(o[s.guild.id].allow, [P.ViewChannel], 'everyone can see it');
    assert.deepEqual(o[s.guild.id].deny, [P.Connect], 'nobody can join');
    assert.deepEqual(o['unverified-role'].allow, [P.ViewChannel], 'people who haven’t verified too');
  }
});

test('joins and leaves change the 24-hour number (bots don’t count); a day later they drop off', async () => {
  const s = setup({ joinedToday: 0 });
  await counter.turnOn(s.guild);
  assert.ok(names(s.channels).includes('📊 Last 24h: 0'));

  for (let i = 0; i < 5; i++) counter.onJoin(s.member(`j${i}`));
  const bot = s.member('somebot', true);
  s.guild.members.cache.set(bot.id, bot); // Discord adds a bot that joins to the member list
  counter.onJoin(bot);
  for (let i = 0; i < 2; i++) counter.onLeave(s.member(`l${i}`));
  s.guild.memberCount += 4; // 5 joined (and a bot), 2 left
  await counter.refresh(s.guild);
  assert.deepEqual(names(s.channels), ['👥 Members: 5,234', '📈 Last 24h: +3']);

  for (let i = 0; i < 10; i++) counter.onLeave(s.member(`x${i}`));
  await counter.refresh(s.guild);
  assert.ok(names(s.channels).includes('📉 Last 24h: −7'));

  // A day later
  const settings = store.guild(s.guild.id);
  for (const e of settings.memberCounter.events) e.at -= 86_400_000 + 1000;
  await counter.refresh(s.guild);
  assert.ok(names(s.channels).includes('📊 Last 24h: 0'));
});

test('a deleted counter is made again; /membercount off removes both and stops counting', async () => {
  const s = setup();
  await counter.turnOn(s.guild);
  const [first] = s.channels.keys();
  s.channels.delete(first);
  await counter.refresh(s.guild);
  assert.equal(s.channels.size, 2, 'made again');

  await counter.turnOff(s.guild);
  assert.equal(s.channels.size, 0);
  counter.onJoin(s.member('late'));
  assert.equal(store.guild(s.guild.id).memberCounter.events.length, 0, 'not counting while off');
  assert.equal(await counter.refresh(s.guild), null);
  assert.equal(s.channels.size, 0);
});

test('names: thousands get commas, and the 24-hour change shows its direction', () => {
  assert.equal(counter.membersName(12345), '👥 Members: 12,345');
  assert.equal(counter.dayName(105), '📈 Last 24h: +105');
  assert.equal(counter.dayName(-12), '📉 Last 24h: −12');
  assert.equal(counter.dayName(0), '📊 Last 24h: 0');
});
