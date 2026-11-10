// Fúrik a sane (#158) ako kreslené 2D obrázky v štýle hry: obyčajný 3D predmet (shared/vehicleshape.ts) premietnutý
// v 8 smeroch ako postavička (art.ts char: 0 dole, 1 vľavo, 2 vpravo, 3 hore, 4 vľavo dole, 5 vpravo dole, 6 vľavo hore,
// 7 vpravo hore), plochy vyplnené a tieňované podľa natočenia k svetlu, s tmavým obrysom. Spolujazdec sa kreslí do
// obrázka medzi zadnú a prednú časť (sedí vo vaničke / na doske). Ten istý obrázok je sprite v 3D (vehicles3d.ts),
// v okne Dielne, v lište a pri hláseniach (vehicleIcon).
import type { Look } from '../shared/data.ts';
import type { VehicleId } from '../shared/save.ts';
import { SEAT_Y, vehicleParts } from '../shared/vehicleshape.ts';
import type { Part, V3 } from '../shared/vehicleshape.ts';
import { must } from '../shared/util.ts';
import { Art } from './art.ts';

type C2 = CanvasRenderingContext2D;
type Pt2 = [number, number];
export const PITCH = Math.atan(1 / Math.SQRT2);       // ako kamera hry (render3d.ts)
// smer obrázka (index ako pri postavičke) → smer „dopredu“ na obrazovke (0 = doprava, kladný = dole, k divákovi)
const SCREEN_ANGLE: readonly number[] = [Math.PI / 2, Math.PI, 0, -Math.PI / 2, Math.PI * 3 / 4, Math.PI / 4, -Math.PI * 3 / 4, -Math.PI / 4];
function norm(v: V3): V3 { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
const LIGHT: V3 = norm([-0.45, 0.8, 0.4]);
const TUB_Y = 0.36; // stred vaničky fúrika – ktorá strana tenkej steny je vnútorná
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => Math.round(Math.max(0, Math.min(255, v * k))));
  return `rgb(${c.join(',')})`;
}
export interface Rider { look: Partial<Look> | null }

