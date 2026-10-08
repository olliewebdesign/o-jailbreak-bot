'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// /verify require-all: everyone who hasn't verified (existing members too) only sees #please-read. Their roles are
// saved and come back when they verify. Staff, VIPs, verified and restricted people are never touched.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-requireall-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number
process.env.DISCORD_CLIENT_SECRET = 'test-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const store = require('../src/store');
const verify = require('../src/verify');
const autorole = require('../src/autorole');
const { runCommand } = require('../src/commands');

const UNVERIFIED = 'unverified-role';
const VERIFIED = 'verified-role';
const MEMBER = 'member-role';
const LEVEL = 'level-5-role';
const VIP = 'vip-role';
const BOOSTER = 'booster-role';

function makeChannel(id, { parentId = null } = {}) {
  const cache = new Collection();
  const channel = {
    id,
    name: id,
    parentId,
    permissionOverwrites: {
      cache,
      edit: async (roleId, perms) => {
        const o = cache.get(roleId) ?? { id: roleId, allow: new PermissionsBitField(), deny: new PermissionsBitField() };
        for (const [name, value] of Object.entries(perms)) {
          o.allow.remove(P[name]);
          o.deny.remove(P[name]);
          if (value === true) o.allow.add(P[name]);
          if (value === false) o.deny.add(P[name]);
        }
        cache.set(roleId, o);
      },
      delete: async (roleId) => cache.delete(roleId),
    },
    messages: { fetch: async () => ({ edit: async (p) => (channel.panel = p) }) },
    send: async (p) => ((channel.panel = p), { id: 'panel' }),
    setName: async () => {},
  };
  return channel;
}

let n = 0;
function setup() {
  const logged = [];
  const members = new Collection();
  const roles = new Collection([UNVERIFIED, VERIFIED, MEMBER, LEVEL, VIP].map((id) => [id, { id, name: id, editable: true, managed: false }]));
  roles.set(BOOSTER, { id: BOOSTER, name: 'Server Booster', editable: false, managed: true });
  const channels = new Collection(['please-read', 'general', 'rules', 'old-jb', 'old-jb-1', 'new-jb', 'restricted', 'log'].map((id) => [id, makeChannel(id)]));
  channels.get('old-jb-1').parentId = 'old-jb';
  const guild = {
    id: `guild-gate-${n++}`,
    name: 'Mine',
    ownerId: 'owner',
    roles: { cache: roles },
    invites: { fetch: async () => new Collection() },
    members: { cache: members, fetch: async (id) => (id ? members.get(id) ?? null : members) },
    channels: { cache: channels, fetch: async (id) => (id === 'log' ? { isTextBased: () => true, send: async (p) => logged.push(p.content) } : channels.get(id) ?? null) },
  };
  guild.client = { application: { id: 'app' }, user: { id: 'bot' }, guilds: { cache: new Collection([[guild.id, guild]]) } };
  const settings = store.guild(guild.id);
  Object.assign(settings, { logChannelId: 'log', autoroleId: MEMBER, vipRoleId: VIP });
  settings.restrict.channelId = 'restricted';
  Object.assign(settings.verify, {
    enabled: true,
    startedAt: Date.now() - 86_400_000,
    roleId: UNVERIFIED,
    verifiedRoleId: VERIFIED,
    channelId: 'please-read',
    messageId: 'panel',
    layout: 3,
    split: { oldCategoryId: 'old-jb', newCategoryId: 'new-jb', notices: {}, verifiedChannels: [] },
  });
  // Like after /verify split: Unverified can't see either section; an admin chose to let Unverified see #rules.
  channels.get('old-jb').permissionOverwrites.edit(UNVERIFIED, { ViewChannel: false });
  channels.get('old-jb-1').permissionOverwrites.edit(UNVERIFIED, { ViewChannel: false });
  channels.get('new-jb').permissionOverwrites.edit(UNVERIFIED, { ViewChannel: false });
  channels.get('rules').permissionOverwrites.edit(UNVERIFIED, { ViewChannel: true });

  const add = (id, { roleIds = [], joinedAt = Date.now() - 30 * 86_400_000, staff = false, bot = false } = {}) => {
    const member = {
      id,
      guild,
      joinedTimestamp: joinedAt,
      pending: false,
      permissions: new PermissionsBitField(staff ? [P.ManageMessages] : []),
      user: { id, tag: id, username: id, bot },
      roles: {
        cache: new Collection(roleIds.map((r) => [r, roles.get(r)])),
        add: async (r) => member.roles.cache.set(r.id ?? r, roles.get(r.id ?? r)),
        remove: async (r) => member.roles.cache.delete(r.id ?? r),
        set: async (ids) => {
          member.roles.cache = new Collection(ids.map((r) => [r, roles.get(r)]));
        },
      },
      send: async () => {},
    };
    members.set(id, member);
    return member;
  };
  return { guild, settings, channels, add, logged };
}

