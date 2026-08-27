// Procedural duck renderer (Canvas 2D). Local coordinate system: duck faces
// right, origin at body centre, body ≈ 70 units long. The waterline sits at
// y = +8; when swimming, everything below it is clipped away and a ripple is
// drawn in front so the duck "sits" in the water.

const TAU = Math.PI * 2;

/** Local units each hat rises above the crown of the head (clearance for overhead markers). */
export const HAT_HEIGHT = {
  tophat: 20,
  wizard: 34,
  party: 26,
  chef: 22,
  crown: 13,
  cowboy: 14,
  viking: 16,
  propeller: 14,
  bow: 10,
  flower: 8,
  headphones: 8,
  helmet: 10,
  pirate: 6,
  shades: 0,
  headband: 4,
  snorkel: 12,
};

const MUSTARD = '#F5C400';
const KETCHUP = '#D7263D';

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} look   from assignLooks()
 * @param {object} o      pose options
 *   x,y      screen position of body centre
 *   scale    pixels per local unit (1 => duck ≈ 70px long)
 *   t        time in seconds (drives idle animation)
 *   effort   0..1.5 how hard the duck is paddling (lean, head pump)
 *   flap     0..1 wing flap intensity
 *   beakOpen 0..1
 *   tilt     extra body rotation (radians)
 *   standing draw legs and skip water clipping (podium pose)
 *   alpha    opacity
 *   dizzy    0..1 stumble wobble
 *   --- race-mode extras (all default to the legacy portrait behaviour) ---
 *   pad      paddle phase in cycles; when given, head pump + lean follow the stroke
 *   squash   -1..1 squash/stretch about the waterline
 *   tailWag  radians of tail rotation
 *   sauce    0..1 mustard/ketchup splats (hot-dog victim)
 *   crown    draw a small floating crown above the headgear
 *   noStroke skip silhouette outlines and the roundel numeral (cheap passes)
 *   leadGlow 0..1 golden contact ripple for the race leader
 *   wingLift static wing raise in radians (start-line "revving" pose), added under any flap
 *   simpleClip clip the hull with a straight waterline instead of the wavy path (low-fx tier)
 */
