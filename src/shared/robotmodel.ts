// Hráč ako 3D robot (#194): opis robota bez Three.js – kĺby (stromček), diely z hladkých tvarov (zaoblená kocka, valec,
// guľa, kapsula, prstenec, kupola), úchyty pre náradie (ruky, nosič na chrbte, temeno) a póza podľa toho, čo robí
// (chôdza, plazenie, tanec, hrabanie, skok). Z opisu stavia sieť client/robot3d.ts (hra aj /debug → Robots); polohu ruky
// (lampáš, lano saní) vie spočítať aj server alebo test bez prehliadača (mountAt).
// Roboty sú vlastné – inšpirované žánrom malých hrdzavých robotov po konci sveta (pásy, veľké oči ako ďalekohľad,
// ošúchaný náter), ale hladké a milé.
// Súradnice: 1 = políčko, y hore, robot pozerá na +z (dopredu), jeho pravá ruka je na −x. Stojí na y = 0.
import { isRecord, lookup, must } from './util.ts';
import type { JsonRecord } from './util.ts';

export type V3 = [number, number, number];

// ---------- vzhľad ----------
export type RobotStyle = 'hrdzavec' | 'kotul' | 'kotlik' | 'plechacik';
export type Accessory = 'none' | 'antenna' | 'hat' | 'sprout';
// Vzhľad robota: štýl, náter, doplnková farba, svetlo očí, ošúchanosť / hrdza (0–1), doplnok na hlave
export interface RobotLook { readonly style: RobotStyle; readonly paint: string; readonly accent: string; readonly eye: string; readonly wear: number; readonly acc: Accessory }
export interface StyleInfo { readonly name: string; readonly desc: string; readonly look: RobotLook }
export const STYLES: Readonly<Record<RobotStyle, StyleInfo>> = {
  hrdzavec: { name: 'Hrdzavec', desc: 'Hranatý záhradník na pásoch, oči ako ďalekohľad na krku.', look: { style: 'hrdzavec', paint: '#d9a441', accent: '#5b6b73', eye: '#9fe7ff', wear: 0.45, acc: 'none' } },
  kotul: { name: 'Kotúľ', desc: 'Guľatý robotík, ktorý sa vozí na jednej guli. Jedno veľké oko pod sklom.', look: { style: 'kotul', paint: '#f1efe6', accent: '#e0734f', eye: '#7cf0b0', wear: 0.15, acc: 'antenna' } },
  kotlik: { name: 'Kotlík', desc: 'Malý kotol na troch tenkých nohách, okrúhle okienko a komínik.', look: { style: 'kotlik', paint: '#6f9a7a', accent: '#c7923e', eye: '#ffd36b', wear: 0.6, acc: 'none' } },
  plechacik: { name: 'Plecháčik', desc: 'Plechovka na krátkych nožičkách, okrúhla hlava a dve okrúhle oči.', look: { style: 'plechacik', paint: '#7fa7d9', accent: '#e9d8a6', eye: '#ffb3c7', wear: 0.3, acc: 'sprout' } }
};
export const STYLE_IDS: readonly RobotStyle[] = ['hrdzavec', 'kotul', 'kotlik', 'plechacik'];
export const ACCESSORIES: Readonly<Record<Accessory, string>> = { none: 'Nič', antenna: 'Anténa', hat: 'Klobúčik', sprout: 'Kvetináčik' };
const ACC_IDS: readonly Accessory[] = ['none', 'antenna', 'hat', 'sprout'];
// Farby na výber (náter, doplnková farba, oči) – milé, trochu vyblednuté
export const PAINTS: readonly string[] = ['#d9a441', '#e0734f', '#c95b5b', '#f1efe6', '#7fa7d9', '#6f9a7a', '#9a7fc4', '#e7c86a', '#8a8f94', '#e89bb4'];
export const ACCENTS: readonly string[] = ['#5b6b73', '#3d4448', '#c7923e', '#e9d8a6', '#e0734f', '#4f7a5a', '#2f5f8a'];
export const EYES: readonly string[] = ['#9fe7ff', '#7cf0b0', '#ffd36b', '#ffb3c7', '#c9a6ff', '#ffffff'];

const HEX = /^#[0-9a-f]{6}$/;
const isStyle = (v: unknown): v is RobotStyle => typeof v === 'string' && STYLE_IDS.some(s => s === v);
const isAcc = (v: unknown): v is Accessory => typeof v === 'string' && ACC_IDS.some(s => s === v);
const color = (v: unknown, def: string): string => typeof v === 'string' && HEX.test(v.toLowerCase()) ? v.toLowerCase() : def;
// Vzhľad z nedôveryhodného JSON (správa klienta, uloženie): neznáme alebo zlé hodnoty → predvolené hodnoty štýlu
export function robotLook(v: unknown): RobotLook {
  const j: JsonRecord = isRecord(v) ? v : {}, w = j['wear'];
  const style = isStyle(j['style']) ? j['style'] : 'hrdzavec', d = STYLES[style].look;
  const wear = typeof w === 'number' && Number.isFinite(w) ? Math.max(0, Math.min(1, w)) : d.wear;
  const acc = j['acc'];
  return { style, paint: color(j['paint'], d.paint), accent: color(j['accent'], d.accent), eye: color(j['eye'], d.eye), wear: Math.round(wear * 100) / 100, acc: isAcc(acc) ? acc : d.acc };
}

