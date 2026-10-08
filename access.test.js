'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Staff access: a moderator is always a moderator (Manage Server through another role or the trusted list doesn't let
// them unrestrict), appeals are only for the person, the owner and Administrators, nobody else keeps personal access
// to the staff channels, and /access explains why someone can see what they can.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-access-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, Collection, OverwriteType, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const store = require('../src/store');
const restrict = require('../src/restrict');
const modGuard = require('../src/modGuard');
const access = require('../src/access');

// A small model of Discord's rules: Administrator sees everything; then @everyone's overwrite, then every role's
// (any allow beats any deny), then the person's own.
function canSee(guild, channel, target) {
  const ows = channel.permissionOverwrites.cache;
  const apply = (bits, o) => (o ? bits.remove(o.deny).add(o.allow) : bits);
  if (!target.roles) {
    const bits = new PermissionsBitField(guild.roles.cache.get(guild.id).permissions).add(target.permissions);
    return apply(apply(bits, ows.get(guild.id)), target.id === guild.id ? null : ows.get(target.id)).has(P.ViewChannel);
  }
  if (target.id === guild.ownerId) return true;
  const roles = [guild.roles.cache.get(guild.id), ...target.roles.cache.values()];
  const base = new PermissionsBitField(roles.map((r) => r.permissions.bitfield).reduce((a, b) => a | b, 0n));
  if (base.has(P.Administrator)) return true;
  let bits = apply(base, ows.get(guild.id));
  const roleOws = [...target.roles.cache.keys()].map((id) => ows.get(id)).filter(Boolean);
  bits = bits.remove(roleOws.map((o) => o.deny.bitfield).reduce((a, b) => a | b, 0n)).add(roleOws.map((o) => o.allow.bitfield).reduce((a, b) => a | b, 0n));
  return apply(bits, ows.get(target.id)).has(P.ViewChannel);
}

let n = 0;
function server() {
  const logged = [];
  const guild = { id: `guild-access-${n++}`, name: 'Mine', ownerId: 'owner', client: { user: { id: 'bot', tag: 'O Jailbreak' } } };
  const role = (id, perms = [], extra = {}) => ({ id, name: id, position: 1, managed: false, tags: null, permissions: new PermissionsBitField(perms), ...extra });
  guild.roles = {
    cache: new Collection(
      [role(guild.id, [P.ViewChannel, P.SendMessages]), role('mod-role', [P.PrioritySpeaker]), role('manager', [P.ManageGuild]), role('admin', [P.Administrator]), role('helper'), role('member')].map((r) => [r.id, r]),
    ),
  };
  const members = new Collection();
  guild.members = { cache: members, fetch: async (id) => members.get(id) ?? null };
  const add = (id, roleIds = []) => {
    const roles = new Collection(roleIds.map((r) => [r, guild.roles.cache.get(r)]));
    const perms = new PermissionsBitField([...roles.values()].map((r) => r.permissions.bitfield).reduce((a, b) => a | b, 0n));
    const member = { id, guild, user: { id, tag: id, bot: false }, roles: { cache: roles }, permissions: perms, toString: () => `<@${id}>` };
    members.set(id, member);
    return member;
  };
  const channels = new Collection();
  const channel = (id, { parentId = null, type = ChannelType.GuildText, topic = null, overwrites = [] } = {}) => {
    const cache = new Collection(
      overwrites.map((o) => [o.id, { id: o.id, type: o.type ?? OverwriteType.Role, allow: new PermissionsBitField(o.allow ?? []), deny: new PermissionsBitField(o.deny ?? []) }]),
    );
    const ch = {
      id,
      name: id,
      type,
      parentId,
      topic,
      rawPosition: channels.size,
      toString: () => `<#${id}>`,
      isTextBased: () => true,
      send: async (p) => logged.push(typeof p === 'string' ? p : p.content),
      permissionsFor: (target) => ({ has: () => canSee(guild, ch, target) }),
      permissionOverwrites: {
        cache,
        edit: async (target, perms, opts) => {
          const o = cache.get(target) ?? { id: target, type: opts.type, allow: new PermissionsBitField(), deny: new PermissionsBitField() };
          cache.set(target, o);
          for (const [name, value] of Object.entries(perms)) {
            o.allow.remove(P[name]);
            o.deny.remove(P[name]);
            if (value === true) o.allow.add(P[name]);
            if (value === false) o.deny.add(P[name]);
          }
        },
      },
    };
    channels.set(id, ch);
    return ch;
  };
  guild.channels = { cache: channels, fetch: async (id) => channels.get(id) ?? null };
  const settings = store.guild(guild.id);
  Object.assign(settings, { logChannelId: 'modlog', modRoleId: 'mod-role' });
  const hidden = (extra = []) => [{ id: guild.id, deny: [P.ViewChannel] }, ...extra];
  channel('general');
  channel('modlog', { overwrites: hidden() });
  return { guild, settings, add, channel, hidden, logged };
}

