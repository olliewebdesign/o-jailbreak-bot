'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Blocked servers: anyone wearing a blocked server's tag, or posting an invite to it, is restricted. Staff never are.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-blocked-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField } = require('discord.js');
const store = require('../src/store');
const restrict = require('../src/restrict');
const blockedServers = require('../src/blockedServers');

const BAD_SERVER = '900000000000000001';
const restricted = [];
restrict.restrictMember = async ({ member, reason }) => {
  restricted.push({ id: member.id, reason });
  store.guild(member.guild.id).restricted[member.id] = { roles: [] };
  return { ok: true, text: 'restricted' };
};

let n = 0;
function setup() {
  const logged = [];
  const log = { isTextBased: () => true, send: async (p) => logged.push(p.content) };
  const client = {
    user: { id: 'bot', tag: 'O Jailbreak' },
    fetchInvite: async (code) => {
      if (['VFQkDSb5rq', 'anonymouse'].includes(code)) return { guild: { id: BAD_SERVER, name: 'Bad Server' } };
      throw Object.assign(new Error('Unknown Invite'), { code: 10006 });
    },
    users: { fetch: async (id) => users.get(id) },
  };
  const users = new Map();
  const members = new Collection();
  const guild = {
    id: `guild-blocked-${n++}`,
    name: 'Mine',
    ownerId: 'owner',
    client,
    members: { cache: members, fetch: async () => members },
    channels: { fetch: async () => log },
  };
  client.guilds = { cache: new Collection([[guild.id, guild]]) };
  store.guild(guild.id).logChannelId = 'log';
  const add = (id, { tagGuild = null, staff = false } = {}) => {
    const user = { id, bot: false, tag: id, primaryGuild: tagGuild ? { identityGuildId: tagGuild, identityEnabled: true, tag: 'ANON' } : null };
    users.set(id, user);
    const member = {
      id,
      guild,
      client,
      user,
      roles: { cache: new Collection() },
      permissions: new PermissionsBitField(staff ? [PermissionsBitField.Flags.ModerateMembers] : []),
    };
    members.set(id, member);
    return member;
  };
  return { guild, client, add, logged };
}

test('both invites resolve to the same blocked server', async () => {
  const { guild } = setup();
  await blockedServers.prepare(guild);
  const list = blockedServers.blockedList(store.guild(guild.id));
  assert.deepEqual(Object.keys(list), [BAD_SERVER]);
  assert.deepEqual(list[BAD_SERVER].invites, ['VFQkDSb5rq', 'anonymouse']);
});

test('anyone wearing the blocked server’s tag is restricted; others and staff are not', async () => {
  const { guild, add, logged } = setup();
  await blockedServers.prepare(guild);
  restricted.length = 0;
  add('tagged', { tagGuild: BAD_SERVER });
  add('other-tag', { tagGuild: '123' });
  add('plain');
  add('mod', { tagGuild: BAD_SERVER, staff: true });

  assert.equal(await blockedServers.sweep(guild), 1);
  assert.deepEqual(restricted.map((r) => r.id), ['tagged']);
  assert.equal(restricted[0].reason, 'Please make a ticket', 'what they’re told');
  assert.ok(logged.some((l) => /<@tagged>/.test(l) && /ANON.*Bad Server/.test(l)), 'the mod log says what was found');
  assert.ok(logged.some((l) => /Staff member <@mod>/.test(l)), 'the owner is told about staff instead');
  const staffWarnings = logged.filter((l) => /Staff member <@mod>/.test(l)).length;

  // Already restricted: not done twice. And the staff warning isn't repeated every 30 seconds.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await blockedServers.sweep(guild), 0);
  assert.equal(logged.filter((l) => /Staff member <@mod>/.test(l)).length, staffWarnings);
});

test('a new member wearing the tag is caught when they join', async () => {
  const { guild, add } = setup();
  await blockedServers.prepare(guild);
  restricted.length = 0;
  const member = add('joiner', { tagGuild: BAD_SERVER });
  assert.equal((await blockedServers.checkMember(member, { fresh: true }))?.ok, true);
  assert.deepEqual(restricted.map((r) => r.id), ['joiner']);
});

test('posting an invite to the blocked server (even disguised) deletes it and restricts them', async () => {
  const { guild, client, add, logged } = setup();
  await blockedServers.prepare(guild);
  restricted.length = 0;
  const member = add('poster');
  const message = { guildId: guild.id, client, deleted: false, delete: async () => (message.deleted = true) };

  assert.equal(await blockedServers.checkMessage(message, member, 'join discord . gg / anonymouse'), true);
  assert.ok(message.deleted);
  assert.equal(restricted[0].reason, 'Please make a ticket');
  assert.ok(logged.some((l) => /invite to \*\*Bad Server/.test(l)));

  const other = add('innocent');
  assert.equal(await blockedServers.checkMessage({ guildId: guild.id, client, delete: async () => {} }, other, 'hello there'), false);
});
