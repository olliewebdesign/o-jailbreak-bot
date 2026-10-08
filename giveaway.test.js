'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Giveaways: enter by reacting 🎉; a reaction only counts for VIPs or people who brought in enough new members (only
// new joins, leavers stop counting). Plus drawing winners and the invite anti-cheat rules.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-giveaway-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const store = require('../src/store');
const giveaway = require('../src/giveaway');
const invites = require('../src/invites');

const VIP_ROLE = 'vip-role';
let nextGuild = 1;

function fakeMember(guild, id, { roles = [], bot = false } = {}) {
  return { id, guild, user: { id, bot, tag: id }, roles: { cache: new Map(roles.map((r) => [r, { id: r }])) } };
}

function fakeGuild() {
  const sent = [];
  const members = new Map();
  const reactors = new Collection();
  const reaction = { emoji: { name: '🎉' }, users: { fetch: async () => reactors } };
  const message = {
    id: 'msg',
    url: 'https://discord.com/x',
    reacted: [],
    edits: [],
    react: async (e) => message.reacted.push(e),
    edit: async (p) => message.edits.push(p),
    reply: async (p) => sent.push(p),
    reactions: { cache: new Collection([['🎉', reaction]]) },
  };
  const channel = {
    id: 'chan',
    isTextBased: () => true,
    send: async (p) => (sent.push(p), message),
    messages: { fetch: async () => message },
  };
  const dms = [];
  const guild = {
    id: `guild-${nextGuild++}`,
    name: 'Test',
    members: { cache: members, fetch: async () => members },
    channels: { cache: new Map([['chan', channel]]), fetch: async () => null },
    client: { users: { fetch: async (id) => ({ send: async (text) => dms.push({ id, text }) }) } },
  };
  store.guild(guild.id).vipRoleId = VIP_ROLE;
  const add = (id, opts) => members.set(id, fakeMember(guild, id, opts));
  const react = (id, bot = false) => reactors.set(id, { id, bot });
  return { guild, channel, message, sent, dms, members, add, react };
}

async function startGiveaway(guild, channel, extra = {}) {
  const { giveaway: g } = await giveaway.start({ guild, channel, host: { id: 'host' }, prize: 'Nitro', durationMs: 3_600_000, ...extra });
  return g;
}

test('durations are read like 30m, 12h, 1d12h and 1w', () => {
  assert.equal(giveaway.parseDuration('30m'), 30 * 60_000);
  assert.equal(giveaway.parseDuration('1d 12h'), 36 * 3_600_000);
  assert.equal(giveaway.parseDuration('1w'), 7 * 86_400_000);
  assert.equal(giveaway.parseDuration('soon'), null);
  assert.equal(giveaway.parseDuration('12'), null);
});

test('the giveaway is a short message with a 🎉 reaction: 3 winners and 2 joins by default', async () => {
  const { guild, channel, message, sent } = fakeGuild();
  const g = await startGiveaway(guild, channel);
  assert.equal(g.winners, 3);
  assert.equal(g.joinsNeeded, 2);
  assert.deepEqual(message.reacted, ['🎉']);
  assert.match(sent[0].content, /GIVEAWAY: Nitro/);
  assert.match(sent[0].content, /React with 🎉 to enter/);
  assert.equal(sent[0].embeds, undefined);
  assert.equal(sent[0].components, undefined);
});

test('reactions only count for VIPs and people with enough new joins; leavers stop counting', async () => {
  const { guild, channel, dms, add, react } = fakeGuild();
  const g = await startGiveaway(guild, channel);
  for (const id of ['vip', 'inviter', 'lazy', 'f1', 'f2']) add(id, id === 'vip' ? { roles: [VIP_ROLE] } : {});
  for (const id of ['vip', 'inviter', 'lazy']) react(id);
  react('some-bot', true);

  await giveaway.onCountedJoin(guild, 'inviter', 'f1');
  await giveaway.onCountedJoin(guild, 'inviter', 'f2');
  await giveaway.onCountedJoin(guild, 'inviter', 'f2'); // the same person can't count twice
  assert.equal(g.joins.inviter.length, 2);
  assert.match(dms.at(-1).text, /you qualify/);

  let { qualified, notQualified } = await giveaway.entries(guild, g);
  assert.deepEqual(qualified.sort(), ['inviter', 'vip']);
  assert.deepEqual(notQualified, ['lazy']);

  await giveaway.onMemberLeave({ id: 'f1', guild });
  assert.match(dms.at(-1).text, /1 of 2/);
  ({ qualified } = await giveaway.entries(guild, g));
  assert.deepEqual(qualified, ['vip']);
});

test('the draw leaves out anyone whose invited people left while the bot was off', async () => {
  const { guild, channel, message, add, react, sent } = fakeGuild();
  const g = await startGiveaway(guild, channel, { winners: 3 });
  for (const id of ['a', 'b', 'a1', 'a2', 'b1', 'b2']) add(id);
  react('a');
  react('b');
  for (const [inviter, joiner] of [['a', 'a1'], ['a', 'a2'], ['b', 'b1'], ['b', 'b2']]) await giveaway.onCountedJoin(guild, inviter, joiner);
  guild.members.cache.delete('b2'); // left without the bot seeing it

  const winners = await giveaway.end(guild, g);
  assert.deepEqual(winners, ['a']);
  assert.ok(g.ended);
  assert.match(message.edits.at(-1).content, /GIVEAWAY ENDED/);
  assert.match(sent.at(-1).content, /Congratulations <@a>/);
  assert.equal(await giveaway.end(guild, g), null, 'a giveaway only ends once');
});

