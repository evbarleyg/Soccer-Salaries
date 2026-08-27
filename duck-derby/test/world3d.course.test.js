import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCourse, SECTION_ORDER } from '../src/world3d/course.js';

const course = buildCourse();

test('course has all seven sections, contiguous and in running order', () => {
  assert.deepEqual(course.sections.map((s) => s.id), SECTION_ORDER);
  for (let k = 1; k < course.sections.length; k++) {
    assert.equal(course.sections[k].s0, course.sections[k - 1].s1);
    assert.ok(course.sections[k].s1 > course.sections[k].s0);
  }
  assert.ok(course.sections[0].s0 <= 0, 'marina starts at/before the start line');
  assert.ok(course.sections.at(-1).s1 >= course.length, 'harbour reaches the finish');
});

test('course length suits a ~40 s race and features sit inside it in order', () => {
  assert.ok(course.length > 800 && course.length < 1150, `length ${course.length}`);
  const f = course.features;
  const seq = [f.startS, f.canyonInS, f.itemBoxes[0], f.lilyInS, f.itemBoxes[1], f.dropApproachS, f.dropLipS, f.dropLandS, f.tunnelInS, f.tunnelOutS, f.itemBoxes[2], f.harborInS, f.finishS];
  for (let k = 1; k < seq.length; k++) assert.ok(seq[k] > seq[k - 1], `feature ${k} out of order: ${seq.join(',')}`);
  assert.ok(f.minS < -40, 'spline extends behind the start for cameras');
  assert.ok(f.maxS > f.finishS + 60, 'spline extends past the finish for the run-out');
});

test('centre line is continuous and smooth; widths sane; water flows downhill overall', () => {
  let prev = course.at(course.features.minS);
  for (let s = course.features.minS + 1; s <= course.features.maxS; s += 1) {
    const p = course.at(s);
    const step = Math.hypot(p.x - prev.x, p.z - prev.z);
    assert.ok(step > 0.9 && step < 1.1, `arc-length parametrisation broken at s=${s}: step ${step}`);
    const turn = Math.acos(Math.max(-1, Math.min(1, p.tx * prev.tx + p.tz * prev.tz)));
    assert.ok(turn < 0.08, `kink at s=${s}: ${turn}`);
    assert.ok(p.width >= 10 && p.width <= 42, `width ${p.width} at ${s}`);
    if (p.section !== 'drop') assert.ok(Math.abs(p.y - prev.y) < 0.08, `water height jumps at s=${s} (${prev.y} -> ${p.y})`);
    assert.ok(Math.abs(p.bank) <= 0.6 + 1e-9);
    prev = p;
  }
  assert.ok(course.at(0).y > course.at(course.length).y + 8, 'finish is well below the start');
  assert.equal(course.sectionIdAt(10), 'marina');
  assert.equal(course.sectionIdAt(course.features.tunnelInS + 5), 'tunnel');
  assert.ok(Math.abs(course.widthAt(0) - course.at(0).width) < 0.3);
});

test('The Drop: a real fall, and the hop arc only exists around the weir', () => {
  const f = course.features;
  assert.ok(course.at(f.dropLipS).y - course.at(f.dropLandS).y > 4, 'weir drops at least 4 m');
  assert.equal(course.hopAt(f.dropLipS - 10), 0);
  assert.equal(course.hopAt(f.dropLandS + 10), 0);
  let peak = 0;
  for (let s = f.dropLipS - 2; s < f.dropLandS + 4; s += 0.5) {
    const h = course.hopAt(s);
    assert.ok(h >= 0 && Number.isFinite(h));
    peak = Math.max(peak, h);
  }
  assert.ok(peak > 2, `ducks should get real air (peak ${peak})`);
});

test('outline covers the whole spline for the minimap', () => {
  const pts = course.outline(8);
  assert.ok(pts.length > 100);
  assert.ok(pts[0].s <= course.features.minS + 1e-9 && pts.at(-1).s >= course.features.maxS - 8);
});
