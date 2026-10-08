'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// VIP applications: reaching the goal no longer gives VIP. They apply, the application goes to the review channel,
// and only admins (Administrator) or the owner can approve or deny it.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-vipapply-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField } = require('discord.js');
const store = require('../src/store');
const vipApply = require('../src/vipApply');

const VIP = 'vip-role';
let n = 0;

function setup() {
  const posted = [];
  const dms = [];
  const review = {
    id: 'review',
    isTextBased: () => true,
    send: async (payload) => {
      const message = {
        id: `app-${posted.length}`,
        embeds: payload.embeds.map((e) => e.toJSON()),
        components: payload.components.map((c) => c.toJSON()),
        edit: async (p) => {
          message.embeds = p.embeds.map((e) => (e.toJSON ? e.toJSON() : e));
          message.components = p.components.map((c) => c.toJSON());
        },
      };
      posted.push(message);
      return message;
    },
  };
  const members = new Collection();
  const guild = {
    id: `guild-vipapply-${n++}`,
    name: 'Test',
    ownerId: 'owner',
    roles: { cache: new Collection([[VIP, { id: VIP, name: 'VIP', editable: true }]]) },
    members: { cache: members, fetch: async (id) => members.get(id) ?? null },
    channels: { cache: new Collection([['review', review]]), fetch: async (id) => (id === 'review' ? review : null) },
    client: { users: { fetch: async (id) => ({ send: async (t) => dms.push({ id, text: t }) }) } },
  };
  const settings = store.guild(guild.id);
  Object.assign(settings, { vipRoleId: VIP, vipJoinsNeeded: 2, vipReviewChannelId: 'review' });

  const addMember = (id) => {
    const member = {
      id,
      guild,
      joinedTimestamp: Date.now() - 10 * 86_400_000, // in the server for 10 days
      user: { id, tag: id, createdTimestamp: Date.now() - 5e10, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' },
      roles: {
        cache: new Collection(),
        add: async (role) => member.roles.cache.set(role.id ?? role, {}),
      },
      send: async (payload) => dms.push({ id, text: payload.content ?? payload, components: payload.components }),
    };
    members.set(id, member);
    return member;
  };

  const press = (action, userId, { admin = false, by = 'someone' } = {}) => {
    const replies = [];
    const interaction = {
      user: { id: by, tag: by },
      guild,
      member: { permissions: new PermissionsBitField(admin ? [PermissionsBitField.Flags.Administrator] : [PermissionsBitField.Flags.ManageGuild]) },
      message: posted.at(-1),
      client: guild.client,
      reply: async (p) => replies.push(p.content ?? p),
      deferReply: async () => {},
      editReply: async (p) => replies.push(p.content ?? p),
      showModal: async (modal) => replies.push({ modal: modal.toJSON().custom_id }),
      deferUpdate: async () => {},
      fields: { getTextInputValue: () => 'Two of the joins are alts' },
    };
    return { interaction, replies, run: () => (action === 'deny-modal' ? vipApply.denyModal(interaction, userId) : vipApply.reviewButton(interaction, action, userId)) };
  };

  return { guild, settings, posted, dms, addMember, press };
}

test('reaching the goal invites them to apply instead of giving VIP (once)', async () => {
  const { guild, settings, dms, addMember } = setup();
  const member = addMember('inviter');
  settings.invites.counts.inviter = 2;

  assert.equal(await vipApply.notifyEligible(guild, 'inviter'), true);
  assert.ok(!member.roles.cache.has(VIP), 'VIP is not given automatically');
  assert.match(dms[0].text, /reached the VIP goal/);
  assert.match(dms[0].text, /Press the button/);
  assert.equal(dms[0].components[0].toJSON().components[0].custom_id, `ojvip:apply:${guild.id}`);
  assert.equal(await vipApply.notifyEligible(guild, 'inviter'), false, 'only told once');
});

test('applying posts the application with who they brought in; only admins can approve', async () => {
  const { guild, settings, posted, addMember, press } = setup();
  const member = addMember('inviter');
  addMember('friend1');
  settings.invites.counts.inviter = 2;
  settings.invites.credited = { friend1: 'inviter', friend2: 'inviter' };

  const result = await vipApply.apply(guild, member);
  assert.equal(result.ok, true);
  assert.equal(posted.length, 1);
  assert.match(posted[0].embeds[0].description, /<@friend1>/);
  assert.match(posted[0].embeds[0].description, /<@friend2>.*🚪 left/, 'shows who has left');
  assert.deepEqual(posted[0].components[0].components.map((b) => b.label), ['Approve', 'Deny']);
  assert.match((await vipApply.apply(guild, member)).text, /already waiting/);

  const mod = press('vip-approve', 'inviter', { admin: false });
  await mod.run();
  assert.match(mod.replies[0], /Only admins/);
  assert.ok(!member.roles.cache.has(VIP));

  const admin = press('vip-approve', 'inviter', { admin: true });
  await admin.run();
  assert.ok(member.roles.cache.has(VIP), 'approved = VIP given');
  assert.match(admin.replies.at(-1), /now has VIP/);
  assert.match(posted[0].embeds[0].fields.at(-1).value, /Approved/);
  assert.ok(posted[0].components[0].components.every((b) => b.disabled), 'buttons lock once decided');
});

test('the owner can approve even without Administrator', async () => {
  const { guild, settings, addMember, press } = setup();
  const member = addMember('inviter');
  settings.invites.counts.inviter = 3;
  await vipApply.apply(guild, member);
  await press('vip-approve', 'inviter', { by: 'owner' }).run();
  assert.ok(member.roles.cache.has(VIP));
});

test('denying asks for a reason, DMs them, and they can reapply after 24 hours', async () => {
  const { guild, settings, posted, dms, addMember, press } = setup();
  const member = addMember('inviter');
  settings.invites.counts.inviter = 2;
  await vipApply.apply(guild, member);

  const deny = press('vip-deny', 'inviter', { admin: true });
  await deny.run();
  assert.deepEqual(deny.replies[0], { modal: 'oj:vipdenymodal:inviter' });

  await press('deny-modal', 'inviter', { admin: true }).run();
  assert.equal(settings.vipApplications.inviter.status, 'denied');
  assert.ok(!member.roles.cache.has(VIP));
  assert.match(dms.at(-1).text, /was denied[\s\S]*alts/);
  assert.match(posted[0].embeds[0].fields.at(-1).value, /Denied[\s\S]*alts/);
  assert.match((await vipApply.apply(guild, member)).text, /apply again/);

  settings.vipApplications.inviter.decidedAt -= 25 * 3_600_000;
  assert.equal((await vipApply.apply(guild, member)).ok, true);
});

test('people under the goal, restricted people and existing VIPs can’t apply', async () => {
  const { guild, settings, addMember } = setup();
  const low = addMember('low');
  settings.invites.counts.low = 1;
  assert.match((await vipApply.apply(guild, low)).text, /1\*\* of \*\*2/);

  const restricted = addMember('bad');
  settings.invites.counts.bad = 5;
  settings.restricted.bad = { roles: [] };
  assert.match((await vipApply.apply(guild, restricted)).text, /Restricted members/);

  const vip = addMember('vip');
  vip.roles.cache.set(VIP, {});
  settings.invites.counts.vip = 5;
  assert.match((await vipApply.apply(guild, vip)).text, /already have VIP/);
});

test('someone who joined less than 7 days ago can’t apply yet, but is told when they can', async () => {
  const { guild, settings, dms, addMember } = setup();
  const quick = addMember('quick');
  quick.joinedTimestamp = Date.now() - 2 * 86_400_000; // joined 2 days ago, already invited enough people
  settings.invites.counts.quick = 5;

  const refused = await vipApply.apply(guild, quick);
  assert.equal(refused.ok, false);
  assert.match(refused.text, /7 days/);
  assert.match(refused.text, /<t:\d+:R>/, 'with a live “in 5 days” timestamp');

  assert.equal(await vipApply.notifyEligible(guild, 'quick'), true, 'still DMed');
  assert.match(dms.at(-1).text, /You can apply <t:\d+:R>/);

  quick.joinedTimestamp = Date.now() - 8 * 86_400_000; // a week later
  assert.equal((await vipApply.apply(guild, quick)).ok, true);
});
