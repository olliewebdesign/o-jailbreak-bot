'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Verification unlocks the new jailbreaks. New joiners get into the server as normal but with Unverified (no
// jailbreaks, just #verify); verifying gives Verified. Anyone in a blocked server is restricted ("Please make a
// ticket"), and verified people are checked again every 30 seconds with their saved login.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-verify-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number
process.env.DISCORD_CLIENT_SECRET = 'test-secret';
process.env.SERVER_IP = '123.45.67.89';
process.env.SERVER_PORT = String(40000 + (process.pid % 20000));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField } = require('discord.js');
const store = require('../src/store');
const restrict = require('../src/restrict');
const verify = require('../src/verify');
const autorole = require('../src/autorole');

const BAD = '900000000000000001';
const UNVERIFIED = 'unverified-role';
const VERIFIED = 'verified-role';
const MEMBER = 'member-role';
const VIP = 'vip-role';

const restricted = [];
restrict.restrictMember = async ({ guild, member, reason }) => {
  restricted.push({ id: member.id, reason });
  store.guild(guild.id).restricted[member.id] = { roles: [] };
  return { ok: true };
};

// Discord's login endpoints, faked. The code they authorized with decides which account and servers come back.
const ACCOUNTS = {
  clean: { id: 'newbie', guilds: ['111', '222'] },
  bad: { id: 'newbie', guilds: ['111', BAD] },
  other: { id: 'someone-else', guilds: [] },
  joiner: { id: 'joiner', guilds: ['111'] },
};
const removedAccess = new Set(); // codes whose user removed the bot under Authorized Apps
let secretWrong = false; // the Client Secret in .env is wrong
const discordDown = new Set(); // codes Discord is having trouble with
const revoked = [];
const realFetch = global.fetch;
const codeOf = (token) => String(token).replace(/^(tok|ref)-/, '').replace(/-r$/, '');
global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://discord.com/api/')) return realFetch(url, init);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const fail = (status, body = {}) => ({ ok: false, status, json: async () => body });
  const form = new URLSearchParams(init.body ?? '');
  if (u.endsWith('/oauth2/token/revoke')) return revoked.push(form.get('token')), ok({});
  if (u.endsWith('/oauth2/token')) {
    if (form.get('grant_type') === 'refresh_token') {
      if (secretWrong) return fail(401, { error: 'invalid_client' });
      const code = codeOf(form.get('refresh_token'));
      return removedAccess.has(code) ? fail(400, { error: 'invalid_grant' }) : ok({ access_token: `tok-${code}-r`, refresh_token: `ref-${code}`, expires_in: 604800 });
    }
    return ok({ access_token: `tok-${form.get('code')}`, refresh_token: `ref-${form.get('code')}`, expires_in: 604800 });
  }
  const code = codeOf(String(init.headers?.Authorization ?? '').replace('Bearer ', ''));
  if (removedAccess.has(code)) return fail(401);
  if (discordDown.has(code)) return fail(500);
  if (u.endsWith('/users/@me')) return ok({ id: ACCOUNTS[code].id });
  if (u.endsWith('/users/@me/guilds')) return ok(ACCOUNTS[code].guilds.map((id) => ({ id })));
  throw new Error(`unexpected ${u}`);
};