// ---------- náhoda ----------
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(r: () => number, a: readonly T[]): T => must(a[Math.floor(r() * a.length)]);
// Náhodný vzhľad (napr. pre iného hráča bez vlastného vzhľadu – podľa mena), vždy ten istý pre to isté semienko
export function randomLook(seed: number): RobotLook {
  const r = rng(seed);
  const style = pick(r, STYLE_IDS);
  return { style, paint: pick(r, PAINTS), accent: pick(r, ACCENTS), eye: pick(r, EYES), wear: Math.round(r() * 80) / 100, acc: pick(r, ACC_IDS) };
}

// ---------- model ----------
export type Shape =
  | { readonly k: 'box'; readonly s: V3; readonly r: number }                 // zaoblená kocka (rozmery, polomer hrán)
  | { readonly k: 'cyl'; readonly r: number; readonly r2?: number; readonly h: number } // valec / kužeľ pozdĺž y (r dole, r2 hore)
  | { readonly k: 'sphere'; readonly r: number; readonly s?: V3 }             // guľa, s = natiahnutie v osiach
  | { readonly k: 'capsule'; readonly r: number; readonly h: number }         // kapsula pozdĺž y (h = dĺžka rovnej časti)
  | { readonly k: 'torus'; readonly r: number; readonly t: number }           // prstenec v rovine xz (okolo y)
  | { readonly k: 'dome'; readonly r: number };                               // horná pologuľa
// Materiály: náter, doplnková farba, kov, tmavý kov, guma, svetlo očí, šošovka (tmavé sklo), sklo, hrdza, svieti (teplo)
export type Mat = 'paint' | 'accent' | 'metal' | 'dark' | 'rubber' | 'eye' | 'lens' | 'glass' | 'rust' | 'warm' | 'leaf' | 'pot';
export type JointId = string;
// Diel: tvar na kĺbe, poloha a natočenie (Euler XYZ, rad) voči kĺbu; tag = čo animovať zvlášť (žmurkanie, para…)
export interface Part { readonly j: JointId; readonly shape: Shape; readonly p: V3; readonly r?: V3; readonly m: Mat; readonly tag?: string }
// Kĺb: rodič a poloha voči nemu; natočenie dáva póza
export interface Joint { readonly id: JointId; readonly parent: JointId | null; readonly p: V3 }
export type MountId = 'handR' | 'handL' | 'back' | 'top';
// Úchyt: kĺb, poloha a natočenie – v ruke sa náradie drží za rúčku (os y náradia ide pozdĺž rúčky)
export interface Mount { readonly j: JointId; readonly p: V3; readonly r?: V3 }
// Koleso / guľa, ktorá sa pri chôdzi otáča (kĺb otočený okolo x o vzdialenosť / polomer)
export interface Wheel { readonly j: JointId; readonly r: number }
export interface RobotModel {
  readonly look: RobotLook; readonly joints: readonly Joint[]; readonly parts: readonly Part[];
  readonly mounts: Readonly<Record<MountId, Mount>>; readonly wheels: readonly Wheel[];
  readonly height: number; // po temeno hlavy (bez doplnku)
  readonly gait: 'roll' | 'walk';
}

