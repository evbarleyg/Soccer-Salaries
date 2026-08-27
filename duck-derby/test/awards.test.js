import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRace, standingsAt } from '../src/sim.js';
import { raceAwards, hotdogCulprits, hotdogLines } from '../src/awards.js';

const N16 = ['Quack Sparrow', 'Duck Norris', 'Mallory', 'Sir Waddles', 'Bill Murray', 'Puddles', 'Feather Locklear', 'Drake', 'Waddle Dee', 'Eggatha', 'Beak Man', 'Ponderosa', 'Gregg Eggleston', 'Honk Williams', 'Mother Clucker', 'Pond Scum'];
const RULES = ['winner-first', 'winner-choice', 'last-first'];
const QA_SEED = 3782871981; // 3GQ-M2XD

const plain = (A) => ({ headline: A.headline, byDuck: [...A.byDuck].map(([d, aw]) => [d, aw.map((a) => ({ ...a }))]), culprits: [...A.culprits] });

test('same (names, seed) twice => identical awards, headline and culprits', () => {
  for (const n of [2, 12, 16]) {
    const names = N16.slice(0, n);
    const a = raceAwards(createRace({ count: n, seed: QA_SEED, duration: 38 }), names, 'winner-first');
    const b = raceAwards(createRace({ count: n, seed: QA_SEED, duration: 38 }), names, 'winner-first');
    assert.deepEqual(plain(a), plain(b));
    assert.ok(a.headline.length > 10 && a.headline.length <= 140, a.headline);
  }
});

test('sane output for tiny and huge fields across seeds, rules and distances', () => {
  for (let seed = 1; seed <= 30; seed++) {
    for (const rule of RULES) {
      const duration = [24, 38, 55][seed % 3];
      for (const n of [2, 16]) {
        const sim = createRace({ count: n, seed, duration, hazards: seed % 5 !== 0 });
        const names = N16.slice(0, n);
        const A = raceAwards(sim, names, rule);
        assert.equal(typeof A.headline, 'string');
        assert.ok(A.headline.length <= 140, `${seed}/${n}/${rule}: ${A.headline.length} chars`);
        assert.ok(A.headline.includes(names[sim.order[0]]), 'headline names the winner');
        let total = 0;
        for (const [duck, awards] of A.byDuck) {
          assert.ok(Number.isInteger(duck) && duck >= 0 && duck < n, `duck index ${duck}`);
          assert.ok(awards.length >= 1 && awards.length <= 2, 'at most two awards per duck');
          for (const a of awards) {
            for (const k of ['id', 'icon', 'label', 'short', 'detail']) assert.equal(typeof a[k], 'string', `${a.id}.${k}`);
            assert.ok(a.label.length <= 48 && a.short.length <= 30, `${a.id}: "${a.label}" / "${a.short}"`);
            assert.ok(!/NaN|undefined|Infinity/.test(a.label + a.detail + a.short + A.headline), `${a.id}: ${a.label} / ${a.detail}`);
          }
          total += awards.length;
          const ids = awards.map((a) => a.id);
          assert.equal(new Set(ids).size, ids.length, 'no duplicate award on one duck');
          if (n < 4) assert.ok(!ids.some((id) => ['COMEBACK', 'COLLAPSE', 'YOYO'].includes(id)), 'no rank-swing awards in tiny fields');
          if (rule !== 'last-first') assert.ok(!ids.some((id) => ['MASTER_TANKER', 'TRIED_TOO_HARD'].includes(id)));
        }
        if (n === 16) assert.ok(total >= 6, `a big field earns at least six tags (${total})`);
        // single-holder superlatives are unique
        for (const id of ['TOP_SPEED', 'LED_MOST', 'ROBBED', 'COMEBACK', 'COLLAPSE', 'ROCKET_START', 'SLEPT_IN', 'WIRE_TO_WIRE', 'DAYLIGHT']) {
          const holders = [...A.byDuck].filter(([, aw]) => aw.some((a) => a.id === id));
          assert.ok(holders.length <= 1, `${id} held by ${holders.length}`);
        }
      }
    }
  }
});

test('the qa3 board (3GQ-M2XD / 12 / winner-first) has a story to tell', () => {
  const sim = createRace({ count: 12, seed: QA_SEED, duration: 38 });
  const A = raceAwards(sim, N16.slice(0, 12), 'winner-first');
  const tags = [...A.byDuck.values()].reduce((s, aw) => s + aw.length, 0);
  assert.ok(tags >= 6, `tags ${tags}`);
  assert.ok(/wins|beats|steals/.test(A.headline), A.headline);
  assert.ok(A.headline.includes('Wooden spoon'), A.headline);
});

