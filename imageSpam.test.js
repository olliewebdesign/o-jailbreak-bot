'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// The MrBeast image scam: 4 images at once, or 4 across messages in a row, get deleted and the person is DMed why.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-images-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField } = require('discord.js');
const store = require('../src/store');
const { checkImages, countImages } = require('../src/filters/imageSpam');
const automod = require('../src/automod');

let nextId = 1;
let nextUser = 1;

function image(name = 'scam.png') {
  return { name, contentType: name.endsWith('.png') ? 'image/png' : null };
}

function fakeMessage({ guild, author, channel, images = 0, content = '', files = [] }) {
  const attachments = new Collection([...Array.from({ length: images }, () => image()), ...files].map((a, i) => [String(i), a]));
  const message = {
    id: String(nextId++),
    guild,
    guildId: guild.id,
    channelId: channel.id,
    channel,
    author,
    member: guild.member,
    content,
    attachments,
    mentions: { users: new Collection(), roles: new Collection() },
    deleted: false,
    inGuild: () => true,
    delete: async () => {
      message.deleted = true;
    },
  };
  channel.sent.set(message.id, message);
  return message;
}

function setup() {
  const dms = [];
  const author = { id: `user-${nextUser++}`, tag: 'scammer', bot: false, send: async (text) => dms.push(text) };
  const channel = { id: 'chan', sent: new Map() };
  channel.messages = { delete: async (id) => (channel.sent.get(id).deleted = true) };
  const guild = {
    id: `guild-images-${nextUser}`,
    name: 'Test',
    ownerId: 'owner',
    channels: { cache: new Map([['chan', channel]]), fetch: async () => channel },
    member: { id: author.id, roles: { cache: new Collection() }, permissions: new PermissionsBitField() },
  };
  guild.member.guild = guild;
  store.guild(guild.id).logChannelId = 'log';
  const send = (opts) => automod.handleMessage(fakeMessage({ guild, author, channel, ...opts }));
  return { guild, author, channel, dms, send };
}

test('images are counted (pictures only, including forwarded ones)', () => {
  const { guild, author, channel } = setup();
  const message = fakeMessage({ guild, author, channel, images: 2, files: [{ name: 'notes.txt', contentType: 'text/plain' }, image('photo.JPG')] });
  message.messageSnapshots = new Collection([['f', { attachments: new Collection([['x', image()]]) }]]);
  assert.equal(countImages(message), 4);
});

test('4 images in one message are deleted and they’re DMed why', async () => {
  const { channel, dms, send } = setup();
  assert.equal(await send({ images: 4 }), 'image-spam');
  assert.ok([...channel.sent.values()][0].deleted);
  assert.match(dms[0], /4 images in one message/);
});

test('4 images in a row across messages are all deleted', async () => {
  const { channel, dms, send } = setup();
  assert.equal(await send({ images: 1 }), undefined);
  assert.equal(await send({ images: 2 }), undefined);
  assert.equal(await send({ images: 1 }), 'image-spam');
  assert.ok([...channel.sent.values()].every((m) => m.deleted), 'every message in the streak is deleted');
  assert.match(dms[0], /4 images in a row/);
});

test('a normal message in between breaks the streak, and 3 images are fine', async () => {
  const { channel, dms, send } = setup();
  await send({ images: 2 });
  await send({ content: 'look at these lol' });
  await send({ images: 2 });
  assert.equal(await send({ images: 1, content: 'and this' }), undefined);
  assert.ok([...channel.sent.values()].every((m) => !m.deleted));
  assert.equal(dms.length, 0);
});

test('the count resets after 2 minutes', () => {
  const { guild, author, channel } = setup();
  const realNow = Date.now;
  try {
    let now = realNow();
    Date.now = () => now;
    assert.equal(checkImages(fakeMessage({ guild, author, channel, images: 3 })), null);
    now += 121_000;
    assert.equal(checkImages(fakeMessage({ guild, author, channel, images: 1 })), null);
  } finally {
    Date.now = realNow;
  }
});
