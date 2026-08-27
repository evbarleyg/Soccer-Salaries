// Duck Derby World — course definition (headless: no Three.js in here).
//
// One signature course, defined as tagged control points. A centripetal
// Catmull-Rom spline through the (x, z) points gives the river's centre line;
// water height (y) and channel width are eased per segment so the weir ("The
// Drop") is a clean step rather than a spline overshoot. Everything the race
// engine, the minimap and the renderer need comes from here so they agree to
// the centimetre: `at(s)` maps a race distance in metres to a point, heading,
// water height, width, banking and section.
//
// Race distance s: 0 at the start pontoon, `course.length` at the finish arch.
// The spline extends before the start (marina basin) and past the finish
// (harbour run-out) so cameras and coasting ducks always have track under them.

import { clamp, smoothstep, lerp } from '../rng.js';

/** Themed stretches of the course, in running order. */
export const SECTIONS = {
  marina: { id: 'marina', name: 'Duck Village Marina', blurb: 'Pontoon start under the blimp', bank: 0.1 },
  canyon: { id: 'canyon', name: 'Canyon S-Bends', blurb: 'Banked turns between the cliffs', bank: 1.0 },
  lily: { id: 'lily', name: 'Lily-Pad Chicane', blurb: 'Weave the pads, mind the frogs', bank: 0.15 },
  drop: { id: 'drop', name: 'The Drop', blurb: 'Over the weir — everyone flies', bank: 0.2 },
  tunnel: { id: 'tunnel', name: 'Log-Flume Tunnel', blurb: 'Dark, fast, echoing', bank: 0.8 },
  rapids: { id: 'rapids', name: 'Rocky Rapids', blurb: 'White water and bonkable rocks', bank: 0.6 },
  harbor: { id: 'harbor', name: 'Harbour Finish', blurb: 'Lighthouse, chequered arch, fireworks', bank: 0.1 },
};
export const SECTION_ORDER = ['marina', 'canyon', 'lily', 'drop', 'tunnel', 'rapids', 'harbor'];

/**
 * Control points: x/z metres (x east, z south), y = water surface height,
 * w = channel width, sec = section that *starts* at this point (until the next
 * point that names one), tag = named feature located exactly at this point.
 */
export const COURSE_SCALE = 0.8; // uniform x/z scale: tunes race length (~40 s) without redrawing the map
const P = (x, z, y, w, extra = {}) => ({ x: x * COURSE_SCALE, z: z * COURSE_SCALE, y, w, ...extra });
export const CONTROL_POINTS = [
  P(-110, 3, 6, 34, { sec: 'marina' }),
  P(-55, 1, 6, 32),
  P(0, 0, 6, 30, { tag: 'start' }),
  P(48, -1, 6, 26),
  P(92, -8, 5.7, 17, { sec: 'canyon', tag: 'canyonIn' }),
  P(135, -9, 5.4, 15),
  P(167, -21, 5.1, 15),
  P(180, -53, 4.8, 15),
  P(181, -85, 4.6, 15),
  P(193, -117, 4.4, 15),
  P(225, -130, 4.2, 15, { tag: 'box1' }),
  P(256, -131, 4.0, 15),
  P(287, -143, 3.8, 15),
  P(300, -175, 3.7, 17),
  P(299, -214, 3.6, 22, { sec: 'lily', tag: 'lilyIn' }),
  P(290, -262, 3.5, 30),
  P(306, -308, 3.5, 28, { tag: 'box2' }),
  P(334, -338, 3.5, 19, { sec: 'drop', tag: 'dropApproach' }),
  P(356, -354, 3.4, 17, { tag: 'dropLip' }),
  P(375, -368, -1.7, 21, { tag: 'dropLand' }),
  P(405, -386, -1.9, 15, { sec: 'tunnel', tag: 'tunnelIn' }),
  P(452, -397, -2.3, 12),
  P(497, -380, -2.7, 12),
  P(530, -346, -3.1, 14, { sec: 'rapids', tag: 'tunnelOut' }),
  P(546, -301, -3.8, 16),
  P(540, -256, -4.5, 16, { tag: 'box3' }),
  P(561, -212, -5.2, 17),
  P(600, -180, -5.6, 22, { sec: 'harbor', tag: 'harborIn' }),
  P(650, -166, -5.7, 28),
  P(702, -171, -5.7, 30),
  P(754, -186, -5.7, 32, { tag: 'finish' }),
  P(806, -209, -5.7, 36),
  P(856, -240, -5.7, 40, { tag: 'end' }),
];

