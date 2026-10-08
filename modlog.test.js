'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// Builds every kind of mod-log message with discord.js's own builders, which throw on anything
// Discord would reject (too-long fields, bad button setups, invalid commands).

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCaseButtons, buildCaseEmbed, buildEvidenceFile } = require('../src/caseLog');
const { definitions } = require('../src/commands');

const longText = 'spam '.repeat(1200);

function sampleCase(overrides) {
  return {
    id: 42,
    type: 'SLUR',
    status: 'OPEN',
    createdAt: Date.now(),
    label: 'Racial slur',
    trigger: 'Racial slur detected: `x***x`',
    userId: '123456789012345678',
    userTag: 'someone',
    avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
    channelId: '223456789012345678',
    messageId: '323456789012345678',
    excerpt: longText.slice(0, 1500),
    excerptTruncated: true,
    actionNote: '🔇 Timed out for 7 days\n🗑️ Message deleted',
    accountCreatedAt: Date.now() - 1e9,
    joinedAt: Date.now() - 1e8,
    priorCases: Array.from({ length: 5 }, (_, i) => `#${i + 1} Spam <t:1700000000:R>`),
    ...overrides,
  };
}

test('slash commands are valid', () => {
  for (const d of definitions) assert.ok(d.toJSON().name);
});

test('every case type and status builds a valid log message', () => {
  const variants = [
    {},
    { type: 'PROMO', label: 'Self-promotion' },
    { type: 'SPAM', label: 'Spam', details: undefined },
    { type: 'MANUAL', label: 'Manual mute', moderatorId: '423456789012345678', trigger: 'r'.repeat(400) },
    {
      type: 'ANTINUKE',
      label: 'Anti-nuke',
      excerpt: null,
      channelId: null,
      summary: '**<@1> looks like they are trying to nuke the server.**',
      details: Array.from({ length: 40 }, (_, i) => `• Deleted channel: channel-${i} (1234567890123456789)`),
      strippedRoles: ['1', '2'],
    },
    { type: 'BOT', label: 'Unapproved bot added', excerpt: null, addedBy: '523456789012345678' },
    { type: 'RESTRICT', label: 'Restricted', excerpt: null, channelId: null, moderatorId: '423456789012345678', trigger: 'r'.repeat(400) },
    { type: 'RESTRICT', label: 'Restricted', excerpt: null, status: 'UNRESTRICTED', resolvedBy: '1', resolvedAt: Date.now(), resolutionNote: 'Appeal accepted' },
    { status: 'RESTRICTED', resolvedBy: '1', resolvedAt: Date.now(), resolutionNote: 'See case #9' },
    { status: 'KEPT', resolvedBy: '1', resolvedAt: Date.now() },
    { status: 'UNMUTED', resolvedBy: '1', resolvedAt: Date.now(), resolutionNote: 'n'.repeat(1000) },
    { status: 'BANNED', resolvedBy: '1', resolvedAt: Date.now(), resolutionNote: 'b'.repeat(1000) },
  ];

  for (const v of variants) {
    const c = sampleCase(v);
    const embed = buildCaseEmbed(c).toJSON();
    const total =
      (embed.title?.length ?? 0) +
      (embed.description?.length ?? 0) +
      (embed.footer?.text.length ?? 0) +
      embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    assert.ok(total <= 6000, `${c.type}/${c.status} embed is ${total} characters (limit 6000)`);

    const rows = buildCaseButtons(c).map((r) => r.toJSON());
    const buttons = rows[0].components;
    assert.ok(buttons.length >= 1 && buttons.length <= 5);
    const closed = ['UNMUTED', 'BANNED', 'RESTRICTED', 'UNRESTRICTED'].includes(c.status);
    assert.equal(buttons.every((b) => b.disabled), closed, `${c.type}/${c.status} buttons disabled state`);
  }
});

test('evidence file contains the full message and context', () => {
  const c = sampleCase({});
  const flagged = {
    createdTimestamp: Date.now(),
    content: longText,
    author: { tag: 'someone', id: c.userId },
    attachments: new Map([['1', { name: 'pic.png', size: 10, url: 'https://cdn.example/pic.png' }]]),
  };
  const context = [{ createdTimestamp: Date.now() - 5000, content: 'hello', author: { tag: 'friend', id: '9' }, attachments: new Map() }];
  const file = buildEvidenceFile(c, { guild: { id: 'g', name: 'Guild' }, channelName: 'general', fullContent: longText, flaggedMessage: flagged, context });
  const text = file.attachment.toString('utf8');
  assert.ok(text.includes(longText));
  assert.ok(text.includes('friend (9): hello'));
  assert.ok(text.includes('<<< FLAGGED'));
  assert.ok(text.includes('pic.png'));
});
