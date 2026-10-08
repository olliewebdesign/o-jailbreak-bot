'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitText } = require('../src/longText.js');

const words = (s) => s.replace(/```[\w+-]*/g, ' ').split(/\s+/).filter(Boolean);

function story(paragraphs, sentencesEach) {
  return Array.from({ length: paragraphs }, (_, p) =>
    Array.from({ length: sentencesEach }, (_, s) => `Paragraph ${p + 1} sentence ${s + 1} tells more of the story about the heist.`).join(' '),
  ).join('\n\n');
}

test('short text stays in one part', () => {
  assert.deepEqual(splitText('Hello world'), ['Hello world']);
  assert.deepEqual(splitText('   '), []);
});

test('10,000+ characters are split into parts that each fit a Discord box, with nothing lost', () => {
  const text = story(40, 5); // ~14,000 characters
  assert.ok(text.length > 10_000);
  const parts = splitText(text);
  assert.ok(parts.length >= 4);
  for (const part of parts) assert.ok(part.length <= 4000, `part is ${part.length} characters`);
  assert.deepEqual(words(parts.join('\n')), words(text), 'every word kept, in order');
  // Splits happen between paragraphs, so no part starts or ends mid-sentence.
  for (const part of parts) {
    assert.match(part, /^Paragraph \d+ sentence 1 /);
    assert.match(part, /heist\.$/);
  }
});

test('one giant paragraph is split between sentences, then words', () => {
  const giant = Array.from({ length: 600 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const parts = splitText(giant, 1000);
  for (const part of parts) {
    assert.ok(part.length <= 1000);
    assert.match(part, /\.$/, 'ends at the end of a sentence');
  }
  assert.deepEqual(words(parts.join(' ')), words(giant));

  const noPunctuation = 'word '.repeat(3000).trim();
  for (const part of splitText(noPunctuation, 500)) assert.ok(!part.startsWith(' ') && !/wor$/.test(part));
});

test('a code block cut in half is closed and reopened', () => {
  const code = `Intro\n\n\`\`\`js\n${Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join('\n')}\n\`\`\`\n\nOutro`;
  const parts = splitText(code, 2000);
  assert.ok(parts.length > 2);
  for (const part of parts) {
    const fences = part.match(/```/g) ?? [];
    assert.equal(fences.length % 2, 0, 'every part has matching ``` fences');
    assert.ok(part.length <= 2000);
  }
  assert.match(parts[1], /^```js\n/);
});

test('Windows line endings and a byte-order mark from Notepad are cleaned up', () => {
  assert.deepEqual(splitText('﻿Line one\r\nLine two\r\n'), ['Line one\nLine two']);
});
