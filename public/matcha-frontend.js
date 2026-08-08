// Matcha zh-en text frontend: text → phone-token ids by greedy longest match
// over the model's own lexicon.txt. Ported from the sibling research repo
// ~/workspace/wasmtts (platform/matcha-frontend.js @ 05b5b35).
//
// Diverges from that port in four places — three in the number path: a
// full-width-digit fix (charCodeAt without fromCharCode emitted code points),
// normalizeLocalForms, and the ruleNormalizer hook prepareText runs it into;
// and one in punctuation: ":" maps to "," because the acoustic model
// VOCALIZES the colon token (id 3) — ~0.25 s of voiced sound per colon,
// stacking linearly, measured — where a comma renders real silence.
// Everything else is still byte-for-byte, so upstream stays diffable.
//
// 簡繁直輸 by decision: there is no OpenCC step and convertTraditional stays the
// identity. The multi-char entries are overwhelmingly simplified, so traditional
// prose falls through to the single-char entries and reads roughly 16% of its
// syllables wrong (銀行 → yin2 xing2, 看著 → kan4 zhu4). Corrections belong in
// pronunciationOverrides, added one line at a time from listening tests — a flat
// table cannot disambiguate 著, and guessing entries up front just moves the
// error around. Note overrides are keyed on the literal input text, and a
// single-char entry is shadowed wherever a longer lexicon match wins.
//
// IIFE global with a CommonJS tail, so the same file serves three loaders:
// importScripts in the synth worker sets self.MatchaFrontend, and node's ESM
// loader sets globalThis.MatchaFrontend (the CJS tail no-ops there) so
// scripts/test-wasm-frontend.mjs can import it without a build step.
(function initMatchaFrontend(globalScope) {
  'use strict';

  const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const SMALL_UNITS = ['', '十', '百', '千'];
  const LARGE_UNITS = ['', '万', '亿', '兆'];
  const PUNCTUATION = new Map([
    ['。', '.'], ['．', '.'], ['｡', '.'],
    ['，', ','], ['、', ','],
    ['！', '!'], ['？', '?'],
    // ":" would be spoken (see header); "，" from a colon reads as the pause a
    // prose colon means. NFKC has already folded ： to : when this map runs.
    ['；', ';'], [':', ','],
    ['（', '('], ['）', ')'],
    ['「', ''], ['『', ''], ['《', ''],
    ['」', ''], ['』', ''], ['》', ''],
    ['“', ''], ['”', ''], ['‘', ''], ['’', ''], ['"', ''],
    ['—', '—'], ['–', '—'], ['…', '…'],
  ]);

  function parseTable(source) {
    return source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function parseTokens(source) {
    const tokens = new Map();
    for (const line of parseTable(source)) {
      const separator = line.lastIndexOf(' ');
      if (separator < 1) continue;
      const id = Number(line.slice(separator + 1));
      if (Number.isFinite(id)) tokens.set(line.slice(0, separator), id);
    }
    return tokens;
  }

  function parseLexicon(source) {
    const lexicon = new Map();
    let maxKeyLength = 1;
    for (const line of parseTable(source)) {
      const separator = line.indexOf(' ');
      if (separator < 1) continue;
      const key = line.slice(0, separator);
      const phones = line.slice(separator + 1).trim().split(/\s+/u);
      if (!phones.length) continue;
      lexicon.set(key, phones);
      maxKeyLength = Math.max(maxKeyLength, key.length);
    }
    return {lexicon, maxKeyLength};
  }

  function sectionToChinese(section) {
    let output = '';
    let unitIndex = 0;
    let pendingZero = false;
    while (section > 0) {
      const digit = section % 10;
      if (digit === 0) {
        if (output) pendingZero = true;
      } else {
        const prefix = pendingZero ? '零' : '';
        output = `${DIGITS[digit]}${SMALL_UNITS[unitIndex]}${prefix}${output}`;
        pendingZero = false;
      }
      unitIndex += 1;
      section = Math.floor(section / 10);
    }
    return output;
  }

  function digitsToChinese(value) {
    return [...value].map((digit) => DIGITS[Number(digit)]).join('');
  }

  function integerToChinese(value) {
    const raw = String(value).replace(/^\+/u, '');
    if (!/^\d+$/u.test(raw)) return raw;
    if (raw.length > 12 || (raw.length > 1 && raw.startsWith('0'))) {
      return digitsToChinese(raw);
    }

    const groups = [];
    for (let end = raw.length; end > 0; end -= 4) {
      groups.unshift(Number(raw.slice(Math.max(0, end - 4), end)));
    }

    let output = '';
    let pendingZero = false;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const largeUnit = LARGE_UNITS[groups.length - index - 1];
      if (group === 0) {
        if (output) pendingZero = true;
        continue;
      }
      if (output && (pendingZero || group < 1000)) output += '零';
      output += sectionToChinese(group) + largeUnit;
      pendingZero = false;
    }
    return (output || '零').replace(/^一十/u, '十');
  }

  function numberToChinese(value) {
    const [integer, fraction] = String(value).split('.');
    const integerText = integerToChinese(integer);
    return fraction === undefined ? integerText : `${integerText}点${digitsToChinese(fraction)}`;
  }

  function normalizeFullWidth(value) {
    return value
      .replace(/[０-９]/gu, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
      .replace(/％/gu, '%')
      .replace(/＋/gu, '+')
      .replace(/－/gu, '-')
      // so 14：30 reaches the time rules exactly like 14:30 — prose colons
      // that survive to normalizePunctuation become commas either way
      .replace(/：/gu, ':');
  }

  // The four shapes sherpa's zh rule tables (see matcha-fst.js) read wrong for a
  // Taiwan reader. Each rewrite keeps the digits wherever it can, so the tables
  // still do the actual reading and only the framing changes:
  //
  //   25.5%       → 百分之25.5      "%" is in neither the lexicon nor tokens.txt,
  //                                 so the tables' 二十五点五% drops the percent
  //                                 silently and the reader hears a bare number.
  //   14:30       → 14点30分        ":" IS a token (id 3) the model SPEAKS —
  //                                 a ~0.25 s vocal artifact, not a pause — so
  //                                 the tables' 十四:三十 comes out garbled.
  //   2026-08-07  → 2026年8月7日     date.fst only knows the 年月日 spelling; the
  //                                 dashed form falls through to number.fst and
  //                                 becomes 二千零二十六-零八-零七.
  //   0912345678  → 零九一二三四五六七八  phone.fst matches 11-digit mainland mobiles
  //                                 and 3-digit short codes only, so a TW number
  //                                 falls through to number.fst as one integer:
  //                                 零九亿一千二百三十四万五千六百七十八.
  //
  // Only the last one has to spend its digits here — no spelling of a number
  // makes number.fst read it one digit at a time — so it converts and then
  // passes through the tables untouched. A leading zero is the signal, and the
  // seven-digit floor is what keeps it off quantities: number.fst already reads
  // short leading-zero runs digit by digit (02 → 零二, 007 → 零零七) and only
  // switches to integer reading once there is a long tail left to group.
  function normalizeLocalForms(value) {
    return value
      .replace(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号號]?/gu,
        (_, year, month, day) => `${year}年${Number(month)}月${Number(day)}日`)
      // The dashed and slashed spellings folded onto the one date.fst knows.
      // Both separators have to be the same character: 4273-9/8 is not a date,
      // and reading it as one would be a worse answer than upstream's.
      .replace(/(^|\D)(\d{4})([-/])(\d{1,2})\3(\d{1,2})(?!\d)/gu,
        (_, before, year, __, month, day) => `${before}${year}年${Number(month)}月${Number(day)}日`)
      .replace(/(^|\D)(\d{1,2}):([0-5]\d)(?!\d)/gu,
        (_, before, hour, minute) => `${before}${hour}点${minute === '00' ? '' : `${minute}分`}`)
      // The "%" is consumed, not moved, so it must not be the only thing keeping
      // two numbers apart: 5213%4 would otherwise fuse into 52134.
      .replace(/(\d+(?:\.\d+)?)\s*%(?!\d)/gu, (_, number) => `百分之${number}`)
      // (02)2345-6789 — the parenthesised area code is standard here, and the
      // brackets would otherwise cut the run in two and leave the local part a
      // quantity. Everything else falls to the bare-run rule below.
      .replace(/\((0\d{1,3})\)\s*(\d[\d-]*\d)/gu, (whole, area, rest) => {
        const digits = (area + rest).replace(/-/gu, '');
        return digits.length >= 7 ? digitsToChinese(digits) : whole;
      })
      .replace(/(^|[^\d.\-])(0[\d-]*\d)/gu, (whole, before, run) => {
        const digits = run.replace(/-/gu, '');
        return digits.length >= 7 ? `${before}${digitsToChinese(digits)}` : whole;
      });
  }

  function normalizeNumbers(value) {
    return normalizeFullWidth(value)
      .replace(/(\d{4})\s*[年\-/]\s*(\d{1,2})\s*[月\-/]\s*(\d{1,2})\s*[日号]?/gu,
        (_, year, month, day) => `${digitsToChinese(year)}年${integerToChinese(month)}月${integerToChinese(day)}日`)
      .replace(/(\d{1,2}):(\d{2})/gu,
        (_, hour, minute) => `${integerToChinese(hour)}点${minute === '00' ? '' : `${integerToChinese(minute)}分`}`)
      .replace(/(\d+(?:\.\d+)?)\s*%/gu, (_, number) => `百分之${numberToChinese(number)}`)
      .replace(/(-?)(\d+\.\d+)/gu,
        (_, sign, number) => `${sign ? '负' : ''}${numberToChinese(number)}`)
      .replace(/(-?)(\d+)/gu,
        (_, sign, number) => `${sign ? '负' : ''}${integerToChinese(number)}`);
  }

  function normalizePunctuation(value) {
    let output = '';
    for (const character of value.normalize('NFKC')) {
      output += PUNCTUATION.get(character) ?? character;
    }
    return output
      .replace(/[\r\n]+/gu, '.')
      .replace(/\s+/gu, ' ')
      .replace(/\.{2,}/gu, '.')
      .trim();
  }

  function createFrontend({
    lexiconText,
    tokensText,
    convertTraditional = (text) => text,
    pronunciationOverrides = {},
    ruleNormalizer = (text) => text,
  }) {
    const {lexicon, maxKeyLength: sourceMaxKeyLength} = parseLexicon(lexiconText);
    const tokens = parseTokens(tokensText);
    let maxKeyLength = sourceMaxKeyLength;

    for (const [word, phones] of Object.entries(pronunciationOverrides)) {
      const list = Array.isArray(phones) ? phones : String(phones).trim().split(/\s+/u);
      lexicon.set(word, list);
      maxKeyLength = Math.max(maxKeyLength, word.length);
    }

    // Digits leave in three passes, most specific first. normalizeLocalForms
    // reframes what the rule tables misread; ruleNormalizer is the FST chain,
    // which is where every ordinary number is actually read; normalizeNumbers is
    // the JS fallback, a no-op once the tables have eaten the digits and the
    // whole reading when they are missing — a device that has the voice pack
    // but not the 212 KB of tables still speaks, just more plainly.
    function prepareText(text) {
      const source = normalizeFullWidth(convertTraditional(String(text)));
      return normalizePunctuation(normalizeNumbers(ruleNormalizer(normalizeLocalForms(source))));
    }

    function tokensFor(text, {allowUnknown = false} = {}) {
      const normalizedText = prepareText(text);
      const ids = [];
      const phones = [];
      const unknown = [];

      for (let offset = 0; offset < normalizedText.length;) {
        const character = normalizedText[offset];
        if (/\s/u.test(character)) {
          offset += 1;
          continue;
        }

        const punctuationId = tokens.get(character);
        if (PUNCTUATION.has(character) || '.,!?:;—…“”()"'.includes(character)) {
          if (Number.isFinite(punctuationId)) {
            ids.push(punctuationId);
            phones.push(character);
          }
          offset += 1;
          continue;
        }

        let match = null;
        const remaining = normalizedText.length - offset;
        for (let length = Math.min(maxKeyLength, remaining); length > 0; length -= 1) {
          const word = normalizedText.slice(offset, offset + length);
          const wordPhones = lexicon.get(word);
          if (wordPhones) {
            match = {word, phones: wordPhones};
            break;
          }
        }

        if (!match) {
          unknown.push({character, offset});
          offset += character.length;
          continue;
        }

        const missingPhones = match.phones.filter((phone) => !tokens.has(phone));
        if (missingPhones.length) {
          unknown.push({word: match.word, offset, missingPhones});
        } else {
          for (const phone of match.phones) {
            ids.push(tokens.get(phone));
            phones.push(phone);
          }
        }
        offset += match.word.length;
      }

      if (unknown.length && !allowUnknown) {
        const error = new Error(`Matcha 前端無法處理：${unknown.map((entry) => entry.word ?? entry.character).join('、')}`);
        error.unknown = unknown;
        throw error;
      }
      return {text: String(text), normalizedText, ids, phones, unknown};
    }

    return {prepareText, tokensFor, lexiconSize: lexicon.size, tokenCount: tokens.size};
  }

  const api = {
    createFrontend,
    integerToChinese,
    normalizeFullWidth,
    normalizeLocalForms,
    normalizeNumbers,
    normalizePunctuation,
    numberToChinese,
    parseLexicon,
    parseTokens,
  };
  globalScope.MatchaFrontend = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : self));
