'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Someone joining (or renaming themselves) with a name like the owner's ("ellie", "eliot"): the owner gets a DM.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-namewatch-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const store = require('../src/store');
const nameWatch = require('../src/nameWatch');

const OWNER = '100000000000000001';

let n = 0;
function setup({ username = 'someone', globalName = null, nickname = null, id = null, staff = false, createdDaysAgo = 2 } = {}) {
  const dms = [];
  const logged = [];
  const guild = {
    id: `guild-watch-${n++}`,
    name: 'O Jailbreak',
    ownerId: OWNER,
    channels: { fetch: async () => ({ isTextBased: () => true, send: async (p) => logged.push(p.content) }) },
  };
  store.guild(guild.id).logChannelId = 'log';
  const memberId = id ?? `user-${n}`;
  const member = {
    id: memberId,
    guild,
    nickname,
    joinedTimestamp: Date.now(),
    client: { users: { fetch: async (uid) => ({ id: uid, send: async (p) => dms.push({ to: uid, ...p }) }) } },
    user: { id: memberId, username, globalName, bot: false, createdTimestamp: Date.now() - createdDaysAgo * 86_400_000, displayAvatarURL: () => 'https://cdn.example/avatar.png' },
    roles: { cache: new Collection() },
    permissions: new PermissionsBitField(staff ? [P.ManageMessages] : []),
  };
  return { guild, member, dms, logged };
}

test('someone joining as “3llie” gets the owner a DM with who they are (and a line in the mod log)', async () => {
  const { member, dms, logged } = setup({ username: 'ellie_support', globalName: '3llie' });
  assert.ok(await nameWatch.check(member, 'joined'));
  assert.equal(dms.length, 1);
  assert.equal(dms[0].to, OWNER);
  const embed = dms[0].embeds[0].data;
  assert.match(embed.title, /joined with a name like yours/);
  assert.match(embed.description, new RegExp(member.id));
  assert.ok(embed.fields.some((f) => f.name === 'Account made' && /New account/.test(f.value)));
  assert.ok(embed.fields.some((f) => f.name === 'User ID' && f.value.includes(member.id)));
  assert.match(logged[0], /joined with a name like the owner’s/);
});

test('Eliot, Russian “Элли” and a nickname count; Kellie, Nellie and Eliza don’t', async () => {
  for (const names of [{ globalName: 'Eliot' }, { globalName: 'Элли' }, { nickname: 'real_ellie' }, { username: 'ell.fx' }]) {
    const { member, dms } = setup(names);
    await nameWatch.check(member, 'joined');
    assert.equal(dms.length, 1, JSON.stringify(names));
  }
  for (const globalName of ['Kellie', 'Nellie', 'Eliza', 'Belly']) {
    const { member, dms } = setup({ globalName });
    await nameWatch.check(member, 'joined');
    assert.equal(dms.length, 0, globalName);
  }
});

test('the owner, staff and servers that turned it off are never reported; a rename is only reported once', async () => {
  const owner = setup({ id: OWNER, globalName: 'Ellie' });
  assert.equal(await nameWatch.check(owner.member, 'joined'), null);
  const mod = setup({ globalName: 'Eliot', staff: true });
  assert.equal(await nameWatch.check(mod.member, 'joined'), null);
  const off = setup({ globalName: 'ellie' });
  store.guild(off.guild.id).modules.nameWatch = false;
  assert.equal(await nameWatch.check(off.member, 'joined'), null);

  const renamer = setup({ username: 'bob' });
  renamer.member.nickname = 'Ellie';
  await nameWatch.check(renamer.member, 'renamed');
  await nameWatch.check(renamer.member, 'renamed');
  assert.equal(renamer.dms.length, 1);
  assert.match(renamer.dms[0].embeds[0].data.title, /changed their name/);
});