test('a moderator is never an admin through Manage Server or the trusted list — only through Administrator', () => {
  const s = server();
  const owner = s.add('owner');
  const plainMod = s.add('mod1', ['mod-role']);
  const modWithManage = s.add('mod2', ['mod-role', 'manager']);
  const trustedMod = s.add('mod3', ['mod-role']);
  const modWithAdmin = s.add('mod4', ['mod-role', 'admin']);
  const manager = s.add('manager1', ['manager']);
  const trustedMember = s.add('friend');
  s.settings.trusted.push('mod3', 'friend');
  assert.equal(modGuard.isAdmin(owner), true);
  assert.equal(modGuard.isAdmin(plainMod), false);
  assert.equal(modGuard.isAdmin(modWithManage), false, 'Manage Server from another role');
  assert.equal(modGuard.isAdmin(trustedMod), false, 'on the trusted list');
  assert.equal(modGuard.isAdmin(modWithAdmin), true, 'Administrator: Discord lets them do anything anyway');
  assert.equal(modGuard.isAdmin(manager), true);
  assert.equal(modGuard.isAdmin(trustedMember), true);
  assert.equal(modGuard.isLimitedMod(modWithManage), true, 'so they keep the moderator limits');
});

test('a moderator with Manage Server through another role can’t press Unrestrict', async () => {
  const s = server();
  const mod = s.add('mod2', ['mod-role', 'manager']);
  s.settings.restricted.alice = { by: 'x', reason: 'x', at: Date.now(), roles: [], ticketChannelId: null };
  const replies = [];
  await restrict.appealButton({ guild: s.guild, user: mod.user, member: mod, reply: async (p) => replies.push(p.content) }, 'appeal-unrestrict', 'alice');
  assert.match(replies[0], /Only admins and the owner can unrestrict/);
  assert.ok(s.settings.restricted.alice, 'still restricted');
});

test('appeals: only the person, the owner and Administrators keep access — everyone else let in loses it', async () => {
  const s = server();
  s.settings.restrict.categoryId = 'appeals';
  s.settings.trusted.push('friend');
  s.add('friend');
  s.add('rando', ['member']);
  s.add('alice');
  s.channel('appeals', { type: ChannelType.GuildCategory, overwrites: s.hidden([{ id: 'helper', allow: [P.ViewChannel] }]) });
  s.channel('appeal-alice', {
    parentId: 'appeals',
    topic: 'Appeal from alice (111111111111111111)',
    overwrites: [
      { id: s.guild.id, allow: [P.ViewChannel] }, // someone let @everyone in
      { id: 'alice', type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages] },
      { id: 'mod-role', allow: [P.ViewChannel, P.SendMessages] }, // from before v1.27.0
      { id: 'manager', allow: [P.ViewChannel] }, // v1.27.0 – v1.28.0
      { id: 'friend', type: OverwriteType.Member, allow: [P.ViewChannel] }, // trusted, v1.27.0 – v1.28.0
      { id: 'rando', type: OverwriteType.Member, allow: [P.ViewChannel] },
      { id: 'admin', allow: [P.ViewChannel] },
      { id: 'bot', type: OverwriteType.Member, allow: [P.ViewChannel] },
    ],
  });
  s.settings.restricted.alice = { roles: [], ticketChannelId: 'appeal-alice' };

  const removed = await restrict.lockAppeals(s.guild);
  const ticket = s.guild.channels.cache.get('appeal-alice');
  const sees = (id) => ticket.permissionsFor(s.guild.members.cache.get(id) ?? s.guild.roles.cache.get(id)).has(P.ViewChannel);
  for (const id of ['mod-role', 'manager', 'friend', 'rando']) assert.equal(ticket.permissionOverwrites.cache.get(id).allow.has(P.ViewChannel), false, id);
  assert.equal(ticket.permissionOverwrites.cache.get(s.guild.id).deny.has(P.ViewChannel), true, '@everyone shut out again');
  assert.equal(sees('alice'), true, 'the person appealing keeps it');
  assert.equal(sees('rando'), false);
  assert.equal(ticket.permissionOverwrites.cache.get('admin').allow.has(P.ViewChannel), true, 'Administrator role left alone');
  assert.equal(ticket.permissionOverwrites.cache.get('bot').allow.has(P.ViewChannel), true, 'the bot left alone');
  assert.equal(s.guild.channels.cache.get('appeals').permissionOverwrites.cache.get('helper').allow.has(P.ViewChannel), false, 'the category too');
  assert.equal(removed.length, 6);
  assert.deepEqual(await restrict.lockAppeals(s.guild), [], 'nothing left to do the second time');
});

