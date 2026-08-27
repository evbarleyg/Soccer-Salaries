// End-to-end flow smoke test in headless Chromium at a tiny viewport (fast even on swiftshader):
// grid -> countdown -> race, then jump near the finish and let finish -> replay -> results play out.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const root = execSync('npm root -g').toString().trim();
    return createRequire(import.meta.url)(root + '/playwright');
  }
}
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
const issues = [];
page.on('pageerror', (e) => issues.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') issues.push('console: ' + m.text()); });
const names = ['Ann', 'Bob', 'Cat', 'Dan', 'Eve', 'Fay'];
await page.goto(`http://localhost:8080/duck-derby/world.html?names=${names.join('~')}&seed=WXYZ-1234&autostart=1&intro=0&sound=0&noadapt=1&cam=2&q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__duckWorld && document.getElementById('boot') === null && window.__duckWorld.state.race, null, { timeout: 60000 });
const W = () => page.evaluate(() => { const s = window.__duckWorld.state; return { phase: s.phase, t: +s.t.toFixed(2), pt: +s.phaseTime.toFixed(2), target: s.target, view: s.view, rate: +s.rate.toFixed(2) }; });
const log = async (label) => console.log(label.padEnd(22), JSON.stringify(await W()));
await log('after boot');
const t0 = Date.now();
await page.waitForFunction(() => window.__duckWorld.state.phase === 'race', null, { timeout: 120000 });
console.log('grid+countdown took', ((Date.now() - t0) / 1000).toFixed(1), 's wall');
await log('race started');
await page.waitForTimeout(1500);
await log('racing');
// jump close to the end and let it play out
await page.evaluate(() => { const r = window.__duckWorld.state.race; window.__duckWorld.jump(Math.min(...r.finishTimes) - 1.0); });
await log('jumped near finish');
await page.waitForFunction(() => window.__duckWorld.state.phase === 'finish', null, { timeout: 180000 });
await log('finish phase');
await page.waitForFunction(() => window.__duckWorld.state.phase === 'results', null, { timeout: 240000 });
await log('results phase');
const res = await page.evaluate(() => ({ rows: document.querySelectorAll('#res-board li').length, title: document.getElementById('res-title').textContent, hidden: document.getElementById('results').hidden, first: document.querySelector('#res-board li .nm')?.textContent, card: !document.getElementById('finish-card').hidden }));
console.log('results', JSON.stringify(res));
// replay button
await page.click('#btn-replay');
await page.waitForTimeout(300);
await log('after replay click');
// switch to tv, then free, then back
await page.evaluate(() => { window.__duckWorld.setView('tv'); });
await log('tv');
await page.evaluate(() => { window.__duckWorld.jump(20); });
await page.waitForTimeout(500);
await log('tv mid-race');
// edit roster -> menu
await page.evaluate(() => document.getElementById('btn-setup').click());
await log('menu');
await browser.close();
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'no console errors');
