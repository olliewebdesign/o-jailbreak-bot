'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// New accounts (under a week old) can't chat: their messages are deleted and they're told when they can (once a day).
// Breaking the rules while new gets them restricted. "ellie is a scammer" from anyone else is deleted and logged.

const os = require('node:os');
const path = require('node:path');
process.env.OJ_DATA_DIR = path.join(os.tmpdir(), `oj-test-newaccounts-${process.pid}`);
require('node:fs').rmSync(process.env.OJ_DATA_DIR, { recursive: true, force: true }); // left over from an earlier run with the same process number

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const store = require('../src/store');
const restrict = require('../src/restrict');
const automod = require('../src/automod');
const { findAccusation } = require('../src/filters/accusations');
const { buildCaseButtons } = require('../src/caseLog');

const DAY = 86_400_000;
const restricted = [];
restrict.restrictMember = async ({ guild, member, reason, proof }) => {
  restricted.push({ id: member.id, reason, proof });
  store.guild(guild.id).restricted[member.id] = { roles: [], reason };
  return { ok: true };
};

let n = 0;
function setup({ accountAgeDays = 1, staff = false } = {}) {
  const logged = [];
  const dms = [];
  const logChannel = { id: 'log', isTextBased: () => true, send: async (p) => (logged.push(p), { id: `logmsg-${logged.length}`, edit: async () => {} }), messages: { fetch: async () => ({ edit: async () => {} }) } };
  const channel = { id: 'general', name: 'general', isTextBased: () => true, send: async () => null, messages: { fetch: async () => new Collection() }, permissionOverwrites: { cache: new Collection() } };
  const guild = {
    id: `guild-new-${n++}`,
    name: 'O Jailbreak',
    ownerId: '100000000000000001',
    client: { user: { id: 'bot', tag: 'O Jailbreak' } },
    channels: { cache: new Map([['general', channel], ['log', logChannel]]), fetch: async (id) => (id === 'log' ? logChannel : channel) },
  };
  const settings = store.guild(guild.id);
  settings.logChannelId = 'log';
  settings.restrict.categoryId = 'appeals';
  const user = { id: `user-${n}`, tag: 'newbie', username: 'newbie', bot: false, createdTimestamp: Date.now() - accountAgeDays * DAY, displayAvatarURL: () => '' };
  const member = {
    id: user.id,
    guild,
    user,
    joinedTimestamp: Date.now(),
    moderatable: true,
    roles: { cache: new Collection() },
    permissions: new PermissionsBitField(staff ? [P.ManageMessages] : []),
    isCommunicationDisabled: () => false,
    timeout: async () => {},
    send: async (t) => dms.push(t),
  };
  let ids = 0;
  const say = (content, where = channel) => {
    const message = {
      id: `m${++ids}`,
      guild,
      guildId: guild.id,
      channelId: where.id,
      channel: where,
      author: user,
      member,
      content,
      createdTimestamp: Date.now(),
      attachments: new Collection(),
      mentions: { users: new Collection(), roles: new Collection() },
      inGuild: () => true,
      deleted: false,
      delete: async () => {
        message.deleted = true;
      },
    };
    return automod.handleMessage(message).then((result) => ({ result, message }));
  };
  return { guild, settings, member, channel, say, logged, dms };
}

test('a new account can’t chat: deleted, DMed when they can (English + Russian), logged once a day', async () => {
  const { say, dms, logged, guild } = setup({ accountAgeDays: 2 });
  restricted.length = 0;
  const first = await say('hello everyone');
  assert.equal(first.result, 'new-account');
  assert.ok(first.message.deleted);
  assert.equal(dms.length, 1);
  assert.match(dms[0].content, /New Discord accounts can’t chat there for their first 7 days/);
  assert.match(dms[0].content, /Новые аккаунты Discord не могут писать там первые 7 дней/);
  assert.match(dms[0].content, /<t:\d+:F>/, 'says exactly when');
  assert.equal(dms[0].components[0].toJSON().components[0].custom_id, `ojnew:ask:${guild.id}`, 'with an “Ask to chat early” button');
  assert.equal(logged.length, 1);
  assert.match(logged[0].content, /New account <@user-\d+> \*\*newbie\*\*/);
  assert.match(logged[0].content, /hello everyone/);

  const second = await say('why cant i talk');
  assert.ok(second.message.deleted);
  assert.equal(dms.length, 1, 'only told once a day');
  assert.equal(logged.length, 1);
  assert.equal(restricted.length, 0, 'just chatting isn’t breaking the rules');
});

test('a new account saying “ellie is a scammer” is restricted, with the message as proof', async () => {
  const { say, dms } = setup();
  restricted.length = 0;
  const { result, message } = await say('ellie is a scammer dont buy anything');
  assert.equal(result, 'new-account-restricted');
  assert.ok(message.deleted);
  assert.equal(restricted.length, 1);
  assert.match(restricted[0].reason, /New account breaking the rules: calling the owner a scammer/);
  assert.equal(restricted[0].proof.excerpt, 'ellie is a scammer dont buy anything');
  assert.equal(dms.length, 0, 'the restriction tells them instead');
});

