'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// /verify split: the jailbreaks section is copied (empty) for Verified members only, while everyone who hasn't
// verified keeps seeing the old one. Discord's rule ("allowed" beats "blocked" between roles) is simulated, so the
// test checks who can actually see what.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-split-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, Collection, OverwriteType, PermissionFlagsBits: P } = require('discord.js');
const config = require('../config');
const store = require('../src/store');
const verify = require('../src/verify');

const GUILD = 'guild-split';
const UNVERIFIED = 'unverified-role';
const VERIFIED = 'verified-role';
const MEMBER = config.updating.memberRoleIds[0];
const VIP = config.updating.vipRoleId;
const BOOSTER = 'booster-role';
let nextId = 1;

// overwrites: roleId -> { allow: Set<bigint>, deny: Set<bigint> }
function makeOverwrites(initial) {
  const map = new Map(Object.entries(initial).map(([id, o]) => [id, { allow: new Set(o.allow ?? []), deny: new Set(o.deny ?? []) }]));
  const view = () =>
    new Collection([...map].map(([id, o]) => [id, { id, type: OverwriteType.Role, allow: { has: (p) => o.allow.has(p) }, deny: { has: (p) => o.deny.has(p) } }]));
  return {
    map,
    get cache() {
      return view();
    },
    edit: async (roleId, perms) => {
      const o = map.get(roleId) ?? { allow: new Set(), deny: new Set() };
      for (const [name, value] of Object.entries(perms)) {
        o.allow.delete(P[name]);
        o.deny.delete(P[name]);
        if (value === true) o.allow.add(P[name]);
        if (value === false) o.deny.add(P[name]);
      }
      map.set(roleId, o);
    },
  };
}

function fakeChannel(guild, { name, type = ChannelType.GuildText, parentId = null, position = 0, overwrites = {} }) {
  const channel = {
    id: `ch-${nextId++}`,
    name,
    type,
    parentId,
    position,
    rawPosition: position,
    permissionOverwrites: makeOverwrites(overwrites),
    clone: async ({ name: newName, parent }) => {
      const copied = Object.fromEntries([...channel.permissionOverwrites.map].map(([id, o]) => [id, { allow: [...o.allow], deny: [...o.deny] }]));
      return fakeChannel(guild, { name: newName ?? channel.name, type: channel.type, parentId: parent ?? channel.parentId, position: channel.position, overwrites: copied });
    },
    setPosition: async (p) => (channel.position = p),
    toString: () => `<#${channel.id}>`,
  };
  guild.channels.cache.set(channel.id, channel);
  return channel;
}

/** Can someone with these roles see the channel? @everyone first, then roles (any allow beats any deny). */
function canSee(ch, roleIds) {
  const o = ch.permissionOverwrites.map;
  let see = !(o.get(GUILD)?.deny.has(P.ViewChannel) ?? false) || Boolean(o.get(GUILD)?.allow.has(P.ViewChannel));
  const roles = roleIds.map((id) => o.get(id)).filter(Boolean);
  if (roles.some((r) => r.deny.has(P.ViewChannel))) see = false;
  if (roles.some((r) => r.allow.has(P.ViewChannel))) see = true;
  return see;
}

function setup() {
  const guild = {
    id: GUILD,
    roles: { cache: new Collection([UNVERIFIED, VERIFIED, MEMBER, VIP, BOOSTER, GUILD].map((id) => [id, { permissions: { has: () => false } }])) },
    channels: { cache: new Collection() },
  };
  const settings = store.guild(GUILD);
  Object.assign(settings.verify, { enabled: true, roleId: UNVERIFIED, verifiedRoleId: VERIFIED });
  settings.vipRoleId = VIP;
  // As the server is now: the section is for the Member role (not @everyone); one channel is VIP-only.
  const memberOnly = { [GUILD]: { deny: [P.ViewChannel] }, [MEMBER]: { allow: [P.ViewChannel] }, [UNVERIFIED]: { deny: [P.ViewChannel] } };
  const category = fakeChannel(guild, { name: 'Jailbreaks', type: ChannelType.GuildCategory, position: 3, overwrites: memberOnly });
  fakeChannel(guild, { name: 'claude', parentId: category.id, position: 0, overwrites: memberOnly });
  fakeChannel(guild, { name: 'chatgpt', parentId: category.id, position: 1, overwrites: memberOnly });
  fakeChannel(guild, {
    name: 'vip-jailbreaks',
    parentId: category.id,
    position: 2,
    overwrites: { [GUILD]: { deny: [P.ViewChannel] }, [VIP]: { allow: [P.ViewChannel] }, [UNVERIFIED]: { deny: [P.ViewChannel] } },
  });
  return { guild, category };
}

const PEOPLE = {
  'existing member (not verified)': [MEMBER],
  'verified member': [MEMBER, VERIFIED],
  'VIP (verified automatically)': [MEMBER, VIP, VERIFIED],
  'new joiner (unverified)': [UNVERIFIED],
};

