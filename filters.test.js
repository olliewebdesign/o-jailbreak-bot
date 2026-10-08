'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findSlur } = require('../src/filters/slurs');
const { findSelfPromo } = require('../src/filters/selfPromo');
const DEFAULT_LIST = require('../src/filters/slurList');

// Test words come from the encoded list so this file doesn't contain slurs either.
const words = DEFAULT_LIST.map(([encoded]) => Buffer.from(encoded, 'base64').toString('utf8'));
const hardR = words[0];
const none = { customWords: [], disabledWords: [] };

const toFlags = (w) => [...w].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 97)).join('');
const toBold = (w) => [...w].map((c) => String.fromCodePoint(0x1d41a + c.charCodeAt(0) - 97)).join('');
const toFullwidth = (w) => [...w].map((c) => String.fromCodePoint(0xff41 + c.charCodeAt(0) - 97)).join('');

test('every built-in word is caught on its own and in a sentence', () => {
  for (const w of words) {
    assert.ok(findSlur(w, none), `plain: ${w.length} letters`);
    assert.ok(findSlur(`ok so you are a ${w.toUpperCase()} lol`, none), `sentence: ${w.length} letters`);
  }
});

test('disguised slurs are caught', () => {
  const disguises = {
    spaced: hardR.split('').join(' '),
    dotted: hardR.split('').join('.'),
    leet: hardR.replace('i', '1').replace('e', '3'),
    cyrillic: hardR.replace('i', 'і'),
    zeroWidth: hardR.split('').join('​'),
    flagEmoji: toFlags(hardR),
    mathBold: toBold(hardR),
    fullwidth: toFullwidth(hardR),
    split: `${hardR.slice(0, 3)} ${hardR.slice(3)}`,
    spoiler: `||${hardR}||`,
    stretched: hardR.replace('i', 'iiii') + 'rrrr',
    insideWord: `xx${hardR}xx`,
    customEmoji: `<:${hardR}:123456789012345678>`,
    accents: hardR.replace('i', 'í').replace('e', 'ë'),
    punctuation: `you ${hardR}!!!`,
    apostrophe: `${hardR.slice(0, 1)}'${hardR.slice(1)}`,
  };
  for (const [name, text] of Object.entries(disguises)) assert.ok(findSlur(text, none), name);
});

test('normal messages are not flagged', () => {
  const innocent = [
    'that was sniggering',
    "don't be niggardly with the snacks",
    'Niger and Nigeria are countries',
    'I live in Pakistan',
    'this food is so spicy',
    "let's pic that one",
    "it's pic related",
    'go ok?',
    'gobbledygook',
    'a red skin rash from the sun',
    'Nigel is here',
    'big gerbil',
    'running gerbils',
    'chinking glasses',
    'Japan trip',
    'raccoon in a cocoon',
    'Scunthorpe United',
    'follow me to the bank',
    'hello!!! 1337 gg',
    'the dredger has a draghead',
    'night night',
    'snigger',
  ];
  for (const text of innocent) assert.equal(findSlur(text, none), null, text);
});

test('custom words can be added, and built-in words turned off', () => {
  assert.equal(findSlur('you are a potato', none), null);
  assert.ok(findSlur('you are a p0t4t0', { customWords: ['potato'], disabledWords: [] }));
  assert.ok(findSlur('big dumb head', { customWords: ['dumb head'], disabledWords: [] }));
  assert.equal(findSlur(words[5], { customWords: [], disabledWords: [words[5]] }), null);
  assert.ok(findSlur(hardR, { customWords: [], disabledWords: [words[5]] }));
});

const checkedInviteCodes = new Set();
function fakeGuild() {
  return {
    id: 'home-guild',
    vanityURLCode: 'myvanity',
    client: {
      async fetchInvite(code) {
        checkedInviteCodes.add(code);
        if (code === 'home') return { guild: { id: 'home-guild', name: 'Home' } };
        if (code.startsWith('dead') || code === 'ez') throw Object.assign(new Error('Unknown Invite'), { code: 10006 });
        return { guild: { id: 'other-guild', name: 'Other Server' } };
      },
    },
  };
}

test('disguised invite links are caught, and the case-sensitive code is checked as typed', async () => {
  const disguised = [
    'my discord server d1scord.gg/vwxswwuNN',
    'disc0rd.gg/abcdef',
    'dlscord.gg/abcdef',
    'd!scord.gg/abcdef',
    'diskord.gg/abcdef',
    'd i s c o r d . g g / abcdef',
    'd.i.s.c.o.r.d.g.g/abcdef',
    'discord dot gg slash abcdef',
    'discord(dot)gg/abcdef',
    'discord[.]gg/abcdef',
    'discord\n.gg\n/abcdef',
    'discord.99/abcdef',
    'discord.gg\\abcdef',
    'discord.gg/ abcdef',
    'ԁiscord.gg/abcdef', // Cyrillic letter
    'dіscord.gg/abcdef', // Cyrillic letter
    'ｄｉｓｃｏｒｄ．ｇｇ／AbCdEf', // full-width
    '𝐝𝐢𝐬𝐜𝐨𝐫𝐝.𝐠𝐠/AbCdEf', // bold font
    'disc​ord.gg/abc​def', // invisible characters
    'discordapp.com/invite/abcdef',
    'd1scord.gg/deadcode', // dead link, but disguised on purpose
  ];
  for (const text of disguised) assert.ok(await findSelfPromo(text, fakeGuild()), text);

  const hit = await findSelfPromo('my discord server d1scord.gg/vwxswwuNN', fakeGuild());
  assert.match(hit.trigger, /Disguised invite link to another server: `d1scord\.gg\/vwxswwuNN`/);
  assert.ok(checkedInviteCodes.has('vwxswwuNN'), 'code looked up with its capitals intact');
  assert.ok(checkedInviteCodes.has('AbCdEf'));
});