test('a new account is restricted for Russian accusations, slurs and @everyone too', async () => {
  for (const text of ['элли мошенник', 'Элли кидала, не покупайте', 'you are a nigger', '@everyone free nitro https://discord-gift.ru/x']) {
    const { say } = setup();
    restricted.length = 0;
    const { result } = await say(text);
    assert.equal(result, 'new-account-restricted', text);
  }
});

test('new accounts can still talk in their appeal ticket, tickets from other bots, and channels let off with /exempt', async () => {
  const { say, settings, member } = setup();
  const appeal = { id: 'ticket-1', parentId: 'appeals', isTextBased: () => true, permissionOverwrites: { cache: new Collection() } };
  assert.equal((await say('please unrestrict me', appeal)).message.deleted, false);

  const otherBotTicket = { id: 'ticket-2', isTextBased: () => true, permissionOverwrites: { cache: new Collection([[member.id, { allow: new PermissionsBitField([P.ViewChannel]) }]]) } };
  assert.equal((await say('i need help', otherBotTicket)).message.deleted, false);

  const help = { id: 'help', isTextBased: () => true, permissionOverwrites: { cache: new Collection() } };
  settings.exempt.newAccounts.channels.push('help');
  assert.equal((await say('hi', help)).message.deleted, false);
});

test('a private thread a new account made itself isn’t a ticket; “hi @everyone” is only deleted', async () => {
  const { say, guild, member } = setup();
  restricted.length = 0;
  guild.members = { cache: new Collection([[member.id, member]]) };
  const ownThread = { id: 'thread-1', type: 12, ownerId: member.id, guild, isThread: () => true, isTextBased: () => true };
  assert.equal((await say('ellie is a scammer', ownThread)).result, 'new-account-restricted');
  const { result, message } = await say('hi @everyone');
  assert.equal(result, 'new-account');
  assert.ok(message.deleted);
});

test('accounts older than a week, staff, and servers that turned it off are left alone', async () => {
  const old = setup({ accountAgeDays: 8 });
  assert.equal((await old.say('hello')).message.deleted, false);
  const mod = setup({ staff: true });
  assert.equal((await mod.say('hello')).message.deleted, false);
  const off = setup();
  off.settings.modules.newAccounts = false;
  assert.equal((await off.say('hello')).message.deleted, false);
});

test('“ellie is a scammer” from an established member: deleted and logged for the mods, not restricted', async () => {
  const { say, logged, guild } = setup({ accountAgeDays: 400 });
  restricted.length = 0;
  const { result, message } = await say('honestly <@100000000000000001> is a scammer');
  assert.ok(message.deleted);
  assert.equal(restricted.length, 0);
  const c = store.getCase(guild.id, result.case.id);
  assert.equal(c.type, 'ACCUSE');
  assert.equal(c.noMute, true);
  assert.match(c.trigger, /ownerping is a scammer|is a scammer/);
  assert.deepEqual(buildCaseButtons(c)[0].toJSON().components.map((b) => b.label), ['Mute', 'Restrict', 'Ban (admins)', 'No action']);
  assert.ok(logged.length >= 1);
});

test('the accusation filter: disguised and Russian versions are caught, defending ellie isn’t', () => {
  const guild = { ownerId: '100000000000000001' };
  for (const text of ['ellie is a scammer', 'is ellie a scammer?', 'ellie scammed me', 's c a m m e r ellie', 'e l l i e is a sc4mm3r', 'elliescammer', 'the owner is a fraud', 'элли скамер', 'элли cкaмeр', 'элли заскамил меня', 'владелец мошенник', 'elli moshennik']) {
    assert.ok(findAccusation(text, guild), `should catch: ${text}`);
  }
  for (const text of ['ellie is not a scammer', 'ellie isn’t a scammer', 'ellie got scammed', 'beware of scammers', 'anon is a scammer, ellie said', 'the owner of anon is a scammer', 'элли не скамер', 'сижу на скамейке', 'ellie warned us about the scam going around', 'thanks ellie',
    // People reporting scammers TO the owner.
    "ellie there's a scammer in general", '<@100000000000000001> this guy is a scammer', 'ellie can you ban the scammer', 'the owner banned the scammer',
    'ellie scam link in general', 'элли помоги меня обманули', 'владелец магазина меня обманул']) {
    assert.equal(findAccusation(text, guild), null, `should leave alone: ${text}`);
  }
});