// Stavba modelu: kĺby, diely a úchyty pridáva štýl
class Builder {
  joints: Joint[] = [{ id: 'root', parent: null, p: [0, 0, 0] }];
  parts: Part[] = [];
  wheels: Wheel[] = [];
  joint(id: JointId, parent: JointId, p: V3): JointId { this.joints.push({ id, parent, p }); return id; }
  add(j: JointId, shape: Shape, p: V3, m: Mat, r?: V3, tag?: string): void { this.parts.push({ j, shape, p, m, ...(r ? { r } : {}), ...(tag ? { tag } : {}) }); }
  // tyč (valec) z bodu a do bodu b
  rod(j: JointId, a: V3, b: V3, r: number, m: Mat): void {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(...d);
    const c = Math.asin(Math.max(-1, Math.min(1, -d[0] / len))), x = Math.atan2(d[2], d[1]);
    this.add(j, { k: 'cyl', r, h: len }, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], m, [x, 0, c]);
  }
  // rameno: plece → lakeť → ruka s dvoma prstami (klieštiky); vracia kĺb ruky
  arm(side: 1 | -1, parent: JointId, p: V3, len: number, thick: number): JointId {
    const s = side > 0 ? 'L' : 'R';
    const sh = this.joint('shoulder' + s, parent, p);
    this.add(sh, { k: 'sphere', r: thick * 1.35 }, [0, 0, 0], 'dark');
    this.add(sh, { k: 'capsule', r: thick, h: len * 0.5 }, [0, -len * 0.3, 0], 'metal');
    const el = this.joint('elbow' + s, sh, [0, -len * 0.6, 0]);
    this.add(el, { k: 'sphere', r: thick * 1.15 }, [0, 0, 0], 'dark');
    this.add(el, { k: 'capsule', r: thick * 0.9, h: len * 0.35 }, [0, -len * 0.22, 0], 'accent');
    const hd = this.joint('hand' + s, el, [0, -len * 0.45, 0]);
    this.add(hd, { k: 'cyl', r: thick * 1.3, h: thick * 1.2 }, [0, 0, 0], 'dark');
    for (const f of [-1, 1]) this.add(hd, { k: 'box', s: [thick * 0.7, thick * 2.6, thick * 1.1], r: thick * 0.3 }, [f * thick * 0.95, -thick * 1.5, 0], 'metal', [0, 0, f * 0.18], 'finger');
    return hd;
  }
  // oko ako ďalekohľad: rúrka dopredu, šošovka, svietiaca dúhovka a viečko (tag 'lid' – žmurkanie)
  binoEye(j: JointId, p: V3, r: number, depth: number): void {
    this.add(j, { k: 'cyl', r, r2: r * 0.92, h: depth }, p, 'paint', [Math.PI / 2, 0, 0]);
    this.add(j, { k: 'torus', r: r * 0.95, t: r * 0.14 }, [p[0], p[1], p[2] + depth / 2], 'dark', [Math.PI / 2, 0, 0]);
    this.add(j, { k: 'sphere', r: r * 0.8, s: [1, 1, 0.35] }, [p[0], p[1], p[2] + depth / 2], 'lens');
    this.add(j, { k: 'sphere', r: r * 0.45, s: [1, 1, 0.3] }, [p[0], p[1], p[2] + depth / 2 + r * 0.22], 'eye');
    this.add(j, { k: 'sphere', r: r * 0.2, s: [1, 1, 0.3] }, [p[0], p[1], p[2] + depth / 2 + r * 0.3], 'lens');
    this.add(j, { k: 'sphere', r: r * 0.12 }, [p[0] - r * 0.22, p[1] + r * 0.22, p[2] + depth / 2 + r * 0.36], 'glass');
    this.add(j, { k: 'box', s: [r * 2.1, r * 1.0, depth * 0.9], r: r * 0.4 }, [p[0], p[1] + r * 0.62, p[2] + depth * 0.06], 'paint', undefined, 'lid');
  }
  // doplnok na temene (bod top)
  accessory(acc: Accessory, j: JointId, p: V3, look: RobotLook): void {
    const [x, y, z] = p;
    if (acc === 'antenna') {
      this.add(j, { k: 'cyl', r: 0.008, h: 0.16 }, [x, y + 0.08, z], 'dark', undefined, 'antenna');
      this.add(j, { k: 'sphere', r: 0.028 }, [x, y + 0.17, z], 'eye', undefined, 'antenna');
    } else if (acc === 'hat') {
      this.add(j, { k: 'cyl', r: 0.13, h: 0.015 }, [x, y + 0.008, z], 'accent');
      this.add(j, { k: 'cyl', r: 0.075, r2: 0.07, h: 0.09 }, [x, y + 0.055, z], 'accent');
      this.add(j, { k: 'cyl', r: 0.077, h: 0.02 }, [x, y + 0.03, z], look.style === 'kotlik' ? 'paint' : 'rust');
    } else if (acc === 'sprout') {
      this.add(j, { k: 'cyl', r: 0.05, r2: 0.065, h: 0.07 }, [x, y + 0.035, z], 'pot');
      this.add(j, { k: 'cyl', r: 0.006, h: 0.08 }, [x, y + 0.1, z], 'leaf', undefined, 'sprout');
      for (const s of [-1, 1]) this.add(j, { k: 'sphere', r: 0.035, s: [1.4, 0.35, 0.8] }, [x + s * 0.035, y + 0.135, z], 'leaf', [0, 0, s * 0.5], 'sprout');
    }
  }
  // škvrny hrdze na rovných stenách: kandidáti (bod, normála), koľko podľa wear
  rust(look: RobotLook, spots: readonly { j: JointId; p: V3; n: 'x' | '-x' | 'y' | 'z' | '-z' }[], size: number): void {
    const r = rng(hashStr(JSON.stringify(look)));
    const n = Math.round(look.wear * spots.length);
    const order = spots.map(s => ({ s, k: r() })).sort((a, b) => a.k - b.k).slice(0, n);
    for (const { s } of order) {
      const rot: V3 = s.n === 'x' || s.n === '-x' ? [0, 0, Math.PI / 2] : s.n === 'y' ? [0, 0, 0] : [Math.PI / 2, 0, 0];
      const k = size * (0.6 + r() * 0.8);
      this.add(s.j, { k: 'sphere', r: k, s: [1 + r() * 0.6, 0.12, 0.8 + r() * 0.5] }, s.p, 'rust', [rot[0], rot[1] + r() * 3, rot[2]]);
    }
  }
}

const MOUNT_BACK = (j: JointId, p: V3): Mount => ({ j, p });
// ruka drží rúčku: klieštiky smerujú dole (−y kĺbu ruky), náradie je natočené dopredu
const MOUNT_HAND = (j: JointId, y: number): Mount => ({ j, p: [0, y, 0.0], r: [Math.PI / 2, 0, 0] });

