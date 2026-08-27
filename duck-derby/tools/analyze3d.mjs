// Monte Carlo report for the 3D race engine: fairness, drama and item stats.
// usage: node tools/analyze3d.mjs [count=12] [races=300]
import { createRace } from '../src/world3d/race.js';
import { ITEM_ORDER } from '../src/world3d/items.js';

const [count = 12, races = 300] = process.argv.slice(2).map(Number);
const wins = new Array(count).fill(0);
const last = new Array(count).fill(0);
const items = Object.fromEntries(ITEM_ORDER.map((i) => [i, 0]));
let hits = 0, front = 0, blocked = 0, leads = 0, photo = 0, hotdogs = 0, winT = 0, lastGap = 0, lateHits = 0, margin = 0;
const t0 = Date.now();
for (let r = 0; r < races; r++) {
  const sim = createRace({ count, seed: (r * 2654435761 + 17) >>> 0 });
  wins[sim.order[0]]++;
  last[sim.order[count - 1]]++;
  for (const e of sim.events) {
    if (e.type === 'pickup') items[e.item]++;
    if (e.type === 'hit') { hits++; if (e.rank <= 2) front++; if (e.t > sim.finishTimes[sim.order[0]] * 0.9) lateHits++; }
    if (e.type === 'blocked') blocked++;
  }
  leads += sim.leadChanges;
  photo += sim.photoFinish ? 1 : 0;
  hotdogs += sim.hotdogs;
  winT += sim.finishTimes[sim.order[0]];
  lastGap += sim.finishTimes[sim.order[count - 1]] - sim.finishTimes[sim.order[0]];
  margin += sim.margin;
}
const exp = races / count;
const chi = (arr) => arr.reduce((s, w) => s + (w - exp) ** 2 / exp, 0);
const per = (x) => (x / races).toFixed(2);
console.log(`${races} races × ${count} ducks in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`wins by lane : ${wins.join(' ')}  chi²=${chi(wins).toFixed(1)} (df=${count - 1})`);
console.log(`lasts by lane: ${last.join(' ')}  chi²=${chi(last).toFixed(1)}`);
console.log(`per race: winner ${per(winT)} s, last +${per(lastGap)} s, margin ${per(margin)} s, photo finishes ${(100 * photo / races).toFixed(0)}%, lead changes ${per(leads)}, hot dogs ${per(hotdogs)}`);
console.log(`items per race: hits ${per(hits)} (front-3 ${per(front)}, last-10% ${per(lateHits)}), blocked ${per(blocked)}`);
console.log('pickups per race: ' + ITEM_ORDER.map((i) => `${i} ${per(items[i])}`).join(', '));
