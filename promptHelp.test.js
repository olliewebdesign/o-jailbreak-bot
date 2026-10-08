'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const promptHelp = require('../src/filters/promptHelp');
const { findBrokenPrompt, findPromptQuestion, isComplaint, modelsIn, autoReply } = promptHelp;

test('catches people saying a prompt doesn’t work', () => {
  for (const text of [
    'the prompt doesnt work',
    'The prompt doesn’t work',
    "prompt isn't working",
    'prompt not working',
    'it didnt work for me',
    "it's not working",
    'this doesnt even work',
    'jb is patched',
    'jailbreak broke again',
    'doesnt work',
    'still not working lol',
    'none of the prompts work',
    'nothing works',
    'the new prompt no longer works',
    'prompt failed on gpt',
    'hey guys\nnot working',
  ]) {
    assert.ok(findBrokenPrompt(text), text);
  }
});

test('leaves normal chat alone', () => {
  for (const text of [
    'hello everyone',
    'how do i use the prompt',
    'it works great thanks',
    'what model does it work on',
    'thanks it worked',
    'where is the guide',
    'i love this jb',
    'nothing to do today',
    'none of them are online',
    'i dont work tomorrow',
  ]) {
    assert.equal(findBrokenPrompt(text), null, text);
    assert.equal(findPromptQuestion(text), null, text);
  }
});

test('spots people asking for help, and those aren’t treated as complaints', () => {
  for (const text of [
    'i cant seem to get the prompt working',
    'I can’t get the jb to work',
    'how do i get this to work',
    'having trouble getting the jailbreak to work on claude',
    'is the prompt patched?',
    'has it been patched',
    'are the jbs dead',
    'does this still work?',
    'is the prompt still working',
  ]) {
    assert.ok(findPromptQuestion(text), text);
  }
  // Complaints are matched by the other patterns.
  for (const text of ['jb is patched', 'the prompt doesnt work', 'prompt not working']) {
    assert.equal(findPromptQuestion(text), null, text);
  }
});

// ----- auto-replies -----

const OPENCODE = '8000000000000000021';
const CLAUDE = '8000000000000000022';
const GROK = '8000000000000000023';

function chat() {
  promptHelp._reset();
  const replies = [];
  let id = 0;
  const say = (text, { channelId = 'general', userId = 'u1', replyTo = null, now = 1_000_000 } = {}) => {
    const message = {
      channelId,
      channel: { parentId: null },
      author: { id: userId },
      reference: replyTo ? { messageId: replyTo } : null,
      reply: async (p) => {
        const sent = { id: `bot-${id++}`, channelId, to: userId, content: p.content };
        replies.push(sent);
        return sent;
      },
    };
    return autoReply(message, text, now);
  };
  return { replies, say };
}

test('a jailbreak named: the How to use video in its own channel (no mute)', async () => {
  const { replies, say } = chat();
  assert.equal(await say('opencode prompt not working'), 'instructions');
  assert.equal(replies[0].content, `Please follow the How to use video step by step in <#${OPENCODE}>`);
  assert.equal(await say('claude and grok dont work', { channelId: 'c2' }), 'instructions');
  assert.equal(replies[1].content, `Please follow the How to use video step by step in <#${CLAUDE}> and <#${GROK}>`);
  for (const text of ['Open Code isnt working', 'is grok patched?', 'cant get qwen to work', 'клод не работает', 'chat gpt jb broke']) {
    promptHelp._reset();
    assert.equal(await say(text), 'instructions', text);
  }
});

test('“the jb doesn’t work” without saying which: asked which one, and the answer gets the right channel', async () => {
  const { replies, say } = chat();
  assert.equal(await say('jb doesnt work'), 'asked');
  assert.equal(replies[0].content, 'Which one isn’t working?');
  assert.equal(await say('claude', { now: 1_000_000 + 30_000 }), 'instructions');
  assert.equal(replies[1].content, `Please follow the How to use video step by step in <#${CLAUDE}>`);

  // Someone else replying to the question counts too; ordinary chat naming one doesn't.
  assert.equal(await say('grok', { userId: 'u2', now: 1_000_000 + 40_000 }), null, 'just mentioning grok');
  assert.equal(await say('grok', { userId: 'u2', replyTo: replies[0].id, now: 1_000_000 + 50_000 }), 'instructions');
  // Said in one of the jailbreaks' own channels: that's the one they mean.
  assert.equal(await say('not working', { channelId: OPENCODE, userId: 'u3' }), 'instructions');
  assert.equal(replies.at(-1).content, `Please follow the How to use video step by step in <#${OPENCODE}>`);
});

test('each reply goes out once per channel every 10 minutes (per jailbreak), so nobody is spammed', async () => {
  const { replies, say } = chat();
  const t0 = 1_000_000;
  assert.equal(await say('opencode not working', { now: t0 }), 'instructions');
  assert.equal(await say('opencode doesnt work', { userId: 'u2', now: t0 + 60_000 }), null, 'a minute later: skipped');
  assert.equal(await say('claude doesnt work', { userId: 'u3', now: t0 + 60_000 }), 'instructions', 'a different jailbreak still gets its answer');
  assert.equal(await say('opencode doesnt work', { channelId: 'other', now: t0 + 60_000 }), 'instructions', 'another channel has its own timer');
  assert.equal(await say('opencode doesnt work', { userId: 'u4', now: t0 + 10 * 60_000 }), 'instructions', '10 minutes later: again');
  assert.equal(await say('jb doesnt work', { userId: 'u5', now: t0 }), 'asked');
  assert.equal(await say('jb doesnt work', { userId: 'u6', now: t0 + 1000 }), null, 'not asked twice in a row');
  assert.equal(await say('the grok one', { userId: 'u6', now: t0 + 2 * 60_000 }), 'instructions', 'not asked again, but their answer still counts');
  assert.equal(await say('the qwen one', { userId: 'u6', now: t0 + 8 * 60_000 }), null, 'after 5 minutes, naming one is just chat');
  assert.equal(replies.length, 6);
});

test('normal chat about the jailbreaks gets nothing', async () => {
  const { replies, say } = chat();
  for (const text of ['claude is great', 'i use grok', 'gpt is cool', 'chatgpt works fine now', 'hello', 'мимо']) assert.equal(await say(text), null, text);
  assert.equal(replies.length, 0);
  assert.deepEqual(modelsIn('opencode and chat gpt not working, also клод'), ['opencode', 'chatgpt', 'claude']);
  assert.equal(isComplaint('i was working on grok stuff'), false);
});

test('a reply that fails to send doesn’t use up the cooldown', async () => {
  promptHelp._reset();
  const failing = { channelId: 'c9', channel: {}, author: { id: 'x' }, reply: async () => { throw new Error('no perms'); } };
  const working = { channelId: 'c9', channel: {}, author: { id: 'y' }, reply: async () => ({ id: 'm' }) };
  assert.equal(await autoReply(failing, 'opencode not working', 5), null);
  assert.equal(await autoReply(working, 'opencode not working', 6), 'instructions');
});