test('nobody but admins keeps personal access to a staff channel, and the mod log says so', async () => {
  const s = server();
  s.add('rando', ['member']);
  s.add('manager1', ['manager']);
  s.add('mod1', ['mod-role']);
  const modlog = s.guild.channels.cache.get('modlog');
  for (const id of ['rando', 'manager1', 'mod1']) await modlog.permissionOverwrites.edit(id, { ViewChannel: true }, { type: OverwriteType.Member });
  const removed = await modGuard.guardStaffChannels(s.guild);
  assert.deepEqual(removed.sort(), ['<@mod1> from <#modlog>', '<@rando> from <#modlog>']);
  assert.equal(modlog.permissionOverwrites.cache.get('manager1').allow.has(P.ViewChannel), true, 'an admin keeps it');
  assert.ok(s.logged.some((l) => /only for the owner and admins, so I took away access: .*<@rando>/.test(l)));
});

test('/access user: shows the role and personal permission that let a regular member into staff channels', async () => {
  const s = server();
  const rando = s.add('rando', ['member', 'helper']);
  s.channel('vip', { overwrites: s.hidden([{ id: 'member', allow: [P.ViewChannel] }]) });
  await s.guild.channels.cache.get('modlog').permissionOverwrites.edit('helper', { ViewChannel: true }, { type: OverwriteType.Role });
  s.channel('staff-chat', { overwrites: s.hidden([{ id: 'rando', type: OverwriteType.Member, allow: [P.ViewChannel] }]) });
  modGuard.modsSettings(s.settings).hiddenChannels.push('staff-chat'); // /modhide add

  const { embeds, components } = access.memberReport(s.guild, rando);
  const embed = embeds[0].toJSON();
  assert.match(embed.description, /I treat them as \*\*a regular member\*\*/);
  assert.match(embed.description, /can see \*\*2 staff channel/);
  const field = (name) => embed.fields.find((f) => f.name.includes(name))?.value ?? '';
  assert.match(field('helper role'), /⚠️<#modlog>/);
  assert.match(field('member role'), /<#vip>/);
  assert.match(field('personally'), /⚠️<#staff-chat>/);
  assert.equal(components[0].components[0].data.custom_id, 'oj:access-clear:rando');

  // The 🧹 button takes the personal access away (not the role's).
  s.add('owner');
  const replies = [];
  await access.clearButton({ guild: s.guild, user: { tag: 'owner' }, member: s.guild.members.cache.get('owner'), reply: async (p) => replies.push(p.content) }, 'rando');
  assert.match(replies[0], /Took away their personal access to 1 channel/);
  assert.equal(s.guild.channels.cache.get('staff-chat').permissionsFor(rando).has(P.ViewChannel), false);
});

test('/access user: someone with Administrator through a role is called out', () => {
  const s = server();
  const sneaky = s.add('sneaky', ['admin']);
  const embed = access.memberReport(s.guild, sneaky).embeds[0].toJSON();
  assert.match(embed.description, /\*\*Administrator\*\* through <@&admin>/);
});

test('/access with no user lists Administrator and Manage Server roles, trusted people, and who else is in staff channels', async () => {
  const s = server();
  s.add('boss', ['admin']);
  s.add('manager1', ['manager']);
  s.add('friend');
  s.add('rando', ['member']);
  s.settings.trusted.push('friend');
  await s.guild.channels.cache.get('modlog').permissionOverwrites.edit('helper', { ViewChannel: true }, { type: OverwriteType.Role });
  await s.guild.channels.cache.get('modlog').permissionOverwrites.edit('rando', { ViewChannel: true }, { type: OverwriteType.Member });
  const embed = access.serverReport(s.guild).embeds[0].toJSON();
  const field = (name) => embed.fields.find((f) => f.name.includes(name)).value;
  assert.match(field('Administrator'), /<@&admin> — <@boss>/);
  assert.match(field('Manage Server'), /<@&manager> — <@manager1>/);
  assert.match(field('Trusted'), /<@friend>/);
  assert.match(field('staff channels'), /<@&helper>: <#modlog>/);
  assert.match(field('staff channels'), /<@rando>: <#modlog>/);
});

test('/access is refused for moderators and members', async () => {
  const s = server();
  const mod = s.add('mod2', ['mod-role', 'manager']);
  const replies = [];
  await access.command({ guild: s.guild, member: mod, user: mod.user, reply: async (p) => replies.push(p.content), options: { getUser: () => null } });
  assert.match(replies[0], /Only admins and the owner/);
});
