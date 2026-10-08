'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Moderators: only /mute, /unmute, /restrict, /msgdelete; no unrestricting; everything logged in #mod-watch; too much at
// once and they're put on cooldown (mod role off, @everyone pinged in #mod-watch, owner DMed) until the owner lifts it.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-modguard-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AuditLogEvent, Collection, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const store = require('../src/store');
const restrict = require('../src/restrict');
const modGuard = require('../src/modGuard');
const { runCommand } = require('../src/commands');

const MOD_ROLE = '8000000000000000020';
const OWNER = 'owner-id';

restrict.restrictMember = async ({ guild, member }) => {
  store.guild(guild.id).restricted[member.id] = { roles: [] };
  return { ok: true, text: `🚷 Restricted <@${member.id}>.` };
};

let n = 0;
function setup() {
  const watch = [];
  const ownerDms = [];
  const roles = new Collection();
  const modRole = { id: MOD_ROLE, name: 'Mod', editable: true, managed: false, permissions: new PermissionsBitField([P.ModerateMembers, P.ManageMessages]) };
  modRole.setPermissions = async (perms) => (modRole.permissions = new PermissionsBitField(perms));
  roles.set(MOD_ROLE, modRole);
  const members = new Collection();
  const guild = {
    id: `guild-mods-${n++}`,
    name: 'O Jailbreak',
    ownerId: OWNER,
    roles: { cache: roles },
    members: { cache: members, fetch: async (id) => (id ? members.get(id) ?? null : members) },
    fetchOwner: async () => ({ send: async (p) => ownerDms.push(p) }),
  };
  const watchChannel = { id: 'watch', name: 'mod-watch', isTextBased: () => true, send: async (p) => watch.push(p) };
  guild.channels = { cache: new Collection([['watch', watchChannel]]), fetch: async (id) => guild.channels.cache.get(id) ?? null };
  guild.client = { user: { id: 'bot', tag: 'O Jailbreak', username: 'O Jailbreak' }, guilds: { cache: new Collection([[guild.id, guild]]) } };
  const settings = store.guild(guild.id);
  Object.assign(settings, { logChannelId: 'log', modRoleId: MOD_ROLE });
  modGuard.modsSettings(settings).watchChannelId = 'watch';

  const add = (id, { roleIds = [], perms = [] } = {}) => {
    const member = {
      id,
      guild,
      user: { id, tag: id, username: id, bot: false, createdTimestamp: 0, displayAvatarURL: () => '' },
      roles: {
        cache: new Collection(roleIds.map((r) => [r, roles.get(r)])),
        remove: async (ids) => [].concat(ids).forEach((r) => member.roles.cache.delete(r.id ?? r)),
        add: async (ids) => [].concat(ids).forEach((r) => member.roles.cache.set(r.id ?? r, roles.get(r.id ?? r))),
        // Moderators rank above ordinary members.
        get highest() {
          const position = member.roles.cache.size ? 1 : 0;
          return { position, comparePositionTo: (other) => position - other.position };
        },
      },
      get permissions() {
        return new PermissionsBitField([...perms, ...member.roles.cache.map((r) => r.permissions?.bitfield ?? 0n)]);
      },
      timeout: async (ms) => (member.timedOutFor = ms),
      isCommunicationDisabled: () => false,
      moderatable: true,
      send: async () => {},
    };
    members.set(id, member);
    return member;
  };
  return { guild, settings, add, watch, ownerDms, modRole };
}

function slash(guild, member, commandName, { sub = null, user = null, target = null, strings = {}, ints = {} } = {}) {
  const replies = [];
  const interaction = {
    commandName,
    guild,
    guildId: guild.id,
    member,
    user: member.user,
    client: guild.client,
    memberPermissions: member.permissions,
    channel: null,
    options: {
      getSubcommand: () => sub,
      getUser: () => user,
      getMember: () => target,
      getString: (k) => strings[k] ?? null,
      getInteger: (k) => ints[k] ?? null,
      getBoolean: () => null,
    },
    deferred: false,
    replied: false,
    deferReply: async () => (interaction.deferred = true),
    reply: async (p) => replies.push(p.content ?? p),
    editReply: async (p) => replies.push(p.content ?? p),
  };
  return { interaction, replies, run: () => runCommand(interaction).then(() => replies) };
}

