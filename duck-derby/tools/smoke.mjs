// End-to-end smoke test: drives the real app through the flows people (and QA) actually use and fails loudly.
// usage: node tools/smoke.mjs <baseUrl>      (exit 1 on any page error, console error, failed expectation or timeout)
// Needs Playwright (global install is fine) and a static server on baseUrl; ~2 min.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const root = execSync('npm root -g').toString().trim();
    return createRequire(import.meta.url)(root + '/playwright');
  }
}
const [baseUrl = 'http://localhost:8080/duck-derby/'] = process.argv.slice(2);
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const problems = [];
const t00 = Date.now();
const ten = ['Quack Sparrow', 'Duck Norris', 'Mallory', 'Sir Waddles', 'Bill Murray', 'Puddles', 'Feather Locklear', 'Drake', 'Waddle Dee', 'Eggatha'];
const shareQuery = (names, extra = '') => `?${names.map((n) => `n=${encodeURIComponent(n)}`).join('&')}&seed=3GQ-M2XD&len=24&rule=w&fx=0${extra}`;

/** One isolated browser context per flow; `fn` gets (page, expect, helpers). */
async function flow(name, fn, { viewport = { width: 1280, height: 720 }, query = '', init = null, hasTouch = false } = {}) {
  const t0 = Date.now();
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  let fails = 0;
  page.on('pageerror', (e) => { problems.push(`[${name}] pageerror: ${e.message}`); fails++; });
  page.on('console', (m) => { if (m.type() === 'error') { problems.push(`[${name}] console: ${m.text()}`); fails++; } });
  const expect = (ok, msg) => { if (!ok) { problems.push(`[${name}] ${msg}`); fails++; } };
  const S = () => page.evaluate(() => { const s = window.__duckDerby.state; return { phase: s.phase, paused: s.paused, n: s.names.length, shared: s.shared, locked: s.locked, seed: s.seed, t: s.t, toast: document.querySelector('#toast').classList.contains('show') ? document.querySelector('#toast').innerText : '' }; });
  const phase = async (ph, timeout = 15000) => {
    try {
      await page.waitForFunction((p) => window.__duckDerby.state.phase === p, ph, { timeout, polling: 100 });
      return true;
    } catch {
      expect(false, `phase "${ph}" not reached within ${timeout} ms (still "${(await S()).phase}")`);
      return false;
    }
  };
  try {
    await page.goto(baseUrl + query, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    await fn(page, expect, { S, phase });
  } catch (e) {
    expect(false, `script error: ${e.message}`);
  }
  await ctx.close();
  console.log(`  ${fails ? 'FAIL' : 'ok  '} ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// 1. setup edits: league size chips + stepper keep names, the blank-name nudge, then a full race to the board
await flow('setup-edits', async (page, expect, { S, phase }) => {
  await page.click('#btn-clear').catch(() => {});
  await page.click('.chip[data-size="8"]');
  expect((await S()).n === 8, 'size chip 8');
  await page.fill('#roster li:nth-child(1) input', 'Alice');
  await page.fill('#roster li:nth-child(2) input', 'W'.repeat(30)); // the one name-length rule: 22, no maxlength attribute
  const typed = await page.$eval('#roster li:nth-child(2) input', (i) => ({ v: i.value, max: i.getAttribute('maxlength') }));
  expect(typed.v === 'W'.repeat(22) && typed.max === null, `30 x W -> ${typed.v.length} chars, maxlength=${typed.max}`);
  await page.click('.chip[data-size="14"]');
  for (let i = 0; i < 3; i++) await page.click('#size-minus');
  const s1 = await S();
  expect(s1.n === 11, `8 -> 14 -> 11 = ${s1.n}`);
  expect((await page.$eval('#roster li:nth-child(1) input', (i) => i.value)) === 'Alice', 'names survive resizing');
  await page.click('#btn-start'); // blanks: first press nudges…
  await page.waitForTimeout(250);
  const s2 = await S();
  expect(s2.phase === 'setup' && /Name every duck/.test(s2.toast), `blank-name nudge (${s2.toast})`);
  await page.click('#btn-start'); // …second press races
  if (!(await phase('race'))) return;
  await page.evaluate(() => window.__duckDerby.jump(12));
  await page.waitForTimeout(300);
  await page.click('#btn-skip');
  if (!(await phase('results', 5000))) return;
  const board = await page.$$eval('#draft-board li:not(.board-head)', (els) => els.length);
  expect(board === 11, `board rows ${board}`);
  expect((await page.$eval('#results-sub .story', (e) => e.textContent.length)) > 10, 'race story on the board');
  await page.click('#btn-again'); // not exported: asks first
  await page.waitForTimeout(200);
  expect(!(await page.$eval('#confirm-new', (e) => e.hidden)), 'New race confirm sheet');
  await page.click('#btn-cancel-new');
  await page.click('#btn-edit');
  await phase('setup', 3000);
});

// 2. a shared link lands locked; "Make my own race" unlocks; Undo goes back to the shared race
await flow('shared-lock', async (page, expect, { S, phase }) => {
  const s0 = await S();
  expect(s0.shared && s0.locked, 'shared link is locked');
  expect(await page.$eval('#roster input', (i) => i.readOnly), 'roster read-only');
  await page.click('#btn-share-own');
  await page.waitForTimeout(400);
  const s1 = await S();
  expect(!s1.shared && !s1.locked && !(await page.evaluate(() => location.search)), 'Make my own race unlocks');
  expect(/own copy/.test(s1.toast), `unlock toast (${s1.toast})`);
  await page.click('#toast button'); // Undo -> back to the shared race
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  const s2 = await S();
  expect(s2.shared && s2.locked, 'Undo restores the shared race');
  await page.click('#btn-share-board'); // straight to the board
  if (!(await phase('results', 8000))) return;
  expect((await page.$eval('#btn-replay', (b) => b.textContent)) === 'Watch again', 'shared results offer Watch again');
}, { query: shareQuery(ten, '&lg=Sunday%20Scaries') });

// 3. pause / skip interleaving in every phase, Esc at the photo still
await flow('pause-skip', async (page, expect, { S, phase }) => {
  await page.click('#btn-start');
  await page.waitForTimeout(300);
  await page.keyboard.press('p'); // intro is not pausable
  expect(!(await S()).paused, 'P ignored in intro');
  if (!(await phase('countdown', 8000))) return;
  await page.keyboard.press('p');
  await page.waitForTimeout(200);
  expect((await S()).paused, 'paused in countdown');
  await page.waitForTimeout(1200);
  expect((await S()).phase === 'countdown', 'countdown holds while paused');
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  expect(!(await S()).paused, 'Space resumes');
  if (!(await phase('race', 8000))) return;
  await page.evaluate(() => window.__duckDerby.jump(9));
  await page.click('#btn-pause');
  await page.waitForTimeout(300);
  const t1 = (await S()).t;
  await page.waitForTimeout(600);
  expect(Math.abs((await S()).t - t1) < 1e-6, 'race clock frozen while paused');
  await page.click('#btn-skip'); // skip while paused: unpauses and lands on the board
  if (!(await phase('results', 5000))) return;
  expect(!(await S()).paused, 'skip clears the pause');
  await page.keyboard.press('p'); // results: no-op
  expect(!(await S()).paused, 'P is a no-op on the results');
  // replay, then Esc exactly at the winner's still
  await page.click('#btn-replay');
  if (!(await phase('race', 12000))) return;
  const winT = await page.evaluate(() => Math.min(...window.__duckDerby.state.sim.finishTimes));
  await page.evaluate((t) => window.__duckDerby.jump(t), winT - 0.4);
  await page.waitForFunction(() => window.__duckDerby.state.winnerAt !== null, null, { timeout: 15000, polling: 50 });
  await page.waitForTimeout(120);
  await page.keyboard.press('Escape');
  if (!(await phase('results', 5000))) return;
  expect((await page.evaluate(() => !window.__duckDerby.scene.photo)), 'no still left behind the board');
  // replay again and pause inside the finish phase, then let it run out to the results by itself
  await page.click('#btn-replay');
  if (!(await phase('race', 12000))) return;
  const lastT = await page.evaluate(() => Math.max(...window.__duckDerby.state.sim.finishTimes));
  await page.evaluate((t) => window.__duckDerby.jump(t), lastT - 0.3);
  if (!(await phase('finish', 15000))) return;
  await page.keyboard.press('p');
  await page.waitForTimeout(200);
  expect((await S()).paused, 'paused in finish');
  await page.keyboard.press('p');
  await phase('results', 15000);
}, { query: shareQuery(ten) });

// 4. browser Back / Forward between the shared setup and its result
await flow('history', async (page, expect, { S, phase }) => {
  await page.click('#btn-start');
  if (!(await phase('race', 12000))) return;
  await page.keyboard.press('Escape');
  if (!(await phase('results', 5000))) return;
  expect(/seed=3GQ-M2XD/.test(await page.evaluate(() => location.search)), 'result URL carries the code');
  await page.goBack();
  await page.waitForTimeout(700);
  const s1 = await S();
  expect(s1.phase === 'setup' && s1.locked, `Back -> locked setup (${s1.phase}, locked ${s1.locked})`);
  await page.goForward();
  await page.waitForTimeout(900);
  expect((await S()).phase === 'results', 'Forward -> the board again');
  await page.goBack();
  await page.waitForTimeout(500);
  await page.goBack(); // past the shared link: whatever is there must not throw
  await page.waitForTimeout(500);
}, { query: shareQuery(ten) });

// 5. storage blocked (private mode / sandboxed iframe): everything still works, nothing throws
await flow('no-storage', async (page, expect, { S, phase }) => {
  expect((await S()).phase === 'setup', 'boots without storage');
  await page.click('#btn-sample');
  await page.click('#btn-start');
  if (!(await phase('race', 12000))) return;
  await page.evaluate(() => window.__duckDerby.setFocus(2)); // "my duck" is remembered via storage normally
  await page.keyboard.press('Escape');
  if (!(await phase('results', 5000))) return;
  await page.click('#btn-copy').catch(() => {});
  await page.waitForTimeout(200);
}, { init: `Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });` });

// 6. broken / hand-edited links fall back gracefully (and say so)
await flow('broken-links', async (page, expect, { S }) => {
  const s = await S();
  expect(s.phase === 'setup' && !s.shared && /looks broken/.test(s.toast), `one-name link -> toast (${s.toast})`);
}, { query: '?n=OnlyOne&seed=3GQ-M2XD' });
await flow('bad-seed', async (page, expect, { S }) => {
  const s = await S();
  expect(s.phase === 'setup' && s.n === 3 && !s.shared, 'bad seed: names kept, not a shared race');
  expect((await page.evaluate(() => window.__duckDerby.state.duration)) === 38, 'bad len -> classic');
}, { query: '?n=A&n=B&n=C&seed=ZZZZZZZ&rule=x&len=99' });
await flow('long-name-link', async (page, expect, { S, phase }) => {
  const s = await S();
  expect(/shortened to 22/.test(s.toast), `shortened-name toast (${s.toast})`);
  expect((await page.evaluate(() => window.__duckDerby.state.names[0])) === 'Z'.repeat(22), 'name cut to 22');
  await page.click('#btn-start');
  await phase('race', 12000);
}, { query: `?n=${'Z'.repeat(30)}&n=Bob&n=Cat&seed=3GQ-M2XD&len=24&fx=0` });

// 7. touch: tap a duck to follow it, tap the strip, nothing throws (phone, hasTouch)
await flow('touch', async (page, expect, { S, phase }) => {
  await page.tap('#btn-start');
  if (!(await phase('race', 12000))) return;
  await page.evaluate(() => window.__duckDerby.jump(10));
  await page.waitForTimeout(400);
  const a = await page.evaluate(() => { const s = window.__duckDerby; const p = s.scene.duckScreen(3, s.state.t, 'race'); return p ? { x: p.x - 20 * p.scale, y: p.y } : null; });
  if (a) {
    await page.touchscreen.tap(a.x, a.y);
    await page.waitForTimeout(200);
    expect((await page.evaluate(() => window.__duckDerby.state.focus)) === 3, 'tap follows the duck');
    for (let k = 0; k < 3; k++) { await page.touchscreen.tap(a.x + 10, a.y); await page.waitForTimeout(120); }
    await page.waitForTimeout(300);
  } else expect(false, 'duck 4 not on screen at t=10');
  await page.tap('#btn-skip');
  await phase('results', 5000);
}, { viewport: { width: 390, height: 844 }, hasTouch: true, query: shareQuery(ten.slice(0, 8)) });

await browser.close();
console.log(`smoke: ${problems.length ? problems.length + ' problem(s)' : 'all flows passed'} in ${((Date.now() - t00) / 1000).toFixed(0)}s`);
if (problems.length) {
  console.log(problems.join('\n'));
  process.exit(1);
}