// Fúrik / sane so stredom na zemi v bode (x, y) plátna, s px na blok (ako postavička: s = 100 → 1 blok = 100 px)
export function drawVehicle(c: C2, id: VehicleId, x: number, y: number, s: number, dir: number, ice: number, rider?: Rider | null): void {
  const th = SCREEN_ANGLE[dir] ?? 0, ct = Math.cos(th), st = Math.sin(th), cp = Math.cos(PITCH), sp = Math.sin(PITCH);
  const view = (p: V3): V3 => [p[0] * ct - p[2] * st, p[1], p[0] * st + p[2] * ct];          // otočený predmet (x doprava, z k divákovi)
  const scr = (v: V3): Pt2 => [x + v[0] * s, y - v[1] * cp * s + v[2] * sp * s];
  const depth = (v: V3): number => v[2] * cp + v[1] * sp;                                   // väčšie = bližšie k divákovi
  const ow = Math.max(1, s * 0.014);
  const path = (pts: Pt2[], close: boolean): void => { c.beginPath(); pts.forEach(([a, b], i) => { if (i) c.lineTo(a, b); else c.moveTo(a, b); }); if (close) c.closePath(); };
  const poly = (pts: Pt2[], fill: string, line: string): void => { path(pts, true); c.fillStyle = fill; c.fill(); c.lineWidth = ow; c.strokeStyle = line; c.stroke(); };
  const items: { d: number; draw: () => void }[] = vehicleParts(id, ice).map(item);
  function item(p: Part): { d: number; draw: () => void } {
    if (p.k === 'poly') {
      const v = p.pts.map(view), avg = (i: 0 | 1 | 2): number => v.reduce((m, q) => m + q[i], 0) / v.length, cen: V3 = [avg(0), avg(1), avg(2)];
      const a = must(v[0]), b = must(v[1]), q = must(v[2]);
      const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w: V3 = [q[0] - a[0], q[1] - a[1], q[2] - a[2]];
      let n = norm([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]);
      if (n[1] * sp + n[2] * cp < 0) n = [-n[0], -n[1], -n[2]]; // strana obrátená k divákovi
      // tenká stena vaničky: keď vidno jej stranu obrátenú do stredu vaničky, je to vnútro (tmavšie)
      const inside = !!p.inner && cen[0] * n[0] + (cen[1] - TUB_Y) * n[1] + cen[2] * n[2] < 0, base = inside && p.inner ? p.inner : p.fill;
      // stena vaničky: vnútro (zadné steny) sa kreslí pred ľadom a spolujazdcom, vonkajšia strana (predné steny) po nich
      const bias = (p.bias ?? 0) + (p.inner ? (inside ? -0.2 : 0.2) : 0);
      const k = 0.62 + 0.45 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
      return { d: depth(cen) + bias, draw: () => { poly(v.map(scr), shade(base, k), shade(base, 0.45)); } };
    }
    if (p.k === 'stick') {
      const v = p.pts.map(view), d = v.reduce((m, q) => m + depth(q), 0) / v.length + (p.bias ?? 0);
      return { d, draw: () => {
        const pts = v.map(scr);
        c.lineCap = 'round'; c.lineJoin = 'round';
        c.strokeStyle = shade(p.fill, 0.45); c.lineWidth = p.w * s + ow * 2; path(pts, false); c.stroke();
        c.strokeStyle = p.fill; c.lineWidth = p.w * s; path(pts, false); c.stroke();
      } };
    }
    // koleso: kruh v rovine x–y; zadná a predná strana pneumatiky, svetlejší náboj so špicami
    const side = view([0, 0, 1])[2] >= 0 ? 1 : -1, wheel = p;
    const at = (r: number, t: number, z: number): Pt2 => scr(view([wheel.c[0] + Math.cos(t) * r, wheel.c[1] + Math.sin(t) * r, wheel.c[2] + z]));
    const ring = (r: number, z: number): Pt2[] => Array.from({ length: 24 }, (_, i) => at(r, i / 24 * Math.PI * 2, z));
    const z = side * wheel.w / 2;
    return { d: depth(view(wheel.c)), draw: () => {
      poly(ring(wheel.r, -z), shade(wheel.fill, 0.7), shade(wheel.fill, 0.4));
      poly(ring(wheel.r, z), shade(wheel.fill, 1), shade(wheel.fill, 0.4));
      poly(ring(wheel.r * 0.66, z), shade(wheel.hub, 0.85), shade(wheel.hub, 0.5));
      c.strokeStyle = shade(wheel.hub, 0.5); c.lineWidth = ow * 1.3;
      for (let i = 0; i < 4; i++) { const t = i * Math.PI / 4; path([at(wheel.r * 0.62, t, z), at(wheel.r * 0.62, t + Math.PI, z)], false); c.stroke(); }
      poly(ring(wheel.r * 0.18, z), shade(wheel.hub, 1.1), shade(wheel.hub, 0.5));
    } };
  }
  // spolujazdec sedí v strede: za ním je to, čo je ďalej od diváka, pred ním zvyšok (predná stena mu zakryje nohy)
  if (rider) {
    const seat = view([id === 'furik' ? -0.04 : -0.06, SEAT_Y[id], 0]), [rx, ry] = scr(seat);
    items.push({ d: depth(seat) - 0.02, draw: () => { Art.char(c, rx, ry, s * 0.82, rider.look, dir, 0, { crawl: true, noShadow: true }); } }); // o niečo menší – sedí, nohy má vo vaničke
  }
  c.save();
  c.lineJoin = 'round';
  items.sort((a, b) => a.d - b.d);
  for (const it of items) it.draw();
  c.restore();
}

// Obrázok do okna, lišty a hlásení: size × size px, pohľad spredu zboku (smer 5 – vpravo dole); data URL v pamäti
const cache = new Map<string, string>();
export function vehicleIcon(id: VehicleId, ice: number, size = 64, dir = 5): string {
  const key = `${id}|${String(ice)}|${String(size)}|${String(dir)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  drawVehicle(must(cv.getContext('2d') ?? undefined), id, size / 2, size * 0.6, size * 0.98, dir, ice);
  const url = cv.toDataURL();
  cache.set(key, url);
  return url;
}
