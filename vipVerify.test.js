'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// VIPs have to verify too. Until they do, VIP is paused (saved and taken off, so the VIP channels are hidden) and they
// only see #💎︱vip-verify. Verifying gives it straight back; being in a blocked server gets them restricted instead.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-vipverify-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const store = require('../src/store');
const restrict = require('../src/restrict');
const verify = require('../src/verify');
const invites = require('../src/invites');

const UNVERIFIED = 'unverified-role';
const VERIFIED = 'verified-role';
const MEMBER = 'member-role';
const VIP = 'vip-role';
const BAD = '900000000000000001';
require('../config').verify.vipDmSeconds = 0; // no waiting between DMs in tests

restrict.restrictMember = async ({ guild, member }) => {
  store.guild(guild.id).restricted[member.id] = { roles: [] };
  return { ok: true, text: 'restricted' };
};
restrict.openTicketFor = async () => null;

let n = 0;
function setup() {
  const logged = [];
  const posted = [];
  const dms = [];
  const members = new Collection();
  const role = (id) => ({ id, name: id, editable: true, managed: false, delete: async () => roles.delete(id) });
  const roles = new Collection([UNVERIFIED, VERIFIED, MEMBER, VIP].map((id) => [id, role(id)]));
  const channels = new Collection();
  const guild = { id: `guild-vipverify-${n++}`, name: 'Mine', ownerId: 'owner' };
  guild.roles = {
    cache: roles,
    create: async ({ name }) => {
      const r = role('room-role');
      r.name = name;
      roles.set(r.id, r);
      return r;
    },
  };
  guild.channels = {
    cache: channels,
    fetch: async (id) => (id === 'log' ? { isTextBased: () => true, send: async (p) => logged.push(p.content) } : channels.get(id) ?? null),
    create: async (opts) => {
      const ch = {
        id: 'vip-verify',
        name: opts.name,
        opts,
        toString: () => '<#vip-verify>',
        send: async (p) => (posted.push(p), { id: 'panel' }),
        messages: { fetch: async () => ({ id: 'panel' }) },
        delete: async () => channels.delete('vip-verify'),
      };
      channels.set(ch.id, ch);
      return ch;
    },
  };
  guild.members = { cache: members, fetch: async (id) => (id ? members.get(id) ?? null : members) };
  guild.client = { user: { id: 'bot', tag: 'O Jailbreak' }, guilds: { cache: new Collection([[guild.id, guild]]) } };
  const settings = store.guild(guild.id);
  Object.assign(settings, { logChannelId: 'log', autoroleId: MEMBER, vipRoleId: VIP });
  Object.assign(settings.verify, { enabled: true, startedAt: Date.now() - 86_400_000, roleId: UNVERIFIED, verifiedRoleId: VERIFIED, channelId: 'verify' });
  settings.blockedServers = { [BAD]: { name: 'anonymouse', invites: ['anonymouse'] } };

  const add = (id, roleIds = [], { staff = false } = {}) => {
    const member = {
      id,
      guild,
      joinedTimestamp: Date.now() - 30 * 86_400_000,
      pending: false,
      permissions: new PermissionsBitField(staff ? [P.ManageMessages] : []),
      user: { id, tag: id, username: id, bot: false },
      roles: {
        cache: new Collection(roleIds.map((r) => [r, roles.get(r)])),
        add: async (r) => member.roles.cache.set(r.id ?? r, roles.get(r.id ?? r)),
        remove: async (r) => member.roles.cache.delete(r.id ?? r),
        set: async (ids) => {
          member.setCalls = (member.setCalls ?? 0) + 1;
          member.roles.cache = new Collection(ids.map((r) => [r, roles.get(r)]));
        },
      },
      send: async (p) => {
        if (member.dmsClosed) throw new Error('Cannot send messages to this user');
        dms.push({ to: id, p });
      },
    };
    members.set(id, member);
    return member;
  };
  return { guild, settings, add, logged, posted, dms, channels, roles };
}

const roleIds = (member) => [...member.roles.cache.keys()].sort();

