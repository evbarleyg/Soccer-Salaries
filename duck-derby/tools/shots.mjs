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
const [baseUrl = 'http://localhost:8080/duck-derby/', outDir = 'shots', seedCode = '7GQ-M2XD'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const issues = [];

async function session(name, viewport, names, steps) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => issues.push(`[${name}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') issues.push(`[${name}] console: ${m.text()}`); });
  const url = `${baseUrl}?names=${encodeURIComponent(names.join('~'))}&seed=${seedCode}&len=38&rule=w`;
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
  await page.waitForTimeout(2600); // intro + part of countdown
  await snap('2-countdown');
  await page.waitForTimeout(1500);
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
  await page.waitForTimeout(900);
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
await browser.close();
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'no console errors');