test('moderators only get the mod commands; admins and members aren’t affected', async () => {
  const { guild, add } = setup();
  const mod = add('mod', { roleIds: [MOD_ROLE] });
  const admin = add('admin', { perms: [P.Administrator] });
  assert.match(modGuard.commandProblem(slash(guild, mod, 'post').interaction), /Moderators can only use/);
  assert.match(modGuard.commandProblem(slash(guild, mod, 'lockdown').interaction), /Moderators can only use/);
  assert.match(modGuard.commandProblem(slash(guild, mod, 'unrestrict').interaction), /Moderators can only use/);
  for (const name of ['mute', 'unmute', 'restrict', 'msgdelete', 'Moderate', 'Delete Message', 'invites', 'rank']) assert.equal(modGuard.commandProblem(slash(guild, mod, name).interaction), null, name);
  assert.equal(modGuard.commandProblem(slash(guild, admin, 'post').interaction), null);
  assert.ok(modGuard.isLimitedMod(mod));
  assert.ok(!modGuard.isLimitedMod(admin));
});

test('a 5th restrict within 5 minutes is refused: mod role off, @everyone in #mod-watch, owner DMed — until lifted', async () => {
  const { guild, settings, add, watch, ownerDms } = setup();
  const mod = add('mod', { roleIds: [MOD_ROLE] });
  for (let i = 1; i <= 4; i++) {
    const target = add(`victim-${i}`);
    const { run } = slash(guild, mod, 'restrict', { user: target.user, target, strings: { reason: 'spam' } });
    const replies = await run();
    assert.match(replies.at(-1), /Restricted/, `restrict ${i} goes through`);
  }
  assert.equal(watch.filter((p) => /restricted/.test(p.content)).length, 4, 'each one is in #mod-watch');

  const fifth = add('victim-5');
  const replies = await slash(guild, mod, 'restrict', { user: fifth.user, target: fifth, strings: { reason: 'spam' } }).run();
  assert.match(replies.at(-1), /too much at once/);
  assert.doesNotMatch(replies.at(-1), /owner|told|logged|watch|\d/, 'nothing tells them they’re watched (or the limit)');
  assert.ok(!settings.restricted['victim-5'], 'the 5th wasn’t done');
  assert.ok(!mod.roles.cache.has(MOD_ROLE), 'mod role taken off');
  const alert = watch.find((p) => p.content === '@everyone');
  assert.ok(alert, '@everyone pinged in #mod-watch');
  assert.deepEqual(alert.allowedMentions, { parse: ['everyone'] });
  assert.match(alert.embeds[0].data.description, /restrict/);
  assert.equal(alert.components[0].toJSON().components[0].custom_id, `ojmod:lift:${guild.id}:mod`);
  assert.equal(ownerDms.length, 1);

  // Still blocked, even for /unmute, until the owner lifts it.
  assert.match(modGuard.commandProblem(slash(guild, mod, 'unmute').interaction), /paused/);
  const result = await modGuard.liftCooldown(guild, 'mod', { id: OWNER, tag: 'owner' });
  assert.ok(result.ok);
  assert.ok(mod.roles.cache.has(MOD_ROLE), 'mod role back');
  assert.equal(modGuard.commandProblem(slash(guild, mod, 'unmute').interaction), null);
});

test('moderators can’t unrestrict', async () => {
  const { guild, add } = setup();
  const mod = add('mod', { roleIds: [MOD_ROLE] });
  const someone = add('someone');
  const { interaction, replies } = slash(guild, mod, 'unrestrict', { user: someone.user });
  // Straight to the handler, as if Discord had shown them the command anyway.
  await require('../src/commands').runCommand(interaction);
  assert.match(replies[0], /Moderators can only use|Only admins/);
});

