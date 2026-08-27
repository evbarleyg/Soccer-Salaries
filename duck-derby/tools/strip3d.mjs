// Filmstrips around key moments (hot dog, item hit, The Drop, lead change, photo finish):
// four 640x360 frames per moment stitched into one 1280x720 PNG for quick review.
// usage: node tools/strip3d.mjs [outDir] [seed] [cam]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const root = execSync('npm root -g').toString().trim();
    return createRequire(import.meta.url)(root + '/playwright');
  }
}
const [outDir = 'shots/strips', seed = '7GQ-M2XD', cam = '1'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
const issues = [];
page.on('pageerror', (e) => issues.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') issues.push('console: ' + m.text()); });
const names = ['Quack Sparrow', 'Duck Norris', 'Mallory', 'Sir Waddles', 'Bill Murray', 'Puddles', 'Feather Locklear', 'Drake', 'Waddle Dee', 'Eggatha', 'Beak Man', 'Ponderosa'];
await page.goto(`http://localhost:8080/duck-derby/world.html?names=${encodeURIComponent(names.join('~'))}&seed=${seed}&autostart=1&intro=0&sound=0&noadapt=1&cam=${cam}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__duckWorld && document.getElementById('boot') === null && window.__duckWorld.state.race, null, { timeout: 90000 });
const moments = await page.evaluate(() => {
  const w = window.__duckWorld; const r = w.state.race; const me = w.state.target;
  const ev = (f) => r.events.find(f);
  const out = [];
  const hd = ev((e) => e.type === 'hotdog'); if (hd) out.push({ name: 'hotdog', t: hd.t, duck: hd.duck });
  const hit = ev((e) => e.type === 'hit' && e.item !== 'hotdog'); if (hit) out.push({ name: 'hit-' + hit.item, t: hit.t, duck: hit.duck });
  const to = ev((e) => e.type === 'takeoff' && e.duck === me); if (to) out.push({ name: 'drop', t: to.t + 0.35, duck: me });
  const lead = r.events.filter((e) => e.type === 'lead' && e.t > 8)[0]; if (lead) out.push({ name: 'lead', t: lead.t, duck: lead.duck });
  const use = ev((e) => e.type === 'use' && (e.item === 'bread' || e.item === 'triple') && e.duck === me); if (use) out.push({ name: 'boost', t: use.t + 0.2, duck: me });
  const gull = r.projectiles.find((p) => p.type === 'seagull'); if (gull) out.push({ name: 'seagull', t: gull.t1 - 0.2, duck: gull.target });
  out.push({ name: 'finish', t: Math.min(...r.finishTimes) - 0.15, duck: r.order[0] });
  return out;
});
const stitch = await browser.newPage({ viewport: { width: 1280, height: 720 } });
for (const m of moments) {
  const frames = [];
  for (const off of [-0.55, -0.15, 0.2, 0.65]) {
    await page.evaluate(([d, t]) => { window.__duckWorld.setTarget(d); window.__duckWorld.jump(t); }, [m.duck, m.t + off]);
    await page.waitForTimeout(350);
    frames.push((await page.screenshot()).toString('base64'));
  }
  const png = await stitch.evaluate(async ([frames, label]) => {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d');
    for (let i = 0; i < 4; i++) { const img = new Image(); img.src = 'data:image/png;base64,' + frames[i]; await img.decode(); g.drawImage(img, (i % 2) * 640, Math.floor(i / 2) * 360); }
    g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(0, 0, 300, 28); g.fillStyle = '#fff'; g.font = 'bold 18px sans-serif'; g.fillText(label, 8, 20);
    return c.toDataURL('image/png').split(',')[1];
  }, [frames, `${m.name} @ ${m.t.toFixed(2)}s  (-0.55, -0.15, +0.2, +0.65)`]);
  writeFileSync(`${outDir}/${m.name}.png`, Buffer.from(png, 'base64'));
  console.log('  ', `${outDir}/${m.name}.png`);
}
await browser.close();
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'no console errors');
