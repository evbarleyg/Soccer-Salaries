import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrial, TRIAL } from '../src/world3d/trial.js';

test('tilt trial: everyone finishes with no steering input, states stay finite, events are sane', () => {
  const names = ['You', 'Ann', 'Bob', 'Cat', 'Dan', 'Eve'];
  const trial = createTrial({ names, playerIndex: 0, seed: 'abc' });
  assert.ok(trial.pads.length > 10 && trial.logs.length > 10);
  let steps = 0;
  const seen = new Set();
  while (!trial.done && steps < 60 * 90) {
    trial.step(1 / 60, 0);
    for (const e of trial.drain()) seen.add(e.type);
    for (const d of trial.ducks) {
      assert.ok(Number.isFinite(d.s) && Number.isFinite(d.lat) && Number.isFinite(d.v));
      assert.ok(Math.abs(d.lat) <= 40);
    }
    steps++;
  }
  assert.ok(trial.done, 'all ducks should finish within 90 s');
  const times = trial.race.finishTimes;
  assert.equal(trial.race.order.length, names.length);
  for (const t of times) assert.ok(t > 30 && t < 70, `finish time ${t}`);
  assert.ok(seen.has('finish') && seen.has('takeoff') && seen.has('splashdown'));
  assert.ok(TRIAL.v0 > 0);
});

test('tilt trial: steering moves the player laterally and hard steering into the bank bonks', () => {
  const trial = createTrial({ names: ['You', 'AI'], playerIndex: 0, seed: 5 });
  for (let k = 0; k < 120; k++) trial.step(1 / 60, 0);
  const lat0 = trial.ducks[0].lat;
  for (let k = 0; k < 60; k++) trial.step(1 / 60, 1);
  assert.ok(trial.ducks[0].lat > lat0 + 3, 'steer left should increase lat');
  let bonk = false;
  for (let k = 0; k < 400 && !bonk; k++) { trial.step(1 / 60, 1); for (const e of trial.drain()) if (e.type === 'stumble' && e.duck === 0 && e.what === 'bank') bonk = true; }
  assert.ok(bonk, 'holding full lock should eventually hit the bank');
});
