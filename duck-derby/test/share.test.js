import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeShare, decodeShare, sanitizeName } from '../src/share.js';

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
