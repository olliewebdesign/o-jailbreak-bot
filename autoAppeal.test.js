'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Being restricted opens an appeal ticket straight away. Moderators can't see appeals: the ticket doesn't let the mod
// role in or ping it, and the Appeals categories (with the tickets in them) are hidden from moderators. A full
// category (Discord allows 50 channels) moves on to "Appeals 2".

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-autoappeal-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, Collection, OverwriteType, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const store = require('../src/store');
const restrict = require('../src/restrict');
const blockedServers = require('../src/blockedServers');
const modGuard = require('../src/modGuard');

const BAD = '900000000000000001';
let n = 0;

function server({ appeals = true } = {}) {
  const logged = [];
  const created = []; // { opts, channel }
  const posted = new Map(); // channelId -> messages
  const cache = new Collection();
  const channel = (id, extra = {}) => {
    const ch = {
      id,
      name: id,
      parentId: null,
      toString: () => `<#${id}>`,
      permissionOverwrites: { cache: new Collection(), edit: async () => {} },
      messages: { fetch: async () => ({ id: 'panel' }) },
      send: async (p) => (posted.get(id) ?? posted.set(id, []).get(id)).push(p),
      ...extra,
    };
    cache.set(id, ch);
    return ch;
  };
  const log = { id: 'log', isTextBased: () => true, send: async (p) => (logged.push(p), { id: `msg-${logged.length}` }) };
  const role = (id, perms = []) => ({ id, name: id, managed: false, editable: true, permissions: new PermissionsBitField(perms) });
  const guild = {
    id: `guild-autoappeal-${n++}`,
    name: 'Mine',
    ownerId: 'owner',
    client: { user: { id: 'bot', tag: 'O Jailbreak' } },
    roles: {
      cache: new Collection([
        ['restricted-role', role('restricted-role')],
        ['mod-role', role('mod-role', [P.ModerateMembers])],
        ['manager', role('manager', [P.ManageGuild])],
        ['admin', role('admin', [P.Administrator])],
      ]),
    },
    members: { me: { permissions: new PermissionsBitField([P.ManageRoles, P.ManageChannels]) }, cache: new Collection([['trusty', {}]]), edit: async () => {}, fetch: async () => null },
    channels: {
      cache,
      fetch: async (id) => (id === 'log' ? log : cache.get(id) ?? null),
      create: async (opts) => {
        const ch = channel(`new-${created.length}`, { name: opts.name, parentId: opts.parent ?? null, type: opts.type });
        created.push({ opts, channel: ch });
        await new Promise((resolve) => setImmediate(resolve)); // Discord takes a moment
        return ch;
      },
    },
  };
  const restricted = channel('restricted');
  restricted.permissionOverwrites.cache.set('restricted-role', { allow: new PermissionsBitField([P.ViewChannel]), deny: new PermissionsBitField() });
  if (appeals) channel('appeals', { type: ChannelType.GuildCategory });

  const settings = store.guild(guild.id);
  Object.assign(settings, { logChannelId: 'log', modRoleId: 'mod-role', trusted: ['trusty'] });
  Object.assign(settings.restrict, { roleId: 'restricted-role', channelId: 'restricted', messageId: 'panel', categoryId: appeals ? 'appeals' : null });

  const dms = [];
  const member = (id) => ({
    id,
    guild,
    user: { id, tag: id, username: id, bot: false, createdTimestamp: Date.now() - 1e10, displayAvatarURL: () => null },
    roles: { cache: new Collection(), set: async () => {} },
    permissions: new PermissionsBitField(),
    joinedTimestamp: Date.now(),
    isCommunicationDisabled: () => false,
    send: async (p) => dms.push({ to: id, p }),
  });
  const tickets = () => created.filter((c) => c.opts.type === ChannelType.GuildText);
  return { guild, settings, logged, created, tickets, posted, member, dms, channel };
}

const descriptionOf = (p) => (p.embeds ?? []).map((e) => (e.toJSON ? e.toJSON() : e).description ?? '').join('\n');

