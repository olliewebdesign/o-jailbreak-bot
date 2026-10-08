'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Moderators can't add bots or make webhooks: whatever they add is removed straight away (with #mod-watch and the
// owner told), the mod role never gets Manage Webhooks & co. in a channel's own settings, and anti-nuke never trusts a
// moderator — even one on the trusted list.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-modadditions-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AuditLogEvent, Collection, OverwriteType, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const store = require('../src/store');
const modGuard = require('../src/modGuard');
const antinuke = require('../src/antinuke');

const MOD_ROLE = 'mod-role';
let n = 0;

function setup() {
  const watch = [];
  const ownerDms = [];
  const deletedHooks = [];
  const kicked = [];
  const roles = new Collection([
    [MOD_ROLE, { id: MOD_ROLE, name: 'Mod', permissions: new PermissionsBitField([P.PrioritySpeaker]) }],
    ['staff', { id: 'staff', name: 'Staff', permissions: new PermissionsBitField([P.ManageWebhooks, P.ManageGuild]) }],
  ]);
  const members = new Collection();
  const guild = {
    id: `guild-additions-${n++}`,
    name: 'Mine',
    ownerId: 'owner',
    roles: { cache: roles },
    members: { cache: members, fetch: async (id) => members.get(id) ?? null },
    fetchOwner: async () => ({ send: async (p) => ownerDms.push(p) }),
  };
  const channel = (id, overwrites = []) => {
    const cache = new Collection(
      overwrites.map((o) => [o.id, { id: o.id, type: o.type ?? OverwriteType.Role, allow: new PermissionsBitField(o.allow ?? []), deny: new PermissionsBitField(o.deny ?? []) }]),
    );
    return {
      id,
      name: id,
      toString: () => `<#${id}>`,
      isTextBased: () => true,
      send: async (p) => watch.push(typeof p === 'string' ? p : p.content),
      permissionOverwrites: {
        cache,
        edit: async (target, perms) => {
          const o = cache.get(target);
          for (const [name, value] of Object.entries(perms)) if (value === null) o.allow.remove(P[name]);
        },
      },
    };
  };
  guild.channels = { cache: new Collection([['watch', channel('watch')]]), fetch: async (id) => guild.channels.cache.get(id) ?? null };
  guild.client = {
    user: { id: 'bot', tag: 'O Jailbreak' },
    fetchWebhook: async (id) => ({ id, name: 'Free Nitro', channelId: 'general', delete: async () => deletedHooks.push(id) }),
    users: { fetch: async () => null },
  };
  const settings = store.guild(guild.id);
  Object.assign(settings, { modRoleId: MOD_ROLE });
  modGuard.modsSettings(settings).watchChannelId = 'watch';
  const add = (id, roleIds = [], { bot = false } = {}) => {
    const member = {
      id,
      guild,
      user: { id, tag: id, username: id, bot, displayAvatarURL: () => null },
      kickable: true,
      roles: { cache: new Collection(roleIds.map((r) => [r, roles.get(r)])) },
      permissions: new PermissionsBitField(roleIds.map((r) => roles.get(r).permissions.bitfield).reduce((a, b) => a | b, 0n)),
      kick: async () => kicked.push(id),
    };
    members.set(id, member);
    return member;
  };
  return { guild, settings, add, channel, watch, ownerDms, deletedHooks, kicked };
}

const audit = (action, executorId, targetId, extra = {}) => ({ action, executorId, targetId, changes: [], ...extra });

test('a webhook made by a moderator is deleted straight away, and the owner is told', async () => {
  const s = setup();
  s.add('mod', [MOD_ROLE, 'staff']); // Manage Webhooks through another role
  await modGuard.onAuditLogEntry(audit(AuditLogEvent.WebhookCreate, 'mod', 'hook-1'), s.guild);
  assert.deepEqual(s.deletedHooks, ['hook-1']);
  assert.ok(s.watch.some((l) => /made a webhook \(\*\*Free Nitro\*\*\) in <#general> — I deleted it/.test(l)));
  assert.match(s.ownerDms[0], /Moderator \*\*mod\*\* in \*\*Mine\*\* made a webhook/);
});

test('a webhook made by an admin is left alone', async () => {
  const s = setup();
  s.add('owner');
  s.add('manager', ['staff']);
  await modGuard.onAuditLogEntry(audit(AuditLogEvent.WebhookCreate, 'owner', 'hook-1'), s.guild);
  await modGuard.onAuditLogEntry(audit(AuditLogEvent.WebhookCreate, 'manager', 'hook-2'), s.guild);
  assert.deepEqual(s.deletedHooks, []);
  assert.equal(s.ownerDms.length, 0);
});

test('a bot added by a moderator is kicked straight away', async () => {
  const s = setup();
  s.add('mod', [MOD_ROLE, 'staff']);
  s.add('nukebot', [], { bot: true });
  await modGuard.onAuditLogEntry(audit(AuditLogEvent.BotAdd, 'mod', 'nukebot'), s.guild);
  assert.deepEqual(s.kicked, ['nukebot']);
  assert.ok(s.watch.some((l) => /added a bot \(\*\*nukebot\*\*\) — I kicked it/.test(l)));
  assert.match(s.ownerDms[0], /added a bot/);
});

test('moderator powers in a channel’s own settings are taken back off the mod role and moderators', async () => {
  const s = setup();
  s.add('mod', [MOD_ROLE]);
  const ch = s.channel('general', [
    { id: MOD_ROLE, allow: [P.ViewChannel, P.ManageWebhooks, P.ManageMessages] },
    { id: 'mod', type: OverwriteType.Member, allow: [P.ManageChannels, P.SendMessages] },
    { id: 'staff', allow: [P.ManageWebhooks] }, // not the mod role: left alone
  ]);
  s.guild.channels.cache.set('general', ch);
  await modGuard.onAuditLogEntry(audit(AuditLogEvent.ChannelOverwriteUpdate, 'someone', 'general'), s.guild);
  const allow = (id) => ch.permissionOverwrites.cache.get(id).allow;
  assert.equal(allow(MOD_ROLE).has(P.ManageWebhooks), false);
  assert.equal(allow(MOD_ROLE).has(P.ManageMessages), false);
  assert.equal(allow(MOD_ROLE).has(P.ViewChannel), true, 'seeing the channel is fine');
  assert.equal(allow('mod').has(P.ManageChannels), false);
  assert.equal(allow('mod').has(P.SendMessages), true);
  assert.equal(allow('staff').has(P.ManageWebhooks), true);
  assert.ok(s.watch.some((l) => /<@someone> gave moderators Discord’s own powers in a channel’s settings/.test(l)));
});

test('anti-nuke never trusts a moderator, even one on the trusted list: a bot they add is kicked, not trusted', async () => {
  const s = setup();
  s.add('mod', [MOD_ROLE, 'staff']);
  s.add('nukebot', [], { bot: true });
  s.settings.trusted.push('mod');
  await antinuke.handleAuditLogEntry(audit(AuditLogEvent.BotAdd, 'mod', 'nukebot'), s.guild);
  assert.ok(!s.settings.trusted.includes('nukebot'), 'the bot isn’t trusted');
  assert.deepEqual(s.kicked, ['nukebot']);

  // A trusted person who isn't a moderator: their bot is trusted, as before.
  s.add('friend');
  s.add('goodbot', [], { bot: true });
  s.settings.trusted.push('friend');
  await antinuke.handleAuditLogEntry(audit(AuditLogEvent.BotAdd, 'friend', 'goodbot'), s.guild);
  assert.ok(s.settings.trusted.includes('goodbot'));
});
