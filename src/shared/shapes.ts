// Stavebné dieliky jemných modelov (#182): minikocka (1/8 bloku) nemusí byť plná kocka – môže to byť klin, nárožie,
// doska, stĺpik… Dielik stále zaberá presne jednu bunku mriežky; tvar hovorí len to, ktorá časť kocky je plná.
// Tvary sa nepíšu ručne po stenách: každý je jednotková kocka orezaná polpriestormi (alebo zjednotenie takých kusov)
// a steny, zakrytie strán aj otočenia sa z toho vypočítajú. Nezávisí od Three.js; používa ho world3d (modely),
// mesher (sieť) aj ladiaca stránka (katalóg dielikov).

import { keys, must } from './util.ts';

type V3 = [number, number, number];
// Smer pozdĺž osi mriežky
export type Dir = 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';
export const DIRS: readonly Dir[] = ['x+', 'x-', 'y+', 'y-', 'z+', 'z-']; // poradie strán kocky ako v mesheri (f = 0..5)
// Stena dielika: mnohouholník v jednotkovej kocke (vrcholy proti smeru hodín pri pohľade zvonku), normála
// a strana kocky, na ktorej leží (0..5), alebo -1 pre šikmú či vnútornú stenu
export interface ShapeFace { pts: readonly Readonly<V3>[]; n: Readonly<V3>; side: number }
// Dielik: id (0 je kocka a v zozname nie je), rodina a smery, z ktorých vznikol, steny,
//   cover[f] – ktorú časť strany f dielik zakrýva (maska 5 × 5 vzoriek), full – bity strán zakrytých celých,
//   prism[os] – tvar sa po osi nemení (rovnaké dieliky v rade sa dajú zlúčiť), occ – zatieňuje rohy susedov,
//   vol – približný objem (podiel kocky)
export interface Shape {
  id: number; family: Family; dirs: readonly Dir[]; faces: readonly ShapeFace[];
  cover: readonly number[]; full: number; prism: readonly boolean[]; occ: boolean; vol: number;
}
export const FULL_COVER = (1 << 25) - 1;

// ---- lineárne funkcie bodu v kocke: [ax, ay, az, c] → ax·x + ay·y + az·z + c ----
type Lin = readonly [number, number, number, number];
const axisOf = (d: Dir): number => 'xyz'.indexOf(d.charAt(0));
const positive = (d: Dir): boolean => d.charAt(1) === '+';
// „ako ďaleko v smere d“: 0 na začiatku kocky, 1 na konci
function along(d: Dir): Lin {
  const l: [number, number, number, number] = [0, 0, 0, 0];
  l[axisOf(d)] = positive(d) ? 1 : -1;
  if (!positive(d)) l[3] = 1;
  return l;
}
const comb = (...terms: readonly (readonly [number, Lin])[]): Lin => {
  const o: [number, number, number, number] = [0, 0, 0, 0];
  for (const [k, l] of terms) for (let i = 0; i < 4; i++) o[i] = (o[i] ?? 0) + k * (l[i] ?? 0);
  return o;
};
const ONE: Lin = [0, 0, 0, 1];
// Polpriestor f(p) ≤ 0; inner = rez medzi dvoma kusmi toho istého dielika (stena sa nekreslí)
interface Half { f: Lin; inner?: boolean }
type Piece = readonly Half[];
const le = (f: Lin, inner?: boolean): Half => (inner ? { f, inner } : { f });

