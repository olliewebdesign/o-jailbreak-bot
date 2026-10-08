'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { Collection, OverwriteType, PermissionFlagsBits: P } = require('discord.js');

process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-updating-test-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // Windows reuses process IDs
const store = require('../src/store');
const updating = require('../src/updating');
const config = require('../config');

const V = P.ViewChannel;

// ----- a small fake Discord server -----

const bits = (n) => ({ bitfield: n, has: (f) => (n & f) === f });
const toBits = (v) => (typeof v === 'bigint' ? v : (v ?? []).reduce((a, f) => a | f, 0n));

let guildCount = 0;
function makeGuild() {
  const id = `g${++guildCount}`;
  const guild = { id, name: 'Test', ownerId: 'owner', calls: 0 };
  const role = (id, name) => ({
    id,
    name,
    managed: false,
    delete: async () => {
      guild.calls++;
      guild.roles.cache.delete(id);
      for (const m of guild.members.cache.values()) m.roles.cache.delete(id);
      for (const c of guild.channels.cache.values()) c.permissionOverwrites.cache.delete(id);
    },
  });
  guild.roles = { cache: new Collection([id, 'm1', 'm2', 'vip', 'mod', 'booster'].map((r) => [r, role(r, r.toUpperCase())])) };
  guild.addRole = (id) => guild.roles.cache.set(id, role(id, id));

  let n = 1;
  const channel = (name, overwrites = []) => {
    const cache = new Collection();
    const put = (id, type, allow, deny) => cache.set(id, { id, type, allow: bits(allow), deny: bits(deny) });
    const ch = {
      id: `c${n++}`,
      name,
      type: 0,
      parentId: null,
      guild,
      toString: () => `#${name}`,
      send: async () => ({}),
      permissionOverwrites: {
        cache,
        put,
        async set(list) {
          guild.calls++;
          cache.clear();
          for (const o of list) put(o.id === 'g' ? guild.id : o.id, o.type ?? OverwriteType.Role, toBits(o.allow), toBits(o.deny));
        },
        async edit(id, perms, { type } = {}) {
          guild.calls++;
          const cur = cache.get(id);
          let allow = cur?.allow.bitfield ?? 0n;
          let deny = cur?.deny.bitfield ?? 0n;
          for (const [name, value] of Object.entries(perms)) {
            allow &= ~P[name];
            deny &= ~P[name];
            if (value === true) allow |= P[name];
            if (value === false) deny |= P[name];
          }
          put(id, type ?? cur?.type ?? OverwriteType.Role, allow, deny);
        },
      },
    };
    for (const [id, allow, deny] of overwrites) put(id === 'g' ? guild.id : id, OverwriteType.Role, toBits(allow), toBits(deny));
    guild.channels.cache.set(ch.id, ch);
    return ch;
  };
  guild.channels = {
    cache: new Collection(),
    create: async ({ name, permissionOverwrites }) => {
      guild.calls++;
      const ch = channel(name);
      await ch.permissionOverwrites.set(permissionOverwrites);
      guild.calls--;
      return ch;
    },
  };
  guild.makeChannel = channel;
  guild.members = { cache: new Collection(), me: { permissions: { has: () => true } } };
  guild.makeMember = (id, roles = []) => {
    const m = { id, roles: { cache: new Collection(roles.map((r) => [r, guild.roles.cache.get(r)])) } };
    guild.members.cache.set(id, m);
    return m;
  };
  guild.client = { user: { id: 'bot' }, users: { fetch: async () => ({ id: 'owner', tag: 'owner' }) } };
  return guild;
}

// Discord's rule: @everyone's overwrite, then all role denies, then all role allows (an allow wins).
function canSee(guild, member, channel) {
  const ow = channel.permissionOverwrites.cache;
  let view = true;
  if (ow.get(guild.id)?.deny.has(V)) view = false;
  if (ow.get(guild.id)?.allow.has(V)) view = true;
  const roleOws = [...member.roles.cache.keys()].map((id) => ow.get(id)).filter(Boolean);
  if (roleOws.some((o) => o.deny.has(V))) view = false;
  if (roleOws.some((o) => o.allow.has(V))) view = true;
  return view;
}