let n = 0;
function setup() {
  const logged = [];
  const dms = [];
  const log = { isTextBased: () => true, send: async (p) => logged.push(p.content) };
  const members = new Collection();
  const roles = new Collection([UNVERIFIED, VERIFIED, MEMBER, VIP].map((id) => [id, { id, name: id, editable: true }]));
  const guild = {
    id: `guild-verify-${n++}`,
    name: 'Mine',
    ownerId: 'owner',
    roles: { cache: roles },
    members: { cache: members, fetch: async (id) => (id ? members.get(id) ?? null : members) },
    channels: { cache: new Collection(), fetch: async () => log },
  };
  const client = { application: { id: 'app-id' }, user: { id: 'bot' }, guilds: { cache: new Collection([[guild.id, guild]]) } };
  guild.client = client;
  const settings = store.guild(guild.id);
  Object.assign(settings, { logChannelId: 'log', autoroleId: MEMBER, vipRoleId: VIP });
  Object.assign(settings.verify, { enabled: true, startedAt: Date.now() - 60_000, roleId: UNVERIFIED, verifiedRoleId: VERIFIED, channelId: 'verify' });
  settings.blockedServers = { [BAD]: { name: 'Bad Server', invites: ['anonymouse'] } };

  const add = (id, { joinedAt = Date.now(), roleIds = [] } = {}) => {
    const member = {
      id,
      guild,
      client,
      joinedTimestamp: joinedAt,
      pending: false,
      permissions: new PermissionsBitField(),
      user: { id, tag: id, bot: false },
      roles: {
        cache: new Collection(roleIds.map((r) => [r, roles.get(r)])),
        add: async (r) => member.roles.cache.set(r.id ?? r, roles.get(r.id ?? r)),
        remove: async (r) => member.roles.cache.delete(r.id ?? r),
      },
      send: async (text) => dms.push(text),
    };
    members.set(id, member);
    return member;
  };
  const verifyWith = (userId, code) => {
    const state = `state-${Math.random()}`;
    verify._states.set(state, { guildId: guild.id, userId, at: Date.now() });
    return verify.handleCallback(client, new URL(`http://x/callback?code=${code}&state=${state}`));
  };
  return { guild, client, settings, add, logged, dms, verifyWith };
}

const has = (member, role) => member.roles.cache.has(role);

test('the web address comes from VERIFY_URL, or the IP and port Bot-Hosting.net gives the server', () => {
  assert.equal(verify.publicUrl(), `http://123.45.67.89:${process.env.SERVER_PORT}`);
  assert.equal(verify.publicUrl({ VERIFY_URL: '1.2.3.4:5000' }), 'http://1.2.3.4:5000');
  assert.equal(verify.publicUrl({ SERVER_IP: '0.0.0.0', SERVER_PORT: '1' }), null, 'an address nobody can reach isn’t used');
});

test('a new joiner gets Unverified and no member role until they verify', async () => {
  const { add, settings } = setup();
  const member = add('newbie');
  assert.equal(await verify.onJoin(member), true);
  assert.ok(has(member, UNVERIFIED));
  assert.equal(await autorole.giveAutorole(member), false, 'the member role waits until they verify');
  assert.ok(!has(member, MEMBER));
  assert.equal(settings.verify.held.newbie.existing, false);
});

test('members who were here before verification started never get Unverified', async () => {
  const { guild, settings, add } = setup();
  const old = add('old-timer', { joinedAt: settings.verify.startedAt - 86_400_000, roleIds: [MEMBER] });
  const missed = add('joined-while-offline', { joinedAt: Date.now(), roleIds: [MEMBER] });
  await verify.resume(guild);
  assert.ok(!has(old, UNVERIFIED));
  assert.ok(has(missed, UNVERIFIED), 'someone who joined while the bot was off is still a new joiner');
});

test('a new joiner who verifies loses Unverified (#verify disappears) and gets Verified; their login is kept for the checks', async () => {
  const { settings, add, logged, verifyWith, guild } = setup();
  const member = add('newbie', { roleIds: [UNVERIFIED, MEMBER] });
  const result = await verifyWith('newbie', 'clean');
  assert.match(result.body, /You’re verified/);
  assert.ok(!has(member, UNVERIFIED));
  assert.ok(has(member, VERIFIED));
  assert.equal(settings.verify.verified.newbie.newJoiner, true);
  assert.equal(settings.verify.verified.newbie.guilds, undefined, 'their server list isn’t saved');
  assert.ok(verify._tokens()[`${guild.id}:newbie`], 'login kept for the 30-second checks');
  assert.ok(!revoked.includes('tok-clean'));
  assert.ok(logged.some((l) => /verified/.test(l)));
});