test('someone who left and rejoined doesn’t count for invites a second time', async () => {
  const { guild } = fakeGuild();
  let uses = 0;
  guild.invites = { fetch: async () => new Map([['code', { code: 'code', uses, inviterId: 'inviter' }]]) };
  await invites.refresh(guild);
  const oldAccount = String(BigInt(Date.now() - 400 * 86_400_000 - 1420070400000) << 22n);
  const joiner = fakeMember(guild, oldAccount);

  uses = 1;
  assert.equal((await invites.onMemberJoin(joiner)).counted, true);
  uses = 2;
  const again = await invites.onMemberJoin(joiner);
  assert.equal(again.counted, false);
  assert.equal(again.reason, 'rejoin');
  assert.equal(invites.joinsBy(store.guild(guild.id), 'inviter'), 1);
});

test('brand-new accounts don’t count (VIP needs accounts over 30 days old)', async () => {
  const { guild } = fakeGuild();
  let uses = 0;
  guild.invites = { fetch: async () => new Map([['code', { code: 'code', uses, inviterId: 'inviter' }]]) };
  await invites.refresh(guild);
  const tenDaysOld = String(BigInt(Date.now() - 10 * 86_400_000 - 1420070400000) << 22n);
  uses = 1;
  const result = await invites.onMemberJoin(fakeMember(guild, tenDaysOld));
  assert.equal(result.counted, false);
  assert.equal(result.reason, 'new-account');
});

test('staff can take joins off someone: it lowers their VIP count and their running giveaways', async () => {
  const { guild, channel, add, react } = fakeGuild();
  const settings = store.guild(guild.id);
  const g = await startGiveaway(guild, channel);
  for (const id of ['cheat', 'j1', 'j2', 'j3']) add(id);
  react('cheat');
  settings.invites.counts.cheat = 6;
  for (const j of ['j1', 'j2', 'j3']) await giveaway.onCountedJoin(guild, 'cheat', j);
  assert.deepEqual((await giveaway.entries(guild, g)).qualified, ['cheat']);

  assert.deepEqual(invites.revokeJoins(settings, 'cheat', 2), { before: 6, after: 4 });
  assert.equal(invites.revokedFrom(settings, 'cheat'), 2);
  const changed = giveaway.revokeJoins(guild, 'cheat', 2);
  assert.deepEqual(changed.map((c) => [c.before, c.after]), [[3, 1]]);
  assert.deepEqual(g.joins.cheat, ['j1'], 'their newest joins are the ones taken off');
  assert.deepEqual((await giveaway.entries(guild, g)).qualified, []);
  assert.deepEqual(giveaway.progressFor(guild, 'cheat').map((p) => p.joins), [1]);

  // Taking off more than they have stops at 0.
  assert.deepEqual(invites.revokeJoins(settings, 'cheat', 50), { before: 4, after: 0 });
  assert.equal(invites.revokedFrom(settings, 'cheat'), 6);
});

test('someone who leaves within 24 hours of joining comes back off their inviter’s count', async () => {
  const { guild } = fakeGuild();
  const settings = store.guild(guild.id);
  let uses = 0;
  guild.invites = { fetch: async () => new Map([['code', { code: 'code', uses, inviterId: 'inviter' }]]) };
  await invites.refresh(guild);
  const account = (n) => String(BigInt(Date.now() - (400 + n) * 86_400_000 - 1420070400000) << 22n);
  const quitter = fakeMember(guild, account(1));
  const stayer = fakeMember(guild, account(2));

  uses = 1;
  await invites.onMemberJoin(quitter);
  uses = 2;
  await invites.onMemberJoin(stayer);
  assert.equal(invites.joinsBy(settings, 'inviter'), 2);

  // Left 10 minutes in: doesn't count any more.
  settings.invites.joinedAt[quitter.id] = Date.now() - 10 * 60_000;
  assert.deepEqual(await invites.onMemberLeave(quitter), { inviterId: 'inviter', count: 1, lostVip: false });
  assert.equal(invites.joinsBy(settings, 'inviter'), 1);
  const listed = invites.broughtBy(settings, 'inviter').find((p) => p.id === quitter.id);
  assert.equal(listed.counted, false);
  assert.equal(listed.reason, 'left-early');
  assert.equal(await invites.onMemberLeave(quitter), null, 'only taken off once');

  // Stayed more than a day before leaving: still counts.
  settings.invites.joinedAt[stayer.id] = Date.now() - 25 * 3_600_000;
  assert.equal(await invites.onMemberLeave(stayer), null);
  assert.equal(invites.joinsBy(settings, 'inviter'), 1);

  // The early leaver comes back and stays: they count again (once).
  uses = 3;
  assert.equal((await invites.onMemberJoin(quitter)).counted, true);
  assert.equal(invites.joinsBy(settings, 'inviter'), 2);
});