test('a new account can ask to chat early; an admin lets them in and they can chat straight away', async () => {
  const { say, guild, member, logged } = setup({ accountAgeDays: 1 });
  const chatRequest = require('../src/chatRequest');
  guild.members = { cache: new Collection([[member.id, member]]), fetch: async () => member };
  guild.client.guilds = { cache: new Collection([[guild.id, guild]]) };
  guild.client.users = { fetch: async () => ({ send: async () => {} }) };
  member.roles.cache = new Collection();
  const replies = [];
  let modal = null;
  const base = { user: member.user, client: guild.client, reply: async (p) => replies.push(p.content) };

  // 📝 in their DMs opens the form.
  await chatRequest.openForm({ ...base, showModal: async (m) => (modal = m) }, guild.id);
  assert.equal(modal.toJSON().custom_id, `ojnew:askmodal:${guild.id}`);

  // The form goes to the mod log with buttons.
  await chatRequest.formSent({ ...base, fields: { getTextInputValue: () => 'I just made this account to join, I want to ask about the prompts' } }, guild.id);
  assert.match(replies.at(-1), /Sent/);
  const request = logged.at(-1);
  assert.match(request.embeds[0].data.title, /Asking to chat early/);
  assert.deepEqual(request.components[0].toJSON().components.map((b) => b.custom_id), [`oj:chat-allow:${member.id}`, `oj:chat-deny:${member.id}`]);

  // Asking again while it's waiting doesn't send a second one.
  await chatRequest.formSent({ ...base, fields: { getTextInputValue: () => 'again' } }, guild.id);
  assert.match(replies.at(-1), /already asked/);

  // A moderator can't decide it; an admin can.
  const press = (presser) => {
    const out = [];
    return chatRequest.reviewButton({ guild, client: guild.client, member: presser, user: presser.user, message: null, reply: async (p) => out.push(p.content) }, 'chat-allow', member.id).then(() => out);
  };
  const mod = { id: 'mod', guild, user: { id: 'mod' }, roles: { cache: new Collection() }, permissions: new PermissionsBitField([P.ManageMessages]) };
  assert.match((await press(mod))[0], /Only admins/);
  const admin = { id: 'admin', guild, user: { id: 'admin' }, roles: { cache: new Collection() }, permissions: new PermissionsBitField([P.Administrator]) };
  assert.match((await press(admin))[0], /can chat now/);

  const { result, message } = await say('hello, finally!');
  assert.notEqual(result, 'new-account');
  assert.equal(message.deleted, false, 'they can chat now');
});


test('a moderator who breaks a rule is restricted (every role off, saved) and the owner is DMed straight away', async () => {
  const modGuard = require('../src/modGuard');
  const { say, guild, settings, member } = setup({ accountAgeDays: 400, staff: true }); // Manage Messages: a moderator
  const watched = [];
  const ownerDms = [];
  guild.channels.cache.set('watch', { id: 'watch', isTextBased: () => true, send: async (p) => watched.push(p.content) });
  modGuard.modsSettings(settings).watchChannelId = 'watch';
  guild.fetchOwner = async () => ({ send: async (p) => ownerDms.push(p) });
  restricted.length = 0;

  const accused = await say('honestly ellie is a scammer');
  assert.equal(accused.result, 'rogue-mod-restricted');
  assert.ok(accused.message.deleted, 'their message is deleted');
  assert.equal(restricted.length, 1);
  assert.match(restricted[0].reason, /Broke the rules: Scam accusation/);
  assert.equal(restricted[0].proof.excerpt, 'honestly ellie is a scammer');
  assert.equal(ownerDms.length, 1, 'the owner is DMed straight away');
  assert.match(ownerDms[0].embeds[0].data.title, /moderator broke the rules — I restricted them/);
  assert.ok(watched.some((t) => /broke a rule: \*\*Scam accusation\*\*.*restricted/.test(t)));

  const fine = await say('the prompt doesnt work anymore, use the new one');
  assert.equal(fine.message.deleted, false, 'mods can say that while helping');

  member.permissions = new PermissionsBitField([P.Administrator]);
  const admin = await say('ellie is a scammer lol');
  assert.equal(admin.message.deleted, false, 'admins are left alone');
});

test('a moderator spamming (past their lighter limit) is restricted too', async () => {
  const { say, guild, channel } = setup({ accountAgeDays: 400, staff: true });
  guild.fetchOwner = async () => ({ send: async () => {} });
  const bulkDeleted = [];
  channel.bulkDelete = async (ids) => (bulkDeleted.push(...ids), new Collection(ids.map((id) => [id, true])));
  restricted.length = 0;
  let last;
  for (let i = 0; i < 20 && !restricted.length; i++) last = await say(`spam spam ${i}`);
  assert.equal(restricted.length, 1);
  assert.match(restricted[0].reason, /Broke the rules: Spam/);
  assert.equal(last.result, 'rogue-mod-restricted');
  assert.ok(bulkDeleted.length > 0, 'the spam is cleaned up');
});
