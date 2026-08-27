// Monte Carlo analysis of the race engine: drama metrics + fairness.
// usage: node tools/analyze.mjs [count=12] [races=2000] [duration=38]
import { createRace, simulateRace, TUNING } from '../src/sim.js';
if (process.env.TUNE) Object.assign(TUNING, JSON.parse(process.env.TUNE));
if (process.env.TUNE) console.log('TUNING', JSON.stringify(TUNING));

const count = Number(process.argv[2] || 12);
const races = Number(process.argv[3] || 2000);
const duration = Number(process.argv[4] || 38);
const curated = process.argv[5] !== 'raw';

const wins = new Array(count).fill(0);
const podiums = new Array(count).fill(0);
const lastPlace = new Array(count).fill(0);
let hotdogTotal = 0, hotdogRaces = 0;
let leadChanges = 0, photo = 0, marginSum = 0, winnerT = 0, lastGap = 0, top3 = 0, forced = 0, spreadMid = 0, spreadMax = 0;
const lcHist = {};
const t0 = performance.now();
for (let r = 0; r < races; r++) {
  const seed = (r * 2654435761 + 12345) >>> 0;
  const sim = curated ? createRace({ count, seed, duration }) : simulateRace({ count, seed, duration });
  wins[sim.order[0]]++;
  for (let p = 0; p < Math.min(3, count); p++) podiums[sim.order[p]]++;
  lastPlace[sim.order[count - 1]]++;
  leadChanges += sim.leadChanges;
  hotdogTotal += sim.hotdogs; if (sim.hotdogs) hotdogRaces++;
  lcHist[sim.leadChanges] = (lcHist[sim.leadChanges] || 0) + 1;
  if (sim.photoFinish) photo++;
  marginSum += sim.margin;
  const ft = sim.order.map((i) => sim.finishTimes[i]);
  winnerT += ft[0];
  lastGap += ft[count - 1] - ft[0];
  top3 += ft[Math.min(2, count - 1)] - ft[0];
  if (sim.events.some((e) => e.forced)) forced++;
  { // pack spread while leader between 20% and 90%
    let acc = 0, n = 0, mx = 0;
    for (let k = 0; k < sim.ticks; k += 6) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < count; i++) { const x = sim.pos[i][k]; if (x < lo) lo = x; if (x > hi) hi = x; }
      if (hi > 200 && hi < 900) { acc += (hi - lo); n++; if (hi - lo > mx) mx = hi - lo; }
    }
    spreadMid += n ? acc / n : 0; spreadMax += mx;
  }
}
const ms = performance.now() - t0;
const pct = (x) => (100 * x / races).toFixed(1) + '%';
console.log(`${races} races x ${count} ducks (${curated ? 'curated' : 'raw'}), ${(ms / races).toFixed(2)} ms/race`);
console.log('win% by lane   :', wins.map(pct).join(' '));
console.log('podium% by lane:', podiums.map(pct).join(' '));
console.log('last% by lane  :', lastPlace.map(pct).join(' '));
console.log('expected win%  :', (100 / count).toFixed(1) + '%');
console.log('avg lead changes:', (leadChanges / races).toFixed(2), 'hist:', JSON.stringify(lcHist));
console.log('photo finishes  :', pct(photo), ' avg margin 1-2:', (marginSum / races).toFixed(2) + 's');
console.log('avg winner time :', (winnerT / races).toFixed(1) + 's', ' avg top3 spread:', (top3 / races).toFixed(2) + 's', ' avg last gap:', (lastGap / races).toFixed(1) + 's');
console.log('hot dogs        : avg', (hotdogTotal / races).toFixed(2), ' races with ≥1:', pct(hotdogRaces));
console.log('forced finishes :', forced, ' avg pack spread (units of 1000):', (spreadMid / races).toFixed(0), ' avg max spread:', (spreadMax / races).toFixed(0));
// chi-square for wins
const exp = races / count;
const chi = wins.reduce((s, w) => s + (w - exp) ** 2 / exp, 0);
console.log('chi-square wins :', chi.toFixed(2), `(df=${count - 1}; 95% critical ≈ ${count === 12 ? 19.68 : count === 10 ? 16.92 : count === 8 ? 14.07 : 'n/a'})`);