const visible = (guild, member) =>
  [...guild.channels.cache.values()]
    .filter((c) => canSee(guild, member, c))
    .map((c) => c.name)
    .sort();

const snapshot = (ch) =>
  JSON.stringify(
    [...ch.permissionOverwrites.cache.values()].map((o) => [o.id, String(o.allow.bitfield), String(o.deny.bitfield)]).sort(),
  );

function setUp() {
  const guild = makeGuild();
  const settings = store.guild(guild.id);
  Object.assign(settings, { modRoleId: 'mod', autoroleId: null, vipRoleId: null });
  const hidden = ['g', 0n, V];
  const ch = {
    general: guild.makeChannel('general'),
    chat: guild.makeChannel('chat'),
    community: guild.makeChannel('community'),
    announcements: guild.makeChannel('announcements', [['g', V, P.SendMessages]]),
    rules: guild.makeChannel('rules', [hidden, ['m1', V, 0n]]),
    vipChat: guild.makeChannel('vip-chat', [hidden, ['vip', V, 0n], ['mod', V, 0n]]),
    vipLounge: guild.makeChannel('vip-lounge', [hidden, ['m2', V, 0n]]),
    staff: guild.makeChannel('staff', [hidden, ['mod', V, 0n]]),
    adminOnly: guild.makeChannel('admin-only', [hidden]),
  };
  Object.assign(config.updating, {
    memberRoleIds: ['m1', 'm2'],
    vipRoleId: 'vip',
    keepVisibleChannelIds: [ch.chat.id, ch.announcements.id],
    vipChannelIds: [ch.vipLounge.id],
  });
  const people = {
    alice: guild.makeMember('alice', ['m1', 'm2']),
    vicky: guild.makeMember('vicky', ['m1', 'm2', 'vip']),
    mia: guild.makeMember('mia', ['m1', 'm2', 'mod']),
    newbie: guild.makeMember('newbie', []),
  };
  return { guild, settings, ch, people };
}

const owner = { id: 'owner', tag: 'owner' };
const U = '🔧︱server-updating';

