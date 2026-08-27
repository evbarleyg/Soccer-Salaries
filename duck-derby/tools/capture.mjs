// Headless capture helper for visual review.
// usage: node tools/capture.mjs <url> <out.png> [width] [height] [waitMs] [fullPage]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const root = execSync('npm root -g').toString().trim();
    const require = createRequire(import.meta.url);
    return require(root + '/playwright');
  }
}

const [url, out, w = '1280', h = '800', wait = '500', full = '0'] = process.argv.slice(2);
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out, fullPage: full === '1' });
await browser.close();
if (errors.length) { console.log('CONSOLE ISSUES:\n' + errors.join('\n')); } else console.log('no console errors');
console.log('saved', out);
