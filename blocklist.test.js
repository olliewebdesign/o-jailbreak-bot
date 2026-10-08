'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// /blocklist: IDs of known members of a blocked server. Anyone on it who's in the server is restricted
// ("Please make a ticket", with the blocked server remembered for their appeal); anyone on it who joins later too.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-blocklist-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField } = require('discord.js');
const store = require('../src/store');
const restrict = require('../src/restrict');
const blocklist = require('../src/blocklist');
const { runCommand } = require('../src/commands');

const BAD = '900000000000000001';
const restricted = [];
restrict.restrictMember = async ({ guild, member, reason }) => {
  restricted.push({ id: member.id, reason });
  store.guild(guild.id).restricted[member.id] = { roles: [], reason };
  return { ok: true };
};

const IDS = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444'];
let n = 0;
function server() {
  const members = new Collection();
  const guild = {
    id: `guild-blocklist-${n++}`,
    name: 'Mine',
    ownerId: '999999999999999999',
    client: { user: { id: 'bot', tag: 'O Jailbreak' } },
    members: { cache: members, fetch: async (id) => (id ? members.get(id) ?? null : members) },
    channels: { cache: new Collection(), fetch: async () => null },
  };
  const settings = store.guild(guild.id);
  settings.blockedServers = { [BAD]: { name: 'Anonymous', invites: ['anonymouse'], icon: null } };
  const add = (id, { staff = false } = {}) => {
    const member = {
      id,
      guild,
      user: { id, username: id, bot: false },
      roles: { cache: new Collection() },
      permissions: new PermissionsBitField(staff ? [PermissionsBitField.Flags.ModerateMembers] : []),
    };
    members.set(id, member);
    return member;
  };
  return { guild, settings, add };
}

function run(guild, sub, { ids = null, file = null, by = guild.ownerId } = {}) {
  const replies = [];
  const interaction = {
    commandName: 'blocklist',
    guild,
    guildId: guild.id,
    user: { id: by, tag: by, send: async () => {} },
    client: guild.client,
    options: { getSubcommand: () => sub, getString: () => ids, getAttachment: () => file },
    deferred: false,
    replied: false,
    deferReply: async () => (interaction.deferred = true),
    reply: async (p) => replies.push(p.content ?? p),
    editReply: async (p) => replies.push(p.content ?? p),
  };
  return runCommand(interaction).then(() => replies);
}

test('/blocklist add restricts everyone on the list who’s here; staff are skipped', async () => {
  const s = server();
  restricted.length = 0;
  s.add(IDS[0]);
  s.add(IDS[1]);
  s.add(IDS[2], { staff: true });
  const replies = await run(s.guild, 'add', { ids: `1. ${IDS[0]}\n2. ${IDS[1]}\n3. ${IDS[2]}, ${IDS[3]}` });
  assert.deepEqual(restricted.map((r) => r.id).sort(), [IDS[0], IDS[1]]);
  assert.ok(restricted.every((r) => r.reason === 'Please make a ticket'));
  assert.deepEqual(s.settings.restricted[IDS[0]].blockedServers, [{ id: BAD, name: 'Anonymous', icon: null }], 'their appeal will ask them to leave Anonymous');
  assert.match(replies.at(-1), /Added \*\*4\*\*/);
  assert.match(replies.at(-1), /Restricted \*\*2\*\* of the \*\*3\*\*/);
});

test('IDs can come from a .txt file, and the owner/bot can’t be added', async () => {
  const s = server();
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from(`${IDS[3]}\n${s.guild.ownerId}`) });
  try {
    const replies = await run(s.guild, 'add', { file: { url: 'https://cdn/ids.txt', size: 100 } });
    assert.ok(blocklist.isListed(s.guild, IDS[3]));
    assert.ok(!blocklist.isListed(s.guild, s.guild.ownerId));
    assert.match(replies.at(-1), /skipped 1/);
  } finally {
    global.fetch = realFetch;
  }
});

test('someone on the blocklist who joins later is restricted straight away', async () => {
  const s = server();
  restricted.length = 0;
  blocklist.add(s.guild, [IDS[3]], 'owner');
  const joiner = s.add(IDS[3]);
  assert.equal((await blocklist.checkMember(joiner))?.ok, true);
  assert.deepEqual(restricted.map((r) => r.id), [IDS[3]]);
  const stranger = s.add('555555555555555555');
  assert.equal(await blocklist.checkMember(stranger), null);
});

test('/blocklist remove and list', async () => {
  const s = server();
  blocklist.add(s.guild, IDS, 'owner');
  s.add(IDS[0]);
  let replies = await run(s.guild, 'list');
  assert.match(replies.at(-1), /\*\*4\*\* IDs on the blocklist\. \*\*1\*\* of them are in the server/);
  replies = await run(s.guild, 'remove', { ids: `${IDS[0]} ${IDS[1]}` });
  assert.match(replies.at(-1), /Took \*\*2\*\*/);
  assert.ok(!blocklist.isListed(s.guild, IDS[0]));
});

test('only the server owner can use it', async () => {
  const s = server();
  const replies = await run(s.guild, 'add', { ids: IDS[0], by: 'an-admin' });
  assert.match(replies[0], /Only the server owner/);
  assert.ok(!blocklist.isListed(s.guild, IDS[0]));
});