function hrdzavec(look: RobotLook, b: Builder): Omit<RobotModel, 'look' | 'joints' | 'parts' | 'wheels'> {
  // pásy: dve dlhé zaoblené kocky po bokoch, v nich tri kolesá, ktorých náboje vidno zboku
  for (const sx of [-1, 1]) {
    b.add('root', { k: 'box', s: [0.11, 0.17, 0.4], r: 0.075 }, [sx * 0.2, 0.09, 0], 'rubber');
    for (const [i, z] of [-0.13, 0, 0.13].entries()) {
      const w = b.joint(`wheel${sx > 0 ? 'L' : 'R'}${i}`, 'root', [sx * 0.2, 0.09, z]);
      const rr = i === 1 ? 0.05 : 0.062;
      b.add(w, { k: 'cyl', r: rr, h: 0.118 }, [0, 0, 0], 'metal', [0, 0, Math.PI / 2]);
      b.add(w, { k: 'box', s: [0.122, rr * 1.7, 0.016], r: 0.006 }, [0, 0, 0], 'accent');
      b.add(w, { k: 'box', s: [0.122, 0.016, rr * 1.7], r: 0.006 }, [0, 0, 0], 'accent');
      b.wheels.push({ j: w, r: rr });
    }
  }
  // trup: zaoblená kocka s dvierkami vpredu, v ktorých je kvetinový „rad“ nitov
  const body = b.joint('body', 'root', [0, 0.36, 0]);
  b.add(body, { k: 'box', s: [0.32, 0.3, 0.3], r: 0.05 }, [0, 0, 0], 'paint');
  b.add(body, { k: 'box', s: [0.34, 0.035, 0.32], r: 0.015 }, [0, -0.13, 0], 'accent');
  b.add(body, { k: 'box', s: [0.2, 0.15, 0.02], r: 0.02 }, [0, 0.01, 0.152], 'accent');
  b.add(body, { k: 'box', s: [0.06, 0.018, 0.02], r: 0.008 }, [0, 0.04, 0.165], 'dark');
  for (const x of [-0.08, 0.08]) for (const y of [-0.05, 0.07]) b.add(body, { k: 'sphere', r: 0.011 }, [x, y, 0.163], 'metal');
  b.add(body, { k: 'cyl', r: 0.018, h: 0.03 }, [0.11, 0.165, -0.07], 'dark');      // výfuk na pleci
  // krk a hlava (dve oči ako ďalekohľad spojené mostíkom)
  const neck = b.joint('neck', body, [0, 0.15, -0.02]);
  b.add(neck, { k: 'cyl', r: 0.03, h: 0.12 }, [0, 0.06, 0], 'dark');
  b.add(neck, { k: 'torus', r: 0.03, t: 0.008 }, [0, 0.04, 0], 'metal');
  const head = b.joint('head', neck, [0, 0.13, 0]);
  b.add(head, { k: 'box', s: [0.1, 0.05, 0.08], r: 0.02 }, [0, 0.01, -0.01], 'accent');
  for (const sx of [-1, 1]) b.binoEye(head, [sx * 0.075, 0.03, 0.0], 0.055, 0.11);
  b.accessory(look.acc, head, [0, 0.1, -0.01], look);
  // ramená z bokov trupu
  b.arm(1, body, [0.19, 0.07, 0.03], 0.26, 0.022);
  b.arm(-1, body, [-0.19, 0.07, 0.03], 0.26, 0.022);
  // nosič na chrbte (rám z rúrok)
  b.add(body, { k: 'box', s: [0.26, 0.02, 0.02], r: 0.008 }, [0, 0.08, -0.17], 'metal');
  b.add(body, { k: 'box', s: [0.26, 0.02, 0.02], r: 0.008 }, [0, -0.08, -0.17], 'metal');
  b.rust(look, [
    { j: body, p: [0.161, -0.06, 0.07], n: 'x' }, { j: body, p: [-0.161, 0.05, -0.05], n: '-x' }, { j: body, p: [0.09, 0.151, 0.06], n: 'y' },
    { j: body, p: [-0.11, -0.07, 0.151], n: 'z' }, { j: body, p: [0.12, 0.09, 0.151], n: 'z' }, { j: body, p: [-0.06, 0.05, -0.151], n: '-z' },
    { j: body, p: [0.161, 0.08, -0.08], n: 'x' }, { j: body, p: [-0.161, -0.08, 0.08], n: '-x' }
  ], 0.035);
  return { mounts: { handR: MOUNT_HAND('handR', -0.03), handL: MOUNT_HAND('handL', -0.03), back: MOUNT_BACK(body, [0, 0, -0.19]), top: { j: head, p: [0, 0.1, -0.01] } }, height: 0.83, gait: 'roll' };
}

