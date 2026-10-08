'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// /massban (server owner only): pasted IDs are banned in one go (even people not in the server); the owner, the bot
// and trusted users never are.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-massban-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField } = require('discord.js');
const store = require('../src/store');
const { runCommand } = require('../src/commands');

const PASTED = `1. 8000000000000000002
2. 800000000000000004
3. 8000000000000000005
4. 800000000000000006
5. 8000000000000000007
6. 8000000000000000008
7. 8000000000000000009
8. 800000000000000010
9. 8000000000000000011
10. 800000000000000012
11. 8000000000000000013
12. 800000000000000014
13. 8000000000000000015
14. 800000000000000016
15. 8000000000000000017
16. 8000000000000000018
17. 8000000000000000019`;

function run(ids, { owner = 'admin', admin = true } = {}) {
  const calls = [];
  const replies = [];
  const guild = {
    id: `guild-massban-${Math.random()}`,
    ownerId: owner,
    bans: {
      bulkCreate: async (list, options) => {
        calls.push({ list, options });
        return { bannedUsers: list.slice(1), failedUsers: list.slice(0, 1) };
      },
    },
    channels: { fetch: async () => null },
  };
  const interaction = {
    commandName: 'massban',
    guild,
    guildId: guild.id,
    user: { id: 'admin', tag: 'admin' },
    client: { user: { id: 'bot' } },
    member: { permissions: new PermissionsBitField(admin ? [PermissionsBitField.Flags.BanMembers] : []) },
    options: { getString: (n) => (n === 'ids' ? ids : null), getInteger: () => null },
    deferred: false,
    replied: false,
    deferReply: async () => (interaction.deferred = true),
    reply: async (p) => replies.push(p.content),
    editReply: async (p) => replies.push(p.content),
  };
  return { interaction, calls, replies, guild };
}

test('the pasted numbered list is read as 17 IDs and banned in one go', async () => {
  const { interaction, calls, replies } = run(PASTED);
  await runCommand(interaction);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].list.length, 17);
  assert.ok(calls[0].list.includes('8000000000000000002') && calls[0].list.includes('8000000000000000019'));
  assert.ok(!calls[0].list.some((id) => id.length < 17), 'list numbers like "1." aren’t treated as IDs');
  assert.equal(calls[0].options.deleteMessageSeconds, 24 * 3600);
  assert.match(replies.at(-1), /Banned 16 of 17/);
  assert.match(replies.at(-1), /1 couldn’t be banned/);
});

test('the owner, the bot and trusted users are never banned', async () => {
  const { interaction, calls, replies, guild } = run('8000000000000000002 111111111111111111 222222222222222222 bot 333333333333333333', { owner: '111111111111111111' });
  interaction.user.id = '111111111111111111';
  interaction.client.user.id = '222222222222222222';
  store.guild(guild.id).trusted.push('333333333333333333');
  await runCommand(interaction);
  assert.deepEqual(calls[0].list, ['8000000000000000002']);
  assert.match(replies.at(-1), /Skipped 3/);
});

test('only the server owner can use it, not even admins', async () => {
  const { interaction, calls, replies } = run(PASTED, { owner: 'someone-else', admin: true });
  await runCommand(interaction);
  assert.equal(calls.length, 0);
  assert.match(replies[0], /Only the server owner/);
});
