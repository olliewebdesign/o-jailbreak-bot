'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Someone restricted for being in a blocked server (like anonymouse) opens an appeal: the ticket asks them to leave
// that server, with its icon, and to wait for the team. Other appeals don't get it.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-appealleave-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField } = require('discord.js');
const store = require('../src/store');
const restrict = require('../src/restrict');
const blockedServers = require('../src/blockedServers');

const BAD = '900000000000000001';
const ICON = 'https://cdn.discordapp.com/icons/900000000000000001/abc.png';
let n = 0;

function server() {
  const sent = []; // everything posted in the new ticket
  const categories = new Collection([['appeals', { id: 'appeals', type: 4 }]]);
  const guild = {
    id: `guild-appeal-${n++}`,
    name: 'Mine',
    ownerId: 'owner',
    roles: { cache: new Collection() },
    channels: {
      cache: categories,
      fetch: async () => null,
      create: async (opts) => {
        const channel = { id: `ticket-${n++}`, name: opts.name, send: async (p) => sent.push(p), toString: () => '<#ticket>' };
        return channel;
      },
    },
  };
  const settings = store.guild(guild.id);
  Object.assign(settings.restrict, { roleId: 'restricted-role', categoryId: 'appeals' });
  settings.blockedServers = { [BAD]: { name: 'anonymouse', invites: ['anonymouse'], icon: ICON } };
  const replies = [];
  const press = (userId) =>
    restrict.appealButton(
      {
        guild,
        user: { id: userId, tag: userId, username: userId },
        member: { roles: { cache: new Collection([['restricted-role', {}]]) } },
        deferReply: async () => {},
        editReply: async (p) => replies.push(p.content ?? p),
        reply: async (p) => replies.push(p.content ?? p),
        deferred: true,
      },
      'appeal-open',
    );
  return { guild, settings, sent, press, replies };
}

const leaveNotices = (sent) => sent.flatMap((p) => p.embeds ?? []).map((e) => (e.toJSON ? e.toJSON() : e)).filter((e) => /Please leave that Discord/.test(e.description ?? ''));

test('an appeal from someone restricted for anonymouse asks them to leave it, with its icon', async () => {
  const s = server();
  s.settings.restricted.alice = { by: 'bot', reason: 'Please make a ticket', at: Date.now(), roles: [], blockedServers: [{ id: BAD, name: 'anonymouse', icon: ICON }] };
  await s.press('alice');
  const [notice] = leaveNotices(s.sent);
  assert.ok(notice, 'the leave message was posted in the ticket');
  assert.match(notice.title, /anonymouse/);
  assert.equal(notice.thumbnail.url, ICON);
  assert.match(notice.description, /You are restricted because you are in the anonymouse server/);
  assert.match(notice.description, /to be a part of our community/);
  assert.match(notice.description, /wait patiently for our team to review and confirm/);
  assert.match(notice.description, /[а-яё]{4,}/i, 'and in Russian');
  const recheck = s.sent.find((p) => p.components?.[0]?.components?.[0]?.data?.custom_id === 'oj:appeal-recheck:alice');
  assert.ok(recheck, 'with a 🔄 Recheck button');
  assert.ok(s.sent.indexOf(recheck) > s.sent.findIndex((p) => (p.embeds ?? []).length && /Please leave/.test(JSON.stringify(p.embeds))), 'under the leave message');
});

test('people restricted for anonymouse before this update are recognised by their reason', async () => {
  const s = server();
  s.settings.restricted.bob = { by: 'bot', reason: 'Please make a ticket', at: Date.now(), roles: [] };
  await s.press('bob');
  assert.equal(leaveNotices(s.sent).length, 1);
});

test('an ordinary appeal doesn’t get it', async () => {
  const s = server();
  s.settings.restricted.carol = { by: 'mod', reason: 'Spamming in general', at: Date.now(), roles: [] };
  await s.press('carol');
  assert.equal(leaveNotices(s.sent).length, 0);
  assert.ok(s.sent.length >= 1, 'the normal appeal message is still there');
});

test('being restricted for a blocked server remembers which one', async () => {
  const guild = { id: `guild-remember-${n++}`, ownerId: 'owner', client: { user: { id: 'bot', tag: 'bot' } }, channels: { fetch: async () => null } };
  const settings = store.guild(guild.id);
  settings.blockedServers = { [BAD]: { name: 'anonymouse', invites: [], icon: ICON } };
  const realRestrict = restrict.restrictMember;
  restrict.restrictMember = async ({ member }) => {
    settings.restricted[member.id] = { roles: [], reason: 'Please make a ticket' };
    return { ok: true };
  };
  try {
    const member = { id: 'dave', guild, user: { id: 'dave', bot: false }, roles: { cache: new Collection() }, permissions: new PermissionsBitField() };
    await blockedServers.restrictAssociated(member, 'wearing the tag of **anonymouse**', [BAD]);
    assert.deepEqual(settings.restricted.dave.blockedServers, [{ id: BAD, name: 'anonymouse', icon: ICON }]);
  } finally {
    restrict.restrictMember = realRestrict;
  }
});
