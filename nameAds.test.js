'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Names that advertise ("discord.gg/abc", "t.me/abc") get their nickname in the server changed to their username.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-nameads-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const store = require('../src/store');
const nameAds = require('../src/nameAds');

let n = 0;
function setup({ globalName = null, nickname = null, staff = false, manageable = true } = {}) {
  const logged = [];
  const guild = {
    id: `guild-names-${n++}`,
    ownerId: 'owner',
    vanityURLCode: null,
    client: { fetchInvite: async () => ({ guild: { id: 'other', name: 'Other Server' } }) },
    channels: { fetch: async () => ({ isTextBased: () => true, send: async (p) => logged.push(p.content) }) },
  };
  store.guild(guild.id).logChannelId = 'log';
  const member = {
    id: `user-${n}`,
    guild,
    nickname,
    manageable,
    user: { id: `user-${n}`, username: 'cool_guy', globalName, bot: false },
    roles: { cache: new Collection() },
    permissions: new PermissionsBitField(staff ? [P.ManageMessages] : []),
    setNickname: async (name) => (member.nickname = name),
  };
  return { guild, member, logged };
}

test('an advertising display name is changed to their username, and the mod log is told', async () => {
  const { member, logged } = setup({ globalName: 'join discord.gg/freeprompts' });
  assert.ok(await nameAds.check(member));
  assert.equal(member.nickname, 'cool_guy');
  assert.match(logged[0], /name was advertising/);
  assert.match(logged[0], /Other Server/);
});

test('telegram links and .gg/ in a nickname count too; normal names, staff and servers with it off are left alone', async () => {
  for (const nickname of ['t.me/jbchannel', 'best jb .gg/coolserver']) {
    const { member } = setup({ nickname });
    assert.ok(await nameAds.check(member), nickname);
  }
  for (const globalName of ['Ellie', 'Dr. Who', 'gg.wp', 'xX_gamer_Xx']) {
    const { member } = setup({ globalName });
    assert.equal(await nameAds.check(member), null, globalName);
  }
  const mod = setup({ globalName: 'discord.gg/freeprompts', staff: true });
  assert.equal(await nameAds.check(mod.member), null);
  const off = setup({ globalName: 'discord.gg/freeprompts' });
  store.guild(off.guild.id).modules.selfPromo = false;
  assert.equal(await nameAds.check(off.member), null);
});

test('someone whose role is above the bot is reported once, not every time', async () => {
  const { member, logged } = setup({ globalName: 'discord.gg/freeprompts', manageable: false });
  await nameAds.check(member);
  await nameAds.check(member);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /can’t change it/);
});