const steps = [];
steps.push(['members see only the kept channels, VIPs keep theirs, staff keep everything, finish puts it all back', async () => {
  const { guild, settings, ch, people } = setUp();
  const { alice, vicky, mia, newbie } = people;
  const before = Object.fromEntries(Object.entries(ch).map(([k, c]) => [k, snapshot(c)]));
  const memberView = ['announcements', 'chat', 'community', 'general', 'rules', 'vip-lounge'];

  // Community is kept with the command (by picking a thread in it) before updating starts: nothing changes yet.
  const kept = await updating.toggleKeepVisible(guild, { isThread: () => true, parent: ch.community, toString: () => '#a-thread' });
  assert.match(kept.text, /its channel/);
  assert.equal(guild.calls, 0);

  const result = await updating.start(guild, owner);
  assert.ok(result.ok, result.text);
  // One change per channel at most (plus making #server-updating), however many members there are.
  assert.ok(guild.calls <= Object.keys(ch).length + 1, `${guild.calls} calls`);

  const during = ['announcements', 'chat', 'community', U].sort();
  assert.deepEqual(visible(guild, alice), during);
  assert.deepEqual(visible(guild, newbie), during, 'people without any role (new joins) see the same');
  assert.deepEqual(visible(guild, vicky), [...during, 'vip-chat', 'vip-lounge'].sort(), 'VIPs keep their channels');
  assert.deepEqual(
    visible(guild, mia),
    ['announcements', 'chat', 'community', 'general', 'rules', 'staff', U, 'vip-chat', 'vip-lounge'].sort(),
    'mods keep everything they could see before',
  );
  assert.ok(!visible(guild, mia).includes('admin-only'), 'mods don’t get into admin-only channels');

  // #server-updating: everyone reads, nobody but mods types.
  const updates = [...guild.channels.cache.values()].find((c) => c.name === U);
  assert.ok(updates.permissionOverwrites.cache.get(guild.id).deny.has(P.SendMessages));
  assert.ok(updates.permissionOverwrites.cache.get('mod').allow.has(P.SendMessages));

  // Running it again, or a channel event for our own change, does nothing.
  let calls = guild.calls;
  for (const c of Object.values(ch)) await updating.onChannelChange(c);
  assert.equal(guild.calls, calls);

  // A channel from config.js can't be toggled; a command-kept one can, and it applies straight away.
  assert.match((await updating.toggleKeepVisible(guild, ch.announcements)).text, /config\.js/);
  await updating.toggleKeepVisible(guild, ch.community);
  assert.deepEqual(visible(guild, alice), ['announcements', 'chat', U].sort());
  await updating.toggleKeepVisible(guild, ch.community);
  assert.deepEqual(visible(guild, alice), during);

  // A new members-only channel made mid-update is hidden too.
  const news = guild.makeChannel('news', [['g', 0n, V], ['m1', V, 0n]]);
  await updating.onChannelChange(news);
  assert.ok(!visible(guild, alice).includes('news'));

  // A setup tool resetting rules' permissions mid-update: hidden again straight away.
  await ch.rules.permissionOverwrites.set([{ id: 'g', deny: V }, { id: 'm1', allow: V }]);
  await updating.onChannelChange(ch.rules);
  assert.deepEqual(visible(guild, alice), during);

  // The owner opens general up to a new role during the update: that's kept afterwards.
  await ch.general.permissionOverwrites.edit('booster', { ViewChannel: true });
  await updating.onChannelChange(ch.general);

  const done = await updating.finish(guild, owner);
  assert.ok(done.ok, done.text);
  assert.deepEqual(visible(guild, alice), [...memberView, 'news'].sort());
  assert.deepEqual(visible(guild, newbie), ['announcements', 'chat', 'community', 'general'], 'no roles = no members-only channels, as before');
  assert.deepEqual(visible(guild, vicky), [...memberView, 'news', 'vip-chat'].sort());
  assert.ok(visible(guild, mia).includes(U), 'mods can still see the (hidden) updates channel');
  assert.ok(!visible(guild, alice).includes(U), 'members can’t');

  // Every channel is exactly as it was, apart from the owner's own change to general.
  for (const [key, snap] of Object.entries(before)) {
    if (key !== 'general') assert.equal(snapshot(ch[key]), snap, `${key} is back how it was`);
  }
  assert.ok(ch.general.permissionOverwrites.cache.get('booster').allow.has(V), 'the owner’s change is kept');
  assert.ok(!ch.general.permissionOverwrites.cache.has(guild.id), 'general is open to everyone again');
  assert.deepEqual(settings.updating.saved, {});
  assert.equal(settings.updating.active, false);

  // Once finished, channel events are ignored and finishing again says so.
  calls = guild.calls;
  await updating.onChannelChange(ch.rules);
  assert.equal(guild.calls, calls);
  assert.equal((await updating.finish(guild, owner)).ok, false);
}]);

steps.push(['the slow role from v1.8.0 is cleaned up when the new version carries on', async () => {
  const { guild, settings, ch, people } = setUp();
  // Mid-update in v1.8.0: everyone half-way through getting the old role, @Member's allow taken off rules.
  guild.addRole('oldrole');
  people.alice.roles.cache.set('oldrole', guild.roles.cache.get('oldrole'));
  for (const c of Object.values(ch)) c.permissionOverwrites.put('oldrole', OverwriteType.Role, 0n, V);
  ch.rules.permissionOverwrites.put('m1', OverwriteType.Role, 0n, 0n);
  Object.assign(settings.updating, { active: true, roleId: 'oldrole', stripped: { [ch.rules.id]: [{ id: 'm1', type: OverwriteType.Role }] }, saved: {}, keepVisible: [] });

  await updating.resume(guild); // what happens when the bot restarts after /update
  assert.ok(!guild.roles.cache.has('oldrole'), 'the old role is deleted');
  assert.equal(settings.updating.roleId, null);
  assert.deepEqual(visible(guild, people.alice), ['announcements', 'chat', U].sort(), 'the new way is in place');

  await updating.finish(guild, owner);
  assert.ok(visible(guild, people.alice).includes('rules'), '@Member got rules back');
  assert.ok(visible(guild, people.alice).includes('general'));
}]);

// One after the other: they share config.js and the saved settings.
test('server updating mode', async (t) => {
  for (const [name, fn] of steps) await t.test(name, fn);
});