test('the mod role has no moderation powers of its own (everything goes through the bot), whoever adds them', async () => {
  const { guild, modRole, watch } = setup();
  modRole.permissions = new PermissionsBitField([P.Administrator, P.BanMembers, P.ModerateMembers, P.ManageMessages, P.SendMessages]);
  const changed = await modGuard.secureModRole(guild, { by: 'sneaky-admin' });
  assert.deepEqual(changed.remove.sort(), ['Administrator', 'BanMembers', 'ManageMessages', 'ModerateMembers']);
  assert.deepEqual(changed.add, ['PrioritySpeaker']);
  for (const p of [P.Administrator, P.BanMembers, P.ModerateMembers, P.ManageMessages]) assert.ok(!modRole.permissions.has(p, false));
  assert.ok(modRole.permissions.has(P.PrioritySpeaker, false), 'the key that shows them the mod commands');
  assert.ok(modRole.permissions.has(P.SendMessages, false), 'harmless permissions are left alone');
  assert.match(watch.at(-1).content, /<@sneaky-admin> changed the \*\*Mod\*\* role/);
});

test('timeouts a moderator gives in Discord itself are logged and count towards the limit (and undone on cooldown)', async () => {
  const { guild, settings, add, watch } = setup();
  const mod = add('mod', { roleIds: [MOD_ROLE] });
  const entry = (targetId) => ({ action: AuditLogEvent.MemberUpdate, executorId: 'mod', targetId, reason: null, changes: [{ key: 'communication_disabled_until', new: new Date(Date.now() + 3_600_000).toISOString() }] });
  for (let i = 1; i <= 6; i++) {
    add(`t-${i}`);
    await modGuard.onAuditLogEntry(entry(`t-${i}`), guild);
  }
  assert.equal(watch.filter((p) => /timed out <@t-\d>/.test(p.content)).length, 6);
  assert.ok(!modGuard.onCooldown(guild, 'mod'));
  const seventh = add('t-7');
  await modGuard.onAuditLogEntry(entry('t-7'), guild);
  assert.ok(modGuard.onCooldown(guild, 'mod'));
  assert.equal(seventh.timedOutFor, null, 'the 7th timeout was undone');
  assert.ok(settings.mods.cooldowns.mod);
});

test('/msgdelete user amount: deletes their recent messages (never pinned ones) and logs them', async () => {
  const { guild, add, watch } = setup();
  const mod = add('mod', { roleIds: [MOD_ROLE] });
  add('admin', { perms: [P.Administrator] });
  add('spammer');
  const msg = (id, authorId, extra = {}) => ({ id, author: { id: authorId, tag: authorId }, member: guild.members.cache.get(authorId) ?? null, content: `msg ${id}`, createdTimestamp: Date.now(), pinned: false, attachments: new Collection(), ...extra });
  const messages = new Collection(
    [msg('1', 'spammer'), msg('2', OWNER), msg('3', 'admin'), msg('4', 'bot'), msg('5', 'spammer', { pinned: true }), msg('6', 'spammer')].map((m) => [m.id, m]),
  );
  const bulkDeleted = [];
  const channel = { id: 'general', name: 'general', messages: { fetch: async () => messages }, bulkDelete: async (ids) => (bulkDeleted.push(...ids), new Collection(ids.map((id) => [id, true]))) };
  const { interaction, run } = slash(guild, mod, 'msgdelete', { user: guild.members.cache.get('spammer').user, ints: { amount: 10 }, strings: { reason: 'clean up' } });
  interaction.channel = channel;
  const replies = await run();
  assert.deepEqual(bulkDeleted.sort(), ['1', '6']);
  assert.match(replies.at(-1), /Deleted \*\*2\*\*/);
  const logged = watch.find((p) => /deleted \*\*2\*\* message/.test(p.content));
  assert.ok(logged && logged.files.length === 1);
});

test('messages a moderator deletes in Discord itself are logged and count towards a limit', async () => {
  const { guild, add, watch } = setup();
  add('mod', { roleIds: [MOD_ROLE] });
  for (let i = 0; i < 15; i++) await modGuard.onAuditLogEntry({ action: AuditLogEvent.MessageDelete, executorId: 'mod', targetId: `u${i}`, extra: { count: 1, channel: { id: 'general' } } }, guild);
  assert.equal(watch.filter((p) => /deleted a message/.test(p.content)).length, 15);
  assert.ok(!modGuard.onCooldown(guild, 'mod'));
  await modGuard.onAuditLogEntry({ action: AuditLogEvent.MessageDelete, executorId: 'mod', targetId: 'u16', extra: { count: 1, channel: { id: 'general' } } }, guild);
  assert.ok(modGuard.onCooldown(guild, 'mod'));
});

