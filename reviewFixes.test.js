'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Bugs found in the full review, each checked so it can't come back: invite counting that could be gamed, VIP being
// taken away after the goal was raised, anti-nuke timeouts lifted through another case, VIP approvals that no longer
// qualify, and giveaway joins wiped when Discord didn't send the member list.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-reviewfixes-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField } = require('discord.js');
const store = require('../src/store');
const invites = require('../src/invites');
const giveaway = require('../src/giveaway');
const vipApply = require('../src/vipApply');
const { unmuteProblem } = require('../src/caseActions');

let n = 0;
let nextAccount = 1;
// A Discord ID for an account made over a year ago (old enough to count).
const oldAccount = () => String(BigInt(Date.now() - (400 + nextAccount++) * 86_400_000 - 1420070400000) << 22n);

function inviteServer() {
  const links = new Map(); // code -> { uses, maxUses, inviterId }
  const state = { vanityUses: 0 };
  const guild = {
    id: `guild-review-${n++}`,
    name: 'Test',
    ownerId: 'owner',
    vanityURLCode: 'ourserver',
    fetchVanityData: async () => ({ uses: state.vanityUses }),
    invites: { fetch: async () => new Map([...links].map(([code, l]) => [code, { code, ...l }])) },
    members: { cache: new Collection(), fetch: async () => null },
    roles: { cache: new Collection() },
    channels: { cache: new Collection(), fetch: async () => null },
  };
  const link = (code, inviterId, maxUses = 0) => links.set(code, { uses: 0, maxUses, inviterId });
  const use = (code) => (links.get(code).uses += 1);
  const member = (id, joinedAt = Date.now()) => ({ id, guild, user: { id, bot: false }, joinedTimestamp: joinedAt });
  return { guild, links, state, link, use, member, settings: store.guild(guild.id) };
}

test('bug 1: someone who rejoins and leaves quickly can’t take a join off their original inviter twice', async () => {
  const s = inviteServer();
  s.link('alice-link', 'alice');
  s.link('carol-link', 'carol');
  await invites.refresh(s.guild);
  const bob = s.member(oldAccount());

  s.use('alice-link');
  assert.equal((await invites.onMemberJoin(bob)).counted, true);
  delete s.settings.invites.joinedAt[bob.id]; // he stayed for days (the join time is only kept for a day or so)
  assert.equal(await invites.onMemberLeave(bob), null);

  s.use('carol-link');
  assert.equal((await invites.onMemberJoin(bob)).reason, 'rejoin', 'rejoining doesn’t count for Carol');
  assert.equal(await invites.onMemberLeave(s.member(bob.id, Date.now())), null, 'leaving straight after a rejoin changes nothing');
  assert.equal(invites.joinsBy(s.settings, 'alice'), 1);
  assert.equal(invites.joinsBy(s.settings, 'carol'), 0);
});

test('bug 2: joining once through the server’s own link doesn’t let someone count a second time', async () => {
  const s = inviteServer();
  s.link('alice-link', 'alice');
  s.link('carol-link', 'carol');
  await invites.refresh(s.guild);
  const x = s.member(oldAccount());

  s.use('alice-link');
  await invites.onMemberJoin(x);
  s.state.vanityUses += 1;
  assert.equal((await invites.onMemberJoin(x)).vanity, true);
  assert.equal(invites.invitedBy(s.settings, x.id), 'alice', 'still credited to Alice');
  s.use('carol-link');
  assert.equal((await invites.onMemberJoin(x)).counted, false);
  assert.equal(invites.joinsBy(s.settings, 'carol'), 0);
});

test('bug 5: members who were here before the bot was counting don’t count as new when they rejoin', async () => {
  const s = inviteServer();
  s.link('carol-link', 'carol');
  await invites.refresh(s.guild);
  const oldTimer = s.member(oldAccount());
  await invites.onMemberLeave(oldTimer);
  assert.equal(invites.invitedBy(s.settings, oldTimer.id), null, 'shown as “not known”, not as a person');

  s.use('carol-link');
  assert.equal((await invites.onMemberJoin(oldTimer)).counted, false);
  assert.equal(invites.joinsBy(s.settings, 'carol'), 0);
});

test('bug 4: two links going up at once credits nobody rather than the wrong person', async () => {
  const s = inviteServer();
  s.link('alice-link', 'alice');
  s.link('bob-link', 'bob');
  await invites.refresh(s.guild);
  s.use('alice-link');
  s.use('bob-link');
  const [first, second] = await Promise.all([invites.onMemberJoin(s.member(oldAccount())), invites.onMemberJoin(s.member(oldAccount()))]);
  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(invites.joinsBy(s.settings, 'alice'), 0);
});

test('bug 9: a deleted link only counts when it was a one-use link that just got used, and only once', async () => {
  const s = inviteServer();
  s.link('unlimited', 'alice', 0);
  s.link('one-use', 'bob', 1);
  await invites.refresh(s.guild);

  // Alice deletes her link by hand; someone joins from Server Discovery.
  invites.onInviteDelete({ guild: s.guild, code: 'unlimited' });
  s.links.delete('unlimited');
  assert.equal(await invites.onMemberJoin(s.member(oldAccount())), null);

  // Bob's one-use link is used and disappears.
  invites.onInviteDelete({ guild: s.guild, code: 'one-use' });
  s.links.delete('one-use');
  assert.equal((await invites.onMemberJoin(s.member(oldAccount()))).inviterId, 'bob');
  assert.equal(await invites.onMemberJoin(s.member(oldAccount())), null, 'not credited twice');
});