test('toilet-bowl extras appear exactly when their conditions hold', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const sim = createRace({ count: 10, seed, duration: 38 });
    const names = N16.slice(0, 10);
    const A = raceAwards(sim, names, 'last-first');
    const all = [...A.byDuck].flatMap(([d, aw]) => aw.map((a) => ({ d, ...a })));
    // MASTER_TANKER: the slowest top speed among the bottom three finishers (may lose out only to the 2-per-duck cap)
    const bottom = sim.order.slice(-3);
    const tanker = bottom.reduce((bi, d) => (sim.stats[d].maxSpeed < sim.stats[bi].maxSpeed ? d : bi), bottom[0]);
    const mt = all.find((a) => a.id === 'MASTER_TANKER');
    if (mt) assert.equal(mt.d, tanker);
    else assert.equal(A.byDuck.get(tanker)?.length, 2, `seed ${seed}: tanker skipped only when full`);
    const tth = all.find((a) => a.id === 'TRIED_TOO_HARD');
    if (tth) assert.equal(tth.d, sim.order[0]);
    else assert.equal(A.byDuck.get(sim.order[0])?.length, 2);
    assert.ok(A.headline.includes('First pick'), A.headline);
  }
});

test('hotdogCulprits: stable per seed, never the victim, valid for every field size', () => {
  let withDogs = 0;
  for (let n = 2; n <= 16; n++) {
    for (let seed = 1; seed <= 6; seed++) {
      const sim = createRace({ count: n, seed, duration: 38, hazards: true });
      const a = hotdogCulprits(sim, n);
      const b = hotdogCulprits(sim, n);
      assert.deepEqual([...a], [...b]);
      const dogs = sim.events.map((e, i) => [e, i]).filter(([e]) => e.type === 'hotdog');
      assert.equal(a.size, dogs.length);
      for (const [ev, idx] of dogs) {
        const c = a.get(idx);
        assert.ok(Number.isInteger(c) && c >= 0 && c < n, `culprit ${c}`);
        assert.notEqual(c, ev.duck, 'never the victim');
        if (n === 2) assert.equal(c, 1 - ev.duck, 'two ducks: the other one did it');
        withDogs++;
      }
      if (seed <= 2) {
        // no hazards: no culprits, no lines
        const clean = createRace({ count: n, seed, duration: 38, hazards: false });
        assert.equal(hotdogCulprits(clean, n).size, 0);
        assert.deepEqual(hotdogLines(clean, N16.slice(0, n)), []);
      }
    }
  }
  assert.ok(withDogs > 15, `hot dogs seen: ${withDogs}`);
  // the export line names culprit, victim, running position and time
  const sim = createRace({ count: 12, seed: QA_SEED, duration: 38 });
  const lines = hotdogLines(sim, N16.slice(0, 12));
  assert.ok(lines.length >= 1);
  for (const l of lines) assert.match(l, /^Hot dog: from the .+ section, hit .+ \(\d+(st|nd|rd|th)\) at \d+\.\d s$/);
  const ev = sim.events.find((e) => e.type === 'hotdog');
  const rank = standingsAt(sim, ev.t).findIndex((r) => r.i === ev.duck) + 1;
  assert.ok(lines[0].includes(`hit ${N16[ev.duck]} (${rank}`), lines[0]);
});

test('SNIPER goes to the culprit and names the victim', () => {
  const sim = createRace({ count: 12, seed: QA_SEED, duration: 38 });
  const names = N16.slice(0, 12);
  const A = raceAwards(sim, names, 'winner-first');
  const [[idx, culprit]] = [...A.culprits];
  const victim = sim.events[idx].duck;
  const sn = (A.byDuck.get(culprit) || []).find((a) => a.id === 'SNIPER');
  assert.ok(sn, 'culprit holds SNIPER');
  assert.ok(sn.label.includes(names[victim]), sn.label);
  const hv = (A.byDuck.get(victim) || []).find((a) => a.id === 'HOTDOG_VICTIM');
  assert.ok(hv, 'victim holds HOTDOG_VICTIM');
});

test('awards.js is pure: imports nothing but sim.js and rng.js', () => {
  const src = readFileSync(new URL('../src/awards.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./rng.js', './sim.js']);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // comments may *mention* Math.random
  assert.ok(!/Math\.random|Date\.now|new Date|performance\.|document\.|window\./.test(code), 'no playback / wall-clock / DOM inputs');
});
