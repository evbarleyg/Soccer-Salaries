// Drive the app through its phases and capture screenshots for review.
// usage: node tools/shots.mjs <baseUrl> <outDir> [seed] [--only=desktop12,fin390,…] [--settle=ms]
//   sessions: desktop12 mobile8 hotdog laptop10 land12 w320 two1280 rulel1440 rulel390 land16 fin1440 fin390 tiny
//             calm1440 longnames390 len55n16 fonts   (a full run takes ~5 min; --only re-shoots a subset)
//   --settle: how long to wait after a jump() before its screenshot (default 350 ms). The live-order board animates a
//             move for ~350 ms after whatever changed, so a capture taken sooner can catch a row mid-glide; 700 gives a
//             settled board at the cost of the race clock reading ~0.35 s later in those frames. The frames taken are
//             the same either way (same sessions, same jumps, same files).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const root = execSync('npm root -g').toString().trim();
    return createRequire(import.meta.url)(root + '/playwright');
  }
}
const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean)) : null;
const settleArg = argv.find((a) => a.startsWith('--settle='));
const SETTLE_MS = settleArg ? Math.max(0, Number.parseInt(settleArg.slice(9), 10) || 0) : 350;
const pos = argv.filter((a) => !a.startsWith('--'));
// NB: race codes are 7 Crockford chars whose first char is 0-3 (32-bit seed); anything
// else is rejected by the app and it would silently race a random seed instead.
const [baseUrl = 'http://localhost:8080/duck-derby/', outDir = 'shots', seedCode = '3GQ-M2XD'] = pos;
if (!/^[0-3][0-9A-HJKMNP-TV-Z]{2}-?[0-9A-HJKMNP-TV-Z]{4}$/i.test(seedCode)) {
  console.error(`seed code "${seedCode}" is not a canonical race code (e.g. 3GQ-M2XD)`);
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
console.log('seed', seedCode.toUpperCase(), only ? `(only: ${[...only].join(', ')})` : '', settleArg ? `(settle ${SETTLE_MS} ms)` : '');
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const issues = [];
const t00 = Date.now();

/**
 * @param {string} name session (file prefix; skipped unless in --only when that is given)
 * @param {{width:number,height:number}} viewport
 * @param {string[]} names roster
 * @param {(page, snap) => Promise<void>} steps
 * @param {{query?: string, reducedMotion?: boolean, hasTouch?: boolean}} [opts] extra URL params ('&rule=l&len=55'), media emulation
 */
async function session(name, viewport, names, steps, opts = {}) {
  if (only && !only.has(name)) return;
  const t0 = Date.now();
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: !!opts.hasTouch, reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => issues.push(`[${name}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') issues.push(`[${name}] console: ${m.text()}`); });
  // legacy `names=` form on purpose: exercises the share decoder's '~' fallback
  // fx=0 pins the top quality tier (headless boxes report few cores and would otherwise start on the low-fx path)
  const q = new URLSearchParams(`names=${encodeURIComponent(names.join('~'))}&seed=${seedCode}&len=38&rule=w&fx=0`);
  for (const [k, v] of new URLSearchParams(opts.query || '')) q.set(k, v); // per-session overrides (rule, len…)
  const url = `${baseUrl}?${q.toString()}`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  try {
    await steps(page, (file) => page.screenshot({ path: `${outDir}/${name}-${file}.png` }));
  } catch (e) {
    issues.push(`[${name}] script: ${e.message}`);
  }
  await ctx.close();
  console.log(`  ${name} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const twelve = ['Quack Sparrow', 'Duck Norris', 'Mallory', 'Sir Waddles', 'Bill Murray', 'Puddles', 'Feather Locklear', 'Drake', 'Waddle Dee', 'Eggatha', 'Beak Man', 'Ponderosa'];
const eight = twelve.slice(0, 8);
const sixteen = [...twelve, 'Gregg Eggleston', 'Honk Williams', 'Mother Clucker', 'Pond Scum'];
const longNames = ['W'.repeat(22), 'M'.repeat(22), '🦆🔥👑🎯🌭💨 Emoji United'];

// --- helpers shared by the sessions ---
const startRace = async (page) => {
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__duckDerby.state.phase === 'race', null, { timeout: 15000 });
};
const winTime = (page) => page.evaluate(() => Math.min(...window.__duckDerby.state.sim.finishTimes));
/** Put the race clock at `t`, then give the page `settle` ms (default --settle, else 350) before the caller shoots. */
const jump = async (page, t, settle = SETTLE_MS) => {
  await page.evaluate((tt) => window.__duckDerby.jump(tt), t);
  await page.waitForTimeout(settle);
};
const toResults = async (page, snap, file = '7-results') => {
  await page.evaluate(() => window.__duckDerby.skipToResults());
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelector('#btn-reveal-all')?.click()); // completes the ceremony instantly
  await page.waitForTimeout(500);
  if (file) await snap(file);
};
/** Frames around the winner's touch: jump to 1.2 s out, wait for the scene's win beat, then shoot at the given offsets (s). */
const finishSequence = async (page, snap, offsets) => {
  const w = await winTime(page);
  await page.evaluate((t) => window.__duckDerby.jump(t), w - 1.2);
  await page.waitForFunction(() => { const s = window.__duckDerby.state; return s.winnerAt !== null || s.t > Math.min(...s.sim.finishTimes) - 0.2; }, null, { timeout: 20000, polling: 16 });
  let at = -0.2;
  let k = 1;
  for (const off of offsets) {
    const race = await page.evaluate(() => { const s = window.__duckDerby.state; return { t: s.t, w: Math.min(...s.sim.finishTimes), rate: s.rate }; });
    void race;
    if (off > at) await page.waitForTimeout(Math.round((off - at) * 1000));
    at = off;
    await snap(`f${k++}`);
  }
};

const flow = async (page, snap) => {
  await snap('1-setup');
  await page.click('#btn-start');
  // intro (2.2 s, sim is built meanwhile) then countdown: snap when the "2" has popped in
  await page.waitForFunction(() => document.querySelector('#callout .big')?.textContent === '2', null, { timeout: 8000 });
  await page.waitForTimeout(250);
  await snap('2-countdown');
  await page.waitForTimeout(750);
  await jump(page, 7);
  await snap('3-early');
  await jump(page, 21);
  await snap('4-mid');
  const winT = await winTime(page);
  await page.evaluate((t) => window.__duckDerby.jump(t - 1.2), winT);
  await page.waitForTimeout(500);
  await snap('5-stretch');
  await page.waitForTimeout(1600);
  await snap('6-line');
  await page.evaluate(() => window.__duckDerby.skipToResults());
  await page.waitForTimeout(3100);
  await snap('7a-ceremony'); // mid-reveal: gold plinth up on the fanfare hit, board rows landing from the last pick
  await page.evaluate(() => document.querySelector('#btn-reveal-all')?.click()); // completes the ceremony instantly
  await page.waitForTimeout(500);
  await snap('7-results');
};

await session('desktop12', { width: 1440, height: 900 }, twelve, flow);
await session('mobile8', { width: 390, height: 844 }, eight, flow);
await session('hotdog', { width: 1440, height: 900 }, twelve, async (page, snap) => {
  await page.click('#btn-start');
  await page.waitForTimeout(4300);
  const hd = await page.evaluate(() => { const e = window.__duckDerby.state.sim.events.find((x) => x.type === 'hotdog'); return e ? e.t : null; });
  if (hd === null) { console.log('no hotdog in this seed'); return; }
  console.log('hotdog at', hd.toFixed(2));
  await page.evaluate((t) => window.__duckDerby.jump(t), hd - 0.75);
  await page.waitForTimeout(450);
  await snap('1-flight');
  await page.waitForTimeout(420);
  await snap('2-impact');
  await page.waitForTimeout(450);
  await snap('3-spin');
  await page.waitForTimeout(700);
  await snap('4-after');
  const th = await page.evaluate(() => { const s = window.__duckDerby.state; const i = s.sim.events.findIndex((x) => x.type === 'hotdog'); const c = s.culprits.get(i); return { culprit: c === undefined ? null : s.raceNames[c], line: s.transcript.filter((l) => l.kind === 'hotdog').map((l) => l.text) }; });
  console.log('hotdog culprit', th.culprit, '|', th.line.join(' / '));
});
await session('laptop10', { width: 1280, height: 720 }, twelve.slice(0, 10), async (page, snap) => {
  await page.click('#btn-start');
  await page.waitForTimeout(4300);
  await jump(page, 30, Math.max(300, SETTLE_MS - 50));
  await snap('4-mid');
});
// landscape phone: compact strip HUD, two-column setup/results
await session('land12', { width: 844, height: 390 }, twelve, async (page, snap) => {
  await snap('1-setup');
  await page.click('#btn-start');
  await page.waitForTimeout(4300);
  await jump(page, 21);
  await snap('4-mid');
  await toResults(page, snap);
});
// very narrow phone
await session('w320', { width: 320, height: 568 }, eight, async (page, snap) => {
  await page.click('#btn-start');
  await page.waitForTimeout(4300);
  await jump(page, 21);
  await snap('4-mid');
});
// two ducks on a laptop: compact lanes + near bank, content-height results with a centred two-plinth podium
await session('two1280', { width: 1280, height: 720 }, twelve.slice(0, 2), async (page, snap) => {
  await startRace(page);
  await jump(page, 14);
  await snap('4-mid');
  const w = await winTime(page);
  await page.evaluate((t) => window.__duckDerby.jump(t), w - 1.2);
  await page.waitForTimeout(2100);
  await snap('6-line');
  await page.waitForTimeout(1200);
  await snap('6b-after');
  await toResults(page, snap);
});
// last place picks first: the back of the field is the story (tail camera, hero card, demoted podium)
const ruleL = async (page, snap) => {
  await startRace(page);
  await jump(page, 21);
  await snap('4-mid');
  const fts = await page.evaluate(() => [...window.__duckDerby.state.sim.finishTimes].sort((a, b) => a - b));
  await page.evaluate((t) => window.__duckDerby.jump(t), fts[fts.length - 2] - 1);
  await page.waitForTimeout(900);
  await snap('6-tail');
  await toResults(page, snap);
};
await session('rulel1440', { width: 1440, height: 900 }, twelve, ruleL, { query: '&rule=l' });
await session('rulel390', { width: 390, height: 844 }, twelve, ruleL, { query: '&rule=l' });
// sixteen on a landscape phone: the densest layout there is
await session('land16', { width: 844, height: 390 }, sixteen, async (page, snap) => {
  await page.click('#btn-start');
  await page.waitForFunction(() => document.querySelector('#callout .big')?.textContent === '2', null, { timeout: 8000 });
  await page.waitForTimeout(250);
  await snap('2-countdown');
  await page.waitForFunction(() => window.__duckDerby.state.phase === 'race', null, { timeout: 15000 });
  await jump(page, 21);
  await snap('4-mid');
  const w = await winTime(page);
  await page.evaluate((t) => window.__duckDerby.jump(t), w - 1.2);
  await page.waitForTimeout(2100);
  await snap('6-line');
  await toResults(page, snap);
});
// the finish, frame by frame: win -0.2, +0.15, +0.45, +0.9, +1.5 s (page clock; slow-mo stretches race time)
const fin = async (page, snap) => {
  await startRace(page);
  await finishSequence(page, snap, [-0.2, 0.15, 0.45, 0.9, 1.5]);
};
await session('fin1440', { width: 1440, height: 900 }, twelve, fin);
await session('fin390', { width: 390, height: 844 }, eight, fin);
// smallest supported screen
await session('tiny', { width: 320, height: 480 }, eight, async (page, snap) => {
  await snap('1-setup');
  await startRace(page);
  await toResults(page, snap);
});
// reduced motion: no zooms, stills or confetti; the results land in their final state
await session('calm1440', { width: 1440, height: 900 }, twelve, async (page, snap) => {
  await startRace(page);
  await jump(page, 21);
  await snap('4-mid');
  await toResults(page, snap);
}, { reducedMotion: true });
// the longest names the sanitizer allows, plus emoji: pills, chips and the win ribbon must hold them
await session('longnames390', { width: 390, height: 844 }, longNames, async (page, snap) => {
  await startRace(page);
  const w = await winTime(page);
  await page.evaluate((t) => window.__duckDerby.jump(t), w - 1.2);
  await page.waitForTimeout(2100);
  await snap('6-win');
  await toResults(page, snap);
});
// the qa3 "PHOTO FINISH then won by 0.55s" case: 16 ducks over the epic distance — transcript to disk, no PHOTO line allowed
await session('len55n16', { width: 1440, height: 900 }, sixteen, async (page, snap) => {
  await startRace(page);
  const w = await winTime(page);
  await page.evaluate((t) => window.__duckDerby.jump(t), w - 6); // the run-in plays out live from 6 s before the touch
  await page.waitForFunction(() => window.__duckDerby.state.winnerAt !== null, null, { timeout: 30000, polling: 100 });
  await page.waitForTimeout(600);
  await snap('6-win');
  const r = await page.evaluate(() => { const s = window.__duckDerby.state; return { margin: s.sim.margin, photo: s.sim.photoFinish, runIn: s.runIn, photoCalled: s.photoCalled, transcript: s.transcript }; });
  writeFileSync(`${outDir}/transcript-len55n16.json`, JSON.stringify(r, null, 2));
  const photoLine = r.transcript.some((l) => /PHOTO FINISH/.test(l.text));
  console.log(`len55n16: margin ${r.margin.toFixed(2)} s, run-in "${r.runIn}", PHOTO line: ${photoLine}`);
  if (r.margin >= 0.35 && (photoLine || r.photoCalled)) console.log('WARNING: PHOTO FINISH called on a race won by ' + r.margin.toFixed(2) + ' s');
}, { query: '&len=55' });
// self-hosted typefaces: no third-party request, and the faces really load
await session('fonts', { width: 1280, height: 720 }, eight, async (page) => {
  const third = [];
  page.on('request', (r) => { if (!r.url().startsWith(new URL(baseUrl).origin)) third.push(r.url()); });
  await page.reload({ waitUntil: 'networkidle' });
  const ok = await page.evaluate(async () => { await document.fonts.ready; await document.fonts.load('20px Bungee'); await document.fonts.load('800 14px Nunito'); return document.fonts.check('20px Bungee') && document.fonts.check('800 14px Nunito'); });
  console.log(`fonts: Bungee + Nunito loaded: ${ok}; third-party requests: ${third.length ? third.join(', ') : 'none'}`);
  if (!ok) issues.push('[fonts] document.fonts.check failed for Bungee/Nunito');
});
await browser.close();
console.log(`done in ${((Date.now() - t00) / 1000).toFixed(0)}s`);
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'no console errors');
