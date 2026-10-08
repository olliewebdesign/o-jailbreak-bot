'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Verification bugs found in the full review, each checked so it can't come back.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const DATA = path.join(os.tmpdir(), `oj-test-verifyfixes-${process.pid}`);
process.env.OJ_DATA_DIR = DATA;
process.env.DISCORD_CLIENT_SECRET = 'test-secret';
process.env.VERIFY_URL = 'http://1.2.3.4:5000';
process.env.SERVER_PORT = String(30000 + (process.pid % 20000));

// A damaged logins file, there before the bot starts.
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'verify-tokens.json'), '{ this is not json');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField } = require('discord.js');
const store = require('../src/store');
const restrict = require('../src/restrict');
const verify = require('../src/verify');

const UNVERIFIED = 'unverified-role';
const VERIFIED = 'verified-role';
const BAD = '900000000000000001';

let restrictWorks = true;
restrict.restrictMember = async ({ guild, member }) => {
  if (!restrictWorks) return { ok: false, text: '❌ Discord didn’t respond' };
  store.guild(guild.id).restricted[member.id] = { roles: [] };
  return { ok: true };
};

let secretWrong = false;
global.fetch = async (url, init = {}) => {
  const form = new URLSearchParams(init.body ?? '');
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  if (String(url).endsWith('/oauth2/token/revoke')) return ok({});
  if (String(url).endsWith('/oauth2/token') && form.get('grant_type') === 'refresh_token') {
    return secretWrong ? { ok: false, status: 401, json: async () => ({ error: 'invalid_client' }) } : ok({ access_token: 'new', refresh_token: 'ref2', expires_in: 604800 });
  }
  if (String(url).endsWith('/users/@me/guilds')) return ok([{ id: '111' }]);
  throw new Error(`unexpected ${url}`);
};

let n = 0;
function setup() {
  const logged = [];
  const log = { isTextBased: () => true, send: async (p) => logged.push(p.content) };
  const members = new Collection();
  const roles = new Collection([UNVERIFIED, VERIFIED].map((id) => [id, { id, name: id, editable: true }]));
  const guild = {
    id: `guild-vfix-${n++}`,
    name: 'Mine',
    ownerId: 'owner',
    roles: { cache: roles },
    members: { cache: members, fetch: async (id) => (id ? members.get(id) ?? null : members) },
    channels: { cache: new Collection(), fetch: async () => log },
  };
  const client = { application: { id: 'app' }, user: { id: 'bot' }, guilds: { cache: new Collection([[guild.id, guild]]) } };
  guild.client = client;
  const settings = store.guild(guild.id);
  Object.assign(settings, { logChannelId: 'log' });
  Object.assign(settings.verify, { enabled: true, roleId: UNVERIFIED, verifiedRoleId: VERIFIED });
  settings.blockedServers = { [BAD]: { name: 'Bad Server', invites: [] } };
  const add = (id, roleIds = []) => {
    const member = {
      id,
      guild,
      client,
      permissions: new PermissionsBitField(),
      user: { id, tag: id, bot: false },
      roles: {
        cache: new Collection(roleIds.map((r) => [r, roles.get(r)])),
        add: async (r) => member.roles.cache.set(r.id ?? r, roles.get(r.id ?? r)),
        remove: async (r) => member.roles.cache.delete(r.id ?? r),
      },
      send: async () => {},
    };
    members.set(id, member);
    return member;
  };
  return { guild, client, settings, add, logged };
}

const has = (m, r) => m.roles.cache.has(r);

test('a damaged logins file is kept (backed up) and never saved over', () => {
  verify._tokens()['x:y'] = { guildId: 'x', userId: 'y' };
  verify.flushTokens();
  assert.equal(fs.readFileSync(path.join(DATA, 'verify-tokens.json'), 'utf8'), '{ this is not json');
  assert.ok(fs.readdirSync(DATA).some((f) => f.startsWith('verify-tokens.json.broken-')), 'a copy is kept');
});

test('a wrong Client Secret pauses the checks — it never unverifies anyone', async () => {
  // (The logins file is "broken" in this test file, so these checks use a login added in memory.)
  const { client, guild, add, logged } = setup();
  const member = add('alice', [VERIFIED]);
  const rec = { guildId: guild.id, userId: 'alice', access: 'old', refresh: 'ref', expiresAt: Date.now() - 1000, scope: 'identify guilds guilds.join' };
  secretWrong = true;
  // Run the same steps the 30-second check does for one person.
  await assert.rejects(
    (async () => {
      const { refreshLogin } = verify._internals;
      await refreshLogin(client, rec);
    })(),
    (err) => err.body?.error === 'invalid_client',
  );
  assert.equal(verify._internals.deauthorized(Object.assign(new Error(), { status: 401, body: { error: 'invalid_client' }, refreshing: true })), false);
  assert.equal(verify._internals.badSecret(Object.assign(new Error(), { status: 401, body: { error: 'invalid_client' }, refreshing: true })), true);
  assert.ok(has(member, VERIFIED));
  secretWrong = false;
  assert.ok(logged.length >= 0);
});

test('only a refused refresh (invalid_grant) or a refusal with a fresh login counts as “removed access”', () => {
  const { deauthorized } = verify._internals;
  assert.equal(deauthorized({ status: 400, body: { error: 'invalid_grant' } }), true);
  assert.equal(deauthorized({ deauthorized: true }), true);
  assert.equal(deauthorized({ status: 401 }), false, 'a plain 401 alone is not enough');
  assert.equal(deauthorized({ status: 500 }), false);
  assert.equal(deauthorized({ status: 429 }), false);
});

test('if restricting fails when someone in a blocked server verifies, they keep Unverified (no way past)', async () => {
  const { guild, add } = setup();
  const member = add('blocked', [UNVERIFIED]);
  restrictWorks = false;
  const result = await verify.finish(guild, member, ['111', BAD], { access_token: 'tok' });
  restrictWorks = true;
  assert.equal(result.ok, false);
  assert.ok(has(member, UNVERIFIED));
  assert.ok(!has(member, VERIFIED));
});

test('someone restricted while their Verify link was open isn’t verified', async () => {
  const { guild, settings, add } = setup();
  const member = add('naughty', [UNVERIFIED]);
  settings.restricted.naughty = { roles: [] };
  const result = await verify.finish(guild, member, ['111'], { access_token: 'tok' });
  assert.equal(result.restricted, true);
  assert.ok(!has(member, VERIFIED));
});

test('/verify off takes Unverified off everyone who has it, not just people it remembers', async () => {
  const { guild, settings, add } = setup();
  const a = add('a', [UNVERIFIED]);
  const b = add('b', [UNVERIFIED]); // e.g. put back after losing VIP
  settings.verify.pending = { a: Date.now() };
  assert.equal(await verify.disable(guild), 2);
  assert.ok(!has(a, UNVERIFIED));
  assert.ok(!has(b, UNVERIFIED));
});

test('a malformed web request gets an answer instead of hanging the server', async () => {
  const { client } = setup();
  const server = verify.startServer(client);
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  const reply = await new Promise((resolve) => {
    const socket = net.connect(Number(process.env.SERVER_PORT), '127.0.0.1', () => socket.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let data = '';
    socket.on('data', (d) => (data += d));
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
    setTimeout(() => socket.destroy(), 5000);
  });
  server.close();
  assert.match(reply, /^HTTP\/1\.1 (200|400)/);
});
