// 2D obrázky fúrika a saní (#158) priamo z ich 3D modelu (world3d.ts vehicleModel): minikocky v izometrii,
// vrch svetlý, boky tmavšie – do okna Dielne, do lišty a k hláseniam. Hra modul načíta až pri prvej potrebe
// (je v tom istom kúsku balíka ako 3D pohľad); obrázky sa pamätajú ako data URL.
import * as W from '../shared/world3d.ts';
import type { VehicleId } from '../shared/save.ts';
import { must } from '../shared/util.ts';

const cache = new Map<string, string>();
const rgb = (hex: string): [number, number, number] => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const shade = (c: readonly [number, number, number], k: number): string => `rgb(${c.map(v => Math.round(Math.min(255, v * k))).join(',')})`;

// Obrázok size × size (px) fúrika či saní s ice kusmi ľadu, natočený dopredu doprava dole
export function vehicleIcon(id: VehicleId, ice: number, size = 64): string {
  const key = id + '|' + String(ice) + '|' + String(size);
  const hit = cache.get(key);
  if (hit) return hit;
  const f = W.vehicleModel(id, ice), { sx, sy, sz, data } = f;
  const at = (x: number, y: number, z: number): number => (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : data[(z * sy + y) * sx + x] ?? 0);
  // izometria: dopredu (+x) ide doprava dole, do strany (+z) doľava dole, hore (+y) hore
  const C = Math.cos(Math.PI / 6), Sn = 0.5;
  const px = (x: number, z: number): number => (x - z) * C;
  const py = (x: number, y: number, z: number): number => (x + z) * Sn - y;
  const cells: [number, number, number, number][] = [];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
    const m = at(x, y, z);
    if (!m) continue;
    cells.push([x, y, z, m]);
    for (const [cx, cy, cz] of [[x, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1], [x, y, z]] as const) {
      x0 = Math.min(x0, px(cx, cz)); x1 = Math.max(x1, px(cx, cz)); y0 = Math.min(y0, py(cx, cy, cz)); y1 = Math.max(y1, py(cx, cy, cz));
    }
  }
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const c = must(cv.getContext('2d') ?? undefined);
  const pad = size * 0.06, k = Math.min((size - 2 * pad) / (x1 - x0), (size - 2 * pad) / (y1 - y0));
  const ox = (size - (x1 - x0) * k) / 2 - x0 * k, oy = (size - (y1 - y0) * k) / 2 - y0 * k;
  const P = (x: number, y: number, z: number): [number, number] => [ox + px(x, z) * k, oy + py(x, y, z) * k];
  const quad = (pts: [number, number][], fill: string): void => {
    c.beginPath(); pts.forEach(([a, b], i) => { if (i) c.lineTo(a, b); else c.moveTo(a, b); }); c.closePath();
    c.fillStyle = fill; c.fill(); c.strokeStyle = fill; c.lineWidth = 0.6; c.stroke(); // bez svetlých škár medzi kockami
  };
  // odzadu dopredu: najprv vzdialené (menšie x + z), v stĺpci odspodu
  cells.sort((a, b) => (a[0] + a[2]) - (b[0] + b[2]) || a[1] - b[1] || a[0] - b[0]);
  for (const [x, y, z, m] of cells) {
    const col = rgb(W.colorOf(m, 1));
    if (!at(x, y + 1, z)) quad([P(x, y + 1, z), P(x + 1, y + 1, z), P(x + 1, y + 1, z + 1), P(x, y + 1, z + 1)], shade(col, 1.08));
    if (!at(x + 1, y, z)) quad([P(x + 1, y + 1, z), P(x + 1, y + 1, z + 1), P(x + 1, y, z + 1), P(x + 1, y, z)], shade(col, 0.82));
    if (!at(x, y, z + 1)) quad([P(x, y + 1, z + 1), P(x + 1, y + 1, z + 1), P(x + 1, y, z + 1), P(x, y, z + 1)], shade(col, 0.64));
  }
  const url = cv.toDataURL();
  cache.set(key, url);
  return url;
}