test('a change to the mod role is checked against Discord’s latest copy of the role', async () => {
  const { guild, modRole } = setup();
  const fresh = { ...modRole, permissions: new PermissionsBitField([P.ModerateMembers, P.ManageMessages, P.BanMembers]) };
  let saved = null;
  fresh.setPermissions = async (perms) => (saved = new PermissionsBitField(perms));
  guild.roles.fetch = async () => fresh; // the cache still has the old, safe copy
  await modGuard.onAuditLogEntry({ action: AuditLogEvent.RoleUpdate, executorId: 'someone', targetId: MOD_ROLE, changes: [] }, guild);
  assert.ok(saved && !saved.has(P.BanMembers, false));
});

test('a cooldown can always be lifted, even if one of their roles is now above the bot', async () => {
  const { guild, add, settings } = setup();
  const mod = add('mod', { roleIds: [MOD_ROLE] });
  guild.roles.cache.set('senior', { id: 'senior', name: 'Senior', editable: false, managed: false, permissions: new PermissionsBitField([P.ManageMessages]) });
  settings.mods.cooldowns.mod = { at: Date.now(), kind: 'restrict', roles: [MOD_ROLE, 'senior'] };
  mod.roles.cache.delete(MOD_ROLE);
  const result = await modGuard.liftCooldown(guild, 'mod', { id: OWNER, tag: 'owner' });
  assert.ok(result.ok);
  assert.match(result.text, /can’t give back \*\*Senior\*\*/);
  assert.ok(mod.roles.cache.has(MOD_ROLE));
  assert.ok(!modGuard.onCooldown(guild, 'mod'));
});

test('undoing a moderator’s timeout puts back a mute the person already had', async () => {
  const { guild, add } = setup();
  add('mod', { roleIds: [MOD_ROLE] });
  for (let i = 1; i <= 6; i++) add(`t-${i}`);
  const entry = (targetId, old = null) => ({ action: AuditLogEvent.MemberUpdate, executorId: 'mod', targetId, changes: [{ key: 'communication_disabled_until', old, new: new Date(Date.now() + 3_600_000).toISOString() }] });
  for (let i = 1; i <= 6; i++) await modGuard.onAuditLogEntry(entry(`t-${i}`), guild);
  const already = add('already-muted');
  const sevenDays = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await modGuard.onAuditLogEntry(entry('already-muted', sevenDays), guild);
  assert.ok(already.timedOutFor > 6 * 86_400_000, 'their 7-day mute is back, not wiped');
});

test('@everyone and bot roles are never treated as the mod role', async () => {
  const { guild, settings } = setup();
  const everyone = { id: guild.id, name: '@everyone', editable: true, managed: false, permissions: new PermissionsBitField([]) };
  everyone.setPermissions = async () => assert.fail('must not touch @everyone');
  guild.roles.cache.set(guild.id, everyone);
  settings.modRoleId = guild.id;
  assert.equal(await modGuard.secureModRole(guild), null);
});