test('after splitting: the old section is for everyone who hasn’t verified, the new one for Verified only', async () => {
  const { guild, category } = setup();
  const result = await verify.splitSection(guild, category);
  assert.equal(result.copied, 3);
  const newCategory = result.newCategory;
  assert.equal(newCategory.position, category.position + 1);

  const byName = (parent) => Object.fromEntries([...guild.channels.cache.values()].filter((c) => c.parentId === parent.id).map((c) => [c.name, c]));
  const oldCh = byName(category);
  const newCh = byName(newCategory);
  assert.deepEqual(Object.keys(newCh), ['claude', 'chatgpt', 'vip-jailbreaks'], 'same channels, same order');

  const sees = (who, ch) => canSee(ch, PEOPLE[who]);
  // Old section
  assert.equal(sees('existing member (not verified)', oldCh.claude), true);
  assert.equal(sees('verified member', oldCh.claude), false);
  assert.equal(sees('VIP (verified automatically)', oldCh.claude), false);
  assert.equal(sees('new joiner (unverified)', oldCh.claude), false);
  // New section
  assert.equal(sees('existing member (not verified)', newCh.claude), false);
  assert.equal(sees('verified member', newCh.claude), true);
  assert.equal(sees('VIP (verified automatically)', newCh.claude), true);
  assert.equal(sees('new joiner (unverified)', newCh.claude), false);
  assert.equal(sees('verified member', newCategory), true);
  // VIP-only channels stay VIP-only, and VIPs only see the new one
  assert.equal(sees('verified member', newCh['vip-jailbreaks']), false, 'verified non-VIPs can’t see the VIP channel');
  assert.equal(sees('VIP (verified automatically)', newCh['vip-jailbreaks']), true);
  assert.equal(sees('VIP (verified automatically)', oldCh['vip-jailbreaks']), false);
  assert.equal(sees('existing member (not verified)', oldCh['vip-jailbreaks']), false, 'the old VIP channel isn’t opened up to everyone');
  assert.deepEqual(result.failed, []);
});

test('it needs verification set up, and a category rather than a channel', async () => {
  const { guild, category } = setup();
  const channel = [...guild.channels.cache.values()].find((c) => c.parentId === category.id);
  await assert.rejects(verify.splitSection(guild, channel), /category/);
  store.guild(GUILD).verify.verifiedRoleId = null;
  await assert.rejects(verify.splitSection(guild, category), /verify setup/);
});

test('another role allowed into the jailbreaks can’t be used to skip verifying; a role-only channel is reported', async () => {
  const guild = {
    id: 'guild-split-2',
    roles: { cache: new Collection([UNVERIFIED, VERIFIED, MEMBER, VIP, BOOSTER, 'guild-split-2'].map((id) => [id, { permissions: { has: () => false } }])) },
    channels: { cache: new Collection() },
  };
  const settings = store.guild(guild.id);
  Object.assign(settings.verify, { enabled: true, roleId: UNVERIFIED, verifiedRoleId: VERIFIED });
  const open = { 'guild-split-2': { deny: [P.ViewChannel] }, [MEMBER]: { allow: [P.ViewChannel] }, [BOOSTER]: { allow: [P.ViewChannel] }, [UNVERIFIED]: { deny: [P.ViewChannel] } };
  const category = fakeChannel(guild, { name: 'Jailbreaks', type: ChannelType.GuildCategory, overwrites: open });
  fakeChannel(guild, { name: 'claude', parentId: category.id, overwrites: open });
  fakeChannel(guild, { name: 'booster-only', parentId: category.id, position: 1, overwrites: { 'guild-split-2': { deny: [P.ViewChannel] }, [BOOSTER]: { allow: [P.ViewChannel] } } });

  const result = await verify.splitSection(guild, category);
  assert.deepEqual(result.cleared, [BOOSTER]);
  const newClaude = [...guild.channels.cache.values()].find((c) => c.parentId === result.newCategory.id && c.name === 'claude');
  const sees = (ch, roles) => {
    const o = ch.permissionOverwrites.map;
    let see = !(o.get('guild-split-2')?.deny.has(P.ViewChannel) ?? false) || Boolean(o.get('guild-split-2')?.allow.has(P.ViewChannel));
    const rs = roles.map((id) => o.get(id)).filter(Boolean);
    if (rs.some((r) => r.deny.has(P.ViewChannel))) see = false;
    if (rs.some((r) => r.allow.has(P.ViewChannel))) see = true;
    return see;
  };
  assert.equal(sees(newClaude, [UNVERIFIED, MEMBER, BOOSTER]), false, 'an unverified booster can’t see the new section');
  assert.equal(sees(newClaude, [MEMBER, BOOSTER, VERIFIED]), true);
  assert.equal(result.roleOnly.length, 1, 'the booster-only channel is reported');

  await assert.rejects(verify.splitSection(guild, category), /already split/);
});
