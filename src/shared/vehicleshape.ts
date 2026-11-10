// Tvar fúrika a saní (#158) ako obyčajných 3D predmetov – mnohouholníky a palice v blokoch, stred na zemi v (0, 0, 0),
// „dopredu“ je +x, hore +y, z = do strany. Kreslí ich client/vehicleart.ts ako kreslený 2D obrázok (8 smerov ako
// postavička, tieňovanie ako pri 3D predmete); tu nie je DOM, aby sa rozmery dali otestovať.
// Oba sú najviac taký dlhý ako hráč (VEHICLE_LEN).
import type { VehicleId } from './save.ts';

export type V3 = readonly [number, number, number];
// Plocha (mnohouholník; inner = farba odvrátenej strany pri tenkej stene, inak sa odvrátená strana nekreslí),
// palica (čiara s hrúbkou w), koleso (kruh v rovine x–y so stredom c a polomerom r, hrúbka w) a miesto pre spolujazdca
export type Part =
  | { k: 'poly'; pts: V3[]; fill: string; inner?: string; layer?: 'ice'; bias?: number }
  | { k: 'stick'; pts: V3[]; w: number; fill: string; bias?: number }   // bias: posun v poradí kreslenia (pod doskou < 0, na doske > 0)
  | { k: 'wheel'; c: V3; r: number; w: number; fill: string; hub: string };
export const VEHICLE_LEN = 0.9;   // najväčšia dĺžka (bloky) – hráč je vysoký asi 1 blok
export const SEAT_Y: Readonly<Record<VehicleId, number>> = { furik: 0.27, sane: 0.2 }; // kde sedí spolujazdec

const RED = '#d8432f', RED_IN = '#9c2b1f', WOOD = '#a8743f', WOOD_D = '#7a4f28', WOOD_L = '#c9965a', IRON = '#4a4d55', ICE = '#bfe6fb', ROPE = '#d8c08a';
// Kváder (6 plôch) od a po b
function box(a: V3, b: V3, fill: string, layer?: 'ice', bias = 0): Part[] {
  const [x0, y0, z0] = a, [x1, y1, z1] = b;
  const q = (pts: V3[]): Part => (layer ? { k: 'poly', pts, fill, layer, bias } : { k: 'poly', pts, fill });
  return [
    q([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]),     // vrch
    q([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]),     // spodok
    q([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]),     // predok
    q([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]),     // zadok
    q([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]),     // pravý bok
    q([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]])      // ľavý bok
  ];
}
// Kocky ľadu: 3 vedľa seba na dne (y0), ďalšie 3 navrchu, trochu posunuté
function iceBlocks(n: number, xs: readonly number[], y0: number, e: number, bias = 0): Part[] {
  const out: Part[] = [];
  for (let k = 0; k < Math.min(6, n); k++) {
    const top = k >= 3, x = (xs[k % 3] ?? 0) + (top ? e * 0.35 : 0), z = top ? 0.02 : (k % 2 ? -0.04 : 0.04), y = y0 + (top ? e * 0.95 : 0);
    out.push(...box([x - e / 2, y, z - e / 2], [x + e / 2, y + e, z + e / 2], ICE, 'ice', bias + (top ? 0.01 : 0)));
  }
  return out;
}