export function drawDuck(ctx, look, o = {}) {
  const {
    x = 0,
    y = 0,
    scale = 1,
    t = 0,
    effort = 0.5,
    flap = 0,
    beakOpen = 0,
    tilt = 0,
    standing = false,
    alpha = 1,
    dizzy = 0,
    faceLeft = false,
    airborne = false,
    pad,
    squash = 0,
    tailWag = 0,
    sauce = 0,
    crown = false,
    noStroke = false,
    leadGlow = 0,
    wingLift = 0,
    simpleClip = false,
  } = o;
  const racing = pad !== undefined && pad !== null;
  const pal = look.palette;
  const pc = paletteCache(ctx, pal);
  const outline = pc.outline;

  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  const s = scale * (look.scale || 1);
  ctx.scale(faceLeft ? -s : s, s);
  const sway = Math.sin(t * 3.1 * (look.bobRate || 1) + (look.bobPhase || 0));
  const lean = racing ? -0.03 - 0.07 * Math.min(effort, 1.35) + sway * 0.015 : -0.06 * Math.min(effort, 1.4) + sway * 0.025;
  ctx.rotate(tilt + lean + Math.sin(t * 13) * 0.12 * dizzy);
  if (squash) {
    // squash & stretch about the waterline pivot so the hull stays planted
    ctx.translate(0, 8);
    ctx.scale(1 + 0.16 * squash, 1 - 0.12 * squash);
    ctx.translate(0, -8);
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // silhouette strokes never drop below ~1.9 screen px at race size
  const lw = (base) => Math.max(base, 1.9 / Math.max(s, 0.05));

  const clipWater = !standing && !airborne;
  if (clipWater) {
    // clip away the submerged hull
    ctx.save();
    ctx.beginPath();
    const wl = 8 + Math.sin(t * 4 + (look.bobPhase || 0)) * 0.8;
    if (simpleClip) ctx.rect(-80, -120, 160, 120 + wl);
    else {
      ctx.moveTo(-80, -120);
      ctx.lineTo(80, -120);
      ctx.lineTo(80, wl);
      for (let px = 80; px >= -80; px -= 8) ctx.lineTo(px, wl + Math.sin(px * 0.18 + t * 6) * 1.1);
      ctx.closePath();
    }
    ctx.clip();
  } else if (standing) {
    drawLegs(ctx, pal, t);
  }

  const flapHz = 7 * (look.flapRate || 1);
  const flapAngle = (flap > 0.01 ? -flap * (0.55 + 0.45 * Math.sin(t * flapHz * TAU)) * 1.05 : Math.sin(t * 2 + (look.bobPhase || 0)) * 0.04) - wingLift;

  // --- tail feathers ---
  ctx.save();
  if (tailWag) {
    ctx.translate(-26, -4);
    ctx.rotate(tailWag);
    ctx.translate(26, 4);
  }
  tailPath(ctx);
  ctx.fillStyle = pal.wing;
  ctx.fill();
  if (!noStroke) {
    ctx.lineWidth = lw(1.4);
    ctx.strokeStyle = outline;
    ctx.stroke();
  }
  ctx.restore();

  // --- body ---
  bodyPath(ctx);
  ctx.fillStyle = pc.body;
  ctx.fill();
  // decorations clipped to the body silhouette
  ctx.save();
  ctx.clip();
  ctx.fillStyle = pal.outline ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.26)';
  ctx.beginPath();
  ctx.ellipse(-4, -12, 20, 5, -0.1, 0, TAU);
  ctx.fill();
  if (pal.accent) {
    // mallard speculum flash on the flank
    const ga = ctx.globalAlpha;
    ctx.fillStyle = pal.accent;
    ctx.globalAlpha = ga * 0.9;
    ctx.beginPath();
    ctx.ellipse(-12, 4, 9, 4, -0.2, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = ga;
  }
  if (pal.metallic) sheen(ctx, t);
  // wing contact shadow so the wing reads inside same-hue bodies
  ctx.save();
  ctx.translate(4.5, -4.5);
  ctx.rotate(flapAngle);
  wingPath(ctx);
  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  ctx.fill();
  ctx.restore();
  if (sauce > 0.05) sauceSplats(ctx, look, sauce, 'body');
  if (pal.outline) {
    bodyPath(ctx);
    ctx.lineWidth = lw(1.6) + 2.2;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.stroke();
  }
  ctx.restore();
  if (!noStroke) {
    bodyPath(ctx);
    ctx.lineWidth = lw(1.6);
    ctx.strokeStyle = outline;
    ctx.stroke();
  }

  // --- number roundel on the chest ---
  roundel(ctx, look, faceLeft, noStroke);

  // --- wing ---
  ctx.save();
  ctx.translate(3, -7);
  ctx.rotate(flapAngle);
  wingPath(ctx);
  ctx.fillStyle = pc.wing;
  ctx.fill();
  if (!noStroke) {
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = pc.wingStroke;
    ctx.stroke();
  }
  // feather lines
  ctx.beginPath();
  ctx.moveTo(-6, 3);
  ctx.quadraticCurveTo(-15, 1, -24, 4);
  ctx.moveTo(-3, 6.5);
  ctx.quadraticCurveTo(-12, 6, -19, 8.5);
  ctx.strokeStyle = pal.wingShade;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();

  // --- head ---
  let pump;
  if (racing) pump = Math.sin(TAU * pad + Math.PI / 2) * (0.8 + 2.2 * Math.min(effort, 1.2));
  else pump = Math.sin(t * 5 * (look.bobRate || 1) + (look.bobPhase || 0)) * 0.9 * Math.min(effort, 1.2);
  const hx = 16 + pump;
  const hy = -21 - Math.abs(pump) * (racing ? 0.35 : 0.3);
  const hr = 11.5;

  // neck ring (mallard)
  if (pal.ring) {
    ctx.save();
    ctx.translate(hx - 3, hy + 9);
    ctx.rotate(-0.5);
    ctx.fillStyle = pal.ring;
    ctx.beginPath();
    ctx.ellipse(0, 0, 8.5, 2.6, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // hats that sit behind the head
  drawHat(ctx, look, t, hx, hy, hr, 'back');

  ctx.beginPath();
  ctx.arc(hx, hy, hr, 0, TAU);
  ctx.save();
  ctx.translate(hx, hy); // cached gradient is defined about the head centre
  ctx.fillStyle = pc.head;
  ctx.fill();
  ctx.restore();
  if (sauce > 0.05 || pal.outline) {
    ctx.save();
    ctx.clip();
    if (sauce > 0.05) sauceSplats(ctx, look, sauce, 'head', hx, hy);
    if (pal.outline) {
      ctx.beginPath();
      ctx.arc(hx, hy, hr, 0, TAU);
      ctx.lineWidth = lw(1.6) + 2.2;
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.stroke();
    }
    ctx.restore();
  }
  if (!noStroke) {
    ctx.beginPath();
    ctx.arc(hx, hy, hr, 0, TAU);
    ctx.lineWidth = lw(1.6);
    ctx.strokeStyle = outline;
    ctx.stroke();
  }

  // cheeks
  if (look.cheeks) {
    ctx.fillStyle = 'rgba(255,105,140,0.35)';
    ctx.beginPath();
    ctx.ellipse(hx + 5, hy + 5.5, 3.2, 2, 0, 0, TAU);
    ctx.fill();
  }

  // --- beak ---
  drawBeak(ctx, pal, hx, hy, beakOpen, outline, noStroke ? 0 : lw(1.1));

  // --- eye ---
  const blinkPhase = (t + (look.blinkOffset || 0)) % 4.2;
  const blink = blinkPhase < 0.11 ? 1 : 0;
  drawEye(ctx, pal, hx + 5, hy - 3, blink, dizzy, t);

  // hats in front
  drawHat(ctx, look, t, hx, hy, hr, 'front');

  if (crown) drawCrownGlyph(ctx, hx - 1, hy - hr - (HAT_HEIGHT[look.hat] || 0) - 8, 7, { t });

  if (clipWater) {
    ctx.restore(); // end clip
    // ripple where body meets water
    ctx.lineWidth = leadGlow > 0.01 ? 1.8 : 1.3;
    ctx.strokeStyle = leadGlow > 0.01 ? `rgba(255,210,63,${0.45 + 0.4 * Math.min(1, leadGlow)})` : 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.ellipse(0, 8.5, 33, 4.2, 0, Math.PI * 0.05, Math.PI * 0.95);
    ctx.stroke();
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = leadGlow > 0.01 ? 'rgba(255,226,120,0.45)' : 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    ctx.ellipse(2, 9, 40, 6, 0, Math.PI * 1.1, Math.PI * 1.9);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Per-palette cache of gradients and derived colours. Canvas gradients are resolved in the
 * user space current at fill time, so one object serves every frame, scale and canvas.
 */
function paletteCache(ctx, pal) {
  if (pal._c) return pal._c;
  const c = {};
  c.outline = pal.outline || shadeOf(pal.shade);
  c.wingStroke = pal.outline ? c.outline : shadeOf(pal.wingShade, 0.72);
  const body = ctx.createLinearGradient(0, -18, 0, 16);
  body.addColorStop(0, pal.light || pal.body);
  body.addColorStop(0.45, pal.body);
  body.addColorStop(1, pal.shade);
  c.body = body;
  const wing = ctx.createLinearGradient(0, -10, 0, 12);
  wing.addColorStop(0, pal.wing);
  wing.addColorStop(1, pal.wingShade);
  c.wing = wing;
  const headBase = pal.head || pal.body;
  const head = ctx.createRadialGradient(3, -5, 2, 0, 0, 13.5);
  head.addColorStop(0, pal.headLight || pal.light || headBase);
  head.addColorStop(0.7, headBase);
  head.addColorStop(1, pal.head ? shadeOf(pal.head) : pal.shade);
  c.head = head;
  const beak = ctx.createLinearGradient(0, -5, 0, 3);
  beak.addColorStop(0, lighten(pal.beak));
  beak.addColorStop(1, pal.beak);
  c.beak = beak;
  try {
    Object.defineProperty(pal, '_c', { value: c, enumerable: false, configurable: true });
  } catch {
    /* frozen palette: uncached */
  }
  return c;
}

function tailPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(-26, -4);
  ctx.quadraticCurveTo(-36, -8, -40, -17);
  ctx.quadraticCurveTo(-31, -13, -29, -9);
  ctx.quadraticCurveTo(-33, -16, -35, -22);
  ctx.quadraticCurveTo(-26, -14, -22, -8);
  ctx.closePath();
}

function bodyPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(-28, -6);
  ctx.bezierCurveTo(-20, -16, -2, -17, 10, -14);
  ctx.bezierCurveTo(22, -12, 30, -6, 29, 3);
  ctx.bezierCurveTo(28, 12, 18, 16, 4, 16);
  ctx.bezierCurveTo(-12, 16, -26, 12, -31, 3);
  ctx.bezierCurveTo(-34, -3, -35, -10, -37, -15);
  ctx.bezierCurveTo(-33, -12, -30, -9, -28, -6);
  ctx.closePath();
}

function wingPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(3, -2);
  ctx.bezierCurveTo(-4, -12, -20, -10, -29, 2);
  ctx.bezierCurveTo(-22, 6, -12, 12, 2, 8);
  ctx.quadraticCurveTo(7, 4, 3, -2);
  ctx.closePath();
}

/** Metallic sweep; caller has already clipped to the body. */
function sheen(ctx, t) {
  const sx = -40 + ((t * 30) % 110);
  const g = ctx.createLinearGradient(sx, -20, sx + 22, 10);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(-40, -20, 80, 40);
}

/** Fixed pseudo-random condiment spots per duck (seeded by its blink offset). */
function sauceSpots(look) {
  if (look._sauceSpots) return look._sauceSpots;
  let z = (Math.floor((look.blinkOffset || 1) * 9973) | 1) >>> 0;
  const rnd = () => {
    z = (Math.imul(z, 1103515245) + 12345) >>> 0;
    return (z >>> 8) / 16777216;
  };
  const body = [];
  for (let k = 0; k < 3; k++) body.push({ x: -22 + rnd() * 40, y: -11 + rnd() * 17, r: 2.5 + rnd() * 1.5, a: rnd() * TAU, c: k < 2 ? MUSTARD : KETCHUP });
  const head = [];
  for (let k = 0; k < 2; k++) head.push({ x: -6 + rnd() * 11, y: -7 + rnd() * 10, r: 2.5 + rnd() * 1.3, a: rnd() * TAU, c: k ? KETCHUP : MUSTARD });
  const spots = { body, head };
  try {
    Object.defineProperty(look, '_sauceSpots', { value: spots, enumerable: false });
  } catch {
    /* frozen look object: recompute next time */
  }
  return spots;
}

function sauceSplats(ctx, look, sauce, part, hx = 0, hy = 0) {
  const spots = sauceSpots(look)[part];
  const a = Math.max(0, Math.min(1, (sauce - 0.05) / 0.3));
  ctx.save();
  ctx.globalAlpha *= a;
  for (const sp of spots) {
    const cx = hx + sp.x;
    const cy = hy + sp.y;
    ctx.fillStyle = sp.c;
    ctx.beginPath();
    ctx.arc(cx, cy, sp.r, 0, TAU);
    // two satellites + a drip make it read as a splat rather than a dot
    ctx.moveTo(cx + Math.cos(sp.a) * sp.r * 1.5 + sp.r * 0.45, cy + Math.sin(sp.a) * sp.r * 1.5);
    ctx.arc(cx + Math.cos(sp.a) * sp.r * 1.5, cy + Math.sin(sp.a) * sp.r * 1.5, sp.r * 0.45, 0, TAU);
    ctx.moveTo(cx + Math.cos(sp.a + 2.2) * sp.r * 1.3 + sp.r * 0.35, cy + Math.sin(sp.a + 2.2) * sp.r * 1.3);
    ctx.arc(cx + Math.cos(sp.a + 2.2) * sp.r * 1.3, cy + Math.sin(sp.a + 2.2) * sp.r * 1.3, sp.r * 0.35, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + sp.r * 0.3, cy + sp.r * 1.25, sp.r * 0.42, sp.r * 0.9, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(cx - sp.r * 0.35, cy - sp.r * 0.35, sp.r * 0.3, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * A small three-point gold crown centred on (cx, cy); `r` is the half-width.
 * Exported so the scene (leader hand-off) and the podium can share one glyph.
 */
export function drawCrownGlyph(ctx, cx, cy, r, { t = 0, rot = 0, stroke = true } = {}) {
  ctx.save();
  ctx.translate(cx, cy);
  if (rot) ctx.rotate(rot);
  const h = r * 1.35;
  ctx.beginPath();
  ctx.moveTo(-r, h * 0.45);
  ctx.lineTo(-r * 1.08, -h * 0.35);
  ctx.lineTo(-r * 0.52, -h * 0.02);
  ctx.lineTo(0, -h * 0.62);
  ctx.lineTo(r * 0.52, -h * 0.02);
  ctx.lineTo(r * 1.08, -h * 0.35);
  ctx.lineTo(r, h * 0.45);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, -h * 0.6, 0, h * 0.5);
  g.addColorStop(0, '#FFE884');
  g.addColorStop(0.55, '#FFD23F');
  g.addColorStop(1, '#E2A400');
  ctx.fillStyle = g;
  ctx.fill();
  if (stroke) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, r * 0.2);
    ctx.strokeStyle = '#B8860B';
    ctx.stroke();
  }
  // band + jewels
  ctx.fillStyle = '#E2A400';
  ctx.fillRect(-r, h * 0.2, 2 * r, h * 0.14);
  ctx.fillStyle = '#E23D4E';
  ctx.beginPath();
  ctx.arc(0, h * 0.27, r * 0.16, 0, TAU);
  ctx.fill();
  // tip baubles
  ctx.fillStyle = '#FFF3B0';
  ctx.beginPath();
  for (const [px, py] of [[-r * 1.08, -h * 0.35], [0, -h * 0.62], [r * 1.08, -h * 0.35]]) {
    ctx.moveTo(px + r * 0.15, py);
    ctx.arc(px, py, r * 0.15, 0, TAU);
  }
  ctx.fill();
  // glint
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.beginPath();
  ctx.ellipse(-r * 0.45, h * 0.05, r * 0.13, r * 0.3, 0.3, 0, TAU);
  ctx.fill();
  const tw = 0.5 + 0.5 * Math.sin(t * 6);
  if (tw > 0.6) {
    ctx.globalAlpha *= (tw - 0.6) / 0.4;
    ctx.fillStyle = '#FFFFFF';
    sparklePath(ctx, r * 0.55, -h * 0.25, r * 0.35);
    ctx.fill();
  }
  ctx.restore();
}

function sparklePath(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    const rr = k % 2 ? r * 0.3 : r;
    const px = cx + Math.cos(a) * rr;
    const py = cy + Math.sin(a) * rr;
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function roundel(ctx, look, mirrored, noText) {
  const cx = 13;
  const cy = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, 7.2, 0, TAU);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 6.05, 0, TAU);
  ctx.fillStyle = look.towel.bg;
  ctx.fill();
  if (noText) return;
  ctx.save();
  ctx.translate(cx, cy + 0.5);
  if (mirrored) ctx.scale(-1, 1);
  ctx.fillStyle = look.towel.text;
  ctx.font = `800 ${look.number > 9 ? 6.9 : 9}px ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(look.number), 0, 0.5);
  ctx.restore();
}

function drawBeak(ctx, pal, hx, hy, open, outline, lineW = 1.1) {
  const bx = hx + 9;
  const by = hy - 1;
  // lower mandible
  ctx.save();
  ctx.translate(bx, by + 2);
  ctx.rotate(open * 0.5);
  ctx.beginPath();
  ctx.moveTo(0, -1);
  ctx.quadraticCurveTo(8, 0, 13, 1.5);
  ctx.quadraticCurveTo(8, 5, 0, 3.5);
  ctx.closePath();
  ctx.fillStyle = pal.beakShade;
  ctx.fill();
  if (lineW) {
    ctx.lineWidth = lineW;
    ctx.strokeStyle = outline;
    ctx.stroke();
  }
  if (open > 0.3) {
    // tongue
    ctx.fillStyle = '#ff7b8a';
    ctx.beginPath();
    ctx.ellipse(5, 1.2, 3.5, 1.3, 0, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  // upper mandible
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(-open * 0.18);
  ctx.beginPath();
  ctx.moveTo(-1, -3.5);
  ctx.quadraticCurveTo(9, -6, 16, -1);
  ctx.quadraticCurveTo(17, 1.2, 14, 1.6);
  ctx.quadraticCurveTo(6, 2.4, -1, 2);
  ctx.closePath();
  ctx.fillStyle = paletteCache(ctx, pal).beak;
  ctx.fill();
  if (lineW) {
    ctx.lineWidth = lineW;
    ctx.strokeStyle = outline;
    ctx.stroke();
  }
  // nostril
  ctx.fillStyle = pal.beakShade;
  ctx.beginPath();
  ctx.ellipse(5, -2, 1.3, 0.7, 0.3, 0, TAU);
  ctx.fill();
  ctx.restore();
}


function drawEye(ctx, pal, ex, ey, blink, dizzy, t) {
  if (dizzy > 0.3) {
    // spiral-ish dizzy eye
    ctx.strokeStyle = pal.eye;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let a = 0; a < TAU * 1.6; a += 0.3) {
      const r = 0.6 + a * 0.45;
      const px = ex + Math.cos(a + t * 10) * r;
      const py = ey + Math.sin(a + t * 10) * r;
      if (a === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    return;
  }
  if (blink) {
    ctx.strokeStyle = pal.eye;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(ex - 3, ey + 0.5);
    ctx.quadraticCurveTo(ex, ey + 2.5, ex + 3, ey + 0.5);
    ctx.stroke();
    return;
  }
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.ellipse(ex, ey, 3.6, 4, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = pal.eye;
  ctx.beginPath();
  ctx.ellipse(ex + 0.8, ey + 0.2, 2.4, 2.9, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(ex + 1.6, ey - 1.1, 1, 0, TAU);
  ctx.fill();
}

function drawLegs(ctx, pal, t) {
  const legCol = pal.beak;
  const dark = pal.beakShade;
  for (const side of [-1, 1]) {
    const lx = -2 + side * 7;
    const sway = Math.sin(t * 2 + side) * 0.6;
    ctx.strokeStyle = dark;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(lx, 12);
    ctx.lineTo(lx + sway, 25);
    ctx.stroke();
    // webbed foot
    ctx.fillStyle = legCol;
    ctx.strokeStyle = dark;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx + sway - 2, 25);
    ctx.lineTo(lx + sway + 11, 24);
    ctx.quadraticCurveTo(lx + sway + 8, 27.5, lx + sway + 10, 29);
    ctx.quadraticCurveTo(lx + sway + 4, 28, lx + sway + 3, 30);
    ctx.quadraticCurveTo(lx + sway - 1, 28.5, lx + sway - 3, 28.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Headgear
// ---------------------------------------------------------------------------

function drawHat(ctx, look, t, hx, hy, hr, layer) {
  const id = look.hat;
  const fn = HAT_DRAWERS[id];
  if (!fn) return;
  ctx.save();
  ctx.translate(hx, hy);
  fn(ctx, look, t, hr, layer);
  ctx.restore();
}

// All hat drawers work in head-local coords: head centre = (0,0), radius hr,
// crown of the head at y = -hr. `layer` is 'back' (before head) or 'front'.
const HAT_DRAWERS = {
  tophat(ctx, look, t, hr, layer) {
    if (layer !== 'front') return;
    ctx.rotate(-0.18);
    ctx.fillStyle = '#17171f';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.2;
    roundRect(ctx, -9.5, -hr - 19, 19, 19, 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#c2213d';
    ctx.fillRect(-9.5, -hr - 5, 19, 3.6);
    ctx.fillStyle = '#17171f';
    ctx.beginPath();
    ctx.ellipse(0, -hr - 0.5, 14.5, 3.2, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    // silk highlight
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(-6.5, -hr - 17, 3, 11);
  },

  crown(ctx, look, t, hr, layer) {
    if (layer !== 'front') return;
    const baseY = -hr + 1.5;
    ctx.beginPath();
    ctx.moveTo(-10, baseY);
    ctx.lineTo(-11, baseY - 9);
    ctx.lineTo(-6.5, baseY - 5);
    ctx.lineTo(-3.5, baseY - 12);
    ctx.lineTo(0, baseY - 5.5);
    ctx.lineTo(3.5, baseY - 12);
    ctx.lineTo(6.5, baseY - 5);
    ctx.lineTo(11, baseY - 9);
    ctx.lineTo(10, baseY);
    ctx.closePath();
    // silver tiara, not gold: the gold crown is reserved for the race leader's floating marker
    const g = ctx.createLinearGradient(0, baseY - 12, 0, baseY);
    g.addColorStop(0, '#F7FAFD');
    g.addColorStop(1, '#9DA9B9');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = '#56606E';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = '#8C98A8';
    ctx.fillRect(-10, baseY - 3, 20, 3);
    const jewels = [['#E23D4E', -5.5], ['#2F7BEA', 0], ['#1DB954', 5.5]];
    for (const [c, jx] of jewels) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(jx, baseY - 1.6, 1.3, 0, TAU);
      ctx.fill();
    }
    for (const jx of [-11, -3.5, 3.5, 11]) {
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(jx, baseY - (Math.abs(jx) > 5 ? 9 : 12), 1.1, 0, TAU);
      ctx.fill();
    }
  },

  cowboy(ctx, look, t, hr, layer) {
    if (layer !== 'front') return;
    ctx.rotate(-0.08);
    const baseY = -hr + 2;
    // crown
    ctx.beginPath();
    ctx.moveTo(-9, baseY);
    ctx.quadraticCurveTo(-10, baseY - 13, -5, baseY - 14);
    ctx.quadraticCurveTo(0, baseY - 10, 5, baseY - 14);
    ctx.quadraticCurveTo(10, baseY - 13, 9, baseY);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, baseY - 14, 0, baseY);
    g.addColorStop(0, '#B07A44');
    g.addColorStop(1, '#7A4E24');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = '#4E3012';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = '#4E3012';
    ctx.fillRect(-9, baseY - 3.5, 18, 2.5);
    // brim with upturned ends
    ctx.beginPath();
    ctx.moveTo(-19, baseY - 4);
    ctx.quadraticCurveTo(-16, baseY + 1, -8, baseY + 1);
    ctx.lineTo(8, baseY + 1);
    ctx.quadraticCurveTo(16, baseY + 1, 19, baseY - 4);
    ctx.quadraticCurveTo(17, baseY + 4, 8, baseY + 3.6);
    ctx.lineTo(-8, baseY + 3.6);
    ctx.quadraticCurveTo(-17, baseY + 4, -19, baseY - 4);
    ctx.closePath();
    ctx.fillStyle = '#946034';
    ctx.fill();
    ctx.stroke();
  },

  viking(ctx, look, t, hr, layer) {
    if (layer !== 'front') return;
    // horns first (behind dome edge)
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 8, -hr + 1);
      ctx.quadraticCurveTo(side * 19, -hr - 1, side * 18, -hr - 15);
      ctx.quadraticCurveTo(side * 14, -hr - 6, side * 6, -hr - 4);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, -hr - 15, 0, -hr + 1);
      g.addColorStop(0, '#FFF8E7');
      g.addColorStop(1, '#C9B48A');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = '#7A6A48';
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }
    // dome
    ctx.beginPath();
    ctx.arc(0, -hr + 4, 11, Math.PI * 1.0, Math.PI * 2.0);
    ctx.closePath();
    const dg = ctx.createLinearGradient(0, -hr - 8, 0, -hr + 4);
    dg.addColorStop(0, '#C8D0DA');
    dg.addColorStop(1, '#7C8794');
    ctx.fillStyle = dg;
    ctx.fill();
    ctx.strokeStyle = '#4A525C';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = '#5E6773';
    ctx.fillRect(-11, -hr + 2, 22, 3);
    ctx.fillStyle = '#4A525C';
    ctx.fillRect(-1.2, -hr - 7, 2.4, 10);
    for (const rx of [-7, 0, 7]) {
      ctx.fillStyle = '#E8EDF2';
      ctx.beginPath();
      ctx.arc(rx, -hr + 3.5, 0.9, 0, TAU);
      ctx.fill();
    }
  },

  pirate(ctx, look, t, hr, layer) {
    if (layer === 'back') {
      // knot tails flutter behind the head
      const w = Math.sin(t * 14) * 2;
      ctx.fillStyle = '#C21F30';
      ctx.beginPath();
      ctx.moveTo(-9, -4);
      ctx.quadraticCurveTo(-17, -2 + w, -22, 3 + w);
      ctx.quadraticCurveTo(-16, -1, -10, 0);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-9, -6);
      ctx.quadraticCurveTo(-18, -9 - w, -23, -6 - w);
      ctx.quadraticCurveTo(-16, -5, -9, -3);
      ctx.closePath();
      ctx.fill();
      return;
    }
    // bandana cap: clip to head circle, fill the upper part
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, hr + 0.6, 0, TAU);
    ctx.clip();
    ctx.fillStyle = '#D42A3C';
    ctx.beginPath();
    ctx.moveTo(-14, -2);
    ctx.quadraticCurveTo(0, -7.5, 14, -5);
    ctx.lineTo(14, -16);
    ctx.lineTo(-14, -16);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    for (const [dx, dy] of [[-6, -8], [1, -9.5], [7, -7.5], [-2, -5.5], [-9, -4.5], [5, -12], [-4, -12]]) {
      ctx.beginPath();
      ctx.arc(dx, dy, 1, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = '#8E1522';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-11.2, -2.4);
    ctx.quadraticCurveTo(0, -7.9, 11.3, -5.2);
    ctx.stroke();
    // eye patch + strap
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-9, -7);
    ctx.lineTo(9, -1);
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.ellipse(5.2, -2.8, 3.9, 3.5, 0.3, 0, TAU);
    ctx.fill();
  },

  shades(ctx, look, t, hr, layer) {
    if (layer !== 'front') return;
    // aviators over the eye
    ctx.strokeStyle = '#C9A227';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(-8, -4.5);
    ctx.lineTo(2, -5.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(1.5, -6);
    ctx.quadraticCurveTo(6, -8, 11, -6);
    ctx.quadraticCurveTo(11.5, 1, 6.5, 1.8);
    ctx.quadraticCurveTo(1.5, 1.5, 1.5, -6);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, -8, 0, 2);
    g.addColorStop(0, '#0f1626');
    g.addColorStop(1, '#4a5a78');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.ellipse(4.5, -4.5, 1.2, 2.4, 0.5, 0, TAU);
    ctx.fill();
  },

  headband(ctx, look, t, hr, layer) {
    if (layer !== 'front') return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, hr + 0.7, 0, TAU);
    ctx.clip();
    ctx.rotate(-0.25);
    ctx.fillStyle = '#F4F4F4';
    ctx.fillRect(-14, -9.5, 28, 6);
    ctx.fillStyle = '#E23D4E';
    ctx.fillRect(-14, -7.6, 28, 1.1);
    ctx.fillStyle = '#2F7BEA';
    ctx.fillRect(-14, -5.6, 28, 1.1);
    ctx.restore();
    // terry-cloth edge lines
    ctx.save();
    ctx.rotate(-0.25);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-10.6, -9.5);
    ctx.lineTo(10.8, -9.5);
    ctx.moveTo(-11.3, -3.5);
    ctx.lineTo(11.4, -3.5);
    ctx.stroke();
    ctx.restore();
  },

  bow(ctx, look, t, hr, layer) {
    if (layer !== 'front') return;
    const c = look.palette.id === 'flamingo' || look.palette.id === 'crimson' ? '#7C4DFF' : '#FF4F9A';
    const d = look.palette.id === 'flamingo' || look.palette.id === 'crimson' ? '#4B2BB5' : '#C2185B';
    ctx.translate(-4, -hr + 1);
    ctx.rotate(-0.3);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(side * 6, -9, side * 13, -6, side * 11, 0);
      ctx.bezierCurveTo(side * 13, 6, side * 6, 7, 0, 0);
      ctx.closePath();
      ctx.fillStyle = c;
      ctx.fill();
      ctx.strokeStyle = d;
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(side * 2, 0);
      ctx.quadraticCurveTo(side * 6, -1, side * 8.5, -3);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    for (const [px, py] of [[-7, -3], [6, 2], [-5, 3], [8, -3]]) {
      ctx.beginPath();
      ctx.arc(px, py, 0.9, 0, TAU);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(0, 0, 2.6, 0, TAU);
    ctx.fillStyle = c;
    ctx.fill();
    ctx.stroke();
  },

  propeller(ctx, look, t, hr, layer) {
    if (layer !== 'front') return;
    // beanie panels
    const cols = ['#E23D4E', '#2F7BEA', '#F5D000', '#1DB954'];
    const top = -hr - 4.5;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, -hr + 4, 11.5, 9, 0, Math.PI, TAU);
    ctx.closePath();
    ctx.clip();
    for (let k = 0; k < 4; k++) {
      ctx.fillStyle = cols[k];
      ctx.beginPath();
      ctx.moveTo(0, top - 1);
      ctx.lineTo(-14 + k * 7, -hr + 5);
      ctx.lineTo(-7 + k * 7, -hr + 5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.beginPath();
    ctx.ellipse(0, -hr + 4, 11.5, 9, 0, Math.PI, TAU);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    // stem + spinning blades
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, top);
    ctx.lineTo(0, top - 4);
    ctx.stroke();
    const spin = Math.cos(t * 22);
    ctx.fillStyle = '#FFB020';
    ctx.strokeStyle = '#A86A00';
    ctx.lineWidth = 0.8;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * 5.5 * spin, top - 4.5, Math.max(0.8, Math.abs(5.5 * spin)), 1.6, 0, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = '#333';
    ctx.beginPath();
    ctx.arc(0, top - 4.5, 1.2, 0, TAU);
    ctx.fill();
  },

  snorkel(ctx, look, t, hr, layer) {
    if (layer === 'back') {
      // tube runs up behind the head
      ctx.strokeStyle = '#FF7A2F';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(-3, 2);
      ctx.quadraticCurveTo(-12, -6, -9, -hr - 9);
      ctx.stroke();
      ctx.strokeStyle = '#2b2b2b';
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(-9, -hr - 8);
      ctx.lineTo(-9, -hr - 12);
      ctx.stroke();
      return;
    }
    // strap
    ctx.strokeStyle = '#178F8A';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-11, -3);
    ctx.quadraticCurveTo(-2, -6, 2, -6);
    ctx.stroke();
    // mask
    roundRect(ctx, 0.5, -9, 11.5, 10, 3.5);
    ctx.fillStyle = 'rgba(140, 230, 255, 0.45)';
    ctx.fill();
    ctx.strokeStyle = '#17BEBB';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.ellipse(3.5, -6, 1, 2.2, 0.4, 0, TAU);
    ctx.fill();
  },

  chef(ctx, look, t, hr, layer) {
    if (layer !== 'front') return;
    const baseY = -hr + 2.5;
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#C9CED6';
    ctx.lineWidth = 1.1;
    // puffs
    const puffs = [[-6, baseY - 13, 6], [5, baseY - 14, 6.5], [0, baseY - 19, 6], [-8, baseY - 8, 4.5], [8, baseY - 8, 4.5]];
    ctx.beginPath();
    for (const [px, py, pr] of puffs) {
      ctx.moveTo(px + pr, py);
      ctx.arc(px, py, pr, 0, TAU);
    }
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(-9, baseY - 9, 18, 9);
    ctx.fill();
    // band
    roundRect(ctx, -9.5, baseY - 6, 19, 6, 1.5);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = '#DDE2E8';
    ctx.beginPath();
    for (const lx of [-5, 0, 5]) {
      ctx.moveTo(lx, baseY - 5);
      ctx.lineTo(lx, baseY - 1);
    }
    ctx.stroke();
  },

  wizard(ctx, look, t, hr, layer) {
    if (layer !== 'front') return;
    const baseY = -hr + 2;
    ctx.rotate(-0.12);
    // brim
    ctx.beginPath();
    ctx.ellipse(0, baseY, 15, 3.4, 0, 0, TAU);
    ctx.fillStyle = '#2C2276';
    ctx.fill();
    ctx.strokeStyle = '#17123F';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    // cone with a floppy bent tip
    ctx.beginPath();
    ctx.moveTo(-9.5, baseY - 1);
    ctx.quadraticCurveTo(-4, baseY - 16, -1, baseY - 27);
    ctx.quadraticCurveTo(1, baseY - 33, -7, baseY - 34);
    ctx.quadraticCurveTo(2, baseY - 30, 4, baseY - 22);
    ctx.quadraticCurveTo(7, baseY - 12, 9.5, baseY - 1);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, baseY - 34, 0, baseY);
    g.addColorStop(0, '#5B4BD6');
    g.addColorStop(1, '#2C2276');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.stroke();
    // stars + moon
    ctx.fillStyle = '#FFE066';
    star(ctx, -2, baseY - 9, 2.2);
    star(ctx, 3, baseY - 17, 1.5);
    star(ctx, -3.5, baseY - 21, 1.2);
    ctx.beginPath();
    ctx.arc(2.5, baseY - 5, 1.9, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#2C2276';
    ctx.beginPath();
    ctx.arc(3.4, baseY - 5.6, 1.6, 0, TAU);
    ctx.fill();
  },

  party(ctx, look, t, hr, layer) {
    if (layer !== 'front') return;
    const baseY = -hr + 2.5;
    ctx.rotate(0.1);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-8.5, baseY);
    ctx.lineTo(0, baseY - 23);
    ctx.lineTo(8.5, baseY);
    ctx.closePath();
    ctx.clip();
    const cols = ['#FF3CAC', '#2BD2FF', '#FFE066'];
    for (let k = -4; k < 8; k++) {
      ctx.fillStyle = cols[(k + 6) % 3];
      ctx.beginPath();
      ctx.moveTo(-12 + k * 4, baseY + 2);
      ctx.lineTo(-8 + k * 4, baseY + 2);
      ctx.lineTo(4 + k * 4, baseY - 26);
      ctx.lineTo(0 + k * 4, baseY - 26);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(-8.5, baseY);
    ctx.lineTo(0, baseY - 23);
    ctx.lineTo(8.5, baseY);
    ctx.closePath();
    ctx.strokeStyle = '#8E1B6B';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    // pompom
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#C9CED6';
    ctx.beginPath();
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * TAU + t * 3;
      ctx.moveTo(Math.cos(a) * 2 + 1.6, baseY - 24 + Math.sin(a) * 2);
      ctx.arc(Math.cos(a) * 2, baseY - 24 + Math.sin(a) * 2, 1.6, 0, TAU);
    }
    ctx.fill();
  },

  flower(ctx, look, t, hr, layer) {
    if (layer !== 'front') return;
    const petals = ['#FF6FAE', '#FFFFFF', '#FFB3DE', '#FFF2A8', '#FF8FB3'];
    // leaves
    ctx.fillStyle = '#3FAE5C';
    for (let k = 0; k < 6; k++) {
      const a = Math.PI * (1.08 + k * 0.155);
      const px = Math.cos(a) * (hr - 0.5);
      const py = Math.sin(a) * (hr - 0.5);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(a + Math.PI / 2 + 0.6);
      ctx.beginPath();
      ctx.ellipse(0, 0, 1.6, 3.6, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    for (let k = 0; k < 5; k++) {
      const a = Math.PI * (1.12 + k * 0.19);
      const px = Math.cos(a) * (hr - 0.2);
      const py = Math.sin(a) * (hr - 0.2);
      ctx.fillStyle = petals[k];
      ctx.beginPath();
      for (let p = 0; p < 5; p++) {
        const pa = (p / 5) * TAU + k;
        ctx.moveTo(px + Math.cos(pa) * 1.9 + 1.7, py + Math.sin(pa) * 1.9);
        ctx.arc(px + Math.cos(pa) * 1.9, py + Math.sin(pa) * 1.9, 1.7, 0, TAU);
      }
      ctx.fill();
      ctx.fillStyle = k % 2 ? '#F5B700' : '#FF7A2F';
      ctx.beginPath();
      ctx.arc(px, py, 1.5, 0, TAU);
      ctx.fill();
    }
  },

  headphones(ctx, look, t, hr, layer) {
    if (layer !== 'front') return;
    ctx.strokeStyle = '#22252B';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 1, hr + 1.5, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
    ctx.strokeStyle = '#3A3F48';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 1, hr + 2.6, Math.PI * 1.2, Math.PI * 1.8);
    ctx.stroke();
    // ear cup (side view)
    const c = look.towel.bg === '#F4F4F4' ? '#E23D4E' : look.towel.bg;
    ctx.fillStyle = '#22252B';
    ctx.beginPath();
    ctx.ellipse(-2.5, -0.5, 6, 6.6, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.ellipse(-2.5, -0.5, 4.3, 4.9, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.ellipse(-4, -2.5, 1.4, 2, 0.5, 0, TAU);
    ctx.fill();
  },

  helmet(ctx, look, t, hr, layer) {
    if (layer !== 'front') return;
    // jockey skull cap in the duck's silks (towel colour) with white quarters
    const silk = look.towel.bg === '#F4F4F4' ? '#1F5BD8' : look.towel.bg;
    const cy = -hr + 4.5;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, cy, 12, 10.5, 0, Math.PI, TAU);
    ctx.closePath();
    ctx.fillStyle = silk;
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.moveTo(0, cy - 12);
    ctx.lineTo(-5, cy + 1);
    ctx.lineTo(5, cy + 1);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(-14, cy - 12, 5.5, 14);
    ctx.fillRect(9, cy - 12, 5.5, 14);
    // gloss
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.ellipse(-4, cy - 6.5, 1.6, 3.2, 0.5, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.ellipse(0, cy, 12, 10.5, 0, Math.PI, TAU);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    // peak (brim) pointing forward, flipped up jauntily
    ctx.beginPath();
    ctx.moveTo(6, cy - 0.5);
    ctx.quadraticCurveTo(15, cy - 5.5, 21, cy - 3.5);
    ctx.quadraticCurveTo(16, cy + 1.2, 6, cy + 1.2);
    ctx.closePath();
    ctx.fillStyle = silk;
    ctx.fill();
    ctx.stroke();
    // button on top + band
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(0, cy - 10.8, 1.5, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(-12, cy - 1, 18, 1.6);
  },
};

export const HAT_IDS = Object.keys(HAT_DRAWERS);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function star(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * TAU - Math.PI / 2;
    const rr = k % 2 ? r * 0.45 : r;
    const px = cx + Math.cos(a) * rr;
    const py = cy + Math.sin(a) * rr;
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function shadeOf(hex, k = 0.62) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * k, g * k, b * k);
}

export function lighten(hex, k = 0.35) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k);
}

/**
 * Draw a duck portrait into a (CSS-sized) canvas. The backing store follows the
 * CSS box (w x h at devicePixelRatio) so a 44x40 roster avatar is not a squashed
 * square. Extra pose keys are forwarded to drawDuck.
 * @param {HTMLCanvasElement} canvas
 * @param {object} look
 * @param {{standing?: boolean, t?: number, w?: number, h?: number, size?: number, flap?: number, beakOpen?: number,
 *   tilt?: number, crown?: boolean, hopY?: number, effort?: number, dizzy?: number}} [opts]
 */
export function renderPortrait(canvas, look, { standing = false, t = 0, w, h, size, hopY = 0, effort, ...pose } = {}) {
  const dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const cssW = w ?? size ?? (canvas.clientWidth || 64);
  const cssH = h ?? size ?? (canvas.clientHeight || cssW);
  const bw = Math.max(1, Math.round(cssW * dpr));
  const bh = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  let scale = (cssW / 96) * (standing ? 0.95 : 1.05);
  let baseY = cssH * (standing ? 0.6 : 0.66);
  const { flap = 0, beakOpen = 0, tilt = 0, crown = false, dizzy = 0 } = pose;
  if (standing && crown) {
    // the floating crown sits above the headgear: shrink/lower the pose so a tall hat + crown
    // still fits the canvas (otherwise the champion's crown is clipped off the top)
    const top = 51 + (HAT_HEIGHT[look.hat] || 0); // head + hat + crown above the body centre, local units
    const bottom = 31; // feet below it
    const hop = 6; // hopY range used by the podium loop
    scale = Math.min(scale, (cssH - hop - 2) / (top + bottom));
    baseY = Math.min(Math.max(baseY, top * scale + hop + 1), cssH - bottom * scale);
  }
  drawDuck(ctx, look, {
    x: cssW * 0.47,
    y: baseY - hopY,
    scale,
    t,
    effort: effort ?? 0.2,
    standing,
    flap,
    beakOpen,
    tilt,
    crown,
    dizzy,
  });
}