function kotul(look: RobotLook, b: Builder): Omit<RobotModel, 'look' | 'joints' | 'parts' | 'wheels'> {
  const ball = b.joint('ball', 'root', [0, 0.11, 0]);
  b.add(ball, { k: 'sphere', r: 0.11 }, [0, 0, 0], 'rubber');
  b.add(ball, { k: 'torus', r: 0.11, t: 0.012 }, [0, 0, 0], 'accent', [0, 0, Math.PI / 2]);
  b.add(ball, { k: 'torus', r: 0.11, t: 0.012 }, [0, 0, 0], 'accent', [Math.PI / 2, 0, 0]);
  b.wheels.push({ j: ball, r: 0.11 });
  // telo: guľa sploštená zdola, sukienka nad guľou
  const body = b.joint('body', 'root', [0, 0.36, 0]);
  b.add(body, { k: 'cyl', r: 0.12, r2: 0.2, h: 0.06 }, [0, -0.14, 0], 'accent');
  b.add(body, { k: 'sphere', r: 0.22, s: [1, 0.8, 1] }, [0, 0, 0], 'paint');
  b.add(body, { k: 'torus', r: 0.215, t: 0.018 }, [0, 0.0, 0], 'accent');
  for (const a of [-0.7, -0.35, 0, 0.35, 0.7]) b.add(body, { k: 'sphere', r: 0.012 }, [Math.sin(a) * 0.222, 0, Math.cos(a) * 0.222], 'metal');
  b.add(body, { k: 'box', s: [0.09, 0.06, 0.03], r: 0.015 }, [0, -0.07, 0.19], 'dark', [-0.4, 0, 0]);
  // hlava: sklenená kupola s jedným veľkým okom vnútri
  const head = b.joint('head', body, [0, 0.16, 0]);
  b.add(head, { k: 'cyl', r: 0.13, h: 0.03 }, [0, 0.0, 0], 'accent');
  b.add(head, { k: 'sphere', r: 0.085 }, [0, 0.09, 0.01], 'paint');
  b.add(head, { k: 'sphere', r: 0.06, s: [1, 1, 0.5] }, [0, 0.1, 0.07], 'lens');
  b.add(head, { k: 'sphere', r: 0.032, s: [1, 1, 0.4] }, [0, 0.1, 0.095], 'eye');
  b.add(head, { k: 'sphere', r: 0.01 }, [-0.014, 0.117, 0.105], 'glass');
  b.add(head, { k: 'box', s: [0.12, 0.045, 0.06], r: 0.02 }, [0, 0.148, 0.055], 'paint', undefined, 'lid');
  b.add(head, { k: 'dome', r: 0.125 }, [0, 0.012, 0], 'glass');
  b.accessory(look.acc, head, [0, 0.135, 0], look);
  b.arm(1, body, [0.2, 0.02, 0.02], 0.2, 0.018);
  b.arm(-1, body, [-0.2, 0.02, 0.02], 0.2, 0.018);
  b.rust(look, [
    { j: body, p: [0.2, -0.06, 0.06], n: 'x' }, { j: body, p: [-0.2, -0.05, -0.05], n: '-x' }, { j: body, p: [0.0, 0.08, -0.19], n: '-z' },
    { j: body, p: [0.12, 0.08, 0.15], n: 'z' }, { j: body, p: [-0.12, -0.07, 0.16], n: 'z' }, { j: body, p: [0.08, 0.15, 0.0], n: 'y' }
  ], 0.03);
  return { mounts: { handR: MOUNT_HAND('handR', -0.03), handL: MOUNT_HAND('handL', -0.03), back: MOUNT_BACK(body, [0, 0, -0.23]), top: { j: head, p: [0, 0.135, 0] } }, height: 0.66, gait: 'roll' };
}

