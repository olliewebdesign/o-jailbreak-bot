'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// While verification is on, someone who joins through an invite only counts for the inviter (VIP and giveaways)
// once they've verified. People who never verify never count. With verification off, joins count straight away.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-inviteverify-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const store = require('../src/store');
const invites = require('../src/invites');
const verify = require('../src/verify');
const giveaway = require('../src/giveaway');

const UNVERIFIED = 'unverified-role';
const VERIFIED = 'verified-role';
let n = 0;
let nextAccount = 1;
const oldAccount = () => String(BigInt(Date.now() - (400 + nextAccount++) * 86_400_000 - 1420070400000) << 22n);

function server({ verification = true } = {}) {
  const links = new Map();
  const roles = new Collection([UNVERIFIED, VERIFIED].map((id) => [id, { id, name: id, editable: true }]));
  const members = new Collection();
  const guild = {
    id: `guild-iv-${n++}`,
    name: 'Test',
    ownerId: 'owner',
    vanityURLCode: null,
    invites: { fetch: async () => new Map([...links].map(([code, l]) => [code, { code, ...l }])) },
    roles: { cache: roles },
    members: { cache: members, fetch: async (id) => (id ? members.get(id) ?? null : members) },
    channels: { cache: new Collection(), fetch: async () => null },
  };
  const settings = store.guild(guild.id);
  Object.assign(settings.verify, { enabled: verification, roleId: UNVERIFIED, verifiedRoleId: VERIFIED });
  const join = async (inviterCode) => {
    links.get(inviterCode).uses += 1;
    const id = oldAccount();
    const member = {
      id,
      guild,
      joinedTimestamp: Date.now(),
      user: { id, bot: false },
      roles: {
        cache: new Collection(),
        add: async (r) => member.roles.cache.set(r.id ?? r, {}),
        remove: async (r) => member.roles.cache.delete(r.id ?? r),
      },
    };
    members.set(id, member);
    const result = await invites.onMemberJoin(member);
    return { member, result };
  };
  return { guild, settings, links, join };
}

test('with verification on, an invited person counts only once they verify', async () => {
  const s = server();
  s.links.set('alice-link', { uses: 0, maxUses: 0, inviterId: 'alice' });
  await invites.refresh(s.guild);

  const { member, result } = await s.join('alice-link');
  assert.equal(result.counted, false);
  assert.equal(result.reason, 'unverified');
  assert.equal(invites.joinsBy(s.settings, 'alice'), 0, 'not yet');
  assert.equal(invites.broughtBy(s.settings, 'alice')[0].reason, 'unverified', '/invites shows them as waiting');

  await verify.markVerified(member, 'verified');
  assert.equal(invites.joinsBy(s.settings, 'alice'), 1, 'counts the moment they verify');
  assert.equal(invites.broughtBy(s.settings, 'alice')[0].counted, true);

  await verify.markVerified(member, 'verified again');
  assert.equal(invites.joinsBy(s.settings, 'alice'), 1, 'only once');
});

test('someone who never verifies never counts, and leaving doesn’t take anything off', async () => {
  const s = server();
  s.links.set('bob-link', { uses: 0, maxUses: 0, inviterId: 'bob' });
  await invites.refresh(s.guild);
  const { member } = await s.join('bob-link');
  assert.equal(await invites.onMemberLeave(member), null);
  assert.equal(invites.joinsBy(s.settings, 'bob'), 0);
});

test('a verified join counts for a running giveaway — but only if they joined after it started', async () => {
  const s = server();
  s.links.set('carol-link', { uses: 0, maxUses: 0, inviterId: 'carol' });
  await invites.refresh(s.guild);
  const early = await s.join('carol-link');
  early.member.joinedTimestamp = Date.now() - 3_600_000; // joined an hour before the giveaway

  s.settings.giveaways.list[1] = { id: 1, startedAt: Date.now() - 60_000, endsAt: Date.now() + 3_600_000, joinsNeeded: 2, joins: {}, ended: false, winnerIds: [], prize: 'x' };
  const g = s.settings.giveaways.list[1];
  const late = await s.join('carol-link');

  await verify.markVerified(early.member, 'verified');
  await verify.markVerified(late.member, 'verified');
  assert.equal(invites.joinsBy(s.settings, 'carol'), 2, 'both count for VIP');
  assert.deepEqual(g.joins.carol, [late.member.id], 'only the one who joined during the giveaway counts for it');
  assert.ok(giveaway);
});

test('with verification off, joins count straight away like before', async () => {
  const s = server({ verification: false });
  s.links.set('dave-link', { uses: 0, maxUses: 0, inviterId: 'dave' });
  await invites.refresh(s.guild);
  const { result } = await s.join('dave-link');
  assert.equal(result.counted, true);
  assert.equal(invites.joinsBy(s.settings, 'dave'), 1);
});