test('an existing member who verifies just gets Verified', async () => {
  const { add, verifyWith } = setup();
  const member = add('newbie', { joinedAt: Date.now() - 1e10, roleIds: [MEMBER] });
  await verifyWith('newbie', 'clean');
  assert.ok(has(member, VERIFIED));
  assert.ok(has(member, MEMBER));
  assert.ok(!has(member, UNVERIFIED));
});

test('verifying while in a blocked server: restricted with “Please make a ticket”, login thrown away', async () => {
  const { add, logged, verifyWith, guild } = setup();
  restricted.length = 0;
  const member = add('newbie', { roleIds: [UNVERIFIED] });
  const result = await verifyWith('newbie', 'bad');
  assert.match(result.body, /make a ticket/);
  assert.deepEqual(restricted, [{ id: 'newbie', reason: 'Please make a ticket' }]);
  assert.ok(logged.some((l) => /Bad Server/.test(l) && /found when they verified/.test(l)), 'the mod log says what was found');
  assert.ok(has(member, UNVERIFIED), 'Unverified stays (saved with their roles), so being unrestricted later doesn’t skip verifying');
  assert.ok(!has(member, VERIFIED));
  assert.ok(revoked.includes('tok-bad'));
  assert.ok(!verify._tokens()[`${guild.id}:newbie`]);
});

test('a link only works once, for the person who pressed Verify, with the same account', async () => {
  const { guild, client, add } = setup();
  const member = add('newbie', { roleIds: [UNVERIFIED] });
  const state = 'one-use';
  verify._states.set(state, { guildId: guild.id, userId: 'newbie', at: Date.now() });
  const wrong = await verify.handleCallback(client, new URL(`http://x/callback?code=other&state=${state}`));
  assert.match(wrong.body, /Wrong account/);
  assert.ok(revoked.includes('tok-other'));
  assert.ok(has(member, UNVERIFIED));
  assert.match((await verify.handleCallback(client, new URL(`http://x/callback?code=clean&state=${state}`))).body, /expired/);
  assert.match((await verify.handleCallback(client, new URL('http://x/callback?error=access_denied&state=x'))).body, /cancelled/);
});

test('the 30-second check restricts a verified person who joins the blocked server later', async () => {
  const { client, add, logged, verifyWith } = setup();
  const member = add('joiner', { roleIds: [UNVERIFIED, MEMBER] });
  await verifyWith('joiner', 'joiner');
  assert.ok(has(member, VERIFIED));

  restricted.length = 0;
  let round = await verify.scanOnce(client);
  assert.equal(restricted.length, 0);
  assert.ok(round.checked >= 1);

  ACCOUNTS.joiner.guilds.push(BAD); // they join anonymouse
  round = await verify.scanOnce(client);
  assert.deepEqual(restricted, [{ id: 'joiner', reason: 'Please make a ticket' }]);
  assert.ok(logged.some((l) => /Bad Server/.test(l) && /30-second check/.test(l)));
  ACCOUNTS.joiner.guilds.pop();
});

test('removing the bot’s access undoes verification; Discord having problems doesn’t', async () => {
  const { client, guild, add, dms, verifyWith } = setup();
  ACCOUNTS.leaver = { id: 'leaver', guilds: ['111'] };
  const member = add('leaver', { roleIds: [UNVERIFIED, MEMBER] });
  await verifyWith('leaver', 'leaver');
  assert.ok(has(member, VERIFIED));

  discordDown.add('leaver');
  await verify.scanOnce(client);
  assert.ok(has(member, VERIFIED), 'a Discord outage never unverifies anyone');
  discordDown.delete('leaver');

  removedAccess.add('leaver');
  await verify.scanOnce(client);
  assert.ok(!has(member, VERIFIED));
  assert.ok(has(member, UNVERIFIED), 'a new joiner goes back to Unverified');
  assert.ok(!verify._tokens()[`${guild.id}:leaver`]);
  assert.match(dms.at(-1), /no longer verified/);
});

