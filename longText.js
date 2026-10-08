// Splits long writing into parts that fit in a Discord message box (4,096 characters), breaking
// between paragraphs where possible, then lines, sentences and words — never in the middle of a word
// unless a single "word" is longer than a whole part. Code blocks cut in half are closed and reopened.
// Used by both the bot (/post) and O Jailbreak Studio.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OJLongText = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const DEFAULT_MAX = 4000;
  const FENCE_ROOM = 16; // space kept free to close and reopen a ``` code block

  function normalize(text) {
    return String(text ?? '')
      .replace(/^﻿/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .trim();
  }

  function splitWords(sentence, budget) {
    const chunks = [];
    for (const word of sentence.split(' ')) {
      if (!word) continue;
      if (word.length <= budget) chunks.push(word);
      else for (let i = 0; i < word.length; i += budget) chunks.push(word.slice(i, i + budget));
    }
    return chunks;
  }

  function splitLine(line, budget) {
    const sentences = line.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [line];
    return sentences
      .map((s) => s.trim())
      .filter(Boolean)
      .flatMap((s) => (s.length <= budget ? [s] : splitWords(s, budget)));
  }

  // Break the text into small pieces, remembering what joined each piece to the one before it.
  function pieces(text, budget) {
    const out = [];
    for (const paragraph of text.split(/\n{2,}/)) {
      if (paragraph.length <= budget) {
        out.push({ text: paragraph, sep: '\n\n' });
        continue;
      }
      paragraph.split('\n').forEach((line, lineIndex) => {
        const lineSep = lineIndex === 0 ? '\n\n' : '\n';
        if (line.length <= budget) out.push({ text: line, sep: lineSep });
        else splitLine(line, budget).forEach((chunk, i) => out.push({ text: chunk, sep: i === 0 ? lineSep : ' ' }));
      });
    }
    return out;
  }

  function balanceCodeBlocks(parts) {
    let openLanguage = null;
    return parts.map((part) => {
      let text = openLanguage === null ? part : `\`\`\`${openLanguage}\n${part}`;
      let inside = null;
      for (const fence of text.matchAll(/```([\w+-]*)/g)) inside = inside === null ? fence[1] : null;
      if (inside !== null) text += '\n```';
      openLanguage = inside;
      return text;
    });
  }

  /**
   * @param {string} text
   * @param {number} [max] - largest part, in characters
   * @returns {string[]} the parts, in order (empty array for empty text)
   */
  function splitText(text, max = DEFAULT_MAX) {
    const clean = normalize(text);
    if (!clean) return [];
    if (clean.length <= max) return [clean];

    const budget = Math.max(50, max - FENCE_ROOM);
    const parts = [];
    let current = '';
    for (const piece of pieces(clean, budget)) {
      const joined = current ? current + piece.sep + piece.text : piece.text;
      if (joined.length <= budget) current = joined;
      else {
        if (current) parts.push(current);
        current = piece.text;
      }
    }
    if (current) parts.push(current);
    return balanceCodeBlocks(parts);
  }

  return { splitText, normalize, DEFAULT_MAX };
});