const roleIds = (member) => [...member.roles.cache.keys()].sort();
const hidden = (channel) => Boolean(channel.permissionOverwrites.cache.get(UNVERIFIED)?.deny.has(P.ViewChannel));

test('turning it on: existing members who haven’t verified hold only Unverified (roles saved); nobody else is touched', async () => {
  const { guild, settings, channels, add } = setup();
  const regular = add('regular', { roleIds: [MEMBER, LEVEL, BOOSTER] });
  const verified = add('verified', { roleIds: [MEMBER, VERIFIED] });
  const vip = add('vip', { roleIds: [MEMBER, VIP, VERIFIED] });
  const mod = add('mod', { roleIds: [MEMBER], staff: true });
  const bot = add('a-bot', { roleIds: [MEMBER], bot: true });
  const owner = add('owner', { roleIds: [MEMBER] });

  const { channel } = await verify.requireAllOn(guild);
  assert.equal(channel.id, 'please-read');
  const progress = await verify.gateEveryone(guild);
  assert.equal(progress.done, 1);

  assert.deepEqual(roleIds(regular), [BOOSTER, UNVERIFIED].sort(), 'only Unverified (a Booster role can’t be taken off)');
  assert.deepEqual(settings.verify.held.regular.roles.sort(), [LEVEL, MEMBER].sort());
  assert.equal(settings.verify.held.regular.existing, true);
  for (const m of [verified, vip, mod, bot, owner]) assert.ok(!m.roles.cache.has(UNVERIFIED), `${m.id} untouched`);

  // Every channel is hidden from Unverified except #please-read, #restricted and #rules (allowed on purpose).
  assert.ok(hidden(channels.get('general')));
  assert.ok(!hidden(channels.get('please-read')));
  assert.ok(!hidden(channels.get('restricted')));
  assert.ok(channels.get('rules').permissionOverwrites.cache.get(UNVERIFIED).allow.has(P.ViewChannel));
  assert.match(channels.get('please-read').panel.embeds[0].data.title, /Verify to chat and see the jailbreaks/);
});

test('verifying gives their roles back (and the member role), removes Unverified and adds Verified', async () => {
  const { guild, settings, add } = setup();
  const regular = add('regular', { roleIds: [MEMBER, LEVEL] });
  await verify.requireAllOn(guild);
  await verify.gateEveryone(guild);
  assert.deepEqual(roleIds(regular), [UNVERIFIED]);

  await verify.finish(guild, regular, ['111']);
  assert.deepEqual(roleIds(regular), [LEVEL, MEMBER, VERIFIED].sort());
  assert.equal(settings.verify.held.regular, undefined);
  assert.equal(settings.verify.verified.regular.newJoiner, false, 'an existing member stays one');
});

test('a new member: Unverified, no member role until they verify', async () => {
  const { guild, settings, add } = setup();
  await verify.requireAllOn(guild);
  const newbie = add('newbie', { joinedAt: Date.now() });
  await autorole.onMemberAdd(newbie).catch(() => {});
  await verify.onJoin(newbie);
  assert.equal(await autorole.giveAutorole(newbie), false);
  assert.deepEqual(roleIds(newbie), [UNVERIFIED]);
  assert.equal(settings.verify.held.newbie.existing, false);

  await verify.finish(guild, newbie, ['111']);
  assert.deepEqual(roleIds(newbie), [MEMBER, VERIFIED].sort());
});