// ---- Rodiny dielikov: smery → kusy (kocka orezaná polpriestormi) ----
// up = kam dielik „rastie“ (opačná strana je plná podstava), high / h1 / h2 = ku ktorej strane je najvyšší
const FAMILIES = {
  // klin 45°: šikmá plocha od spodnej hrany po hornú hranu pri strane high
  klin: { name: 'Klin', arity: 2, build: (high: Dir, up: Dir) => [[le(comb([1, along(up)], [-1, along(high)]))]] },
  // nárožie: vonkajší roh valbovej strechy – ihlan s vrcholom v hornom rohu pri stranách h1 a h2
  narozie: { name: 'Nárožie', arity: 3, build: (h1: Dir, h2: Dir, up: Dir) => [[le(comb([1, along(up)], [-1, along(h1)])), le(comb([1, along(up)], [-1, along(h2)]))]] },
  // úžľabie: vnútorný roh strechy – dva kliny spojené do „L“
  uzlabie: {
    name: 'Úžľabie', arity: 3, build: (h1: Dir, h2: Dir, up: Dir) => [
      [le(comb([1, along(up)], [-1, along(h1)])), le(comb([1, along(h2)], [-1, along(h1)]), true)],
      [le(comb([1, along(up)], [-1, along(h2)])), le(comb([1, along(h1)], [-1, along(h2)]), true)]]
  },
  // roh: malý štvorsten v rohu kocky, kde sa stretajú strany d1, d2, d3
  roh: { name: 'Roh', arity: 3, build: (d1: Dir, d2: Dir, d3: Dir) => [[le(comb([2, ONE], [-1, along(d1)], [-1, along(d2)], [-1, along(d3)]))]] },
  // zrezaný roh: kocka bez štvorstena v rohu oproti stranám d1, d2, d3
  zrezany: { name: 'Zrezaný roh', arity: 3, build: (d1: Dir, d2: Dir, d3: Dir) => [[le(comb([1, ONE], [-1, along(d1)], [-1, along(d2)], [-1, along(d3)]))]] },
  // nízky klin (sklon 1 : 2) z dvoch dielikov za sebou: spodok stúpa od 0 po 1/2, vrch od 1/2 po 1.
  // Položený na bok (up vodorovne) je z neho strmý sklon 2 : 1.
  nizkyA: { name: 'Nízky klin – spodok', arity: 2, build: (high: Dir, up: Dir) => [[le(comb([1, along(up)], [-0.5, along(high)]))]] },
  nizkyB: { name: 'Nízky klin – vrch', arity: 2, build: (high: Dir, up: Dir) => [[le(comb([1, along(up)], [-0.5, along(high)], [-0.5, ONE]))]] },
  // doska pri strane side: polovičná a štvrtinová hrúbka
  doska: { name: 'Doska 1/2', arity: 1, build: (side: Dir) => [[le(comb([0.5, ONE], [-1, along(side)]))]] },
  platna: { name: 'Doska 1/4', arity: 1, build: (side: Dir) => [[le(comb([0.75, ONE], [-1, along(side)]))]] },
  // stĺpik: tenký hranol (1/2 × 1/2) stredom bunky v smere osi
  stlpik: {
    name: 'Stĺpik', arity: 1, build: (ax: Dir) => [DIRS.filter(d => axisOf(d) !== axisOf(ax)).map(d => le(comb([0.25, ONE], [-1, along(d)])))]
  },
  // hrot: ihlan s vrcholom v strede hornej strany (vrch komína, kolíka, veže)
  hrot: {
    name: 'Hrot', arity: 1, build: (up: Dir) => [DIRS.filter(d => axisOf(d) !== axisOf(up)).map(d => le(comb([1, along(up)], [-2, along(d)])))]
  },
  // strieška: hrebeň strechy v jednej bunke – stúpa z oboch strán osi side do stredu
  strieska: {
    name: 'Strieška', arity: 2, build: (side: Dir, up: Dir) => [DIRS.filter(d => axisOf(d) === axisOf(side)).map(d => le(comb([1, along(up)], [-2, along(d)])))]
  }
} as const satisfies Record<string, { name: string; arity: number; build: (a: Dir, b: Dir, c: Dir) => Piece[] }>;
export type Family = keyof typeof FAMILIES;
export const FAMILY_NAMES: Readonly<Record<Family, string>> = Object.fromEntries(Object.entries(FAMILIES).map(([k, v]) => [k, v.name])) as Record<Family, string>;

