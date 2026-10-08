'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Forwarding a message from a VIP-only channel into a channel ordinary members can see: the forward is deleted and
// the person is restricted ("Leaking VIP content"). Forwards elsewhere, normal replies, and staff are left alone.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-vipleak-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, MessageReferenceType, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const config = require('../config');
const store = require('../src/store');
const restrict = require('../src/restrict');
const automod = require('../src/automod');

const GUILD = 'guild-vipleak';
const MEMBER = config.updating.memberRoleIds[0];
const VIP = config.updating.vipRoleId;

const restricted = [];
restrict.restrictMember = async ({ member, reason }) => {
  restricted.push({ id: member.id, reason });
  store.guild(GUILD).restricted[member.id] = { roles: [], reason };
  return { ok: true };
};

// Channels: who (by role) can see each one.
const VISIBLE = {
  'vip-prompts': [VIP],
  'vip-chat': [VIP],
  general: [GUILD, MEMBER, VIP],
  'staff-only': [],
};
const channel = (id) => ({
  id,
  parentId: null,
  permissionsFor: (roleId) => ({ has: (p) => p === P.ViewChannel && VISIBLE[id].includes(roleId) }),
});
const channels = new Collection(Object.keys(VISIBLE).map((id) => [id, channel(id)]));
const logged = [];
const guild = {
  id: GUILD,
  name: 'Test',
  ownerId: 'owner',
  roles: { cache: new Collection([GUILD, MEMBER, VIP].map((id) => [id, { id }])) },
  channels: { cache: channels, fetch: async (id) => (id === 'log' ? { isTextBased: () => true, send: async (p) => logged.push(p.content) } : channels.get(id) ?? null) },
  members: { fetch: async () => null },
  client: { user: { id: 'bot', tag: 'O Jailbreak' } },
};
store.guild(GUILD).logChannelId = 'log';

function forward({ from, to, by = 'leaker', staff = false, type = MessageReferenceType.Forward }) {
  const member = {
    id: by,
    guild,
    user: { id: by, username: by, bot: false },
    roles: { cache: new Collection([[VIP, {}]]) },
    permissions: new PermissionsBitField(staff ? [PermissionsBitField.Flags.ManageMessages] : []),
  };
  const message = {
    id: `m-${Math.random()}`,
    guild,
    guildId: GUILD,
    channelId: to,
    channel: channels.get(to),
    author: member.user,
    member,
    content: '',
    messageSnapshots: new Collection([['s', { content: 'SECRET VIP PROMPT' }]]),
    attachments: new Collection(),
    mentions: { users: new Collection(), roles: new Collection() },
    reference: { type, channelId: from, guildId: GUILD, messageId: 'orig' },
    inGuild: () => true,
    deleted: false,
    delete: async () => {
      message.deleted = true;
    },
  };
  return message;
}

test('forwarding from a VIP channel into a public channel: deleted, restricted, logged', async () => {
  restricted.length = 0;
  const message = forward({ from: 'vip-prompts', to: 'general' });
  assert.equal(await automod.handleMessage(message), 'vip-leak');
  assert.ok(message.deleted);
  assert.deepEqual(restricted, [{ id: 'leaker', reason: 'Leaking VIP content' }]);
  assert.ok(logged.some((l) => /forwarding VIP content/.test(l) && /<#vip-prompts>/.test(l) && /<#general>/.test(l) && /SECRET VIP PROMPT/.test(l)));
});

test('forwards that don’t leak anything are left alone', async () => {
  restricted.length = 0;
  for (const [from, to] of [
    ['vip-prompts', 'vip-chat'], // VIP to VIP
    ['vip-prompts', 'staff-only'], // into a staff channel
    ['general', 'general'], // from a public channel
  ]) {
    const message = forward({ from, to, by: `ok-${from}-${to}` });
    assert.notEqual(await automod.handleMessage(message), 'vip-leak', `${from} → ${to}`);
    assert.ok(!message.deleted, `${from} → ${to} not deleted`);
  }
  assert.equal(restricted.length, 0);
});

test('staff forwarding VIP content is fine, and normal replies aren’t forwards', async () => {
  restricted.length = 0;
  const staff = forward({ from: 'vip-prompts', to: 'general', by: 'a-mod', staff: true });
  await automod.handleMessage(staff);
  assert.ok(!staff.deleted);
  const reply = forward({ from: 'vip-prompts', to: 'general', by: 'replier', type: MessageReferenceType.Default });
  assert.notEqual(await automod.handleMessage(reply), 'vip-leak');
  assert.equal(restricted.length, 0);
});