test('a role given to someone waiting (by a mod or another bot) is taken back off and saved; giving Verified lets them in', async () => {
  const { guild, settings, add } = setup();
  const regular = add('regular', { roleIds: [MEMBER] });
  await verify.requireAllOn(guild);
  await verify.gateEveryone(guild);

  const before = { partial: false, roles: { cache: new Collection(regular.roles.cache) } };
  await regular.roles.add(LEVEL);
  await verify.onMemberUpdate(before, regular);
  assert.deepEqual(roleIds(regular), [UNVERIFIED]);
  assert.ok(settings.verify.held.regular.roles.includes(LEVEL));

  await regular.roles.add(VERIFIED);
  await verify.onMemberUpdate(before, regular);
  assert.deepEqual(roleIds(regular), [LEVEL, MEMBER, VERIFIED].sort());
  assert.equal(settings.verify.verified.regular.via, 'manual');
});

test('turning it off gives existing members their roles back; new members keep waiting to verify', async () => {
  const { guild, settings, channels, add } = setup();
  const regular = add('regular', { roleIds: [MEMBER, LEVEL] });
  const newbie = add('newbie', { joinedAt: Date.now() });
  await verify.requireAllOn(guild);
  await verify.onJoin(newbie);
  await verify.gateEveryone(guild);

  const { released, left } = await verify.requireAllOff(guild);
  assert.equal(released, 1);
  assert.equal(left, 0);
  assert.deepEqual(roleIds(regular), [LEVEL, MEMBER].sort());
  assert.deepEqual(roleIds(newbie), [UNVERIFIED], 'new members still have to verify');
  assert.deepEqual(Object.keys(settings.verify.held), ['newbie']);
  assert.ok(hidden(channels.get('general')), 'still hidden from people who haven’t verified');
  assert.ok(hidden(channels.get('old-jb-1')) && hidden(channels.get('new-jb')), 'the jailbreak sections stay hidden from Unverified');
});

test('turning it off never loses saved roles: a failure keeps them for the next try; restricted people get them on unrestrict', async () => {
  const { guild, settings, add } = setup();
  const flaky = add('flaky', { roleIds: [MEMBER, LEVEL] });
  const naughty = add('naughty', { roleIds: [MEMBER, LEVEL] });
  await verify.requireAllOn(guild);
  await verify.gateEveryone(guild);
  // Restricted while waiting: their record only has Unverified in it.
  settings.restricted.naughty = { roles: [UNVERIFIED], reason: 'x' };

  const realSet = flaky.roles.set;
  flaky.roles.set = async () => {
    throw new Error('Discord is down');
  };
  const first = await verify.requireAllOff(guild);
  assert.equal(first.left, 1, 'still saved');
  assert.deepEqual(settings.verify.held.flaky.roles.sort(), [LEVEL, MEMBER].sort());
  assert.deepEqual(settings.restricted.naughty.roles.sort(), [LEVEL, MEMBER].sort(), 'existing member: Unverified swapped for their real roles');
  assert.equal(settings.verify.held.naughty, undefined);

  flaky.roles.set = realSet;
  await verify.scanOnce(guild.client); // the 30-second round tries again
  assert.deepEqual(roleIds(flaky), [LEVEL, MEMBER].sort());
  assert.deepEqual(settings.verify.held, {});
});

test('the Restricted and Verified roles are never saved as roles to give back', async () => {
  const { guild, settings, add } = setup();
  settings.restrict.roleId = 'restricted-role';
  guild.roles.cache.set('restricted-role', { id: 'restricted-role', name: 'Restricted', editable: true, managed: false });
  const member = add('member', { roleIds: [MEMBER] });
  await verify.requireAllOn(guild);
  await verify.gateEveryone(guild);
  // A mod gives Restricted in Discord: the update arrives before the restricted record exists.
  await member.roles.add('restricted-role');
  await verify.onMemberUpdate({ partial: true }, member);
  assert.ok(member.roles.cache.has('restricted-role'), 'not taken off');
  assert.ok(!settings.verify.held.member.roles.includes('restricted-role'));
});

test('staff (or someone trusted) stuck with Unverified are let in', async () => {
  const { guild, add } = setup();
  const mod = add('mod', { roleIds: [MEMBER, UNVERIFIED], staff: true, joinedAt: Date.now() });
  await verify.requireAllOn(guild);
  await verify.gateEveryone(guild);
  assert.ok(!mod.roles.cache.has(UNVERIFIED), 'Unverified would hide the whole server from them');
});
// (VIPs have to verify too: see vipVerify.test.js.)

