'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Members can only see /invites if they have "Use Application Commands": the bot switches it on for the member roles,
// and reports what it can't change (the Integrations page, channel overrides).

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-cmdaccess-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const config = require('../config');
const commandAccess = require('../src/commandAccess');

const GUILD = '1000000000000000000';
const MEMBER = config.updating.memberRoleIds[0];

function fakeRole(id, name, perms) {
  const role = {
    id,
    name,
    editable: true,
    permissions: new PermissionsBitField(perms),
    setPermissions: async (bits) => {
      role.permissions = new PermissionsBitField(bits);
    },
  };
  return role;
}

function fakeGuild({ commandPerms = new Collection() } = {}) {
  const everyone = fakeRole(GUILD, '@everyone', [P.ViewChannel, P.SendMessages]);
  const member = fakeRole(MEMBER, 'Member', [P.SendMessages]);
  const roles = new Collection([
    [GUILD, everyone],
    [MEMBER, member],
  ]);
  const guild = {
    id: GUILD,
    name: 'Test',
    roles: { cache: roles, everyone },
    channels: { cache: new Collection(), fetch: async () => null },
    client: { application: { id: 'app' }, user: { id: 'app' } },
    commands: {
      permissions: { fetch: async () => commandPerms },
      fetch: async () => new Collection([['cmd-invites', { id: 'cmd-invites', name: 'invites' }]]),
    },
  };
  return { guild, everyone, member };
}

test('the Member role from config.js is one of the roles checked', () => {
  assert.equal(MEMBER, '8000000000000000003');
  const { guild } = fakeGuild();
  assert.deepEqual(commandAccess.memberRoles(guild).map((r) => r.id), [GUILD, MEMBER]);
});

test('"Use Application Commands" is switched on for @everyone and the Member role', async () => {
  const { guild, everyone, member } = fakeGuild();
  const lines = await commandAccess.check(guild, { report: false });
  assert.ok(everyone.permissions.has(P.UseApplicationCommands));
  assert.ok(member.permissions.has(P.UseApplicationCommands));
  assert.match(lines[0], /Switched on \*\*Use Application Commands\*\* for @everyone, @Member/);
  assert.ok(member.permissions.has(P.SendMessages), 'their other permissions are kept');

  assert.deepEqual(await commandAccess.check(guild, { report: false }), [], 'nothing to say once it’s fixed');
});

test('blocks on the Integrations page are reported with what to click', async () => {
  const allChannels = String(BigInt(GUILD) - 1n);
  const commandPerms = new Collection([
    ['app', [{ id: GUILD, type: 1, permission: false }]],
    ['cmd-invites', [{ id: allChannels, type: 3, permission: false }]],
  ]);
  const { guild } = fakeGuild({ commandPerms });
  const lines = await commandAccess.check(guild, { report: false });
  const integrations = lines.find((l) => l.includes('Integrations'));
  assert.ok(integrations, lines.join('\n'));
  assert.match(integrations, /O Jailbreak \(all commands\)\*\* is switched off for \*\*@everyone/);
  assert.match(integrations, /\/invites\*\* is switched off for \*\*All Channels/);
});