function kotlik(look: RobotLook, b: Builder): Omit<RobotModel, 'look' | 'joints' | 'parts' | 'wheels'> {
  const body = b.joint('body', 'root', [0, 0.42, 0]);
  // tri nohy: bedro pod kotlom, koleno, chodidlo (tanierik)
  for (const [i, a] of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].entries()) {
    const ax = Math.sin(a + Math.PI) * 0.12, az = Math.cos(a + Math.PI) * 0.12;
    const hip = b.joint('hip' + i, body, [ax, -0.12, az]);
    b.add(hip, { k: 'sphere', r: 0.028 }, [0, 0, 0], 'dark');
    // koleno vonku, chodidlo trochu bližšie pod kotlom – nohy ako trojnožka
    const kp: V3 = [ax * 0.6, -0.12, az * 0.6];
    b.rod(hip, [0, 0, 0], kp, 0.014, 'metal');
    const knee = b.joint('knee' + i, hip, kp);
    b.add(knee, { k: 'sphere', r: 0.022 }, [0, 0, 0], 'accent');
    b.rod(knee, [0, 0, 0], [-ax * 0.25, -0.155, -az * 0.25], 0.013, 'metal');
    b.add(knee, { k: 'cyl', r: 0.04, r2: 0.03, h: 0.018 }, [-ax * 0.25, -0.16, -az * 0.25], 'dark');
  }
  // kotol: valec s klenutým vrchnákom a spodkom, obruče, okienko s okom
  b.add(body, { k: 'cyl', r: 0.17, h: 0.2 }, [0, 0, 0], 'paint');
  b.add(body, { k: 'sphere', r: 0.17, s: [1, 0.35, 1] }, [0, -0.1, 0], 'paint');
  for (const y of [-0.085, 0.085]) b.add(body, { k: 'torus', r: 0.172, t: 0.013 }, [0, y, 0], 'accent');
  for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; b.add(body, { k: 'sphere', r: 0.008 }, [Math.sin(a) * 0.182, 0.085, Math.cos(a) * 0.182], 'metal'); }
  const head = b.joint('head', body, [0, 0.1, 0]);
  b.add(head, { k: 'sphere', r: 0.168, s: [1, 0.5, 1] }, [0, 0, 0], 'paint');
  b.add(head, { k: 'cyl', r: 0.03, h: 0.02 }, [0, 0.085, 0], 'accent');
  // komínik so stieškou; z neho stúpa para (tag 'steam')
  b.add(head, { k: 'cyl', r: 0.025, r2: 0.03, h: 0.12 }, [0.08, 0.1, -0.06], 'dark');
  b.add(head, { k: 'cyl', r: 0.04, r2: 0.032, h: 0.025 }, [0.08, 0.17, -0.06], 'accent');
  for (const k of [0, 1, 2]) b.add(head, { k: 'sphere', r: 0.025 + k * 0.012 }, [0.08 + k * 0.01, 0.21 + k * 0.05, -0.06], 'glass', undefined, 'steam');
  // okienko vpredu (oko) – mosadzný rám, sklo, svetlo vnútri a viečko
  const eye = b.joint('eye', body, [0, 0.0, 0.17]);
  b.add(eye, { k: 'torus', r: 0.075, t: 0.018 }, [0, 0, 0], 'accent', [Math.PI / 2, 0, 0]);
  b.add(eye, { k: 'sphere', r: 0.07, s: [1, 1, 0.25] }, [0, 0, 0], 'lens');
  b.add(eye, { k: 'sphere', r: 0.035, s: [1, 1, 0.3] }, [0, 0, 0.012], 'eye');
  b.add(eye, { k: 'sphere', r: 0.012 }, [-0.02, 0.025, 0.02], 'glass');
  b.add(eye, { k: 'box', s: [0.16, 0.08, 0.04], r: 0.03 }, [0, 0.055, 0.005], 'paint', undefined, 'lid');
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; b.add(eye, { k: 'sphere', r: 0.008 }, [Math.cos(a) * 0.075, Math.sin(a) * 0.075, 0.016], 'metal'); }
  b.accessory(look.acc, head, [-0.03, 0.09, 0.02], look);
  b.arm(1, body, [0.19, 0.04, 0.0], 0.24, 0.018);
  b.arm(-1, body, [-0.19, 0.04, 0.0], 0.24, 0.018);
  b.rust(look, [
    { j: body, p: [0.165, -0.04, 0.05], n: 'x' }, { j: body, p: [-0.165, 0.03, -0.04], n: '-x' }, { j: body, p: [0.1, -0.03, -0.14], n: '-z' },
    { j: body, p: [-0.12, 0.04, 0.12], n: 'z' }, { j: body, p: [0.12, -0.05, 0.12], n: 'z' }, { j: body, p: [-0.08, 0.04, -0.15], n: '-z' },
    { j: body, p: [0.165, 0.04, -0.06], n: 'x' }
  ], 0.032);
  return { mounts: { handR: MOUNT_HAND('handR', -0.03), handL: MOUNT_HAND('handL', -0.03), back: MOUNT_BACK(body, [0, 0, -0.2]), top: { j: head, p: [-0.03, 0.09, 0.02] } }, height: 0.62, gait: 'walk' };
}

function plechacik(look: RobotLook, b: Builder): Omit<RobotModel, 'look' | 'joints' | 'parts' | 'wheels'> {
  const body = b.joint('body', 'root', [0, 0.3, 0]);
  // nohy: krátke kapsuly s veľkými topánkami
  for (const sx of [-1, 1]) {
    const hip = b.joint('hip' + (sx > 0 ? 'L' : 'R'), body, [sx * 0.07, -0.1, 0]);
    b.add(hip, { k: 'capsule', r: 0.03, h: 0.08 }, [0, -0.07, 0], 'metal');
    b.add(hip, { k: 'box', s: [0.08, 0.05, 0.12], r: 0.022 }, [0, -0.165, 0.02], 'accent');
  }
  // trup: plechovka s rebrami
  b.add(body, { k: 'cyl', r: 0.14, h: 0.24 }, [0, 0.02, 0], 'paint');
  for (const y of [-0.08, 0.0, 0.08]) b.add(body, { k: 'torus', r: 0.142, t: 0.008 }, [0, y + 0.02, 0], 'metal');
  b.add(body, { k: 'cyl', r: 0.145, h: 0.02 }, [0, 0.14, 0], 'accent');
  b.add(body, { k: 'box', s: [0.12, 0.08, 0.02], r: 0.015 }, [0, 0.0, 0.14], 'accent');
  for (const x of [-0.03, 0, 0.03]) b.add(body, { k: 'sphere', r: 0.012 }, [x, 0.0, 0.152], x ? 'warm' : 'eye', undefined, 'led');
  // hlava: guľa s dvomi okrúhlymi očami
  const neck = b.joint('neck', body, [0, 0.15, 0]);
  b.add(neck, { k: 'cyl', r: 0.025, h: 0.04 }, [0, 0.02, 0], 'dark');
  const head = b.joint('head', neck, [0, 0.13, 0]);
  b.add(head, { k: 'sphere', r: 0.12 }, [0, 0, 0], 'paint');
  b.add(head, { k: 'torus', r: 0.121, t: 0.008 }, [0, -0.02, 0], 'accent');
  for (const sx of [-1, 1]) {
    b.add(head, { k: 'torus', r: 0.035, t: 0.008 }, [sx * 0.045, 0.01, 0.105], 'metal', [Math.PI / 2 - 0.15, sx * 0.4, 0]);
    b.add(head, { k: 'sphere', r: 0.033, s: [1, 1, 0.45] }, [sx * 0.045, 0.01, 0.108], 'lens', [0, sx * 0.4, 0]);
    b.add(head, { k: 'sphere', r: 0.018, s: [1, 1, 0.4] }, [sx * 0.047, 0.012, 0.118], 'eye', [0, sx * 0.4, 0]);
    b.add(head, { k: 'sphere', r: 0.007 }, [sx * 0.045 - 0.01, 0.024, 0.124], 'glass');
    b.add(head, { k: 'box', s: [0.075, 0.03, 0.04], r: 0.014 }, [sx * 0.047, 0.058, 0.098], 'paint', [0, sx * 0.4, 0], 'lid');
    b.add(head, { k: 'cyl', r: 0.025, h: 0.03 }, [sx * 0.12, 0, 0], 'accent', [0, 0, Math.PI / 2]); // „uši“
  }
  b.add(head, { k: 'box', s: [0.05, 0.012, 0.02], r: 0.006 }, [0, -0.05, 0.11], 'dark', [-0.3, 0, 0]);
  b.accessory(look.acc, head, [0, 0.118, 0], look);
  b.arm(1, body, [0.16, 0.08, 0], 0.2, 0.018);
  b.arm(-1, body, [-0.16, 0.08, 0], 0.2, 0.018);
  b.rust(look, [
    { j: body, p: [0.14, -0.05, 0.03], n: 'x' }, { j: body, p: [-0.14, 0.05, -0.02], n: '-x' }, { j: body, p: [0.06, -0.06, 0.13], n: 'z' },
    { j: body, p: [-0.07, 0.07, -0.13], n: '-z' }, { j: body, p: [0.08, 0.06, -0.12], n: '-z' }
  ], 0.03);
  return { mounts: { handR: MOUNT_HAND('handR', -0.03), handL: MOUNT_HAND('handL', -0.03), back: MOUNT_BACK(body, [0, 0.02, -0.16]), top: { j: head, p: [0, 0.118, 0] } }, height: 0.68, gait: 'walk' };
}