test('a mod giving Verified works even when Discord only sends part of the old member', async () => {
  const { guild, add } = setup();
  const regular = add('regular', { roleIds: [MEMBER] });
  await verify.requireAllOn(guild);
  await verify.gateEveryone(guild);
  await regular.roles.add(VERIFIED);
  await verify.onMemberUpdate({ partial: true }, regular);
  assert.deepEqual(roleIds(regular), [MEMBER, VERIFIED].sort());
});

test('verifying when Discord won’t give the roles back says so, and keeps them saved', async () => {
  const { guild, settings, add } = setup();
  const regular = add('regular', { roleIds: [MEMBER] });
  await verify.requireAllOn(guild);
  await verify.gateEveryone(guild);
  regular.roles.set = async () => {
    throw new Error('Discord is down');
  };
  const result = await verify.finish(guild, regular, ['111']);
  assert.equal(result.ok, false);
  assert.equal(result.failed, true);
  assert.deepEqual(settings.verify.held.regular.roles, [MEMBER]);
});

test('Discord saying “missing permissions” stops the round instead of trying everyone', async () => {
  const { guild, add, logged } = setup();
  let calls = 0;
  for (const id of ['a', 'b', 'c']) {
    add(id, { roleIds: [MEMBER] }).roles.set = async () => {
      calls++;
      throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    };
  }
  await verify.requireAllOn(guild);
  await verify.gateEveryone(guild);
  assert.equal(calls, 1);
  assert.ok(logged.some((l) => /won’t let me change people’s roles/.test(l)));
});

function command(guild, enabled, by = guild.ownerId) {
  const replies = [];
  const interaction = {
    commandName: 'verify',
    guild,
    guildId: guild.id,
    user: { id: by, tag: by },
    client: guild.client,
    options: { getSubcommand: () => 'require-all', getBoolean: () => enabled },
    deferred: false,
    replied: false,
    deferReply: async () => (interaction.deferred = true),
    reply: async (p) => replies.push(p.content ?? p),
    editReply: async (p) => replies.push(p.content ?? p),
  };
  return runCommand(interaction).then(() => replies);
}

test('/verify require-all: owner only, and refused while verifying doesn’t work (nobody could get back in)', async () => {
  const { guild, settings } = setup();
  assert.match((await command(guild, true, 'an-admin'))[0], /Only the server owner/);
  const replies = await command(guild, true);
  assert.match(replies[0], /isn’t working yet/);
  assert.equal(settings.verify.requireAll, false);
});

test('people who haven’t verified can see the two sections from config.js (not VIP-only channels in them), nothing else', async () => {
  const { guild, channels } = setup();
  const [sectionA] = require('../config').verify.visibleSections;
  channels.set(sectionA, makeChannel(sectionA));
  channels.set('info-chat', makeChannel('info-chat', { parentId: sectionA }));
  const vipInInfo = makeChannel('vip-in-info', { parentId: sectionA });
  await vipInInfo.permissionOverwrites.edit(guild.id, { ViewChannel: false });
  await vipInInfo.permissionOverwrites.edit(VIP, { ViewChannel: true });
  channels.set('vip-in-info', vipInInfo);

  await verify.gateEveryone(guild);
  const view = (id) => channels.get(id).permissionOverwrites.cache.get(UNVERIFIED);
  assert.ok(view(sectionA).allow.has(P.ViewChannel), 'the section itself');
  assert.ok(view('info-chat').allow.has(P.ViewChannel), 'channels in it');
  assert.ok(view('vip-in-info').deny.has(P.ViewChannel), 'VIP-only stays VIP-only');
  assert.ok(view('general').deny.has(P.ViewChannel), 'everything else is hidden');
  assert.ok(view('rules').allow.has(P.ViewChannel), 'a channel an admin let them into is left alone');
});

