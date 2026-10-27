'use strict';

const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/gu;
const ASCII_CODE_SYMBOLS = /^[=+\-*/%&|^~<>!.,:;(){}\[\]`'"\\]+$/u;
const EAST_ASIAN_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function candidateText(candidate) {
  return Array.isArray(candidate?.blocks)
    ? candidate.blocks.map(block => typeof block?.text === 'string' ? block.text : '').join('\n').trim()
    : '';
}

function candidateScore(candidate) {
  // 按可读字母与数字计分，不因语言或 CJK 字符数量加权。
  return (candidateText(candidate).match(LETTER_OR_NUMBER) || []).length;
}

function scriptGroups(words) {
  const groups = new Set();
  for (const word of words) {
    for (const character of word) {
      if (/\p{N}/u.test(character)) groups.add('number');
      else if (EAST_ASIAN_SCRIPT.test(character)) groups.add('east-asian');
      else if (/\p{Script=Latin}/u.test(character)) groups.add('latin');
      else if (/\p{L}/u.test(character)) groups.add('other');
    }
  }
  return groups;
}

function isFragmentedNoise(text) {
  const tokens = text.split(/\s+/u).filter(Boolean);
  if (tokens.length < 5) return false;
  const words = tokens.filter(token => HAS_LETTER_OR_NUMBER.test(token));
  const symbolTokens = tokens.filter(token => !HAS_LETTER_OR_NUMBER.test(token) && !ASCII_CODE_SYMBOLS.test(token));
  if (words.length < 3 || symbolTokens.length < 2) return false;
  const singleCharacterWords = words.filter(token => Array.from(token.replace(/\p{M}/gu, '')).length === 1).length;
  // WinRT 不提供置信度；只对多字形混杂、多个单字碎片和独立符号同时出现的候选发低质量信号。
  return singleCharacterWords / words.length >= 0.6 && scriptGroups(words).size >= 3;
}

function selectOcrCandidate(candidates, { automatic = true } = {}) {
  const ranked = (Array.isArray(candidates) ? candidates : []).map((candidate, index) => {
    const text = candidateText(candidate);
    const reliable = Boolean(text) && !(automatic && isFragmentedNoise(text));
    return { candidate, index, text, score: candidateScore(candidate), reliable };
  }).sort((left, right) => Number(right.reliable) - Number(left.reliable) || right.score - left.score || left.index - right.index);
  if (!ranked.length) return { blocks: [], quality: { reliable: false, reason: 'quality' } };
  const best = ranked[0];
  return { ...best.candidate, quality: best.reliable ? { reliable: true } : { reliable: false, reason: 'quality' } };
}

module.exports = { candidateScore, selectOcrCandidate };