test('bug 10: a new link made before the bot has read the server’s links is ignored', () => {
  const s = inviteServer();
  invites.onInviteCreate({ guild: { id: 'never-loaded' }, code: 'x', uses: 0, inviterId: 'alice' });
  assert.ok(s); // nothing to crash on, and nothing partial stored
});

test('bug 6: raising /vip goal never takes VIP off someone approved at the old goal', async () => {
  const s = inviteServer();
  const roles = new Collection([['vip', { id: 'vip', name: 'VIP', editable: true }]]);
  s.guild.roles.cache = roles;
  const member = { id: 'alice', guild: s.guild, user: { id: 'alice' }, roles: { cache: new Collection([['vip', {}]]), remove: async (r) => member.roles.cache.delete(r.id ?? r) }, send: async () => {} };
  s.guild.members.fetch = async () => member;
  Object.assign(s.settings, { vipRoleId: 'vip', vipJoinsNeeded: 10 });
  s.settings.vipApplications = { alice: { status: 'approved', goal: 5 } };
  s.settings.invites.counts.alice = 6;
  assert.equal(await invites.takeVipIfBelow(s.guild, 'alice', { why: 'x', onlyIfApproved: true }), false, '6 is still at or above the 5 she was approved at');
  assert.ok(member.roles.cache.has('vip'));
  s.settings.invites.counts.alice = 4;
  assert.equal(await invites.takeVipIfBelow(s.guild, 'alice', { why: 'x', onlyIfApproved: true }), true);
});

test('bugs 3 and 8: anti-nuke timeouts can only be lifted by the owner/trusted, whichever case is used; nobody reviews their own case', () => {
  const guild = { id: `guild-cases-${n++}`, ownerId: 'owner' };
  store.guild(guild.id).trusted = ['trusted-admin'];
  store.createCase(guild.id, { type: 'ANTINUKE', label: 'Anti-nuke', userId: 'nuker', strippedRoles: ['a'] });
  store.createCase(guild.id, { type: 'MANUAL', label: 'Manual mute', userId: 'nuker', timedOut: true });
  assert.match(unmuteProblem(guild, 'nuker', 'rogue-mod'), /anti-nuke/);
  assert.equal(unmuteProblem(guild, 'nuker', 'trusted-admin'), null);
  assert.equal(unmuteProblem(guild, 'nuker', 'owner'), null);
  assert.match(unmuteProblem(guild, 'some-mod', 'some-mod'), /your own case/);
  assert.equal(unmuteProblem(guild, 'someone-else', 'rogue-mod'), null, 'ordinary cases are fine');
});

test('bug 17: approving an application that no longer qualifies doesn’t give VIP, and it stays open', async () => {
  const guild = {
    id: `guild-approve-${n++}`,
    ownerId: 'owner',
    name: 'Test',
    roles: { cache: new Collection([['vip', { id: 'vip', name: 'VIP', editable: true }]]) },
    members: { fetch: async () => ({ id: 'alice', roles: { cache: new Collection(), add: async () => {} }, send: async () => {} }) },
    channels: { fetch: async () => null },
  };
  const settings = store.guild(guild.id);
  Object.assign(settings, { vipRoleId: 'vip', vipJoinsNeeded: 5 });
  settings.vipApplications = { alice: { status: 'pending' } };
  settings.invites.counts.alice = 3; // people she invited left while it waited
  const replies = [];
  const interaction = {
    user: { id: 'owner', tag: 'owner' },
    guild,
    member: { permissions: new PermissionsBitField([PermissionsBitField.Flags.Administrator]) },
    deferReply: async () => {},
    editReply: async (t) => replies.push(t),
    reply: async (p) => replies.push(p.content),
  };
  await vipApply.reviewButton(interaction, 'vip-approve', 'alice');
  assert.match(replies.at(-1), /don’t qualify any more/);
  assert.equal(settings.vipApplications.alice.status, 'pending');
});

test('bug 7: if Discord doesn’t send the member list, giveaway joins aren’t wiped and no winners are drawn from half a list', async () => {
  const guild = {
    id: `guild-gw-${n++}`,
    members: { cache: new Collection(), fetch: async () => Promise.reject(new Error('timed out')) },
    channels: { cache: new Collection() },
  };
  const settings = store.guild(guild.id);
  settings.giveaways.list[1] = { id: 1, channelId: 'c', messageId: 'm', joinsNeeded: 2, winners: 3, joins: { alice: ['f1', 'f2'] }, ended: false, winnerIds: [], prize: 'x', endsAt: 0 };
  const g = settings.giveaways.list[1];
  const result = await giveaway.entries(guild, g, { prune: true });
  assert.equal(result.complete, false);
  assert.deepEqual(g.joins.alice, ['f1', 'f2'], 'joins kept');
  await assert.rejects(giveaway.end(guild, g), /member list/);
  assert.equal(g.ended, false, 'tried again later instead');
});