test('anything someone who hasn’t verified types is deleted, and they’re DMed (once) to verify', async () => {
  const { guild, add } = setup();
  const automod = require('../src/automod');
  const newbie = add('newbie', { joinedAt: Date.now() });
  await verify.onJoin(newbie);
  const dms = [];
  newbie.send = async (text) => dms.push(text);
  newbie.user.createdTimestamp = Date.now() - 365 * 86_400_000;
  const channel = { id: 'info-chat', name: 'info-chat', isTextBased: () => true, permissionOverwrites: { cache: new Collection() } };
  const say = async (content) => {
    const message = {
      id: `m-${Math.random()}`, guild, guildId: guild.id, channelId: channel.id, channel, author: newbie.user, member: newbie, content,
      createdTimestamp: Date.now(), attachments: new Collection(), mentions: { users: new Collection(), roles: new Collection() },
      inGuild: () => true, deleted: false, delete: async () => (message.deleted = true),
    };
    return { result: await automod.handleMessage(message), message };
  };
  const first = await say('hello');
  assert.equal(first.result, 'unverified');
  assert.ok(first.message.deleted);
  assert.equal(dms.length, 1);
  assert.match(dms[0], /Please verify to message in Mine\.\*\* You will also get access to the jailbreak prompts/);
  assert.match(dms[0], /please message <@100000000000000001>/);
  assert.match(dms[0], /<#please-read>/);
  await say('hello again');
  assert.equal(dms.length, 1, 'only once a day');
});

test('after a restart, someone still waiting to verify never gets their roles back (even before the member list loads)', async () => {
  const { guild, settings, add } = setup();
  const regular = add('regular', { roleIds: [MEMBER, LEVEL] });
  await verify.requireAllOn(guild);
  await verify.gateEveryone(guild);
  guild.members.cache.delete('regular'); // not loaded yet after a restart
  guild.members.fetch = async (id) => (id === 'regular' ? regular : new Collection([['regular', regular]]));
  await verify.resume(guild);
  assert.deepEqual(roleIds(regular), [UNVERIFIED]);
  assert.ok(settings.verify.held.regular);
});

test('the visible sections: a staff-only channel stays hidden, and nobody waiting can react or start threads', async () => {
  const { guild, channels } = setup();
  const [sectionA] = require('../config').verify.visibleSections;
  // @everyone can't see channels server-wide; only the member role can.
  guild.roles.cache.set(guild.id, { id: guild.id, permissions: new PermissionsBitField([]) });
  guild.roles.cache.get(MEMBER).permissions = new PermissionsBitField([P.ViewChannel]);
  channels.set(sectionA, makeChannel(sectionA));
  const staffOnly = makeChannel('staff-only', { parentId: sectionA });
  await staffOnly.permissionOverwrites.edit(MEMBER, { ViewChannel: false });
  channels.set('staff-only', staffOnly);
  channels.set('chat', makeChannel('chat', { parentId: sectionA }));
  await verify.gateEveryone(guild);
  const o = (id) => channels.get(id).permissionOverwrites.cache.get(UNVERIFIED);
  assert.ok(o('staff-only').deny.has(P.ViewChannel));
  assert.ok(o('chat').allow.has(P.ViewChannel));
  for (const p of [P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads]) assert.ok(o('chat').deny.has(p));
});

test('someone with Manage Server (or Ban, Kick...) is never held back', async () => {
  const { guild, add } = setup();
  const admin = add('admin', { roleIds: [MEMBER], joinedAt: Date.now() });
  admin.permissions = new PermissionsBitField([P.ManageGuild]);
  await verify.requireAllOn(guild);
  await verify.gateEveryone(guild);
  assert.ok(admin.roles.cache.has(MEMBER));
  assert.ok(!admin.roles.cache.has(UNVERIFIED));
});

test('if require-all can’t be set up it stays off, so nobody is locked out', async () => {
  const { guild, settings, channels, add } = setup();
  const regular = add('regular', { roleIds: [MEMBER] });
  channels.delete('please-read');
  guild.channels.create = async () => {
    throw new Error('Missing Permissions');
  };
  await assert.rejects(verify.requireAllOn(guild));
  assert.equal(settings.verify.requireAll, false);
  await verify.gateEveryone(guild);
  assert.ok(regular.roles.cache.has(MEMBER), 'an existing member keeps their roles');
});

test('deleting the Verified role doesn’t strip verified people; when it’s re-made they get it back', async () => {
  const { guild, settings, add } = setup();
  const verified = add('verified-newbie', { roleIds: [MEMBER, VERIFIED], joinedAt: Date.now() });
  settings.verify.verified['verified-newbie'] = { at: Date.now(), blocked: [], newJoiner: true };
  guild.roles.cache.delete(VERIFIED);
  verified.roles.cache.delete(VERIFIED);
  guild.roles.create = async ({ name }) => {
    const role = { id: `new-${name}`, name, editable: true, managed: false };
    guild.roles.cache.set(role.id, role);
    return role;
  };
  await verify.gateEveryone(guild); // puts the role back instead of holding anyone back
  assert.ok(verified.roles.cache.has(MEMBER), 'not stripped');
  assert.ok(verified.roles.cache.has(settings.verify.verifiedRoleId), 'got the new Verified role');
});

test('someone who leaves while waiting comes back as a new member, not owed their old roles', async () => {
  const { guild, settings, add } = setup();
  const regular = add('regular', { roleIds: [MEMBER, LEVEL] });
  await verify.requireAllOn(guild);
  await verify.gateEveryone(guild);
  assert.ok(settings.verify.held.regular);
  verify.onMemberLeave(regular);
  assert.equal(settings.verify.held.regular, undefined);
});

test('someone with no roles at all is treated like a new member: only #please-read and the two sections until they verify', async () => {
  const { guild, settings, add } = setup();
  const nobody = add('nobody', { roleIds: [] }); // here long before verification started
  await verify.gateEveryone(guild);
  assert.deepEqual(roleIds(nobody), [UNVERIFIED]);
  assert.ok(settings.verify.held.nobody.noRoles);
  // Not let go again on the next round just because they now hold Unverified.
  await verify.scanOnce(guild.client);
  assert.deepEqual(roleIds(nobody), [UNVERIFIED]);
  await verify.finish(guild, nobody, ['111']);
  assert.deepEqual(roleIds(nobody), [MEMBER, VERIFIED].sort(), 'verifying lets them in');
});

test('VIP channels only blocked from the member role are hidden from @everyone too (VIPs and bots keep access)', async () => {
  const vipLock = require('../src/vipLock');
  const { guild, settings, channels } = setup();
  settings.vipRoleId = VIP;
  const [vipChannelId] = require('../config').updating.vipChannelIds;
  const vip = makeChannel(vipChannelId);
  await vip.permissionOverwrites.edit(MEMBER, { ViewChannel: false });
  await vip.permissionOverwrites.edit(VIP, { ViewChannel: true });
  guild.roles.cache.set('some-bot', { id: 'some-bot', name: 'Some Bot', managed: true, editable: false });
  vip.permissionsFor = (role) => ({ has: () => role.id === 'some-bot' });
  channels.set(vipChannelId, vip);
  // Not a VIP channel: left alone.
  const general = channels.get('general');

  const fixed = await vipLock.lockVipChannels(guild);
  assert.deepEqual(fixed.map((c) => c.id), [vipChannelId]);
  const o = (id) => vip.permissionOverwrites.cache.get(id);
  assert.ok(o(guild.id).deny.has(P.ViewChannel), '@everyone can’t see it');
  assert.ok(o(VIP).allow.has(P.ViewChannel), 'VIPs still can');
  assert.ok(o('some-bot').allow.has(P.ViewChannel), 'a bot that could see it still can');
  assert.equal(general.permissionOverwrites.cache.get(guild.id), undefined);

  // Nothing to do the second time; and never during a lockdown.
  assert.deepEqual(await vipLock.lockVipChannels(guild), []);
  settings.lockdown.active = true;
  vip.permissionOverwrites.cache.delete(guild.id);
  assert.deepEqual(await vipLock.lockVipChannels(guild), []);
});

test('the old #please-read is renamed to ✅︱verify (same channel, same Verify message)', async () => {
  const { guild, channels, settings } = setup();
  const channel = channels.get('please-read');
  channel.name = 'please-read';
  channel.setName = async (name) => (channel.name = name);
  await verify.ensureSetup(guild);
  assert.equal(channel.name, '✅︱verify');
  assert.equal(settings.verify.channelId, 'please-read', 'still the same channel');
  assert.match(channel.panel.embeds[0].data.title, /Verify to chat/);
});
