'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// /verifybutton: posts an announcement with a working Verify button, the ready-made English + Russian one or your own
// text, with the same rules as /post (only where you could post yourself, only pings you're allowed to use).

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-verifybutton-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField } = require('discord.js');
const { runCommand, definitions } = require('../src/commands');

function run({ text = null, title = null, ping = null, canPost = true, canPingEveryone = true } = {}) {
  const posted = [];
  const replies = [];
  const perms = (flags) => ({ has: (p) => [].concat(p).every((x) => flags.includes(x)) });
  const allFlags = Object.values(PermissionsBitField.Flags);
  const channel = {
    id: 'announcements',
    isTextBased: () => true,
    toString: () => '<#announcements>',
    permissionsFor: (who) => (who === 'me' ? perms(allFlags) : perms(canPost ? allFlags : [])),
    send: async (p) => (posted.push(p), { url: 'https://discord.com/channels/1/2/3' }),
  };
  const interaction = {
    commandName: 'verifybutton',
    guild: { id: 'guild-vb', members: { me: 'me' } },
    guildId: 'guild-vb',
    member: { permissions: new PermissionsBitField(canPingEveryone ? [PermissionsBitField.Flags.MentionEveryone] : []) },
    channel,
    options: {
      getChannel: () => null,
      getString: (name) => ({ text, title, ping })[name] ?? null,
      getRole: () => null,
    },
    deferred: false,
    replied: false,
    reply: async (p) => replies.push(p.content),
    editReply: async (p) => replies.push(p.content),
  };
  return { interaction, posted, replies };
}

test('the command exists and is for Manage Server', () => {
  const def = definitions.find((d) => d.name === 'verifybutton').toJSON();
  assert.equal(def.default_member_permissions, String(PermissionsBitField.Flags.ManageGuild));
});

test('posts the ready-made English + Russian announcement with a working Verify button', async () => {
  const { interaction, posted, replies } = run({ ping: 'everyone' });
  await runCommand(interaction);
  assert.equal(posted.length, 1);
  const embed = posted[0].embeds[0].toJSON();
  assert.match(embed.description, /only for \*\*verified\*\* members/);
  assert.match(embed.description, /[а-яё]{4,}/i);
  assert.equal(posted[0].components[0].toJSON().components[0].custom_id, 'oj:verify-start', 'the same button as #please-read');
  assert.equal(posted[0].content, '@everyone');
  assert.deepEqual(posted[0].allowedMentions.parse, ['everyone']);
  assert.match(replies.at(-1), /Posted/);
  assert.match(replies.at(-1), /isn’t on yet/, 'warns when verification isn’t set up');
});

test('your own text and title, with \\n for new lines', async () => {
  const { interaction, posted } = run({ text: 'Big update!\\nVerify below.', title: 'Read this' });
  await runCommand(interaction);
  const embed = posted[0].embeds[0].toJSON();
  assert.equal(embed.title, 'Read this');
  assert.equal(embed.description, 'Big update!\nVerify below.');
  assert.equal(posted[0].content, undefined, 'no ping unless asked');
});

test('you can’t post where you couldn’t yourself, or ping @everyone without permission', async () => {
  let r = run({ canPost: false });
  await runCommand(r.interaction);
  assert.equal(r.posted.length, 0);
  assert.match(r.replies[0], /can’t post/);

  r = run({ ping: 'everyone', canPingEveryone: false });
  await runCommand(r.interaction);
  assert.equal(r.posted.length, 0);
  assert.match(r.replies[0], /permission to ping/);
});
