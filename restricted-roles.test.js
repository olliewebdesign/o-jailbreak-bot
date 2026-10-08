'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Restricted people must never hold VIP (or any other role): a role that's allowed into a channel beats the Restricted
// role's "can't see", so they'd see those channels again.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-restricted-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const store = require('../src/store');
const restrict = require('../src/restrict');
const invites = require('../src/invites');

const RESTRICTED = 'restricted-role';
const VIP = 'vip-role';
let nextGuild = 1;

function fakeGuild() {
  const roles = new Collection(
    [
      [RESTRICTED, { id: RESTRICTED, name: 'Restricted', editable: true, managed: false }],
      [VIP, { id: VIP, name: 'VIP', editable: true, managed: false }],
      ['booster', { id: 'booster', name: 'Server Booster', editable: false, managed: true }],
    ].map(([id, r]) => [id, r]),
  );
  const guild = {
    id: `guild-${nextGuild++}`,
    name: 'Test',
    roles: { cache: roles },
    channels: { fetch: async () => null },
    members: { fetch: async () => null },
  };
  const settings = store.guild(guild.id);
  settings.restrict.roleId = RESTRICTED;
  settings.vipRoleId = VIP;
  settings.vipJoinsNeeded = 1;
  return { guild, settings };
}

function fakeMember(guild, id, roleIds) {
  const member = {
    id,
    guild,
    user: { id, tag: id, bot: false },
    added: [],
    removed: [],
    roles: {
      cache: new Collection(roleIds.map((r) => [r, guild.roles.cache.get(r)])),
      add: async (role) => {
        const rid = role.id ?? role;
        member.added.push(rid);
        member.roles.cache.set(rid, guild.roles.cache.get(rid));
      },
      remove: async (ids) => {
        for (const rid of [].concat(ids)) {
          member.removed.push(rid);
          member.roles.cache.delete(rid);
        }
      },
    },
    send: async () => {},
  };
  return member;
}

test('a restricted person approved for VIP doesn’t get the role; it’s saved for when they’re unrestricted', async () => {
  const { guild, settings } = fakeGuild();
  const member = fakeMember(guild, 'naughty', [RESTRICTED]);
  guild.members.fetch = async () => member;
  settings.restricted.naughty = { roles: [], by: 'mod', reason: 'x', at: Date.now() };

  settings.invites.counts.naughty = 5;
  assert.equal(await invites.giveVip(guild, member, settings, 5, { approvedBy: { id: 'admin', tag: 'admin' } }), 'saved');
  assert.deepEqual(member.added, [], 'VIP was not handed out');
  assert.ok(!member.roles.cache.has(VIP));
  assert.deepEqual(settings.restricted.naughty.roles, [VIP], 'VIP saved for when they’re unrestricted');
});

test('a role given to a restricted person by anyone else is taken straight back off and saved', async () => {
  const { guild, settings } = fakeGuild();
  const member = fakeMember(guild, 'naughty', [RESTRICTED, VIP, 'booster']);
  settings.restricted.naughty = { roles: ['member-role'], by: 'mod', reason: 'x', at: Date.now() };

  assert.deepEqual(await restrict.holdBackRoles(member), [VIP]);
  assert.deepEqual([...member.roles.cache.keys()].sort(), ['booster', RESTRICTED].sort(), 'only roles the bot can’t remove are left');
  assert.deepEqual(settings.restricted.naughty.roles.sort(), ['member-role', VIP].sort());
});

test('roles given back by unrestricting are left alone', async () => {
  const { guild, settings } = fakeGuild();
  // Unrestricting: the Restricted role is already gone, the record is about to be deleted.
  const member = fakeMember(guild, 'forgiven', [VIP]);
  settings.restricted.forgiven = { roles: [VIP], by: 'mod', reason: 'x', at: Date.now() };
  assert.deepEqual(await restrict.holdBackRoles(member), []);
  assert.ok(member.roles.cache.has(VIP));
});

test('people who aren’t restricted get VIP when approved', async () => {
  const { guild, settings } = fakeGuild();
  const member = fakeMember(guild, 'good', []);
  guild.members.fetch = async () => member;
  settings.invites.counts.good = 5;
  assert.equal(await invites.giveVip(guild, member, settings, 5, { approvedBy: { id: 'admin', tag: 'admin' } }), true);
  assert.ok(member.roles.cache.has(VIP));
});