// ---- Geometria: steny kusu = každá rovina orezaná všetkými ostatnými polpriestormi ----
const EPS = 1e-7;
const dot = (a: Readonly<V3>, b: Readonly<V3>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Readonly<V3>, b: Readonly<V3>): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: Readonly<V3>, b: Readonly<V3>): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const evalLin = (f: Lin, p: Readonly<V3>): number => f[0] * p[0] + f[1] * p[1] + f[2] * p[2] + f[3];
// šesť strán kocky ako polpriestory (v poradí DIRS): along(d) − 1 ≤ 0
const CUBE: readonly Half[] = DIRS.map(d => le(comb([1, along(d)], [-1, ONE])));
function clip(poly: readonly V3[], f: Lin): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = must(poly[i]), b = must(poly[(i + 1) % poly.length]), fa = evalLin(f, a), fb = evalLin(f, b);
    if (fa <= EPS) out.push(a);
    if ((fa < -EPS && fb > EPS) || (fa > EPS && fb < -EPS)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
  }
  return out;
}
const snap = (v: number): number => Math.round(v * 1e6) / 1e6;
function pieceFaces(piece: Piece): ShapeFace[] {
  const halves = [...CUBE, ...piece], out: ShapeFace[] = [];
  halves.forEach((h, i) => {
    if (h.inner) return;
    const a: V3 = [h.f[0], h.f[1], h.f[2]], len = Math.hypot(...a), n: V3 = [a[0] / len, a[1] / len, a[2] / len];
    // veľký štvorec v rovine f = 0, vrcholy proti smeru hodín pri pohľade proti normále
    const p0: V3 = [-n[0] * h.f[3] / len, -n[1] * h.f[3] / len, -n[2] * h.f[3] / len];
    const helper: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], t1r = cross(helper, n), l1 = Math.hypot(...t1r);
    const t1: V3 = [t1r[0] / l1, t1r[1] / l1, t1r[2] / l1], t2 = cross(n, t1);
    let poly: V3[] = ([[-9, -9], [9, -9], [9, 9], [-9, 9]] as const).map(([s, t]): V3 => [p0[0] + t1[0] * s + t2[0] * t, p0[1] + t1[1] * s + t2[1] * t, p0[2] + t1[2] * s + t2[2] * t]);
    halves.forEach((o, j) => { if (j !== i && poly.length) poly = clip(poly, o.f); });
    // zahodíme zdvojené vrcholy a steny bez plochy
    const pts: V3[] = [];
    for (const p of poly) {
      const q: V3 = [snap(p[0]), snap(p[1]), snap(p[2])];
      const same = (r: V3 | undefined): boolean => !!r && Math.abs(r[0] - q[0]) + Math.abs(r[1] - q[1]) + Math.abs(r[2] - q[2]) < 1e-5;
      if (!same(pts[pts.length - 1]) && !(pts.length && same(pts[0]) && p === poly[poly.length - 1])) pts.push(q);
    }
    if (pts.length < 3) return;
    let area = 0;
    for (let k = 1; k + 1 < pts.length; k++) area += dot(cross(sub(must(pts[k]), must(pts[0])), sub(must(pts[k + 1]), must(pts[0]))), n) / 2;
    if (area < 1e-5) return;
    // stena na rovine kocky, ktorá sa zhoduje s rovinou iného (skoršieho) polpriestoru, by bola dvakrát
    if (i >= 6 && CUBE.some(c => Math.abs(c.f[0] - h.f[0] / len) + Math.abs(c.f[1] - h.f[1] / len) + Math.abs(c.f[2] - h.f[2] / len) + Math.abs(c.f[3] - h.f[3] / len) < 1e-6)) return;
    out.push({ pts, n: [snap(n[0]), snap(n[1]), snap(n[2])], side: i < 6 ? i : -1 });
  });
  return out;
}
const inside = (pieces: readonly Piece[], p: Readonly<V3>): boolean => pieces.some(pc => pc.every(h => evalLin(h.f, p) <= EPS));
// bod v mnohouholníku steny (vrátane okraja)
function inFace(fc: ShapeFace, p: Readonly<V3>): boolean {
  for (let i = 0; i < fc.pts.length; i++) {
    const a = must(fc.pts[i]), b = must(fc.pts[(i + 1) % fc.pts.length]);
    if (dot(cross(sub(b, a), sub(p, a)), fc.n) < -1e-6) return false;
  }
  return true;
}
// Vzorky zakrytia strany: 5 × 5 bodov v rovine strany (súradnice sveta – rovnaké pre obe strany tej istej roviny)
const SAMPLES = [0.1, 0.3, 0.5, 0.7, 0.9];
function coverOf(faces: readonly ShapeFace[], side: number): number {
  const ax = side >> 1, ua = (ax + 1) % 3, va = (ax + 2) % 3, on = faces.filter(f => f.side === side);
  let mask = 0;
  if (on.length) SAMPLES.forEach((u, i) => {
    SAMPLES.forEach((v, j) => {
      const p: V3 = [0, 0, 0];
      p[ax] = side & 1 ? 0 : 1; p[ua] = u; p[va] = v;
      if (on.some(f => inFace(f, p))) mask |= 1 << (i * 5 + j);
    });
  });
  return mask;
}
// Podpis tvaru: ktoré z 4 × 4 × 4 bodov mriežky sú vnútri (rovnaký tvar z iných smerov má rovnaký podpis)
function signature(pieces: readonly Piece[]): string {
  let s = '';
  for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) { let b = 0; for (let x = 0; x < 4; x++) if (inside(pieces, [(x + 0.5) / 4, (y + 0.5) / 4, (z + 0.5) / 4])) b |= 1 << x; s += b.toString(16); }
  return s;
}