test('only VIPs who genuinely verified keep VIP — every kind of free verification older versions gave is paused', async () => {
  const s = setup();
  const rec = (extra = {}) => ({ at: Date.now(), blocked: [], ...extra });
  // Pressed Verify themselves:
  const real = s.add('real', [MEMBER, VIP, VERIFIED]);
  s.settings.verify.verified.real = rec({ newJoiner: false }); // v1.12.0 on (with a saved login)
  const realOld = s.add('realOld', [MEMBER, VIP, VERIFIED]);
  s.settings.verify.verified.realOld = rec(); // v1.11 (before saved logins existed)
  const manual = s.add('manual', [MEMBER, VIP, VERIFIED]);
  s.settings.verify.verified.manual = rec({ via: 'manual' }); // staff let them in by hand
  // Never genuinely verified:
  const never = s.add('never', [MEMBER, VIP]);
  const free = s.add('free', [MEMBER, VIP, VERIFIED]);
  s.settings.verify.verified.free = rec({ newJoiner: false, via: 'vip' }); // free with VIP, v1.12.0 on
  const freeOld = s.add('freeOld', [MEMBER, VIP, VERIFIED]); // free with VIP in v1.11.2: no record at all
  const flagged = s.add('flagged', [MEMBER, VIP, VERIFIED]);
  s.settings.verify.verified.flagged = rec({ blocked: ['anonymouse'] }); // found in a blocked server, never restricted
  const staff = s.add('staffvip', [MEMBER, VIP], { staff: true });

  assert.equal(await verify.verifyVips(s.guild), 4);
  for (const m of [real, realOld, manual]) assert.deepEqual(roleIds(m), [MEMBER, VERIFIED, VIP].sort(), `${m.id} keeps VIP`);
  assert.deepEqual(roleIds(never), [MEMBER, 'room-role'].sort(), 'VIP off (the VIP channels are hidden), the VIP — verify role on, member role kept');
  for (const m of [free, freeOld, flagged]) assert.deepEqual(roleIds(m), [MEMBER, 'room-role'].sort(), `${m.id}: VIP paused, and the Verified they didn't earn goes too`);
  assert.equal(s.settings.verify.verified.free, undefined);
  assert.deepEqual(roleIds(staff), [MEMBER, VIP].sort(), 'staff never have to');
  assert.deepEqual(s.settings.verify.vipHeld.never.roles, [VIP]);
  assert.ok(s.logged.some((l) => /paused VIP for \*\*4\*\* VIP\(s\) who never verified themselves \(kept it for \*\*3\*\* who did\)/.test(l)));

  const room = s.channels.get('vip-verify');
  assert.equal(room.name, '💎︱vip-verify');
  const sees = Object.fromEntries(room.opts.permissionOverwrites.map((o) => [o.id, o]));
  assert.deepEqual(sees[s.guild.id].deny, [P.ViewChannel], 'nobody else can see it');
  assert.ok(sees['room-role'].allow.includes(P.ViewChannel));
  assert.ok(sees['room-role'].deny.includes(P.SendMessages), 'read-only');
  const panel = s.posted[0].embeds[0].toJSON();
  assert.match(panel.title, /VIPs need to verify now/);
  assert.match(panel.description, /VIP isn’t gone/);
  assert.match(panel.description, /Any issues\? DM <@100000000000000001>/);
  assert.match(panel.description, /[а-яё]{5,}/i, 'and in Russian');
  assert.equal(s.posted[0].components[0].components[0].data.custom_id, 'oj:verify-start');
});

test('verifying gives VIP straight back (one role change), and the channel goes once every VIP has verified', async () => {
  const s = setup();
  const a = s.add('a', [MEMBER, VIP]);
  const b = s.add('b', [MEMBER, VIP]);
  await verify.verifyVips(s.guild);

  a.setCalls = 0;
  const result = await verify.finish(s.guild, a, ['123']); // not in any blocked server
  assert.equal(result.ok, true);
  assert.deepEqual(roleIds(a), [MEMBER, VERIFIED, VIP].sort());
  assert.equal(a.setCalls, 1, 'Verified and VIP in the same change');
  assert.ok(s.channels.has('vip-verify'), 'b still has to verify');

  await verify.finish(s.guild, b, []);
  assert.deepEqual(roleIds(b), [MEMBER, VERIFIED, VIP].sort());
  assert.ok(!s.channels.has('vip-verify'), 'everyone verified: the channel is deleted');
  assert.ok(!s.roles.has('room-role'), 'and its role');
  assert.ok(s.logged.some((l) => /Every paused VIP has verified/.test(l)));
});

test('a VIP in anonymouse is restricted when they verify, and doesn’t get VIP back', async () => {
  const s = setup();
  const anon = s.add('anon', [MEMBER, VIP]);
  await verify.verifyVips(s.guild);
  const result = await verify.finish(s.guild, anon, [BAD]);
  assert.deepEqual(result.blocked, ['anonymouse']);
  assert.ok(s.settings.restricted.anon, 'restricted');
  assert.ok(!anon.roles.cache.has(VIP));
  assert.deepEqual(s.settings.verify.vipHeld.anon.roles, [VIP], 'still paused');
});