test('invites to this server are fine however they are written; gamer chat is not an invite', async () => {
  const clean = ['d1scord.gg/home', 'd i s c o r d . g g / home', 'discord gg/ez', 'gg/ez', 'gg ez discord', 'I love discord, gg everyone', 'discord.gg'];
  for (const text of clean) assert.equal(await findSelfPromo(text, fakeGuild()), null, text);
});

test('self-promotion is caught', async () => {
  const promo = [
    'join discord.gg/AbC123',
    'discord . gg / cool',
    'discord gg/cool',
    'https://discord.com/invite/xyz',
    'dsc.gg/cool',
    'sub to my channel',
    'check out my youtube',
    'follow me on tiktok',
    'im live on twitch',
    'twitch.tv/coolstreamer',
    'youtube.com/@creator',
    'guns.lol/me',
    'link in bio',
    'just hit 100 subs thanks everyone youtube.com/@abc',
    'come join our discord',
  ];
  for (const text of promo) assert.ok(await findSelfPromo(text, fakeGuild()), text);
});

test('normal links and chat are not self-promotion', async () => {
  const clean = [
    'join my server',
    'follow me to the bank',
    'check this out https://youtube.com/watch?v=abc',
    'subscribe to the newsletter',
    'discord.gg/home',
    'discord.gg/dead',
    'discord.gg/myvanity',
    'https://discord.com/channels/123/456/789',
    'that twitch streamer is funny',
    'watch this https://clips.twitch.tv/abc',
    'I really like this creator, his videos are so funny and make me laugh youtube.com/@creator',
    'im live laughing',
  ];
  for (const text of clean) assert.equal(await findSelfPromo(text, fakeGuild()), null, text);
});

test('other chat apps, selling, Russian ads, .gg/ shorthand and shop links are caught', async () => {
  const promo = [
    't.me/jailbreakchannel',
    't . me / bestprompts',
    't(dot)me/bestprompts',
    'т.ме/bestprompts', // Russian letters
    'chat.whatsapp.com/AbC123xyz',
    'guilded.gg/coolserver',
    'tg: @bestjbchannel',
    '@freeprompts on telegram',
    'join our telegram',
    'join .gg/coolserver',
    'discord.com/servers/cool-server-222222222222222222',
    'discords.com/servers/coolserver',
    'selling jailbreaks dm me',
    'im selling private prompts',
    'jailbreak for $5',
    'dm me for working jailbreaks',
    'got a private jb, hmu',
    'sellix.io/bestjb',
    'whop.com/jailbreaks',
    'paypal.me/someone',
    'продаю промпты',
    'пр0даю промпты', // a zero for the о
    'у меня есть рабочий джб, пишите в лс',
    'подписывайтесь на мой канал',
    'заходите на наш сервер',
    'тг: @bestjb',
  ];
  for (const text of promo) assert.equal((await findSelfPromo(text, fakeGuild()))?.kind, 'promo', text);
});

test('fake Discord and Steam links are caught as scams; the real sites are fine', async () => {
  const scams = ['free nitro https://dlscord-gift.com/claim', 'https://discord-nitro.ru/gift', 'dіscord.com/login', 'steamcommunlty.com/tradeoffer/new', 'stearncommunity.ru/gift', 'steamcomminuty.com/id/x'];
  for (const text of scams) assert.equal((await findSelfPromo(text, fakeGuild()))?.kind, 'scam', text);
  const real = ['https://discord.gift/AbCdEf', 'https://discord.js.org/docs', 'discordjs.guide', 'steamcommunity.com/id/me', 'https://store.steampowered.com/app/1', 'steamgifts.com is cool'];
  for (const text of real) assert.equal(await findSelfPromo(text, fakeGuild()), null, text);
});

test('asking about prompts, offering help, and normal chat are not selling or advertising', async () => {
  const clean = [
    'anyone selling prompts?',
    'dm me if you need help',
    'can someone dm me the prompt',
    'the prompt isnt working, can anyone dm me?',
    'they sold me a fake jb lol',
    'is this method still working',
    'i like telegram more than whatsapp',
    'look at me/you',
    'кто знает рабочий промпт?',
    'у меня не работает промпт',
    '.gg/home',
    'gg/ez',
    'just paid $5 for lunch',
  ];
  for (const text of clean) assert.equal(await findSelfPromo(text, fakeGuild()), null, text);
});

test('a message full of spaces can’t freeze the bot', async () => {
  for (const text of ['tg' + ' '.repeat(4000) + 'x', 'телеграм' + ' '.repeat(4000) + 'x', 'i have ' + 'a '.repeat(1990)]) {
    const start = Date.now();
    await findSelfPromo(text, fakeGuild());
    assert.ok(Date.now() - start < 500, `took ${Date.now() - start}ms`);
  }
});

test('asking for help, saying no, and complaining about a ban aren’t advertising', async () => {
  for (const text of [
    'I have an issue with my account, can someone dm me?',
    'i have no access to the channels, can a mod message me',
    'у меня есть вопрос по доступу, напишите админ',
    'я не продам свой акк',
    'why would i sell my account lol',
    'i had to buy my own nitro',
    'my account got banned on twitch',
    'my video got taken down by youtube',
  ]) {
    assert.equal(await findSelfPromo(text, fakeGuild()), null, text);
  }
});