const BUILD: Readonly<Record<RobotStyle, (look: RobotLook, b: Builder) => Omit<RobotModel, 'look' | 'joints' | 'parts' | 'wheels'>>> = { hrdzavec, kotul, kotlik, plechacik };
export function robotModel(look0: RobotLook): RobotModel {
  const look = robotLook(look0), b = new Builder();
  const rest = BUILD[look.style](look, b);
  return { look, joints: b.joints, parts: b.parts, wheels: b.wheels, ...rest };
}

// ---------- póza ----------
// Čo robot práve robí (ako CharOpts postavičky): fáza kroku (rastie s prejdenou dráhou), plazenie, tanec, hrabanie (čas),
// výška skoku, čas (žmurkanie, rozhliadanie), náradie v ruke
export interface PoseOpts { phase?: number; t?: number; crawl?: boolean; dance?: boolean; dig?: number; jz?: number; holding?: boolean; walking?: boolean }
export interface JointPose { r: V3; d?: V3 }
export interface RobotPose { readonly joints: ReadonlyMap<JointId, JointPose>; readonly blink: number; readonly steam: number }
const sin = Math.sin, cos = Math.cos;
// Póza kĺbov: rameno sa kýve pri chôdzi, pri hrabaní ruka kope, pri tanci sa trup vlní a ruky sú hore,
// pri plazení sa robot prikrčí (krk sa zasunie, telo sa skloní). Kolesá sa krútia podľa prejdenej dráhy.
export function robotPose(m: RobotModel, o: PoseOpts): RobotPose {
  const J = new Map<JointId, JointPose>();
  const set = (j: JointId, r: V3, d?: V3): void => { if (m.joints.some(x => x.id === j)) J.set(j, d ? { r, d } : { r }); };
  const ph = o.phase ?? 0, t = o.t ?? 0, walk = !!o.walking && !o.dance && !o.dig;
  const sw = walk ? sin(ph) : 0;
  const roll = m.gait === 'roll';
  // kolesá: dráha ≈ fáza × 0,09 políčka
  for (const w of m.wheels) set(w.j, [ph * 0.09 / w.r, 0, 0]);
  // trup: pohupovanie, predklon pri plazení, tanec
  const bob = roll ? (walk ? Math.abs(sin(ph * 2)) * 0.008 : 0) : Math.abs(sw) * 0.025;
  const crawl = o.crawl ? 1 : 0;
  let bodyR: V3 = [walk && m.look.style === 'kotul' ? 0.18 : 0, 0, walk && !roll ? sw * 0.06 : 0];
  let bodyD: V3 = [0, bob - crawl * (roll ? 0.04 : 0.09), 0];
  if (o.dance) { bodyR = [0, sin(t * 3) * 0.5, sin(t * 6) * 0.12]; bodyD = [0, Math.abs(sin(t * 6)) * 0.04, 0]; }
  if (crawl) bodyR = [bodyR[0] + 0.35, bodyR[1], bodyR[2]];
  set('body', bodyR, bodyD);
  // krk: pri plazení zasunutý, inak sa hlava zvedavo rozhliada
  const look = o.dance ? 0 : sin(t * 0.7) * 0.35 * (walk ? 0.3 : 1);
  set('neck', [-crawl * 0.3, 0, 0], [0, -crawl * 0.07, 0]);
  set('head', [crawl * -0.1 + (o.dig ? 0.35 : 0), look, sin(t * 1.3) * 0.06 + (o.dance ? sin(t * 6) * 0.25 : 0)]);
  set('eye', [0, 0, 0]);
  // ramená: [predpaženie (−x = dopredu), 0, odpaženie]
  const fwd = (a: number): V3 => [-a, 0, 0];
  let armR = fwd(sw * 0.5), armL = fwd(-sw * 0.5), elbR: V3 = [-0.3, 0, 0], elbL: V3 = [-0.3, 0, 0];
  if (o.holding) { armR = fwd(0.5 + sw * 0.15); elbR = [-0.7, 0, 0]; }
  if (o.dig) { const k = sin(o.dig * 8); armR = fwd(0.9 + k * 0.6); elbR = [-0.5 - k * 0.4, 0, 0]; armL = fwd(0.7 + k * 0.4); }
  if (o.dance) { armR = [-2.6 + sin(t * 6) * 0.3, 0, -0.3]; armL = [-2.6 - sin(t * 6) * 0.3, 0, 0.3]; elbR = [-0.4, 0, 0]; elbL = [-0.4, 0, 0]; }
  if (crawl && !o.dig) { armR = fwd(0.9); armL = fwd(0.9); }
  set('shoulderR', armR); set('shoulderL', armL);
  set('elbowR', elbR); set('elbowL', elbL);
  // nohy (chôdza): bedrá sa kývu striedavo; trojnožka Kotlíka cupitá po jednej nohe
  if (!roll) {
    set('hipL', [walk ? -sw * 0.5 : 0, 0, 0]); set('hipR', [walk ? sw * 0.5 : 0, 0, 0]);
    for (let i = 0; i < 3; i++) { const k = walk ? sin(ph + (i * 2 * Math.PI) / 3) : 0; set('hip' + i, [k * 0.25, 0, 0], [0, Math.max(0, k) * 0.03, 0]); }
  }
  // žmurkanie: každé ~4 s na 0,15 s (0 = otvorené, 1 = zavreté)
  const bt = ((t % 4.1) + 4.1) % 4.1;
  const blink = bt < 0.15 ? sin((bt / 0.15) * Math.PI) : 0;
  return { joints: J, blink, steam: (t * 0.6) % 1 };
}

