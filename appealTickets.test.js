'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Appeal tickets: someone restricted who leaves and rejoins gets their ticket back (Discord removes their access when
// they leave), and banning someone with an open appeal closes it as "Banned".

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-appealtickets-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, OverwriteType } = require('discord.js');
const store = require('../src/store');
const restrict = require('../src/restrict');

let n = 0;
function server() {
  const logged = [];
  const ticketMessages = [];
  const overwrites = [];
  let canSee = false;
  const ticket = {
    id: 'ticket-1',
    toString: () => '<#ticket-1>',
    permissionsFor: () => ({ has: () => canSee }),
    permissionOverwrites: { edit: async (id, perms, opts) => (overwrites.push({ id, perms, type: opts.type }), (canSee = true)) },
    send: async (p) => ticketMessages.push(typeof p === 'string' ? p : p.content),
    messages: { fetch: async () => new Collection() },
    delete: async () => {},
    name: 'appeal-alice',
  };
  const log = { isTextBased: () => true, send: async (p) => logged.push(p) };
  const guild = {
    id: `guild-tickets-${n++}`,
    name: 'Mine',
    client: { user: { id: 'bot', tag: 'O Jailbreak' } },
    channels: { cache: new Collection([['ticket-1', ticket]]), fetch: async (id) => (id === 'log' ? log : null) },
    fetchAuditLogs: async () => ({ entries: new Collection([['1', { target: { id: 'alice' }, executor: { id: 'admin', tag: 'admin' } }]]) }),
  };
  const settings = store.guild(guild.id);
  Object.assign(settings, { logChannelId: 'log' });
  settings.restrict.roleId = 'restricted-role';
  settings.restricted.alice = { by: 'mod', reason: 'x', at: Date.now(), roles: [], ticketChannelId: 'ticket-1' };
  const member = { id: 'alice', guild, user: { id: 'alice', tag: 'alice' }, roles: { add: async () => {} } };
  return { guild, settings, member, ticket, overwrites, ticketMessages, logged };
}

test('someone restricted who leaves and rejoins can see their appeal ticket again', async () => {
  const s = server();
  assert.equal(await restrict.reapplyIfRestricted(s.member), true);
  assert.equal(s.overwrites.length, 1);
  assert.equal(s.overwrites[0].id, 'alice');
  assert.equal(s.overwrites[0].type, OverwriteType.Member);
  assert.equal(s.overwrites[0].perms.ViewChannel, true);
  assert.equal(s.overwrites[0].perms.SendMessages, true);
  assert.match(s.ticketMessages.at(-1), /<@alice> rejoined — they can see this appeal again/);
  assert.ok(s.logged.some((p) => /can see their appeal/.test(p.content)));
  assert.equal(s.settings.restricted.alice.ticketChannelId, 'ticket-1', 'still the same ticket');
});

test('if their ticket was deleted while they were gone, they can open a new one', async () => {
  const s = server();
  s.guild.channels.cache.delete('ticket-1');
  await restrict.reapplyIfRestricted(s.member);
  assert.equal(s.settings.restricted.alice.ticketChannelId, null);
});

test('pressing “Open an appeal ticket” with a ticket they can’t see gives it back', async () => {
  const s = server();
  const replies = [];
  await restrict.appealButton(
    {
      guild: s.guild,
      user: s.member.user,
      member: s.member,
      reply: async (p) => replies.push(p.content),
      editReply: async (p) => replies.push(p.content),
    },
    'appeal-open',
  );
  assert.equal(s.overwrites.length, 1);
  assert.match(replies.at(-1), /already have an appeal open: <#ticket-1>/);
});

test('banning someone with an open appeal closes it as “Banned”, with the chat saved', async () => {
  const s = server();
  await restrict.onBanAdd({ guild: s.guild, user: { id: 'alice', tag: 'alice' } });
  assert.equal(s.settings.restricted.alice.ticketChannelId, null);
  assert.match(s.ticketMessages.at(-1), /closed \(\*\*Banned\*\*\)/);
  const closed = s.logged.find((p) => /Appeal from <@alice> closed by <@admin> — \*\*Banned\*\*/.test(p.content));
  assert.ok(closed, 'logged with who banned them');
  assert.equal(closed.files[0].name, 'appeal-alice.txt', 'with the chat transcript');
});

test('banning someone without an appeal does nothing extra', async () => {
  const s = server();
  s.settings.restricted.alice.ticketChannelId = null;
  await restrict.onBanAdd({ guild: s.guild, user: { id: 'alice', tag: 'alice' } });
  assert.equal(s.ticketMessages.length, 0);
});
