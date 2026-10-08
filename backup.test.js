'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// /backup pull: everyone who verified (and allowed "join servers for you") is added to the new server. People who
// left the old server on purpose, restricted people, and people who removed the bot's access are skipped.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-backup-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number
process.env.DISCORD_CLIENT_SECRET = 'test-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const store = require('../src/store');
const verify = require('../src/verify');

// Refreshing a login: works unless the person removed the bot's access.
const removedAccess = new Set();
global.fetch = async (url, init = {}) => {
  const form = new URLSearchParams(init.body ?? '');
  if (String(url).endsWith('/oauth2/token') && form.get('grant_type') === 'refresh_token') {
    const who = form.get('refresh_token').replace('ref-', '');
    if (removedAccess.has(who)) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
    return { ok: true, status: 200, json: async () => ({ access_token: `tok-${who}-new`, refresh_token: `ref-${who}`, expires_in: 604800 }) };
  }
  throw new Error(`unexpected ${url}`);
};

function fakeGuild(id, memberIds = []) {
  const members = new Collection(memberIds.map((m) => [m, { id: m }]));
  return { id, name: id, members: { cache: members, fetch: async (uid) => members.get(uid) ?? Promise.reject(new Error('Unknown Member')) } };
}

function saveLogin(guildId, userId, { scope = 'identify guilds guilds.join', expired = false } = {}) {
  verify._tokens()[`${guildId}:${userId}`] = {
    guildId,
    userId,
    access: `tok-${userId}`,
    refresh: `ref-${userId}`,
    expiresAt: expired ? Date.now() - 1000 : Date.now() + 86_400_000,
    scope,
    lastScan: Date.now(),
  };
}

test('everyone who verified is added to the backup server; leavers, restricted people and lost access are skipped', async () => {
  const OLD = 'old-server';
  const old = fakeGuild(OLD, ['alice', 'bob', 'carol', 'dave', 'erin', 'gone-access']);
  const added = [];
  const backup = fakeGuild('backup-server', ['bob']);
  backup.members.add = async (userId, { accessToken }) => {
    if (accessToken === 'tok-expired-login') throw Object.assign(new Error('Invalid OAuth2 access token'), { code: 50025 });
    if (userId === 'gone-access') throw Object.assign(new Error('Invalid OAuth2 access token'), { code: 50025 });
    added.push({ userId, accessToken });
    return { id: userId };
  };
  const client = { application: { id: 'app' }, user: { id: 'bot' }, guilds: { cache: new Collection([[OLD, old], ['backup-server', backup]]) } };

  saveLogin(OLD, 'alice');
  saveLogin(OLD, 'bob'); // already in the backup server
  saveLogin(OLD, 'carol', { expired: true }); // login ran out → refreshed first
  saveLogin(OLD, 'dave', { scope: 'identify guilds' }); // verified before backups existed → can't be added
  saveLogin(OLD, 'erin');
  store.guild(OLD).restricted.erin = { roles: [] }; // restricted → never pulled
  saveLogin(OLD, 'frank'); // left the old server on purpose → skipped
  saveLogin(OLD, 'gone-access');
  removedAccess.add('gone-access');

  const before = await verify.pullCandidates(client, backup);
  assert.deepEqual(before.candidates.map((r) => r.userId).sort(), ['alice', 'bob', 'carol', 'gone-access']);
  assert.equal(before.left, 1);
  assert.equal(before.restricted, 1);

  const result = await verify.pullMembers(client, backup);
  assert.deepEqual(added.map((a) => a.userId).sort(), ['alice', 'carol']);
  assert.equal(added.find((a) => a.userId === 'carol').accessToken, 'tok-carol-new', 'an expired login is refreshed first');
  assert.equal(result.added, 2);
  assert.equal(result.already, 1);
  assert.equal(result.noAccess, 1);
  assert.equal(result.failed, 0);
});

test('if the old server is gone, everyone who verified there is added', async () => {
  const backup = fakeGuild('backup-2');
  const added = [];
  backup.members.add = async (userId) => (added.push(userId), { id: userId });
  const client = { application: { id: 'app' }, user: { id: 'bot' }, guilds: { cache: new Collection([['backup-2', backup]]) } };
  saveLogin('deleted-server', 'zoe');
  saveLogin('deleted-server', 'yan');
  const result = await verify.pullMembers(client, backup, { fromGuildId: 'deleted-server' });
  assert.deepEqual(added.sort(), ['yan', 'zoe']);
  assert.equal(result.added, 2);
});
