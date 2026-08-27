// Quick single-state capture for iterating: loads world.html with autostart,
// waits for boot, runs a script (jump/setView/...), screenshots.
// usage: node tools/snap3d.mjs <out.png> [w] [h] [js-to-eval] [waitMs] [extraQuery]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const root = execSync('npm root -g').toString().trim();
    return createRequire(import.meta.url)(root + '/playwright');
  }
}
const [out = 'shot.png', w = '1280', h = '720', js = '', wait = '600', extra = ''] = process.argv.slice(2);
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
const issues = [];
page.on('pageerror', (e) => issues.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') issues.push(m.type() + ': ' + m.text()); });
const names = ['Quack Sparrow', 'Duck Norris', 'Mallory', 'Sir Waddles', 'Bill Murray', 'Puddles', 'Feather Locklear', 'Drake', 'Waddle Dee', 'Eggatha', 'Beak Man', 'Ponderosa'];
const url = `http://localhost:8080/duck-derby/world.html?names=${encodeURIComponent(names.join('~'))}&seed=7GQ-M2XD&autostart=1&intro=0&sound=0${extra ? '&' + extra : ''}`;
const t0 = Date.now();
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__duckWorld && window.__duckWorld.state.race && document.getElementById('boot') === null, null, { timeout: 60000 });
console.log('boot ms', Date.now() - t0);
if (js) await page.evaluate(js);
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out });
const info = await page.evaluate(() => { const r = window.__duckWorld.renderer.info; return { calls: r.render.calls, tris: r.render.triangles, geos: r.memory.geometries, tex: r.memory.textures, phase: window.__duckWorld.state.phase, t: window.__duckWorld.state.t }; });
console.log(JSON.stringify(info));
await browser.close();
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'no console errors');
console.log('saved', out);