test('right-click → Delete Message: deletes and logs messages (other mods’ too), never the owner’s or admins’', async () => {
  const { guild, add, watch } = setup();
  const mod = add('mod', { roleIds: [MOD_ROLE] });
  add('admin', { perms: [P.Administrator] });
  add('other-mod', { roleIds: [MOD_ROLE] });
  add('spammer');
  const menu = (authorId) => {
    const target = { id: `m-${authorId}`, channelId: 'general', author: { id: authorId, tag: authorId, username: authorId }, member: guild.members.cache.get(authorId) ?? null, content: `hi from ${authorId}`, pinned: false, attachments: new Collection(), deleted: false };
    target.delete = async () => (target.deleted = true);
    const { interaction, run } = slash(guild, mod, 'Delete Message');
    interaction.targetMessage = target;
    return { target, run };
  };
  for (const who of [OWNER, 'admin', 'bot']) {
    const { target, run } = menu(who);
    const replies = await run();
    assert.equal(target.deleted, false, who);
    assert.match(replies.at(-1), /can’t delete|one of my messages/, who);
  }
  const rogue = menu('other-mod');
  await rogue.run();
  assert.ok(rogue.target.deleted, 'a rogue mod’s message can be deleted by another mod');
  const { target, run } = menu('spammer');
  const replies = await run();
  assert.ok(target.deleted);
  assert.match(replies.at(-1), /Deleted/);
  assert.ok(watch.some((p) => /deleted a message by <@spammer>/.test(p.content) && /hi from spammer/.test(p.content)));
});

test('channels hidden from mods: the mod role is blocked, and each mod personally (a shared Staff role can’t let them in)', async () => {
  const { guild, add, settings } = setup();
  const STAFF = 'staff-role';
  guild.roles.cache.set(STAFF, { id: STAFF, name: 'Staff', editable: true, managed: false, permissions: new PermissionsBitField([]) });
  const mod = add('mod', { roleIds: [MOD_ROLE, STAFF] });
  const helper = add('helper', { roleIds: [STAFF] }); // not a mod: left alone
  const [hiddenId] = require('../config').mods.hiddenChannelIds;
  const overwrites = new Collection();
  const channel = {
    id: hiddenId,
    name: 'admin-chat',
    permissionOverwrites: {
      cache: overwrites,
      edit: async (id, perms) => {
        const o = overwrites.get(id) ?? { id, allow: new PermissionsBitField(), deny: new PermissionsBitField() };
        for (const [name, value] of Object.entries(perms)) {
          o.allow.remove(P[name]);
          o.deny.remove(P[name]);
          if (value === true) o.allow.add(P[name]);
          if (value === false) o.deny.add(P[name]);
        }
        overwrites.set(id, o);
      },
    },
    // Discord's rule: a block on the person beats everything, then any role that's allowed in beats a blocked one.
    permissionsFor: (m) => ({
      has: () => {
        if (overwrites.get(m.id)?.deny.has(P.ViewChannel)) return false;
        return [...m.roles.cache.keys()].some((r) => overwrites.get(r)?.allow.has(P.ViewChannel));
      },
    }),
  };
  await channel.permissionOverwrites.edit(STAFF, { ViewChannel: true });
  guild.channels.cache.set(hiddenId, channel);

  await modGuard.hideLogsFromMods(guild);
  assert.ok(overwrites.get(MOD_ROLE).deny.has(P.ViewChannel), 'mod role blocked');
  assert.ok(!channel.permissionsFor(mod).has(P.ViewChannel), 'the mod can’t see it, even with Staff');
  assert.ok(channel.permissionsFor(helper).has(P.ViewChannel), 'non-mods with Staff still can');

  // No longer a mod: the personal block comes off.
  mod.roles.cache.delete(MOD_ROLE);
  await modGuard.hideLogsFromMods(guild);
  assert.ok(channel.permissionsFor(mod).has(P.ViewChannel));
  assert.deepEqual(settings.mods.memberBlocks[hiddenId] ?? [], []);
});


test('a moderator can’t unmute another moderator; an admin can', async () => {
  const { guild, add } = setup();
  const mod = add('mod', { roleIds: [MOD_ROLE] });
  add('other-mod', { roleIds: [MOD_ROLE] });
  const admin = add('admin', { perms: [P.Administrator] });
  assert.match(await modGuard.unmuteModProblem(guild, mod, 'other-mod'), /Only admins and the owner can unmute a moderator/);
  assert.equal(await modGuard.unmuteModProblem(guild, admin, 'other-mod'), null);
  add('member');
  assert.equal(await modGuard.unmuteModProblem(guild, mod, 'member'), null);
});

