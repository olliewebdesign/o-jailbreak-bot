'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Blocked names: anyone using "anonymouse" (config.js → blockedServers.names, or /blockserver addname) as their
// username, display name or nickname is restricted straight away — disguised or not. Staff never are.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-blockednames-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField } = require('discord.js');
const store = require('../src/store');
const restrict = require('../src/restrict');
const blockedServers = require('../src/blockedServers');

const BAD = '900000000000000001';
const restricted = [];
restrict.restrictMember = async ({ member, reason }) => {
  restricted.push({ id: member.id, reason });
  store.guild(member.guild.id).restricted[member.id] = { roles: [], reason };
  return { ok: true, text: 'restricted' };
};
restrict.openTicketFor = async () => null;

let n = 0;
function setup() {
  restricted.length = 0;
  const logged = [];
  const log = { isTextBased: () => true, send: async (p) => logged.push(p.content) };
  const users = new Map();
  const client = { user: { id: 'bot', tag: 'O Jailbreak' }, users: { fetch: async (id) => users.get(id) } };
  const members = new Collection();
  const guild = { id: `guild-names-${n++}`, name: 'Mine', ownerId: 'owner', client, members: { cache: members, fetch: async () => members }, channels: { fetch: async () => log } };
  client.guilds = { cache: new Collection([[guild.id, guild]]) };
  const settings = store.guild(guild.id);
  settings.logChannelId = 'log';
  const add = (id, { username = id, globalName = null, nickname = null, staff = false } = {}) => {
    const user = { id, bot: false, tag: username, username, globalName, primaryGuild: null };
    users.set(id, user);
    const member = { id, guild, client, user, nickname, roles: { cache: new Collection() }, permissions: new PermissionsBitField(staff ? [PermissionsBitField.Flags.ModerateMembers] : []) };
    members.set(id, member);
    return member;
  };
  return { guild, settings, add, logged };
}

const NAMES = ['anonymouse', 'анонимаус'];

test('“anonymouse” is caught however it’s disguised', () => {
  for (const name of [
    'anonymouse',
    'Anonymouse',
    'ANONYMOUSE',
    'an0nym0use',
    'аnоnуmоusе', // Russian look-alike letters
    '𝓪𝓷𝓸𝓷𝔂𝓶𝓸𝓾𝓼𝓮',
    'ＡＮＯＮＹＭＯＵＳＥ',
    'theanonymouse',
    'anonymouse_ru',
    'xX_anonymouse_Xx',
    'anon.ymouse',
    'a n o n y m o u s e',
    'ano​nymouse', // an invisible character
    'Anonymouse Support 💸',
    'АНОНИМАУС',
  ]) {
    assert.ok(blockedServers.blockedNameIn(name, NAMES), name);
  }
});

test('ordinary names aren’t caught — not even “Anonymous”', () => {
  for (const name of ['anonymous', 'Anonymous', 'Anonymous Eagle', 'anonymous.eagle', 'anonymous_user', 'анонимус', 'Mouse', 'Ellie']) {
    assert.equal(blockedServers.blockedNameIn(name, NAMES), null, name);
  }
});

test('someone joining with the name is restricted straight away, whichever name it’s in', async () => {
  const s = setup();
  const byUsername = s.add('a', { username: 'anonymouse.shop' });
  const byDisplayName = s.add('b', { globalName: 'an0nym0use' });
  const byNickname = s.add('c', { nickname: 'ANONYMOUSE' });
  const fine = s.add('d', { globalName: 'Anonymous' });
  for (const m of [byUsername, byDisplayName, byNickname, fine]) await blockedServers.checkMember(m, { fresh: true });
  assert.deepEqual(restricted.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(restricted[0].reason, 'Please make a ticket');
  assert.ok(s.logged.some((l) => /<@b>.*using the name \*\*anonymouse\*\* \(“an0nym0use”\)/.test(l)), 'the mod log says why');
});

test('staff with the name aren’t restricted (the mod log is told instead)', async () => {
  const s = setup();
  const mod = s.add('mod', { globalName: 'anonymouse', staff: true });
  assert.equal(await blockedServers.checkMember(mod), null);
  assert.equal(restricted.length, 0);
  assert.ok(s.logged.some((l) => /Staff member <@mod>/.test(l)));
});

test('the 30-second check catches people already in the server, even with no blocked servers', async () => {
  const s = setup();
  s.add('x', { globalName: 'Anonymouse 💸' });
  s.add('y', { globalName: 'Anonymous' });
  assert.equal(await blockedServers.sweep(s.guild, { fromCache: true }), 1);
  assert.deepEqual(restricted.map((r) => r.id), ['x']);
  assert.equal(await blockedServers.sweep(s.guild, { fromCache: true }), 0, 'not twice');
});

test('names added with /blockserver addname are blocked too', async () => {
  const s = setup();
  s.settings.blockedNames.push('freenitroshop');
  assert.ok(blockedServers.blockedNames(s.settings).includes('anonymouse'), 'the config.js name is always there');
  await blockedServers.checkMember(s.add('z', { globalName: 'FreeNitroShop' }));
  assert.deepEqual(restricted.map((r) => r.id), ['z']);
});

test('their appeal asks them to leave anonymouse only if it’s a blocked server going by that name', async () => {
  const s = setup();
  s.settings.blockedServers = { [BAD]: { name: 'Some Shop', invites: ['anonymouse'], icon: null } };
  await blockedServers.checkMember(s.add('p', { globalName: 'anonymouse' }));
  assert.deepEqual(s.settings.restricted.p.blockedServers, [{ id: BAD, name: 'Some Shop', icon: null }]);

  s.settings.blockedNames.push('freenitroshop');
  await blockedServers.checkMember(s.add('q', { globalName: 'freenitroshop' }));
  assert.deepEqual(s.settings.restricted.q.blockedServers, [], 'a name that isn’t a server’s: no leave message');
});