test('rejoining: with a saved login they get Verified back (and are still checked); without one they verify again', async () => {
  const { settings, add, verifyWith, guild } = setup();
  ACCOUNTS.back = { id: 'back', guilds: [] };
  const first = add('back', { roleIds: [UNVERIFIED] });
  await verifyWith('back', 'back');
  guild.members.cache.delete('back');
  const again = add('back');
  assert.equal(await verify.onJoin(again), false);
  assert.ok(has(again, VERIFIED));
  assert.ok(!has(again, UNVERIFIED));
  assert.ok(first);

  settings.verify.verified.nologin = { at: Date.now(), blocked: [] };
  const noLogin = add('nologin');
  assert.equal(await verify.onJoin(noLogin), true);
  assert.ok(has(noLogin, UNVERIFIED));
});

test('the messages explain it in English and Russian, with a Verify button', () => {
  for (const panel of [verify.verifyChannelPanel(), verify.oldSectionNotice()]) {
    const text = JSON.stringify(panel.embeds.map((e) => e.toJSON()));
    assert.match(text, /Verify/);
    assert.match(text, /[а-яё]{4,}/i, 'has Russian');
    assert.match(text, /<@100000000000000001>/, 'says who to message (a clickable @)');
    assert.equal(panel.components[0].toJSON().components[0].custom_id, 'oj:verify-start');
  }
});

test('the web server answers Discord’s redirect', async () => {
  const { guild, client, add } = setup();
  ACCOUNTS.web = { id: 'web', guilds: [] };
  add('web', { roleIds: [UNVERIFIED] });
  const server = verify.startServer(client);
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  verify._states.set('state-http', { guildId: guild.id, userId: 'web', at: Date.now() });
  const res = await realFetch(`http://127.0.0.1:${process.env.SERVER_PORT}/callback?code=web&state=state-http`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /You’re verified/);
  server.close();
});

test('a wrong Client Secret in .env pauses the 30-second checks — nobody is unverified', async () => {
  const { client, guild, add, verifyWith } = setup();
  ACCOUNTS.patient = { id: 'patient', guilds: ['111'] };
  const member = add('patient', { roleIds: [UNVERIFIED, MEMBER] });
  await verifyWith('patient', 'patient');
  assert.ok(has(member, VERIFIED));

  verify._tokens()[`${guild.id}:patient`].expiresAt = Date.now() - 1000; // their login needs refreshing
  removedAccess.add('patient'); // and Discord refuses the old one…
  secretWrong = true; // …but the refresh fails because OUR secret is wrong
  const round = await verify.scanOnce(client);
  secretWrong = false;
  removedAccess.delete('patient');
  assert.equal(round.paused, true);
  assert.ok(has(member, VERIFIED), 'still verified');
  assert.ok(verify._tokens()[`${guild.id}:patient`], 'login kept');
});

test('the 🔄 Recheck link: their login is kept and the result goes to their appeal ticket — it never verifies them', async () => {
  const { guild, client, add, settings } = setup();
  ACCOUNTS.rechecker = { id: 'rechecker', guilds: [BAD, '123'] };
  const member = add('rechecker');
  settings.restricted.rechecker = { roles: [], reason: 'Please make a ticket', blockedServers: [], ticketChannelId: null };
  const recheck = require('../src/appealRecheck');
  const real = recheck.afterLogin;
  const calls = [];
  recheck.afterLogin = async (g, id, ids) => calls.push({ id, ids });
  try {
    verify._states.set('recheck-state', { guildId: guild.id, userId: 'rechecker', at: Date.now(), purpose: 'recheck' });
    const res = await verify.handleCallback(client, new URL('http://x/callback?code=rechecker&state=recheck-state'));
    assert.match(res.body, /Checked ✅/);
    assert.deepEqual(calls, [{ id: 'rechecker', ids: [BAD, '123'] }]);
    assert.ok(verify._tokens()[`${guild.id}:rechecker`], 'kept, so the next recheck is instant');
    assert.ok(!has(member, VERIFIED), 'not verified by it');
  } finally {
    recheck.afterLogin = real;
  }
});