test('right-click → Moderate: a private panel with Delete / Mute / Restrict; Delete works straight away and is logged', async () => {
  const { guild, add, watch } = setup();
  const mod = add('mod', { roleIds: [MOD_ROLE] });
  add('spammer');
  const { handleInteraction } = require('../src/interactions');
  const messages = new Collection();
  const channel = { id: 'general', name: 'general', messages: { fetch: async (id) => messages.get(id) ?? Promise.reject(Object.assign(new Error('Unknown Message'), { code: 10008 })) } };
  guild.channels.cache.set('general', channel);
  const target = { id: 'msg-1', channelId: 'general', author: { id: 'spammer', tag: 'spammer', username: 'spammer' }, member: guild.members.cache.get('spammer'), content: 'join my server', pinned: false, attachments: new Collection() };
  target.delete = async () => messages.delete('msg-1');
  messages.set('msg-1', target);

  // The menu: a private (ephemeral) panel with three buttons.
  const { interaction, replies } = slash(guild, mod, 'Moderate');
  interaction.targetMessage = target;
  const panels = [];
  interaction.reply = async (p) => panels.push(p);
  await require('../src/commands').runCommand(interaction);
  const panel = panels[0];
  assert.ok(panel.flags, 'only the moderator sees it');
  assert.deepEqual(panel.components[0].toJSON().components.map((b) => b.label), ['Delete', 'Mute', 'Restrict']);
  assert.match(panel.embeds[0].data.description, /join my server/);

  // 🗑️ Delete.
  const updates = [];
  const button = {
    customId: 'oj:mod-delete:general:msg-1', guild, guildId: guild.id, member: mod, user: mod.user, client: guild.client, channelId: 'general',
    isButton: () => true, isModalSubmit: () => false, isChatInputCommand: () => false, isMessageContextMenuCommand: () => false, inCachedGuild: () => true,
    update: async (p) => updates.push(p), reply: async (p) => replies.push(p.content ?? p),
  };
  await handleInteraction(button);
  assert.ok(!messages.has('msg-1'), 'deleted');
  assert.match(updates[0].embeds[0].data.description, /Deleted/);
  assert.ok(watch.some((p) => /deleted a message by <@spammer>/.test(p.content)));

  // 🔇 Mute opens the reason form.
  messages.set('msg-1', target);
  let modal = null;
  await handleInteraction({ ...button, customId: 'oj:mod-mute:general:msg-1', showModal: async (m) => (modal = m) });
  assert.equal(modal.toJSON().custom_id, 'oj:mutemodal:general:msg-1');
});

// /cleanup: a popup with the latest 15 messages; the moderator ticks the spam and it's deleted.
function cleanupChannel(guild, list) {
  const messages = new Collection(list.map((m) => [m.id, m]));
  const bulkDeleted = [];
  const channel = {
    id: 'general',
    name: 'general',
    messages: { cache: new Collection(), fetch: async (arg) => (typeof arg === 'string' ? messages.get(arg) ?? Promise.reject(new Error('Unknown Message')) : messages) },
    bulkDelete: async (ids) => (bulkDeleted.push(...ids), ids.forEach((id) => messages.delete(id)), new Collection(ids.map((id) => [id, true]))),
  };
  guild.channels.cache.set('general', channel);
  return { channel, bulkDeleted };
}
const chat = (guild, id, authorId, extra = {}) => ({
  id,
  author: { id: authorId, tag: authorId, username: authorId },
  member: guild.members.cache.get(authorId) ?? null,
  content: `free nitro discord-gift.ru/${id}`,
  createdTimestamp: Date.now() - 60_000,
  pinned: false,
  attachments: new Collection(),
  ...extra,
});
function submitCleanup(guild, member, picked, reason = '') {
  const replies = [];
  const interaction = {
    customId: 'oj:cleanupmodal:general',
    guild,
    member,
    user: member.user,
    memberPermissions: member.permissions,
    fields: { getStringSelectValues: () => picked, getTextInputValue: () => reason },
    deferred: false,
    replied: false,
    deferReply: async () => (interaction.deferred = true),
    reply: async (p) => replies.push(p.content ?? p),
    editReply: async (p) => replies.push(p.content ?? p),
  };
  return require('../src/commands').cleanupModal(interaction, 'general').then(() => replies);
}