const SAMPLES = 2400; // arc-length table resolution

// ---- centripetal Catmull-Rom (same maths as THREE.CatmullRomCurve3) ----
function cubic(x0, x1, x2, x3, dt0, dt1, dt2, t) {
  let t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
  let t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
  t1 *= dt1;
  t2 *= dt1;
  const c0 = x1;
  const c1 = t1;
  const c2 = -3 * x1 + 3 * x2 - 2 * t1 - t2;
  const c3 = 2 * x1 - 2 * x2 + t1 + t2;
  return c0 + t * (c1 + t * (c2 + t * c3));
}

function makeSpline(pts) {
  const n = pts.length;
  const ext0 = { x: 2 * pts[0].x - pts[1].x, z: 2 * pts[0].z - pts[1].z };
  const ext1 = { x: 2 * pts[n - 1].x - pts[n - 2].x, z: 2 * pts[n - 1].z - pts[n - 2].z };
  /** raw spline point at global parameter t in [0,1]; also returns segment + weight */
  function raw(t) {
    const p = (n - 1) * clamp(t, 0, 1);
    let seg = Math.floor(p);
    let w = p - seg;
    if (seg >= n - 1) {
      seg = n - 2;
      w = 1;
    }
    const p0 = seg > 0 ? pts[seg - 1] : ext0;
    const p1 = pts[seg];
    const p2 = pts[seg + 1];
    const p3 = seg + 2 < n ? pts[seg + 2] : ext1;
    let dt0 = Math.pow((p1.x - p0.x) ** 2 + (p1.z - p0.z) ** 2, 0.25);
    let dt1 = Math.pow((p2.x - p1.x) ** 2 + (p2.z - p1.z) ** 2, 0.25);
    let dt2 = Math.pow((p3.x - p2.x) ** 2 + (p3.z - p2.z) ** 2, 0.25);
    if (dt1 < 1e-4) dt1 = 1;
    if (dt0 < 1e-4) dt0 = dt1;
    if (dt2 < 1e-4) dt2 = dt1;
    return {
      x: cubic(p0.x, p1.x, p2.x, p3.x, dt0, dt1, dt2, w),
      z: cubic(p0.z, p1.z, p2.z, p3.z, dt0, dt1, dt2, w),
      seg,
      w,
    };
  }
  return { raw, n };
}

/**
 * Build the course object. Pure and cheap (a few ms) so tests, tools and the
 * renderer can each call it.
 */