// ---------- matice (bez Three.js) ----------
// Afinná matica 3×4 po stĺpcoch: [x, y, z, posun]
type M34 = [V3, V3, V3, V3];
// natočenie Euler XYZ (ako Three.js 'XYZ': R = Rx · Ry · Rz)
function eulerM(r: V3, p: V3): M34 {
  const [a, b, c] = r, ca = cos(a), sa = sin(a), cb = cos(b), sb = sin(b), cc = cos(c), sc = sin(c);
  return [
    [cb * cc, ca * sc + sa * sb * cc, sa * sc - ca * sb * cc],
    [-cb * sc, ca * cc - sa * sb * sc, sa * cc + ca * sb * sc],
    [sb, -sa * cb, ca * cb],
    p
  ];
}
const apply = (m: M34, v: V3): V3 => [
  m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2] + m[3][0],
  m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2] + m[3][1],
  m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2] + m[3][2]
];
const dir = (m: M34, v: V3): V3 => [m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2], m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2], m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2]];
const mul = (a: M34, b: M34): M34 => [dir(a, b[0]), dir(a, b[1]), dir(a, b[2]), apply(a, b[3])];
// Matica kĺbu v súradniciach robota (pri póze)
export function jointMatrix(m: RobotModel, pose: RobotPose | null, id: JointId): M34 {
  const j = m.joints.find(x => x.id === id);
  if (!j) throw new Error('robot nemá kĺb ' + id);
  const jp = pose?.joints.get(id), d = jp?.d ?? [0, 0, 0];
  const local = eulerM(jp?.r ?? [0, 0, 0], [j.p[0] + d[0], j.p[1] + d[1], j.p[2] + d[2]]);
  return j.parent ? mul(jointMatrix(m, pose, j.parent), local) : local;
}
// Kde je úchyt (ruka, chrbát, temeno) v súradniciach robota – napr. odkiaľ svieti lampáš a kde je lano saní
export function mountAt(m: RobotModel, pose: RobotPose | null, id: MountId): V3 {
  const mt = m.mounts[id];
  return apply(jointMatrix(m, pose, mt.j), mt.p);
}
// Úchyt vo svete: robot stojí na (x, y, z) a pozerá v smere uhla a (smer pohybu: dx = cos a, dz = sin a)
export function mountInWorld(m: RobotModel, pose: RobotPose | null, id: MountId, x: number, y: number, z: number, a: number): V3 {
  const [px, py, pz] = mountAt(m, pose, id);
  // model pozerá na +z; otočenie okolo y tak, aby +z mieril na (cos a, sin a)
  const yaw = Math.PI / 2 - a, c = cos(yaw), s = sin(yaw);
  return [x + px * c + pz * s, y + py, z - px * s + pz * c];
}
// Natočenie robota okolo y pre uhol pohybu a (Three.js rotation.y)
export const yawOf = (a: number): number => Math.PI / 2 - a;
export const styleName = (s: string): string => lookup(STYLES, s)?.name ?? s;
