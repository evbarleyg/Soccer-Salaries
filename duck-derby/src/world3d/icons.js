// Procedurally drawn item icons (Canvas 2D) shared by the HUD slot and the
// little held-item sprites above the ducks. No image files, no emoji fonts.
import { ITEMS } from './items.js';

/** Draw item `id` centred in a w×h box on ctx. */
export function drawItemIcon(g, id, x, y, size) {
  g.save();
  g.translate(x, y);
  const s = size / 100; // design space: 100×100 centred on 0,0
  g.scale(s, s);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  switch (id) {
    case 'bread':
    case 'triple': {
      const loaf = (ox, oy, sc = 1) => {
        g.save();
        g.translate(ox, oy);
        g.scale(sc, sc);
        g.fillStyle = '#e8a33c';
        g.strokeStyle = '#7a4a12';
        g.lineWidth = 5;
        g.beginPath();
        g.moveTo(-34, 20);
        g.lineTo(-34, -4);
        g.bezierCurveTo(-36, -30, 36, -30, 34, -4);
        g.lineTo(34, 20);
        g.closePath();
        g.fill();
        g.stroke();
        g.fillStyle = '#f6d08a';
        g.beginPath();
        g.ellipse(0, -8, 26, 11, 0, Math.PI, 0);
        g.fill();
        g.strokeStyle = '#c77d22';
        g.lineWidth = 4;
        for (const dx of [-14, 0, 14]) { g.beginPath(); g.moveTo(dx - 5, -16); g.lineTo(dx + 5, -4); g.stroke(); }
        g.restore();
      };
      if (id === 'triple') { loaf(-20, 14, 0.62); loaf(20, 14, 0.62); loaf(0, -14, 0.7); } else loaf(0, 2, 1);
      break;
    }
    case 'hornet': {
      // wings
      g.fillStyle = 'rgba(220,245,255,0.9)';
      g.strokeStyle = '#5a7080';
      g.lineWidth = 3;
      for (const sx of [-1, 1]) { g.beginPath(); g.ellipse(sx * 18, -24, 12, 22, sx * 0.6, 0, Math.PI * 2); g.fill(); g.stroke(); }
      // body
      g.fillStyle = '#ffd23f';
      g.strokeStyle = '#1b1b1b';
      g.lineWidth = 5;
      g.beginPath();
      g.ellipse(0, 6, 34, 24, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = '#1b1b1b';
      for (const dx of [-12, 6]) { g.fillRect(dx, -16, 9, 44); }
      // stinger + angry eye
      g.beginPath(); g.moveTo(34, 4); g.lineTo(48, 8); g.lineTo(34, 14); g.closePath(); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(-24, 0, 7, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#e0362c'; g.beginPath(); g.arc(-25, 1, 3.5, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'stone': {
      g.fillStyle = '#8fa3ad';
      g.strokeStyle = '#3d4c54';
      g.lineWidth = 5;
      g.beginPath();
      g.ellipse(0, 4, 38, 22, -0.15, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.45)';
      g.beginPath(); g.ellipse(-10, -6, 16, 7, -0.2, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#66d6ff'; g.lineWidth = 4;
      for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(-30 + k * 26, 34, 8 + k * 2, Math.PI * 1.1, Math.PI * 1.9); g.stroke(); }
      break;
    }
    case 'shield': {
      const grd = g.createRadialGradient(-12, -14, 4, 0, 0, 42);
      grd.addColorStop(0, 'rgba(255,255,255,0.95)');
      grd.addColorStop(0.35, 'rgba(140,225,255,0.55)');
      grd.addColorStop(1, 'rgba(60,160,230,0.75)');
      g.fillStyle = grd;
      g.strokeStyle = '#bdf0ff';
      g.lineWidth = 5;
      g.beginPath(); g.arc(0, 0, 40, 0, Math.PI * 2); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 6;
      g.beginPath(); g.arc(0, 0, 30, Math.PI * 1.15, Math.PI * 1.55); g.stroke();
      break;
    }
    case 'mud': {
      g.fillStyle = '#7a5230';
      g.strokeStyle = '#3e2612';
      g.lineWidth = 5;
      g.beginPath();
      const n = 9;
      for (let k = 0; k <= n; k++) {
        const a = (k / n) * Math.PI * 2;
        const r = k % 2 ? 40 : 26;
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r + 4;
        if (k === 0) g.moveTo(px, py); else g.quadraticCurveTo(Math.cos(a - Math.PI / n) * 20, Math.sin(a - Math.PI / n) * 20 + 4, px, py);
      }
      g.closePath(); g.fill(); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.3)'; g.beginPath(); g.ellipse(-10, -8, 10, 6, -0.4, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'feather': {
      g.save();
      g.rotate(-0.6);
      const grd = g.createLinearGradient(-40, 0, 40, 0);
      grd.addColorStop(0, '#fff1a8'); grd.addColorStop(0.5, '#ffd23f'); grd.addColorStop(1, '#e09a10');
      g.fillStyle = grd; g.strokeStyle = '#8a5a00'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(-44, 0); g.bezierCurveTo(-20, -30, 30, -24, 46, 0); g.bezierCurveTo(30, 24, -20, 30, -44, 0); g.closePath(); g.fill(); g.stroke();
      g.strokeStyle = '#8a5a00'; g.lineWidth = 4; g.beginPath(); g.moveTo(-56, 0); g.lineTo(44, 0); g.stroke();
      g.lineWidth = 2; for (let k = -3; k <= 3; k++) { g.beginPath(); g.moveTo(k * 10, 0); g.lineTo(k * 10 + 8, -14); g.moveTo(k * 10, 0); g.lineTo(k * 10 + 8, 14); g.stroke(); }
      g.restore();
      // sparkle
      g.fillStyle = '#fff'; star(g, 26, -26, 9); star(g, -30, 22, 6);
      break;
    }
    case 'seagull': {
      g.fillStyle = '#3d7be0'; g.beginPath(); g.arc(0, 0, 44, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#ffffff'; g.lineWidth = 9;
      g.beginPath(); g.moveTo(-38, 4); g.quadraticCurveTo(-20, -22, 0, 0); g.quadraticCurveTo(20, -22, 38, 4); g.stroke();
      g.fillStyle = '#ffb020'; g.beginPath(); g.moveTo(-4, 4); g.lineTo(4, 4); g.lineTo(0, 14); g.closePath(); g.fill();
      g.fillStyle = '#ffd23f'; star(g, 26, 26, 8); 
      break;
    }
    case 'hotdog': {
      g.fillStyle = '#e8a33c'; g.strokeStyle = '#7a4a12'; g.lineWidth = 4;
      g.beginPath(); g.ellipse(0, 0, 44, 18, -0.3, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#c4452d'; g.beginPath(); g.ellipse(0, -2, 40, 10, -0.3, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#ffd23f'; g.lineWidth = 4; g.beginPath();
      for (let k = -4; k <= 4; k++) { const px = k * 9; const py = -2 - px * 0.3 + (k % 2 ? 4 : -4); if (k === -4) g.moveTo(px, py); else g.lineTo(px, py); }
      g.stroke();
      break;
    }
    default: {
      g.fillStyle = '#fff'; g.font = '900 70px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', 0, 4);
    }
  }
  g.restore();
}

function star(g, x, y, r) {
  g.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const rr = k % 2 ? r * 0.35 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}

const cache = new Map();
/** A cached canvas for item id at pixel size. */
export function itemIconCanvas(id, size = 96) {
  const key = id + size;
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  drawItemIcon(g, id, size / 2, size / 2, size * 0.9);
  cache.set(key, c);
  return c;
}

export const itemName = (id) => (ITEMS[id] ? ITEMS[id].name : id);
