import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeShare, decodeShare, sanitizeName, truncateCodePoints, shortenedCount, NAME_MAX } from '../src/share.js';
import { assignLooks } from '../src/ducks.js';

const NAMES = ['A~B', '  spaced   out ', '🦆🔥 Big Quack Energy', 'مرحبا بالعالم', 'a&b=c?d#e%+', 'x'.repeat(40)];
const CLEAN = ['A~B', 'spaced out', '🦆🔥 Big Quack Energy', 'مرحبا بالعالم', 'a&b=c?d#e%+', 'x'.repeat(22)];

test('share links round-trip awkward names and every option', () => {
  for (const seed of [0, 4294967295]) {
    const race = { names: NAMES, seed, duration: 55, rule: 'last-first', salt: 7, hazards: false, league: 'Sunday Scaries — 2026' };
    const back = decodeShare('?' + encodeShare(race));
    assert.deepEqual(back, { ...race, names: CLEAN });
    // also without the leading '?', and via a full URL's search part
    assert.deepEqual(decodeShare(encodeShare(race)), { ...race, names: CLEAN });
  }
});

test('defaults: winner-first, hazards on, salt 0, no league', () => {
  const back = decodeShare('?' + encodeShare({ names: ['Tom ~ the GOAT', 'B'], seed: 12345, duration: 38, rule: 'winner-first', salt: 0, hazards: true, league: '' }));
  assert.deepEqual(back, { names: ['Tom ~ the GOAT', 'B'], seed: 12345, duration: 38, rule: 'winner-first', salt: 0, hazards: true, league: '' });
  const qs = encodeShare({ names: ['A', 'B'], seed: 1, duration: 38, rule: 'winner-choice' });
  assert.ok(!qs.includes('salt=') && !qs.includes('hz=') && !qs.includes('lg='), qs);
  assert.equal(decodeShare(qs).rule, 'winner-choice');
  assert.equal(decodeShare('?n=A&n=B&len=99&rule=zzz&salt=abc').duration, 38);
  assert.equal(decodeShare('?n=A&n=B&len=99&rule=zzz&salt=abc').salt, 0);
  assert.equal(decodeShare('?n=A&n=B').seed, null);
});

test('legacy ~-joined links still decode', () => {
  const back = decodeShare('?names=A~B~C&seed=3GQ-M2XD&len=38&rule=w');
  assert.deepEqual(back.names, ['A', 'B', 'C']);
  assert.equal(back.seed, 3782871981);
  assert.equal(back.duration, 38);
  assert.equal(back.rule, 'winner-first');
  // `n` wins over legacy `names`
  assert.deepEqual(decodeShare('?n=X&n=Y&names=A~B~C').names, ['X', 'Y']);
});

test('not a share link / out-of-range rosters => null', () => {
  assert.equal(decodeShare('?n=Solo'), null);
  assert.equal(decodeShare(''), null);
  assert.equal(decodeShare('?seed=3GQ-M2XD'), null);
  assert.equal(decodeShare('?' + new Array(17).fill('n=a').join('&')), null);
  assert.equal(decodeShare('?' + new Array(16).fill('n=a').join('&')).names.length, 16);
});

test('sanitizeName truncates by code point and collapses whitespace', () => {
  assert.equal(sanitizeName('  a \t b  '), 'a b');
  assert.equal(sanitizeName('🦆'.repeat(30)), '🦆'.repeat(22));
  assert.equal(sanitizeName(null), '');
  assert.equal(sanitizeName(42), '42');
});

// --- the one name-length rule: grapheme-safe truncation, identical on both ends of a link ---
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'; // 👨‍👩‍👧‍👦 = 7 code points, 1 cluster
const FLAG = '\u{1F1FA}\u{1F1F8}'; // 🇺🇸
const RI = /[\u{1F1E6}-\u{1F1FF}]/gu;

/** Run fn once with Intl.Segmenter available and once with it shadowed (old WebViews fall back to code points). */
function bothModes(fn) {
  fn('segmenter');
  const S = Intl.Segmenter;
  Intl.Segmenter = undefined;
  try {
    fn('fallback');
  } finally {
    Intl.Segmenter = S;
  }
}

