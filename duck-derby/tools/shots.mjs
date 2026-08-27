// Drive the app through its phases and capture screenshots for review.
// usage: node tools/shots.mjs <baseUrl> <outDir> [seed]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const root = execSync('npm root -g').toString().trim();
    return createRequire(import.meta.url)(root + '/playwright');
  }
}
// NB: race codes are 7 Crockford chars whose first char is 0-3 (32-bit seed); anything
// else is rejected by the app and it would silently race a random seed instead.
const [baseUrl = 'http://localhost:8080/duck-derby/', outDir = 'shots', seedCode = '3GQ-M2XD'] = process.argv.slice(2);
if (!/^[0-3][0-9A-HJKMNP-TV-Z]{2}-?[0-9A-HJKMNP-TV-Z]{4}$/i.test(seedCode)) {
  console.error(`seed code "${seedCode}" is not a canonical race code (e.g. 3GQ-M2XD)`);
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
console.log('seed', seedCode.toUpperCase());
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const issues = [];

async function session(name, viewport, names, steps) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => issues.push(`[${name}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') issues.push(`[${name}] console: ${m.text()}`); });
  // legacy `names=` form on purpose: exercises the share decoder's '~' fallback
  // fx=0 pins the top quality tier (headless boxes report few cores and would otherwise start on the low-fx path)
  const url = `${baseUrl}?names=${encodeURIComponent(names.join('~'))}&seed=${seedCode}&len=38&rule=w&fx=0`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await steps(page, (file) => page.screenshot({ path: `${outDir}/${name}-${file}.png` }));
  await ctx.close();
}

const twelve = ['Quack Sparrow', 'Duck Norris', 'Mallory', 'Sir Waddles', 'Bill Murray', 'Puddles', 'Feather Locklear', 'Drake', 'Waddle Dee', 'Eggatha', 'Beak Man', 'Ponderosa'];
const eight = twelve.slice(0, 8);

const flow = async (page, snap) => {
  await snap('1-setup');
  await page.click('#btn-start');
  // intro (2.2 s, sim is built meanwhile) then countdown: snap when the "2" has popped in
  await page.waitForFunction(() => document.querySelector('#callout .big')?.textContent === '2', null, { timeout: 8000 });
  await page.waitForTimeout(250);
  await snap('2-countdown');
  await page.waitForTimeout(750);
  await page.evaluate(() => window.__duckDerby.jump(7));
  await page.waitForTimeout(350);
  await snap('3-early');
  await page.evaluate(() => window.__duckDerby.jump(21));
  await page.waitForTimeout(350);
  await snap('4-mid');
  const winT = await page.evaluate(() => Math.min(...window.__duckDerby.state.sim.finishTimes));
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
});
await session('laptop10', { width: 1280, height: 720 }, twelve.slice(0, 10), async (page, snap) => {
  await page.click('#btn-start');
  await page.waitForTimeout(4300);
  await page.evaluate(() => window.__duckDerby.jump(30));
  await page.waitForTimeout(300);
  await snap('4-mid');
});
// landscape phone: compact strip HUD, two-column setup/results
await session('land12', { width: 844, height: 390 }, twelve, async (page, snap) => {
  await snap('1-setup');
  await page.click('#btn-start');
  await page.waitForTimeout(4300);
  await page.evaluate(() => window.__duckDerby.jump(21));
  await page.waitForTimeout(350);
  await snap('4-mid');
  await page.evaluate(() => window.__duckDerby.skipToResults());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('#btn-reveal-all')?.click());
  await page.waitForTimeout(500);
  await snap('7-results');
});
// very narrow phone
await session('w320', { width: 320, height: 568 }, eight, async (page, snap) => {
  await page.click('#btn-start');
  await page.waitForTimeout(4300);
  await page.evaluate(() => window.__duckDerby.jump(21));
  await page.waitForTimeout(350);
  await snap('4-mid');
});
await browser.close();
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'no console errors');
