// Drive Duck Derby World through its phases/sections and capture screenshots.
// usage: node tools/shots3d.mjs [baseUrl] [outDir] [seed] [only]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const root = execSync('npm root -g').toString().trim();
    return createRequire(import.meta.url)(root + '/playwright');
  }
}
const [baseUrl = 'http://localhost:8080/duck-derby/world.html', outDir = 'shots/world', seedCode = '7GQ-M2XD', only = ''] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const issues = [];
const twelve = ['Quack Sparrow', 'Duck Norris', 'Mallory', 'Sir Waddles', 'Bill Murray', 'Puddles', 'Feather Locklear', 'Drake', 'Waddle Dee', 'Eggatha', 'Beak Man', 'Ponderosa'];

async function session(name, viewport, names, query, steps) {
  if (only && !name.startsWith(only)) return;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => issues.push(`[${name}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') issues.push(`[${name}] ${m.type()}: ${m.text()}`); });
  const url = `${baseUrl}?names=${encodeURIComponent(names.join('~'))}&seed=${seedCode}&sound=0${query}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__duckWorld && document.getElementById('boot') === null, null, { timeout: 90000 });
  const snap = async (file, wait = 650) => { await page.waitForTimeout(wait); await page.screenshot({ path: `${outDir}/${name}-${file}.png` }); console.log('  ', `${name}-${file}.png`); };
  const ev = (js) => page.evaluate(js);
  await steps({ page, snap, ev });
  await ctx.close();
}

const raceFlow = async ({ snap, ev }) => {
  const W = 'window.__duckWorld';
  // section times for the target duck (cam=1)
  const times = await ev(`(() => { const w = ${W}; const r = w.state.race; const c = w.course; const F = c.features; const i = w.state.target;
    const tAt = (s) => { for (let t = 0; t < 80; t += 1/30) { if (w.state.race && (function(){ const arr = r.pos[i]; const f = Math.min(arr.length - 1, t / r.dt); const k = Math.floor(f); return arr[k]; })() >= s) return t; } return 60; };
    const take = r.events.find(e => e.type === 'takeoff' && e.duck === i);
    const hd = r.events.find(e => e.type === 'hotdog');
    const hit = r.events.find(e => e.type === 'hit' && e.item !== 'hotdog');
    return { marina: 2.6, canyon: tAt(F.canyonInS + 60), bend: tAt(F.itemBoxes[0] + 8), lily: tAt(F.lilyInS + 45), drop: take ? take.t + 0.45 : tAt(F.dropLipS + 6), tunnel: tAt(F.tunnelInS + 50), rapids: tAt(F.tunnelOutS + 60), harbor: tAt(F.harborInS + 40), finish: Math.min(...r.finishTimes) - 0.25, hotdog: hd ? hd.t : null, hotdogDuck: hd ? hd.duck : null, hit: hit ? hit.t : null, hitDuck: hit ? hit.duck : null }; })()`);
  console.log('  times', JSON.stringify(times));
  await ev(`${W}.setPhase('flythrough', 1.5)`); await snap('01-fly-marina', 900);
  await ev(`${W}.setPhase('flythrough', 4.6)`); await snap('02-fly-canyon', 900);
  await ev(`${W}.setPhase('flythrough', 8.2)`); await snap('03-fly-tunnel', 900);
  await ev(`${W}.setPhase('grid', 1.2)`); await snap('04-grid', 800);
  await ev(`${W}.jump(${times.marina})`); await snap('05-marina-chase');
  await ev(`${W}.jump(${times.canyon})`); await snap('06-canyon-chase');
  await ev(`${W}.jump(${times.bend})`); await snap('07-canyon-items');
  await ev(`${W}.jump(${times.lily})`); await snap('08-lily-chase');
  await ev(`${W}.jump(${times.drop})`); await snap('09-drop-midair');
  await ev(`${W}.jump(${times.tunnel})`); await snap('10-tunnel');
  await ev(`${W}.jump(${times.rapids})`); await snap('11-rapids');
  await ev(`${W}.jump(${times.harbor})`); await snap('12-harbor');
  if (times.hotdog !== null) {
    await ev(`${W}.setTarget(${times.hotdogDuck}); ${W}.jump(${times.hotdog - 0.32})`); await snap('13-hotdog-flight', 400);
    await ev(`${W}.jump(${times.hotdog + 0.35})`); await snap('14-hotdog-spin', 400);
    await ev(`${W}.setTarget(0)`);
  }
  if (times.hit !== null) { await ev(`${W}.setTarget(${times.hitDuck}); ${W}.jump(${times.hit - 0.25})`); await snap('15-item-hit', 450); await ev(`${W}.setTarget(0)`); }
  await ev(`${W}.setView('tv'); ${W}.jump(${times.canyon})`); await snap('16-tv-canyon');
  await ev(`${W}.jump(${times.drop - 0.3})`); await snap('17-tv-drop');
  await ev(`${W}.jump(${times.rapids})`); await snap('18-tv-rapids');
  await ev(`${W}.setView('chase'); ${W}.jump(${times.finish})`); await snap('19-finish', 500);
  await ev(`${W}.results()`); await snap('20-results', 1200);
  await ev(`${W}.freeCam(200, 60, -60, 150, 5, -90)`); await snap('21-free-overview', 900);
};

await session('desktop', { width: 1280, height: 720 }, twelve, '&autostart=1&intro=0&cam=1', raceFlow);
await session('mobile', { width: 390, height: 844 }, twelve.slice(0, 8), '&autostart=1&intro=0&cam=1', raceFlow);
await session('menu-desktop', { width: 1280, height: 720 }, twelve, '', async ({ snap }) => { await snap('00-setup', 800); });
await session('menu-mobile', { width: 390, height: 844 }, twelve.slice(0, 10), '', async ({ snap }) => { await snap('00-setup', 800); });
await browser.close();
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'no console errors');