test('truncation never splits a ZWJ family: whole families only, in both modes', () => {
  bothModes((mode) => {
    const out = truncateCodePoints(FAMILY.repeat(4), NAME_MAX);
    const families = out.split(FAMILY).length - 1;
    assert.equal(out, FAMILY.repeat(families), `${mode}: only whole families remain`);
    assert.ok(families >= 3, `${mode}: keeps at least three families`);
    assert.ok(!out.endsWith('\u200D'), `${mode}: no trailing ZWJ`);
    assert.equal((out.match(/\u{1F468}/gu) || []).length, families, `${mode}: no dangling U+1F468`);
    // typing 15 families keeps whole families only
    const typed = sanitizeName(FAMILY.repeat(15));
    assert.equal(typed, FAMILY.repeat(typed.split(FAMILY).length - 1), `${mode}: 15 families -> whole families`);
  });
});

test('flags keep an even number of regional indicators in both modes', () => {
  bothModes((mode) => {
    const out = sanitizeName(FLAG.repeat(15));
    const ris = (out.match(RI) || []).length;
    assert.ok(ris > 0 && ris % 2 === 0, `${mode}: ${ris} regional indicators`);
    assert.equal(out, FLAG.repeat(ris / 2));
  });
});

test('a cut never lands in front of a skin-tone modifier or variation selector', () => {
  bothModes((mode) => {
    const thumbs = 'a'.repeat(21) + '\u{1F44D}\u{1F3FD}'; // 21 + 👍🏽 (2 code points)
    const out = sanitizeName(thumbs);
    assert.ok(out === thumbs || out === 'a'.repeat(21), `${mode}: ${JSON.stringify(out)}`);
    const heart = 'b'.repeat(21) + '\u2764\uFE0F';
    const out2 = sanitizeName(heart);
    assert.ok(out2 === heart || out2 === 'b'.repeat(21), `${mode}: ${JSON.stringify(out2)}`);
  });
});

test('sanitizeName is idempotent (incl. a cut that exposes trailing whitespace)', () => {
  bothModes((mode) => {
    for (const raw of ['x'.repeat(21) + ' y', '  a  b  ', FAMILY.repeat(9), FLAG.repeat(13) + ' tail', '🦆'.repeat(30), 'e\u0301'.repeat(30), 'plain']) {
      const once = sanitizeName(raw);
      assert.equal(sanitizeName(once), once, `${mode}: ${JSON.stringify(raw)}`);
      assert.ok(!/^\s|\s$/.test(once), `${mode}: trimmed`);
    }
  });
});

test('16 emoji names survive encode -> decode unchanged, and both ends hash identical looks', () => {
  const names = [FAMILY.repeat(2) + ' fam', FLAG.repeat(3), '🦆🔥 Big Quack Energy', '👍🏽 crew', 'Zoë', 'नमस्ते', '한국어 이름', 'e\u0301mile', '🏴‍☠️ pirates', '❤️‍🔥', 'a'.repeat(30), FAMILY.repeat(5), 'x', 'Mike', 'mike', '  spaced   out  '];
  const race = { names, seed: 7, duration: 38, rule: 'winner-first', salt: 0, hazards: true, league: '' };
  const once = decodeShare('?' + encodeShare(race));
  const twice = decodeShare('?' + encodeShare({ ...race, names: once.names }));
  assert.deepEqual(twice.names, once.names);
  assert.deepEqual(once.names, names.map(sanitizeName));
  const strip = (looks) => looks.map((l) => [l.name, l.palette.id, l.hat, l.towel.bg]);
  assert.deepEqual(strip(assignLooks(names.map(sanitizeName), 3)), strip(assignLooks(once.names, 3)));
});

test('shortenedCount counts only real cuts, not trimming', () => {
  assert.equal(shortenedCount(['a'.repeat(30), '  b  ', 'c c', 'x'.repeat(22), 'y'.repeat(23)]), 2);
  assert.equal(shortenedCount([]), 0);
  assert.equal(shortenedCount(null), 0);
});
