// Záložka Assets, optimalizácia siete (#176): čisté výpočty bez DOM – pixely obrázkov na kreslenie, počty stien
// a obdĺžnik pod texelom. Stránka (mesherview.ts) aj test ich importujú.
import type { AtlasRect } from '../../client/finebake.ts';
import type { Baked, Quad } from '../../shared/mesher.ts';
import type { FineModel } from '../../shared/world3d.ts';

export type ColorMode = 'color' | 'emission';
export const FACE_NAMES = ['+x', '−x', '+y (top)', '−y (bottom)', '+z', '−z'];
export const faceOf = (q: Pick<Quad, 'ax' | 'sg'>): number => q.ax * 2 + (q.sg > 0 ? 0 : 1);

// RGBA pixely obrázka na kreslenie: farba s nepriehľadnou alfou (v obrázku je alfa žiarenie, väčšina stien by bola
// neviditeľná), žiarenie ako maska (žltá = svieti, sivá = nie), zatienenie sivo – stretch roztiahne rozsah na 0–255
export function atlasPixels(b: Pick<Baked, 'color' | 'ao'>, which: 'color' | 'emission' | 'ao', stretch = false): { W: number; H: number; px: Uint8ClampedArray<ArrayBuffer> } {
  if (which === 'ao') {
    const { W, H, data } = b.ao, px = new Uint8ClampedArray(W * H * 4);
    let lo = 255, hi = 0;
    if (stretch) for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = stretch && hi > lo ? hi - lo : 0;
    for (let i = 0; i < W * H; i++) {
      const v = data[i] ?? 0, g = span ? Math.round((v - lo) * 255 / span) : v;
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = g; px[i * 4 + 3] = 255;
    }
    return { W, H, px };
  }
  const { W, H, data } = b.color, px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (which === 'color') { px[o] = data[o] ?? 0; px[o + 1] = data[o + 1] ?? 0; px[o + 2] = data[o + 2] ?? 0; }
    else { const e = (data[o + 3] ?? 0) > 127; px[o] = e ? 255 : 70; px[o + 1] = e ? 214 : 70; px[o + 2] = e ? 60 : 70; }
    px[o + 3] = 255;
  }
  return { W, H, px };
}

// Počty: steny minikociek bez zlúčenia (ako kedysi), zlúčené obdĺžniky, trojuholníky, zaplnenie obrázkov, pamäť
export interface MeshStats {
  voxelFaces: number; quads: number; trisBefore: number; trisAfter: number;
  color: { W: number; H: number; used: number; bytes: number }; ao: { W: number; H: number; used: number; bytes: number };
  meshBytes: number;
}
export function meshStats(f: FineModel, b: Baked): MeshStats {
  const { sx, sy, sz, data } = f;
  const get = (x: number, y: number, z: number): number => (y < 0 ? 1 : (x < 0 || z < 0 || x >= sx || y >= sy || z >= sz) ? 0 : data[(z * sy + y) * sx + x] ?? 0);
  let faces = 0;
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
    if (!data[(z * sy + y) * sx + x]) continue;
    faces += (get(x + 1, y, z) ? 0 : 1) + (get(x - 1, y, z) ? 0 : 1) + (get(x, y + 1, z) ? 0 : 1) + (get(x, y - 1, z) ? 0 : 1) + (get(x, y, z + 1) ? 0 : 1) + (get(x, y, z - 1) ? 0 : 1);
  }
  let cu = 0, au = 0;
  for (const q of b.quads) { cu += q.w * q.h; au += (q.w + 1) * (q.h + 1); }
  return {
    voxelFaces: faces, quads: b.quads.length, trisBefore: faces * 2, trisAfter: b.quads.length * 2,
    color: { W: b.color.W, H: b.color.H, used: cu, bytes: b.color.data.length },
    ao: { W: b.ao.W, H: b.ao.H, used: au, bytes: b.ao.data.length },
    meshBytes: b.P.byteLength + b.N.byteLength + b.UV.byteLength + b.UV2.byteLength + b.I.byteLength
  };
}

// Zlúčený obdĺžnik pod texelom (x, y) obrázka, alebo -1 (okraj, voľné miesto)
export function quadAt(rects: readonly AtlasRect[], x: number, y: number): number {
  for (let k = 0; k < rects.length; k++) { const r = rects[k]; if (r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return k; }
  return -1;
}