test('/cleanup opens a popup with the latest 15 messages a moderator may delete — never the owner’s, admins’, mine or pinned', async () => {
  const { guild, add } = setup();
  const mod = add('mod', { roleIds: [MOD_ROLE] });
  add('admin', { perms: [P.Administrator] });
  add('a');
  const list = [chat(guild, 'o', OWNER), chat(guild, 'ad', 'admin'), chat(guild, 'b', 'bot'), chat(guild, 'p', 'a', { pinned: true })];
  for (let i = 0; i < 20; i++) list.push(chat(guild, `${i}`, 'a', { content: i === 0 ? '' : `spam ${i}`, attachments: i === 0 ? new Collection([['f', { url: 'x' }]]) : new Collection() }));
  const { channel } = cleanupChannel(guild, list);
  const { interaction, run } = slash(guild, mod, 'cleanup');
  interaction.channel = channel;
  let modal = null;
  interaction.showModal = async (m) => (modal = m.toJSON());
  await run();
  const select = modal.components[0].component;
  assert.equal(modal.custom_id, 'oj:cleanupmodal:general');
  assert.equal(select.options.length, 15);
  assert.deepEqual(select.options.map((o) => o.value), Array.from({ length: 15 }, (_, i) => `${i}`), 'newest first, protected ones left out');
  assert.equal(select.max_values, 15);
  assert.match(select.options[0].label, /^a: 📎 1 file/);
  assert.match(select.options[1].label, /^a: spam 1$/);
  assert.match(select.options[1].description, /1 min ago · @a/);
});

test('submitting the /cleanup popup deletes exactly the ticked messages, saves them, and never deletes a protected one', async () => {
  const { guild, add, watch } = setup();
  const mod = add('mod', { roleIds: [MOD_ROLE] });
  add('admin', { perms: [P.Administrator] });
  for (const id of ['a', 'b']) add(id);
  const { bulkDeleted } = cleanupChannel(guild, [chat(guild, '1', 'a'), chat(guild, '2', 'b'), chat(guild, '3', 'a', { content: 'normal chat' }), chat(guild, '4', 'admin')]);
  const replies = await submitCleanup(guild, mod, ['1', '2', '4', 'gone'], 'raid');
  assert.deepEqual(bulkDeleted.sort(), ['1', '2'], 'the admin’s is never deleted, and the real chat is left');
  assert.match(replies.at(-1), /Deleted \*\*2\*\* message\(s\)\. \(2 were already gone\.\)/);
  assert.doesNotMatch(replies.at(-1), /mod-watch|logged/i, 'moderators aren’t told it’s logged');
  const logged = watch.find((p) => /deleted \*\*2\*\* message\(s\) from \*\*2\*\* people in <#general> \(picked with \/cleanup\) — raid/.test(p.content));
  assert.ok(logged && logged.files[0].name === 'cleanup-general.txt', 'every deleted message is saved');
});

test('/cleanup: moderators can send it 4 times in 5 minutes; the 5th isn’t done and they’re on cooldown', async () => {
  const { guild, add, settings } = setup();
  const mod = add('mod', { roleIds: [MOD_ROLE] });
  add('a');
  const list = Array.from({ length: 10 }, (_, i) => chat(guild, `${i}`, 'a'));
  const { bulkDeleted } = cleanupChannel(guild, list);
  for (let i = 0; i < 4; i++) await submitCleanup(guild, mod, [`${i}`]);
  assert.equal(bulkDeleted.length, 4);
  assert.ok(!modGuard.onCooldown(guild, 'mod'));
  await submitCleanup(guild, mod, ['5']);
  assert.equal(bulkDeleted.length, 4, 'the 5th isn’t done');
  assert.ok(settings.mods.cooldowns.mod);
});

test('moderators can use /cleanup; members can’t', async () => {
  const { guild, add } = setup();
  const mod = add('mod', { roleIds: [MOD_ROLE] });
  assert.equal(modGuard.commandProblem(slash(guild, mod, 'cleanup').interaction), null);
  const member = add('someone');
  const replies = await submitCleanup(guild, member, ['1']);
  assert.match(replies[0], /Only moderators/);
});
