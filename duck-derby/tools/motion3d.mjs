// Dense motion strips: 9 frames at a fixed sim-time step around a moment, stitched 3x3 (each 424x240) into one
// 1272x720 PNG — for judging animation arcs (hop, barrel roll, squash, camera moves) rather than single poses.
// usage: node tools/motion3d.mjs [outDir] [step=0.12] [seed] [cam]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const root = execSync('npm root -g').toString().trim();
    return createRequire(import.meta.url)(root + '/playwright');
  }
}
const [outDir = 'shots/motion', stepArg = '0.12', seed = '7GQ-M2XD', cam = '1'] = process.argv.slice(2);
const STEP = Number(stepArg) || 0.12;
mkdirSync(outDir, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const W = 424, H = 240;
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const issues = [];
page.on('pageerror', (e) => issues.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') issues.push('console: ' + m.text()); });
const names = ['Quack Sparrow', 'Duck Norris', 'Mallory', 'Sir Waddles', 'Bill Murray', 'Puddles', 'Feather Locklear', 'Drake'];
await page.goto(`http://localhost:8080/duck-derby/world.html?names=${encodeURIComponent(names.join('~'))}&seed=${seed}&autostart=1&intro=0&sound=0&noadapt=1&cam=${cam}&hud=0`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__duckWorld && document.getElementById('boot') === null && window.__duckWorld.state.race, null, { timeout: 90000 });
await page.addStyleTag({ content: '#hud, #lower-third, #finish-card, #letterbox span { display: none !important; }' }); // pictures only
const moments = await page.evaluate(() => {
  const w = window.__duckWorld; const r = w.state.race; const me = w.state.target;
  const ev = (f) => r.events.find(f);
  const out = [];
  out.push({ name: 'start', t: 0.05, duck: me, view: 'chase' });
  const hit = ev((e) => e.type === 'hit' && e.item !== 'hotdog'); if (hit) out.push({ name: 'spin-' + hit.item, t: hit.t - 0.1, duck: hit.duck, view: 'chase' });
  const hd = ev((e) => e.type === 'hotdog'); if (hd) out.push({ name: 'hotdog', t: hd.t - 0.5, duck: hd.duck, view: 'chase' });
  const to = ev((e) => e.type === 'takeoff' && e.duck === me); if (to) { out.push({ name: 'drop-chase', t: to.t - 0.2, duck: me, view: 'chase', n: 12 }); out.push({ name: 'drop-tv', t: to.t - 0.4, duck: me, view: 'tv', n: 12 }); }
  const use = ev((e) => e.type === 'use' && (e.item === 'bread' || e.item === 'triple')); if (use) out.push({ name: 'boost', t: use.t - 0.1, duck: use.duck, view: 'chase' });
  const lead = r.events.filter((e) => e.type === 'lead' && e.t > 8)[0]; if (lead) out.push({ name: 'tv-leadcut', t: lead.t - 0.3, duck: lead.duck, view: 'tv' });
  out.push({ name: 'finish', t: Math.min(...r.finishTimes) - 0.5, duck: r.order[0], view: 'chase' });
  out.push({ name: 'cruise', t: 15, duck: me, view: 'chase' });
  return out;
});
const stitch = await browser.newPage({ viewport: { width: 3 * W, height: 3 * H } });
for (const m of moments) {
  const n = m.n || 9;
  const cols = n > 9 ? 4 : 3;
  const rows = Math.ceil(n / cols);
  const frames = [];
  await page.evaluate(([d, t, v]) => { const w = window.__duckWorld; w.tick(0); w.setView(v); w.setTarget(d); w.jump(t - 1.2); for (let i = 0; i < 24; i++) w.tick(0.05); }, [m.duck, m.t, m.view]);
  for (let k = 0; k < n; k++) {
    // real frame stepping (not seeks): camera springs, particles and animation state stay continuous
    if (k > 0) await page.evaluate((s) => { const w = window.__duckWorld; const sub = Math.max(1, Math.round(s / 0.04)); for (let i = 0; i < sub; i++) w.tick(s / sub); }, STEP);
    frames.push((await page.screenshot()).toString('base64'));
  }
  const png = await stitch.evaluate(async ([frames, label, W, H, cols, rows]) => {
    const c = document.createElement('canvas'); c.width = cols * W; c.height = rows * H; const g = c.getContext('2d');
    for (let i = 0; i < frames.length; i++) { const img = new Image(); img.src = 'data:image/png;base64,' + frames[i]; await img.decode(); g.drawImage(img, (i % cols) * W, Math.floor(i / cols) * H); g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect((i % cols) * W, Math.floor(i / cols) * H, 26, 20); g.fillStyle = '#fff'; g.font = 'bold 14px sans-serif'; g.fillText(String(i + 1), (i % cols) * W + 7, Math.floor(i / cols) * H + 15); }
    g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(30, 0, 360, 22); g.fillStyle = '#fff'; g.font = 'bold 15px sans-serif'; g.fillText(label, 36, 16);
    return c.toDataURL('image/png').split(',')[1];
  }, [frames, `${m.name} from ${m.t.toFixed(2)}s, step ${STEP}s, ${m.view}`, W, H, cols, rows]);
  writeFileSync(`${outDir}/${m.name}.png`, Buffer.from(png, 'base64'));
  console.log('  ', `${outDir}/${m.name}.png`);
}
await browser.close();
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'no console errors');
