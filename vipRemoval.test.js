'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Dropping below the VIP goal takes VIP away: straight away with /vip revoke, and when invited people leave within a
// day (only for VIPs who got it through an approved application). Verified that only came with VIP goes too.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-vipremoval-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField } = require('discord.js');
const store = require('../src/store');
const invites = require('../src/invites');
const verify = require('../src/verify');
const { runCommand } = require('../src/commands');

const VIP = 'vip-role';
const VERIFIED = 'verified-role';
const UNVERIFIED = 'unverified-role';
let n = 0;

function setup() {
  const logged = [];
  const dms = [];
  const log = { isTextBased: () => true, send: async (p) => logged.push(p.content) };
  const members = new Collection();
  const roles = new Collection([VIP, VERIFIED, UNVERIFIED].map((id) => [id, { id, name: id === VIP ? 'VIP' : id, editable: true }]));
  const guild = {
    id: `guild-vipremoval-${n++}`,
    name: 'Mine',
    ownerId: 'owner',
    roles: { cache: roles },
    members: { cache: members, fetch: async (id) => (id ? members.get(id) ?? null : members) },
    channels: { cache: new Collection(), fetch: async () => log },
  };
  const settings = store.guild(guild.id);
  Object.assign(settings, { logChannelId: 'log', vipRoleId: VIP, vipJoinsNeeded: 3 });
  Object.assign(settings.verify, { enabled: true, roleId: UNVERIFIED, verifiedRoleId: VERIFIED });
  const add = (id, roleIds = []) => {
    const member = {
      id,
      guild,
      user: { id, tag: id, bot: false },
      roles: {
        cache: new Collection(roleIds.map((r) => [r, roles.get(r)])),
        add: async (r) => member.roles.cache.set(r.id ?? r, roles.get(r.id ?? r)),
        remove: async (r) => member.roles.cache.delete(r.id ?? r),
      },
      send: async (t) => dms.push(t),
    };
    members.set(id, member);
    return member;
  };
  return { guild, settings, add, logged, dms };
}

const has = (m, r) => m.roles.cache.has(r);

test('/vip revoke below the goal takes VIP off (and Verified that only came with VIP)', async () => {
  const { guild, settings, add, logged, dms } = setup();
  const cheat = add('cheat', [VIP, VERIFIED]);
  settings.invites.counts.cheat = 4;
  settings.verify.verified.cheat = { at: Date.now(), blocked: [], via: 'vip' };

  const replies = [];
  const interaction = {
    commandName: 'vip',
    guild,
    guildId: guild.id,
    user: { id: 'admin', tag: 'admin', toString: () => '<@admin>' },
    options: {
      getSubcommand: () => 'revoke',
      getUser: () => ({ id: 'cheat', toString: () => '<@cheat>' }),
      getInteger: () => 2,
      getString: () => 'alts',
    },
    deferred: false,
    replied: false,
    deferReply: async () => (interaction.deferred = true),
    editReply: async (p) => replies.push(p.content),
    reply: async (p) => replies.push(p.content),
  };
  await runCommand(interaction);

  assert.equal(settings.invites.counts.cheat, 2);
  assert.ok(!has(cheat, VIP), 'VIP taken off');
  assert.ok(!has(cheat, VERIFIED), 'Verified that came with VIP taken off too');
  assert.match(replies.at(-1), /Took <@&vip-role> off them/);
  assert.match(dms.at(-1), /was removed/);
  assert.ok(logged.some((l) => /Took \*\*VIP\*\* off <@cheat>/.test(l)));
});

test('/vip revoke that leaves them at or above the goal keeps VIP', async () => {
  const { guild, settings, add } = setup();
  const fine = add('fine', [VIP]);
  settings.invites.counts.fine = 10;
  invites.revokeJoins(settings, 'fine', 2);
  assert.equal(await invites.takeVipIfBelow(guild, 'fine', { why: 'x' }), false);
  assert.ok(has(fine, VIP));
});

test('someone who verified properly keeps Verified when they lose VIP', async () => {
  const { guild, settings, add } = setup();
  const proper = add('proper', [VIP, VERIFIED]);
  settings.invites.counts.proper = 0;
  settings.verify.verified.proper = { at: Date.now(), blocked: [] }; // verified with Discord, not via VIP
  assert.equal(await invites.takeVipIfBelow(guild, 'proper', { why: 'x' }), true);
  assert.ok(!has(proper, VIP));
  assert.ok(has(proper, VERIFIED));
});

test('a leaver taking an approved VIP below the goal removes VIP; a VIP you gave out yourself is left alone', async () => {
  const { guild, settings, add } = setup();
  const approved = add('approved', [VIP]);
  const gifted = add('gifted', [VIP]);
  settings.vipApplications = { approved: { status: 'approved' } };
  settings.invites.counts.approved = 3;
  settings.invites.counts.gifted = 3;
  settings.invites.credited = { quick1: 'approved', quick2: 'gifted' };
  settings.invites.joinedAt = { quick1: Date.now() - 600_000, quick2: Date.now() - 600_000 };

  const r1 = await invites.onMemberLeave({ id: 'quick1', guild });
  assert.equal(r1.lostVip, true);
  assert.ok(!has(approved, VIP));
  assert.equal(settings.vipApplications.approved.status, 'removed', 'they can apply again later');

  const r2 = await invites.onMemberLeave({ id: 'quick2', guild });
  assert.equal(r2.lostVip, false);
  assert.ok(has(gifted, VIP), 'VIP given by hand is never taken away automatically');
});

test('VIP saved for a restricted person is taken out of what they get back', async () => {
  const { guild, settings, add } = setup();
  add('naughty');
  settings.invites.counts.naughty = 0;
  settings.restricted.naughty = { roles: ['member', VIP] };
  assert.equal(await invites.takeVipIfBelow(guild, 'naughty', { why: 'x' }), true);
  assert.deepEqual(settings.restricted.naughty.roles, ['member']);
});

test('losing VIP in Discord itself also removes Verified that only came with it', async () => {
  const { settings, add } = setup();
  const member = add('was-vip', [VERIFIED]);
  settings.verify.verified['was-vip'] = { at: Date.now(), blocked: [], via: 'vip', newJoiner: true };
  const before = { partial: false, roles: { cache: new Collection([[VIP, {}], [VERIFIED, {}]]) } };
  await verify.onMemberUpdate(before, member);
  assert.ok(!has(member, VERIFIED));
  assert.ok(has(member, UNVERIFIED), 'a new joiner goes back to not seeing the jailbreaks');
});