test('getting VIP later without having verified pauses it straight away; a mod giving Verified gives it back', async () => {
  const s = setup();
  const later = s.add('later', [MEMBER]);
  await later.roles.add(VIP);
  await verify.onMemberUpdate({ partial: false, roles: { cache: new Collection([[MEMBER, {}]]) } }, later);
  assert.deepEqual(roleIds(later), [MEMBER, 'room-role'].sort());

  await later.roles.add(VERIFIED);
  await verify.onMemberUpdate({ partial: false, roles: { cache: new Collection(later.roles.cache) } }, later);
  assert.deepEqual(roleIds(later), [MEMBER, VERIFIED, VIP].sort());
});

test('VIP taken away while paused (below the invite goal) isn’t given back when they verify', async () => {
  const s = setup();
  const m = s.add('m', [MEMBER, VIP]);
  await verify.verifyVips(s.guild);
  s.settings.vipApplications = { m: { status: 'approved' } };
  assert.equal(await invites.takeVipIfBelow(s.guild, 'm', { why: 'below the goal' }), true);
  assert.equal(s.settings.verify.vipHeld.m, undefined);
  assert.ok(!m.roles.cache.has('room-role'), 'no VIP — verify role any more');
  await verify.finish(s.guild, m, []);
  assert.deepEqual(roleIds(m), [MEMBER, VERIFIED].sort());
});

test('turning verification off gives every paused VIP their VIP back', async () => {
  const s = setup();
  const m = s.add('m', [MEMBER, VIP]);
  await verify.verifyVips(s.guild);
  assert.equal(await verify.releasePausedVips(s.guild), 1);
  assert.deepEqual(roleIds(m), [MEMBER, VIP].sort());
  assert.ok(!s.channels.has('vip-verify'));
});

test('a VIP verified for free in v1.11.2 who joined after verification started goes back to waiting to verify', async () => {
  const s = setup();
  const m = s.add('newish', [MEMBER, VIP, VERIFIED]);
  m.joinedTimestamp = Date.now(); // after verification started, no record (v1.11.2)
  await verify.verifyVips(s.guild);
  assert.ok(m.roles.cache.has(UNVERIFIED), 'like any new member who hasn’t verified');
  assert.ok(!m.roles.cache.has(VERIFIED) && !m.roles.cache.has(VIP));
  assert.ok(m.roles.cache.has('room-role'), 'and can still see #💎︱vip-verify');
});

test('every paused VIP is DMed once (any issues → DM the owner); VIPs who keep VIP aren’t', async () => {
  const s = setup();
  s.add('a', [MEMBER, VIP]);
  const closed = s.add('closed', [MEMBER, VIP]);
  closed.dmsClosed = true;
  s.add('real', [MEMBER, VIP, VERIFIED]);
  s.settings.verify.verified.real = { at: Date.now(), blocked: [] };
  await verify.verifyVips(s.guild);
  await verify.queueVipDms(s.guild);
  assert.deepEqual(s.dms.map((d) => d.to), ['a'], 'not the VIP who verified; DMs closed just fail quietly');
  const dm = s.dms[0].p;
  assert.match(dm.content, /VIPs in Mine need to verify now/);
  assert.match(dm.content, /VIP isn’t gone/);
  assert.match(dm.content, /Any issues\? DM <@100000000000000001>/);
  assert.match(dm.content, /[а-яё]{5,}/i, 'and in Russian');
  assert.equal(dm.components[0].components[0].data.url, `https://discord.com/channels/${s.guild.id}/vip-verify`);
  assert.ok(s.logged.some((l) => /DMed \*\*1\*\* paused VIP\(s\).*\*\*1\*\* have their DMs closed/.test(l)));

  // Never twice, even after a restart (it's remembered).
  await verify.verifyVips(s.guild);
  await verify.queueVipDms(s.guild);
  assert.equal(s.dms.length, 1);

  // Someone paused later gets theirs.
  const later = s.add('later', [MEMBER]);
  await later.roles.add(VIP);
  await verify.onMemberUpdate({ partial: false, roles: { cache: new Collection([[MEMBER, {}]]) } }, later);
  await verify.queueVipDms(s.guild);
  assert.deepEqual(s.dms.map((d) => d.to), ['a', 'later']);
});