test('restricting someone opens their appeal ticket straight away, and tells them where it is', async () => {
  const s = server();
  const result = await restrict.restrictMember({ guild: s.guild, member: s.member('alice'), moderator: { id: 'mod', tag: 'mod' }, reason: 'Spamming' });
  assert.equal(result.ok, true);
  const [ticket] = s.tickets();
  assert.ok(ticket, 'a ticket was made');
  assert.equal(ticket.opts.parent, 'appeals');
  assert.equal(s.settings.restricted.alice.ticketChannelId, ticket.channel.id);
  assert.match(result.text, /their appeal ticket \(opened for them\)/);
  assert.doesNotMatch(result.text, /<#new-/, 'no link: moderators can’t open it');
  const dm = s.dms.find((d) => d.to === 'alice');
  assert.match(descriptionOf(dm.p), new RegExp(`explain in your appeal ticket: <#${ticket.channel.id}>`));
  assert.ok(s.logged.some((p) => /alice\*\* was restricted — appeal opened automatically/.test(p.content ?? '')));
});

test('moderators aren’t let into appeal tickets or pinged in them — only the person (and Administrators, who see everything)', async () => {
  const s = server();
  await restrict.restrictMember({ guild: s.guild, member: s.member('alice'), moderator: { id: 'mod', tag: 'mod' }, reason: 'Spamming' });
  const [ticket] = s.tickets();
  const ids = ticket.opts.permissionOverwrites.map((o) => o.id);
  assert.ok(!ids.includes('mod-role'), 'no mod role');
  assert.deepEqual(ticket.opts.permissionOverwrites.find((o) => o.id === s.guild.id).deny, [P.ViewChannel]);
  assert.equal(ticket.opts.permissionOverwrites.find((o) => o.id === 'alice').type, OverwriteType.Member);
  assert.ok(!ids.includes('manager'), 'not a Manage Server role');
  assert.ok(!ids.includes('trusty'), 'not trusted users');
  assert.deepEqual(ids.sort(), [s.guild.id, 'alice'].sort(), 'just @everyone (shut out) and them');
  const [first] = s.posted.get(ticket.channel.id);
  assert.equal(first.content, '<@alice>');
  assert.deepEqual(first.allowedMentions, { users: ['alice'] });
});

test('the Appeals category doesn’t let moderators in either, and it’s made the first time someone’s restricted', async () => {
  const s = server({ appeals: false });
  await restrict.restrictMember({ guild: s.guild, member: s.member('alice'), moderator: { id: 'mod', tag: 'mod' }, reason: 'Spamming' });
  const category = s.created.find((c) => c.opts.type === ChannelType.GuildCategory);
  assert.equal(category.opts.name, 'Appeals');
  assert.deepEqual(category.opts.permissionOverwrites.map((o) => o.id), [s.guild.id]);
  assert.equal(s.settings.restrict.categoryId, category.channel.id);
});

test('moderators are blocked from the Appeals categories and every ticket in them (including ones from before)', async () => {
  const s = server();
  s.settings.restrict.extraCategoryIds = ['appeals-2'];
  s.channel('appeals-2', { type: ChannelType.GuildCategory });
  s.channel('old-ticket', { parentId: 'appeals' });
  s.channel('newer-ticket', { parentId: 'appeals-2' });
  s.channel('general');
  const hidden = modGuard.hiddenChannelIds(s.guild);
  for (const id of ['appeals', 'appeals-2', 'old-ticket', 'newer-ticket']) assert.ok(hidden.includes(id), id);
  assert.ok(!hidden.includes('general'));
  assert.ok(!hidden.includes('restricted'), '#restricted stays as it is');
});

test('a full Appeals category (50 channels) moves on to “Appeals 2”', async () => {
  const s = server();
  for (let i = 0; i < 50; i++) s.channel(`full-${i}`, { parentId: 'appeals' });
  await restrict.restrictMember({ guild: s.guild, member: s.member('alice'), moderator: { id: 'mod', tag: 'mod' }, reason: 'Spamming' });
  const category = s.created.find((c) => c.opts.type === ChannelType.GuildCategory);
  assert.equal(category.opts.name, 'Appeals 2');
  assert.deepEqual(s.settings.restrict.extraCategoryIds, [category.channel.id]);
  assert.equal(s.tickets()[0].opts.parent, category.channel.id);
  assert.equal(s.settings.restrict.categoryId, 'appeals', 'the first one is kept');
  assert.equal(restrict.isRestrictSpace(s.tickets()[0].channel, s.settings.restrict), true, 'not hidden from the person');
});

test('two people restricted at once don’t make two Appeals categories', async () => {
  const s = server({ appeals: false });
  const mod = { id: 'mod', tag: 'mod' };
  await Promise.all(['alice', 'bob'].map((id) => restrict.restrictMember({ guild: s.guild, member: s.member(id), moderator: mod, reason: 'Raid' })));
  assert.equal(s.created.filter((c) => c.opts.type === ChannelType.GuildCategory).length, 1);
  assert.equal(s.tickets().length, 2);
});

test('if the ticket can’t be made, they’re told to appeal in #restricted instead', async () => {
  const s = server();
  s.guild.channels.create = async () => {
    throw new Error('Maximum number of guild channels reached (500)');
  };
  const result = await restrict.restrictMember({ guild: s.guild, member: s.member('alice'), moderator: { id: 'mod', tag: 'mod' }, reason: 'Spamming' });
  assert.equal(result.ok, true, 'still restricted');
  assert.match(result.text, /can appeal there/);
  assert.match(descriptionOf(s.dms[0].p), /You can only see <#restricted> for now/);
  assert.equal(s.settings.restricted.alice.ticketChannelId, null, 'the button still works');
});

test('restricted for a blocked server: the automatic ticket asks them to leave it', async () => {
  const s = server();
  s.settings.blockedServers = { [BAD]: { name: 'anonymouse', invites: [], icon: null } };
  const alice = s.member('alice');
  await blockedServers.restrictAssociated(alice, 'wearing the tag of **anonymouse**', [BAD]);
  const [ticket] = s.tickets();
  assert.ok(ticket, 'one ticket');
  assert.equal(s.tickets().length, 1);
  const notice = s.posted.get(ticket.channel.id).map(descriptionOf).find((d) => /Please leave that Discord/.test(d));
  assert.match(notice, /in the anonymouse server/);
});

test('pressing the appeal button after a ticket was opened automatically points to that ticket', async () => {
  const s = server();
  const alice = s.member('alice');
  await restrict.restrictMember({ guild: s.guild, member: alice, moderator: { id: 'mod', tag: 'mod' }, reason: 'Spamming' });
  const ticket = s.tickets()[0].channel;
  ticket.permissionsFor = () => ({ has: () => true });
  const replies = [];
  await restrict.appealButton({ guild: s.guild, user: alice.user, member: { ...alice, roles: { cache: new Collection() } }, reply: async (p) => replies.push(p.content) }, 'appeal-open');
  assert.match(replies[0], new RegExp(`already have an appeal open: <#${ticket.id}>`));
  assert.equal(s.tickets().length, 1);
});
