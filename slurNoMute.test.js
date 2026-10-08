'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Slurs and blocked words: the message is deleted and a case goes to the mod log, but nobody is muted automatically.
// The case has a 🔇 Mute button for the moderators.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-slur-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField } = require('discord.js');
const store = require('../src/store');
const automod = require('../src/automod');
const { buildCaseButtons } = require('../src/caseLog');
const { muteCase, keepCase } = require('../src/caseActions');

function setup() {
  const logged = [];
  const timeouts = [];
  const dms = [];
  const logChannel = { id: 'log', isTextBased: () => true, send: async (p) => (logged.push(p), { id: 'logmsg', edit: async () => {} }), messages: { fetch: async () => ({ edit: async () => {} }) } };
  const channel = { id: 'chan', name: 'general', isTextBased: () => true, send: async () => null, messages: { fetch: async () => new Collection() } };
  const guild = {
    id: `guild-slur-${Math.random()}`,
    name: 'Test',
    ownerId: 'owner',
    channels: { cache: new Map([['chan', channel], ['log', logChannel]]), fetch: async (id) => (id === 'log' ? logChannel : channel) },
  };
  const user = { id: 'rude', tag: 'rude', bot: false, createdTimestamp: 0, displayAvatarURL: () => '', send: async (t) => dms.push(t) };
  const member = {
    id: 'rude',
    guild,
    user,
    joinedTimestamp: 0,
    moderatable: true,
    roles: { cache: new Collection() },
    permissions: new PermissionsBitField(),
    isCommunicationDisabled: () => false,
    timeout: async (ms) => timeouts.push(ms),
    send: async (t) => dms.push(t),
  };
  store.guild(guild.id).logChannelId = 'log';
  const message = {
    id: 'm1',
    guild,
    guildId: guild.id,
    channelId: 'chan',
    channel,
    author: user,
    member,
    content: 'you are a nigger',
    createdTimestamp: Date.now(),
    attachments: new Collection(),
    mentions: { users: new Collection(), roles: new Collection() },
    inGuild: () => true,
    deleted: false,
    delete: async () => {
      message.deleted = true;
    },
  };
  return { guild, message, member, logged, timeouts, dms };
}

test('a slur is deleted and logged, but not muted', async () => {
  const { guild, message, logged, timeouts } = setup();
  const result = await automod.handleMessage(message);
  assert.ok(result?.case, 'a case was opened');
  assert.equal(result.timedOut, false);
  assert.ok(message.deleted, 'the message was deleted');
  assert.equal(timeouts.length, 0, 'nobody was timed out');
  assert.equal(logged.length, 1, 'the case went to the mod log');

  const c = store.getCase(guild.id, result.case.id);
  assert.equal(c.noMute, true);
  assert.match(c.actionNote, /Not muted/);
  const labels = buildCaseButtons(c)[0].toJSON().components.map((b) => b.label);
  assert.deepEqual(labels, ['Mute', 'Restrict', 'Ban (admins)', 'No action']);
});

test('a moderator can press 🔇 Mute on the case, and it becomes a normal mute case', async () => {
  const { guild, message, member, timeouts, dms } = setup();
  const { case: opened } = await automod.handleMessage(message);
  const c = store.getCase(guild.id, opened.id);

  const result = await muteCase(guild, c, { id: 'mod', tag: 'mod' }, member);
  assert.equal(result.ok, true);
  assert.equal(timeouts.length, 1);
  assert.equal(c.noMute, false);
  assert.match(c.actionNote, /Timed out by <@mod>/);
  assert.doesNotMatch(c.actionNote, /Not muted/);
  assert.match(dms.at(-1), /You were muted/);
  assert.deepEqual(buildCaseButtons(c)[0].toJSON().components.map((b) => b.label), ['Unmute', 'Restrict', 'Ban (admins)', 'Keep Muted']);
});

test('"No action" closes the review without muting', async () => {
  const { guild, message, timeouts } = setup();
  const { case: opened } = await automod.handleMessage(message);
  const c = store.getCase(guild.id, opened.id);
  const result = await keepCase(guild, c, { id: 'mod', tag: 'mod' });
  assert.match(result.text, /isn’t muted/);
  assert.equal(timeouts.length, 0);
});
