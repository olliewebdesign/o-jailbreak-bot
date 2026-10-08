'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// The 🔄 Recheck button in the appeal ticket of someone restricted for a blocked server: are they still in it?

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-recheck-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const store = require('../src/store');
const restrict = require('../src/restrict');
const verify = require('../src/verify');
const recheck = require('../src/appealRecheck');

const BAD = '900000000000000001';
let lists = {}; // userId -> their server list (what their saved login would show), or undefined = no saved login
verify.serverListOf = async (guild, userId) => lists[userId] ?? null;
verify.hasSavedLogin = async (guild, userId) => Boolean(lists[userId]);
verify.recheckLink = () => 'https://discord.com/oauth2/authorize?state=x';

let n = 0;
function setup() {
  recheck._pressedAt.clear();
  lists = {};
  const posted = [];
  const users = new Map();
  const members = new Collection();
  const ticket = { id: 'ticket', send: async (p) => (posted.push(p), { id: 'm' }) };
  const guild = {
    id: `guild-recheck-${n++}`,
    name: 'Mine',
    ownerId: 'owner',
    client: { user: { id: 'bot' }, users: { fetch: async (id) => users.get(id) ?? null } },
    channels: { cache: new Collection([['ticket', ticket]]) },
    members: { cache: members, fetch: async (id) => members.get(id) ?? null },
  };
  const settings = store.guild(guild.id);
  settings.blockedServers = { [BAD]: { name: 'anonymouse', invites: ['anonymouse'], icon: null } };
  settings.restricted.anon = { roles: [], reason: 'Please make a ticket', blockedServers: [{ id: BAD, name: 'anonymouse', icon: null }], ticketChannelId: 'ticket' };
  const add = (id, { admin = false, tag = null, globalName = null } = {}) => {
    const user = { id, tag: id, username: id, globalName, primaryGuild: tag ? { identityGuildId: BAD, identityEnabled: true, tag } : null };
    users.set(id, user);
    const member = { id, guild, user, nickname: null, roles: { cache: new Collection() }, permissions: new PermissionsBitField(admin ? [P.Administrator] : []) };
    members.set(id, member);
    return member;
  };
  const press = (member, userId = 'anon') => {
    const replies = [];
    const interaction = {
      guild,
      user: member.user,
      member,
      deferReply: async () => (interaction.deferred = true),
      reply: async (p) => replies.push(p),
      editReply: async (p) => replies.push(p),
    };
    return recheck.recheckButton(interaction, userId).then(() => replies);
  };
  return { guild, settings, add, press, posted };
}

const text = (reply) => (reply.embeds?.[0]?.toJSON?.() ?? reply.embeds?.[0])?.description ?? reply.content ?? '';

test('an admin rechecks: still in anonymouse → “Not yet”; left → “Looks like they’ve left”', async () => {
  const s = setup();
  s.add('anon');
  const admin = s.add('admin', { admin: true });
  lists.anon = ['123', BAD];
  let [reply] = await s.press(admin);
  assert.match(text(reply), /❌ \*\*Still in anonymouse\*\*/);
  assert.match(text(reply), /Not yet/);

  recheck._pressedAt.clear();
  lists.anon = ['123'];
  [reply] = await s.press(admin);
  assert.match(text(reply), /✅ Not in \*\*anonymouse\*\* any more/);
  assert.match(text(reply), /Looks like they’ve left/);
  assert.equal(reply.flags, undefined, 'posted in the ticket for both to see');
});

test('their profile is checked too: still wearing the tag or using the name counts', async () => {
  const s = setup();
  s.add('anon', { tag: 'ANON', globalName: 'an0nym0use' });
  lists.anon = ['123'];
  const [reply] = await s.press(s.add('admin', { admin: true }));
  assert.match(text(reply), /Still wearing the \*\*ANON\*\* tag of \*\*anonymouse\*\*/);
  assert.match(text(reply), /Still using the name \*\*anonymouse\*\*/);
  assert.match(text(reply), /Not yet/);
});

test('no saved login: they get a one-time link to let me check; an admin is told to ask them', async () => {
  const s = setup();
  const anon = s.add('anon');
  let [reply] = await s.press(anon);
  assert.equal(reply.flags !== undefined, true, 'just for them');
  assert.equal(reply.components[0].components[0].data.url, 'https://discord.com/oauth2/authorize?state=x');

  recheck._pressedAt.clear();
  [reply] = await s.press(s.add('admin', { admin: true }));
  assert.match(text(reply), /can’t see their server list/);
  assert.match(text(reply), /Can’t tell yet/);
});

test('only they or an admin can press it, and not twice in 30 seconds', async () => {
  const s = setup();
  s.add('anon');
  let [reply] = await s.press(s.add('random'));
  assert.match(reply.content, /Only they or an admin/);
  const admin = s.add('admin', { admin: true });
  lists.anon = ['123'];
  await s.press(admin);
  [reply] = await s.press(admin);
  assert.match(reply.content, /try again in \d+ seconds/);
});

test('after they authorize from the link, the result is posted in their ticket', async () => {
  const s = setup();
  s.add('anon');
  await recheck.afterLogin(s.guild, 'anon', ['123']);
  assert.match(text(s.posted[0]), /Looks like they’ve left/);
});

test('open tickets for a blocked server get the button once; ordinary appeals don’t', async () => {
  const s = setup();
  s.settings.restricted.ordinary = { roles: [], reason: 'Spamming', ticketChannelId: 'ticket' };
  await recheck.addToOpenTickets(s.guild);
  await recheck.addToOpenTickets(s.guild);
  assert.equal(s.posted.length, 1);
  assert.equal(s.posted[0].components[0].components[0].data.custom_id, 'oj:appeal-recheck:anon');
  assert.ok(restrict.blockedServersFor(s.settings, s.settings.restricted.anon).length);
});