export function buildCourse(points = CONTROL_POINTS) {
  const spline = makeSpline(points);
  const n = points.length;

  // arc-length table over the global parameter
  const ts = new Float64Array(SAMPLES + 1);
  const arc = new Float64Array(SAMPLES + 1);
  let prev = spline.raw(0);
  let acc = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const p = spline.raw(t);
    if (i > 0) acc += Math.hypot(p.x - prev.x, p.z - prev.z);
    ts[i] = t;
    arc[i] = acc;
    prev = p;
  }
  const totalArc = acc;

  // parameter -> arc length at each control point (points sit at t = k/(n-1))
  const pointArc = points.map((_, k) => arcAtT(k / (n - 1)));

  function arcAtT(t) {
    const f = clamp(t, 0, 1) * SAMPLES;
    const i = Math.min(SAMPLES - 1, Math.floor(f));
    return lerp(arc[i], arc[i + 1], f - i);
  }
  function tAtArc(a) {
    const x = clamp(a, 0, totalArc);
    let lo = 0;
    let hi = SAMPLES;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arc[mid] <= x) lo = mid;
      else hi = mid;
    }
    const span = arc[hi] - arc[lo];
    return lerp(ts[lo], ts[hi], span > 1e-9 ? (x - arc[lo]) / span : 0);
  }

  // tags & sections
  const tags = {};
  const sectionStarts = []; // [{id, arc}]
  let curSec = points[0].sec || 'marina';
  const segSection = new Array(n - 1);
  for (let k = 0; k < n; k++) {
    const p = points[k];
    if (p.tag) tags[p.tag] = pointArc[k];
    if (p.sec) {
      curSec = p.sec;
      sectionStarts.push({ id: p.sec, arc: pointArc[k] });
    }
    if (k < n - 1) segSection[k] = curSec;
  }
  const startArc = tags.start ?? 0;
  const finishArc = tags.finish ?? totalArc;
  const length = finishArc - startArc;
  const toS = (a) => a - startArc;

  /** section ranges in race metres */
  const sections = sectionStarts.map((e, i) => ({
    ...SECTIONS[e.id],
    s0: toS(e.arc),
    s1: toS(i + 1 < sectionStarts.length ? sectionStarts[i + 1].arc : totalArc),
  }));

  const features = {
    startS: 0,
    finishS: length,
    minS: toS(0),
    maxS: toS(totalArc),
    canyonInS: toS(tags.canyonIn),
    lilyInS: toS(tags.lilyIn),
    dropApproachS: toS(tags.dropApproach),
    dropLipS: toS(tags.dropLip),
    dropLandS: toS(tags.dropLand),
    tunnelInS: toS(tags.tunnelIn),
    tunnelOutS: toS(tags.tunnelOut),
    harborInS: toS(tags.harborIn),
    itemBoxes: [toS(tags.box1), toS(tags.box2), toS(tags.box3)],
    endS: toS(tags.end ?? totalArc),
  };

  // curvature / banking table (signed, + = turning left when travelling forward)
  const CURV_N = 600;
  const curv = new Float32Array(CURV_N + 1);
  {
    const h = totalArc / CURV_N;
    const heading = (a) => {
      const e = 0.5;
      const p0 = spline.raw(tAtArc(a - e));
      const p1 = spline.raw(tAtArc(a + e));
      return Math.atan2(-(p1.z - p0.z), p1.x - p0.x); // z south -> flip for maths angle
    };
    for (let i = 0; i <= CURV_N; i++) {
      const a = i * h;
      let d = heading(Math.min(totalArc - 1, a + 1.5)) - heading(Math.max(1, a - 1.5));
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      curv[i] = d / 3; // radians per metre
    }
    // smooth a little so banking eases in and out
    for (let pass = 0; pass < 10; pass++) {
      let prevV = curv[0];
      for (let i = 1; i < CURV_N; i++) {
        const v = curv[i];
        curv[i] = (prevV + 2 * v + curv[i + 1]) / 4;
        prevV = v;
      }
    }
  }

  /**
   * Sample the course at race distance s (metres from the start line; may be
   * negative or beyond the finish). Returns a fresh object unless `out` given.
   */
  function at(s, out = {}) {
    const a = clamp(s + startArc, 0, totalArc);
    const over = s + startArc - a; // metres beyond the table (extrapolate straight)
    const t = tAtArc(a);
    const r = spline.raw(t);
    // heading from a centred difference in arc space
    const e = 0.35;
    const ra = spline.raw(tAtArc(Math.max(0, a - e)));
    const rb = spline.raw(tAtArc(Math.min(totalArc, a + e)));
    let tx = rb.x - ra.x;
    let tz = rb.z - ra.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const p1 = points[r.seg];
    const p2 = points[r.seg + 1];
    const wgt = smoothstep(0, 1, r.w);
    out.x = r.x + tx * over;
    out.z = r.z + tz * over;
    out.tx = tx; // unit tangent (forward)
    out.tz = tz;
    out.nx = tz; // unit left-hand normal (to the duck's left when facing forward; y-up, z-south)
    out.nz = -tx;
    // water height: eased per segment; the weir gets a sharper profile
    if (p1.tag === 'dropLip') {
      const k = smoothstep(0.025, 0.15, r.w); // near-vertical sheet hugging the weir face
      out.y = lerp(p1.y, p2.y, k);
    } else out.y = lerp(p1.y, p2.y, wgt);
    out.width = lerp(p1.w, p2.w, wgt);
    out.section = segSection[r.seg];
    const ci = clamp((a / totalArc) * CURV_N, 0, CURV_N);
    const c0 = Math.floor(ci);
    const c1 = Math.min(CURV_N, c0 + 1);
    out.curvature = lerp(curv[c0], curv[c1], ci - c0);
    out.bank = clamp(out.curvature * 26 * (SECTIONS[out.section]?.bank ?? 0.5), -0.6, 0.6);
    out.s = s;
    return out;
  }

  /** Airborne hop height above the water for a duck at distance s (The Drop). */
  function hopAt(s) {
    const lip = features.dropLipS - 1.5;
    const land = features.dropLandS + 4;
    if (s <= lip || s >= land) return 0;
    const e = (s - lip) / (land - lip);
    // ballistic-looking arc relative to the falling water sheet
    const water0 = at(lip).y;
    const water1 = at(land).y;
    const waterHere = at(s).y;
    const chord = lerp(water0, water1, smoothstep(0.15, 1, e)); // where a thrown duck would be
    const arcH = 2.2 * 4 * e * (1 - e); // extra loft
    return Math.max(0, chord + arcH - waterHere);
  }

  function sectionAt(s) {
    for (const sec of sections) if (s < sec.s1) return sec;
    return sections[sections.length - 1];
  }

  /** Polyline of the centre line for minimaps: [{x,z,s}] every `step` metres. */
  function outline(step = 4) {
    const pts = [];
    for (let s = features.minS; s <= features.maxS; s += step) {
      const p = at(s);
      pts.push({ x: p.x, z: p.z, s, width: p.width, section: p.section });
    }
    return pts;
  }

  // Fast per-half-metre lookup (width + section index) for the race engine.
  let _lut = null;
  function lut() {
    if (_lut) return _lut;
    const step = 0.5;
    const s0 = features.minS;
    const n = Math.ceil((features.maxS - s0) / step) + 1;
    const width = new Float32Array(n);
    const sec = new Uint8Array(n);
    const tmp = {};
    for (let i = 0; i < n; i++) {
      at(s0 + i * step, tmp);
      width[i] = tmp.width;
      sec[i] = SECTION_ORDER.indexOf(tmp.section);
    }
    _lut = { step, s0, n, width, sec };
    return _lut;
  }
  /** Channel width at s (fast). */
  function widthAt(s) {
    const l = lut();
    const f = clamp((s - l.s0) / l.step, 0, l.n - 1);
    const i = Math.floor(f);
    const j = Math.min(l.n - 1, i + 1);
    return lerp(l.width[i], l.width[j], f - i);
  }
  /** Section id at s (fast). */
  function sectionIdAt(s) {
    const l = lut();
    return SECTION_ORDER[l.sec[clamp(Math.round((s - l.s0) / l.step), 0, l.n - 1)]];
  }

  return { points, length, totalArc, startArc, sections, features, at, hopAt, sectionAt, sectionIdAt, widthAt, outline };
}

let _course = null;
/** Shared lazily-built instance. */
export function getCourse() {
  if (!_course) _course = buildCourse();
  return _course;
}