// ---- Katalóg: všetky dieliky zo všetkých smerov (rovnaké tvary len raz), id od 1 ----
export const SHAPES: (Shape | undefined)[] = [undefined];
const byKey = new Map<string, number>();
const bySig = new Map<string, number>();
function* combos(arity: number, picked: Dir[] = []): Generator<Dir[]> {
  if (picked.length === arity) { yield picked; return; }
  for (const d of DIRS) if (picked.every(p => axisOf(p) !== axisOf(d))) yield* combos(arity, [...picked, d]);
}
for (const family of keys(FAMILIES)) {
  const def = FAMILIES[family];
  for (const dirs of combos(def.arity)) {
    const build: (a: Dir, b: Dir, c: Dir) => Piece[] = def.build;
    const pieces = build(must(dirs[0]), dirs[1] ?? 'y+', dirs[2] ?? 'y+'), sig = family + ':' + signature(pieces); // rovnaký tvar tej istej rodiny z iných smerov = ten istý dielik
    let id = bySig.get(sig);
    if (id === undefined) {
      id = SHAPES.length;
      const faces = pieces.flatMap(pieceFaces), cover = DIRS.map((_, f) => coverOf(faces, f));
      const halves = pieces.flat();
      let inSamples = 0;
      for (const ch of sig.slice(sig.indexOf(':') + 1)) for (let b = parseInt(ch, 16); b; b >>= 1) inSamples += b & 1;
      SHAPES.push({
        id, family, dirs, faces, cover, full: cover.reduce((m, c, f) => (c === FULL_COVER ? m | (1 << f) : m), 0),
        prism: [0, 1, 2].map(a => halves.every(h => h.f[a] === 0)), occ: inSamples >= 28, vol: inSamples / 64
      });
      bySig.set(sig, id);
    }
    byKey.set(family + '|' + dirs.join(','), id);
  }
}
if (SHAPES.length > 255) throw new Error('priveľa dielikov na jeden bajt');

// Id dielika rodiny pre dané smery (navzájom kolmé); zlá kombinácia je chyba v modeli
export function shapeId(family: Family, ...dirs: Dir[]): number {
  const id = byKey.get(family + '|' + dirs.join(','));
  if (id === undefined) throw new Error(`neznámy dielik ${family} ${dirs.join(' ')}`);
  return id;
}
// Skratky pre modely (up je predvolene hore)
export const klin = (high: Dir, up: Dir = 'y+'): number => shapeId('klin', high, up);
export const narozie = (h1: Dir, h2: Dir, up: Dir = 'y+'): number => shapeId('narozie', h1, h2, up);
export const uzlabie = (h1: Dir, h2: Dir, up: Dir = 'y+'): number => shapeId('uzlabie', h1, h2, up);
export const roh = (d1: Dir, d2: Dir, d3: Dir): number => shapeId('roh', d1, d2, d3);
export const zrezany = (d1: Dir, d2: Dir, d3: Dir): number => shapeId('zrezany', d1, d2, d3);
export const nizky = (high: Dir, up: Dir = 'y+'): [number, number] => [shapeId('nizkyA', high, up), shapeId('nizkyB', high, up)];
export const doska = (side: Dir = 'y-'): number => shapeId('doska', side);
export const platna = (side: Dir = 'y-'): number => shapeId('platna', side);
export const stlpik = (axis: Dir = 'y+'): number => shapeId('stlpik', axis);
export const hrot = (up: Dir = 'y+'): number => shapeId('hrot', up);
export const strieska = (side: Dir, up: Dir = 'y+'): number => shapeId('strieska', side, up);

// Otočenie o 90° okolo zvislej osi (ako world3d.rotateY: +x → +z → −x → −z): ROT_Y[id] = id otočeného dielika
const TURN: Readonly<Record<Dir, Dir>> = { 'x+': 'z+', 'z+': 'x-', 'x-': 'z-', 'z-': 'x+', 'y+': 'y+', 'y-': 'y-' };
export const ROT_Y: Uint8Array = Uint8Array.from(SHAPES, s => (s ? shapeId(s.family, ...s.dirs.map(d => TURN[d])) : 0));
