import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The 3D game ships as static files with an import map and no bundler, so a
// typo in a relative import only shows up in the browser. Check them here.
test('world.html references files that exist and maps three to the vendored build', () => {
  const html = readFileSync(join(root, 'world.html'), 'utf8');
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  assert.ok(map.imports.three.startsWith('./vendor/three/'));
  assert.ok(existsSync(join(root, map.imports.three)), 'vendored three.module missing');
  assert.ok(existsSync(join(root, map.imports['three/addons/'], 'utils/BufferGeometryUtils.js')));
  assert.ok(existsSync(join(root, 'vendor/es-module-shims.js')) && existsSync(join(root, 'vendor/qrcode.js')));
  for (const m of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
    const ref = m[1];
    if (/^(https?:|data:|mailto:)/.test(ref)) continue;
    assert.ok(existsSync(join(root, ref)), `missing ${ref}`);
  }
  for (const id of ['world', 'setup', 'hud', 'results', 'minimap', 'item-canvas', 'res-board', 'btn-start', 'btn-share']) assert.ok(html.includes(`id="${id}"`), `#${id} missing from world.html`);
});

test('every relative import in src/world3d resolves', () => {
  const dir = join(root, 'src/world3d');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 15);
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/^\s*import[^'"]+['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      if (spec === 'three' || spec.startsWith('three/addons/')) continue;
      assert.ok(spec.startsWith('.'), `${f}: bare import ${spec}`);
      assert.ok(existsSync(resolve(dir, spec)), `${f}: cannot resolve ${spec}`);
    }
  }
});

test('headless engine modules do not import three (so node tests and workers can use them)', () => {
  for (const f of ['course.js', 'race.js', 'items.js', 'params.js']) {
    const src = readFileSync(join(root, 'src/world3d', f), 'utf8');
    assert.ok(!/from ['"]three/.test(src), `${f} imports three`);
  }
});