// Fúrik: vanička (šikmé steny, tenké – vidno dnu), koleso vpredu, dve rúčky dozadu a dve nôžky
function furik(ice: number): Part[] {
  const yb = 0.27, yt = 0.45, b = { x0: -0.17, x1: 0.13, z: 0.12 }, t = { x0: -0.26, x1: 0.28, z: 0.2 };
  const B = (x: number, z: number): V3 => [x, yb, z], T = (x: number, z: number): V3 => [x, yt, z];
  const wall = (pts: V3[]): Part => ({ k: 'poly', pts, fill: RED, inner: RED_IN });
  return [
    { k: 'wheel', c: [0.31, 0.13, 0], r: 0.13, w: 0.06, fill: '#3a3a40', hub: WOOD_L },
    { k: 'stick', pts: [[0.31, 0.13, 0.04], [0.1, 0.26, 0.11]], w: 0.035, fill: WOOD_D, bias: -0.3 },    // oje (pod vaničkou) k osi kolesa
    { k: 'stick', pts: [[0.31, 0.13, -0.04], [0.1, 0.26, -0.11]], w: 0.035, fill: WOOD_D, bias: -0.3 },
    { k: 'stick', pts: [[0.1, 0.26, 0.12], [-0.44, 0.38, 0.16]], w: 0.04, fill: WOOD, bias: -0.3 },      // rúčky
    { k: 'stick', pts: [[0.1, 0.26, -0.12], [-0.44, 0.38, -0.16]], w: 0.04, fill: WOOD, bias: -0.3 },
    { k: 'stick', pts: [[-0.13, 0.27, 0.12], [-0.15, 0, 0.13]], w: 0.035, fill: WOOD_D, bias: -0.3 },    // nôžky
    { k: 'stick', pts: [[-0.13, 0.27, -0.12], [-0.15, 0, -0.13]], w: 0.035, fill: WOOD_D, bias: -0.3 },
    { k: 'poly', pts: [B(b.x0, -b.z), B(b.x0, b.z), B(b.x1, b.z), B(b.x1, -b.z)], fill: RED_IN, bias: -0.3 },   // dno
    wall([B(b.x0, -b.z), T(t.x0, -t.z), T(t.x0, t.z), B(b.x0, b.z)]),                                             // zadná stena
    wall([B(b.x1, -b.z), B(b.x1, b.z), T(t.x1, t.z), T(t.x1, -t.z)]),                                             // predná (šikmá)
    wall([B(b.x0, b.z), T(t.x0, t.z), T(t.x1, t.z), B(b.x1, b.z)]),                                               // boky
    wall([B(b.x0, -b.z), B(b.x1, -b.z), T(t.x1, -t.z), T(t.x0, -t.z)]),
    ...iceBlocks(ice, [-0.12, 0.0, 0.12], yb, 0.12)
  ];
}
// Sane: dve sanice so zahnutou špičkou, stĺpiky, doska z latiek a lano vpredu
function sane(ice: number): Part[] {
  const out: Part[] = [];
  for (const z of [-0.15, 0.15]) {
    out.push({ k: 'stick', pts: [[-0.4, 0.02, z], [0.3, 0.02, z], [0.4, 0.06, z], [0.44, 0.15, z], [0.4, 0.23, z]], w: 0.035, fill: IRON, bias: -0.5 });
    for (const x of [-0.3, -0.02, 0.26]) out.push({ k: 'stick', pts: [[x, 0.02, z], [x, 0.16, z]], w: 0.035, fill: WOOD_D, bias: -0.5 });
  }
  out.push(...box([-0.4, 0.16, -0.21], [0.34, 0.2, 0.21], WOOD_L));                                                 // doska
  for (let x = -0.33; x < 0.3; x += 0.12) out.push({ k: 'stick', pts: [[x, 0.201, -0.21], [x, 0.201, 0.21]], w: 0.012, fill: WOOD_D, bias: 0.02 }); // škáry medzi latkami
  out.push({ k: 'stick', pts: [[0.4, 0.23, -0.15], [0.4, 0.23, 0.15]], w: 0.035, fill: WOOD_D });                     // priečka vpredu
  out.push({ k: 'stick', pts: [[0.4, 0.23, -0.08], [0.46, 0.14, -0.02], [0.45, 0.08, 0.04], [0.4, 0.23, 0.08]], w: 0.018, fill: ROPE }); // slučka lana
  out.push(...iceBlocks(ice, [-0.24, -0.08, 0.08], 0.2, 0.13, 0.15)); // ľad je vždy na doske
  return out;
}
export function vehicleParts(id: VehicleId, ice: number): Part[] { return id === 'sane' ? sane(ice) : furik(ice); }
// Rozmer predmetu v smere x (dĺžka) a z (šírka), bloky
export function extent(parts: readonly Part[]): { len: number; wid: number; top: number } {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
  const add = (p: V3, r = 0): void => { x0 = Math.min(x0, p[0] - r); x1 = Math.max(x1, p[0] + r); z0 = Math.min(z0, p[2] - r); z1 = Math.max(z1, p[2] + r); top = Math.max(top, p[1] + r); };
  for (const p of parts) {
    if (p.k === 'wheel') add(p.c, p.r);
    else for (const q of p.pts) add(q, p.k === 'stick' ? p.w / 2 : 0);
  }
  return { len: x1 - x0, wid: z1 - z0, top };
}
