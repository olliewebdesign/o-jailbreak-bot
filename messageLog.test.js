'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Server logs: deleted messages (with their text, even if Discord no longer has it, and who deleted them), edits,
// bulk deletes, joins and leaves — all in the logs channel from config.js.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-messagelog-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const config = require('../config');
const store = require('../src/store');
const messageLog = require('../src/messageLog');

const LOGS = config.logs.channelId;
const posted = [];
const logChannel = { id: LOGS, isTextBased: () => true, send: async (p) => posted.push(p) };
let auditEntries = [];
const guild = {
  id: 'guild-logs',
  memberCount: 42,
  channels: { cache: new Collection([[LOGS, logChannel]]) },
  fetchAuditLogs: async () => ({ entries: new Collection(auditEntries.map((e, i) => [String(i), e])) }),
};
store.guild(guild.id).logChannelId = 'mod-log';

const user = (id) => ({ id, tag: id, username: id, bot: false, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png', createdTimestamp: Date.now() - 1e10 });
function message({ id, content, channelId = 'general', author = user('alice'), files = [] }) {
  return {
    id,
    guild,
    guildId: guild.id,
    channelId,
    author,
    content,
    url: `https://discord.com/channels/${guild.id}/${channelId}/${id}`,
    createdTimestamp: Date.now() - 60_000,
    attachments: new Collection(files.map((f, i) => [String(i), f])),
    inGuild: () => true,
    partial: false,
  };
}
// What Discord sends when a message it no longer has in memory is deleted: just the IDs.
const partial = (id, channelId = 'general') => ({ id, guild, guildId: guild.id, channelId, partial: true });
const last = () => posted.at(-1);
const embed = (p) => p.embeds[0].toJSON();

test('a deleted message is logged with what it said — even after Discord forgot it — and who deleted it', async () => {
  messageLog.remember(message({ id: 'm1', content: 'here is the secret prompt', files: [{ name: 'shot.png', url: 'https://cdn/x.png' }] }));
  auditEntries = [{ target: { id: 'alice' }, extra: { channel: { id: 'general' } }, executorId: 'a-mod', createdTimestamp: Date.now() }];
  await messageLog.onDelete(partial('m1'));
  const e = embed(last());
  assert.equal(e.title, '🗑️ Message deleted');
  assert.equal(e.description, 'here is the secret prompt');
  assert.ok(e.fields.some((f) => f.name === 'Deleted by' && f.value === '<@a-mod>'));
  assert.ok(e.fields.some((f) => f.name === 'Channel' && f.value === '<#general>'));
  assert.ok(e.fields.some((f) => f.name === 'Attachments' && /shot\.png/.test(f.value)));
  assert.ok(e.fields.some((f) => f.name === 'Author' && /\*\*alice\*\*/.test(f.value)), 'name shown as text too');
});

test('a message from before the bot started remembering still gets a line, just without the text', async () => {
  auditEntries = [];
  await messageLog.onDelete(partial('never-seen'));
  assert.match(embed(last()).description, /before I started remembering/);
});

test('edits show before and after; link previews loading aren’t logged', async () => {
  const before = posted.length;
  const original = message({ id: 'm2', content: 'old text' });
  messageLog.remember(original);
  await messageLog.onUpdate({ ...original, partial: true }, { ...original, content: 'new text' });
  const e = embed(last());
  assert.equal(e.title, '✏️ Message edited');
  assert.equal(e.fields.find((f) => f.name === 'Before').value, 'old text');
  assert.equal(e.fields.find((f) => f.name === 'After').value, 'new text');

  await messageLog.onUpdate({ ...original, content: 'new text' }, { ...original, content: 'new text' });
  assert.equal(posted.length, before + 1, 'no log when the text didn’t change');
});

test('bulk deletes are logged with a file of everything remembered', async () => {
  messageLog.remember(message({ id: 'b1', content: 'one' }));
  messageLog.remember(message({ id: 'b2', content: 'two' }));
  await messageLog.onBulkDelete(new Collection([['b2', partial('b2')], ['b1', partial('b1')]]), { id: 'general', name: 'general', guild });
  const p = last();
  assert.match(embed(p).description, /\*\*2\*\* messages/);
  const text = p.files[0].attachment.toString('utf8');
  assert.match(text, /alice \(alice\): one/);
  assert.match(text, /alice \(alice\): two/);
});

test('nothing in the logs channel or mod log, and no bot messages, is logged (no loops)', async () => {
  const before = posted.length;
  messageLog.remember(message({ id: 'l1', content: 'x', channelId: LOGS }));
  await messageLog.onDelete(partial('l1', LOGS));
  await messageLog.onDelete(partial('l2', 'mod-log'));
  messageLog.remember(message({ id: 'bot1', content: 'beep', author: { ...user('bot'), bot: true } }));
  await messageLog.onDelete({ ...message({ id: 'bot1', content: 'beep', author: { ...user('bot'), bot: true } }) });
  assert.equal(posted.length, before);
});
