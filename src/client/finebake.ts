// Vypečenie jemného modelu (Mesher.bakeModel) presne ako v hre: farba materiálu × tieňovanie strany × jemná variácia
// minikocky (drevo, kameň, šindle), alfa = žiarenie, zatienenie rohov podľa AO_CURVE. Bez Three.js – používa ho
// render3d.ts aj ladiaca záložka Assets (#176), aby ladiaci pohľad ukazoval tie isté obrázky ako hra.
import * as W from '../shared/world3d.ts';
import type { FineModel } from '../shared/world3d.ts';
import * as MS from '../shared/mesher.ts';
import type { Baked } from '../shared/mesher.ts';
import { must } from '../shared/util.ts';

type V3 = [number, number, number];
export const FACE_SHADE: readonly number[] = [0.62, 0.62, 1.0, 0.5, 0.8, 0.8]; // +x, -x, +y, -y, +z, -z (ako v Minecrafte)
export const AO_CURVE: readonly number[] = [0.5, 0.68, 0.84, 1];
export const hex = (h: string): V3 => { const n = parseInt(h.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

// Model v obdobím se → sieť v minikockách (P v bunkách mriežky) a dva obrázky; pod modelom je zem (y < 0 je plné)
export function bakeFine(f: FineModel, se: number): Baked {
  const { sx, sy, sz, data } = f;
  const get = (x: number, y: number, z: number): number => (y < 0 ? 1 : (x < 0 || z < 0 || x >= sx || y >= sy || z >= sz) ? 0 : data[(z * sy + y) * sx + x] ?? 0);
  const cols = new Map<number, V3>(); // pracujeme priamo v sRGB ako kresby z art.ts (bez prevodu farieb)
  return MS.bakeModel([sx, sy, sz], get, v => !!v, (m, x, y, z, fi) => {
    let c = cols.get(m);
    if (!c) { c = hex(W.colorOf(m, se)); cols.set(m, c); }
    const vary = 0.94 + W.hash(x, y, z) * 0.12, sh = must(FACE_SHADE[fi]);
    return [Math.min(1, c[0] * vary) * sh, Math.min(1, c[1] * vary) * sh, Math.min(1, c[2] * vary) * sh, W.EMISSIVE[m] ? 1 : 0];
  }, AO_CURVE);
}

// Obdĺžnik každého zlúčeného obdĺžnika v oboch obrázkoch (v texeloch, bez okraja 1 texel) – zo súradníc UV a UV2 siete
export interface AtlasRect { x: number; y: number; w: number; h: number }
export function atlasRects(b: Pick<Baked, 'quads' | 'UV' | 'UV2' | 'color' | 'ao'>): { color: AtlasRect[]; ao: AtlasRect[] } {
  const color: AtlasRect[] = [], ao: AtlasRect[] = [];
  b.quads.forEach((q, k) => {
    // roh 0 je (du, dv) = (0, 0) pri oboch znamienkach normály, roh 2 je (1, 1)
    const u0 = (b.UV[k * 8] ?? 0) * b.color.W, v0 = (b.UV[k * 8 + 1] ?? 0) * b.color.H;
    color.push({ x: Math.round(u0), y: Math.round(v0), w: q.w, h: q.h });
    const a0 = (b.UV2[k * 8] ?? 0) * b.ao.W - 0.5, b0 = (b.UV2[k * 8 + 1] ?? 0) * b.ao.H - 0.5;
    ao.push({ x: Math.round(a0), y: Math.round(b0), w: q.w + 1, h: q.h + 1 });
  });
  return { color, ao };
}
