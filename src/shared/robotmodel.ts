// Hráč ako 3D robot (#194): procedurálny generátor robota bez Three.js. Robot je „genóm“ (RobotLook) zložený z dielov –
// podvozok (pásy, dve kolesá, guľa, dve nohy, trojnožka), trup (kocka, guľa, kotol, plechovka), hlava (ďalekohľad,
// sklenená kupola, guľa, televízor, žiadna – oči na trupe), počet očí, rozmery, ramená, drobnosti (komín, štítok, nity,
// svetielka), farby, hrdza a doplnok. randomLook(semienko) ho vygeneruje, robotModel z neho postaví kĺby (stromček),
// diely z hladkých tvarov a úchyty pre náradie (ruky, nosič na chrbte, temeno); robotPose dá pózu podľa toho, čo robí.
// Sieť stavia client/robot3d.ts (hra aj /debug → Robots); polohu ruky (lampáš, lano saní) vie spočítať aj test (mountAt).
// Štyri ručne naladené roboty (Hrdzavec, Kotúľ, Kotlík, Plecháčik) sú predvoľby generátora (PRESETS).
// Roboty sú vlastné – inšpirované žánrom malých hrdzavých robotov po konci sveta, ale hladké a milé.
// Súradnice: 1 = políčko, y hore, robot pozerá na +z (dopredu), jeho pravá ruka je na −x. Stojí na y = 0.
import { isRecord, lookup, must } from './util.ts';
import type { JsonRecord } from './util.ts';

export type V3 = [number, number, number];

// ---------- genóm ----------
export const LOCOS = ['treads', 'wheels', 'ball', 'legs2', 'legs3'] as const;
export const BODIES = ['box', 'ball', 'barrel', 'can'] as const;
export const HEADS = ['bino', 'dome', 'ball', 'tv', 'none'] as const;
export const ACCS = ['none', 'antenna', 'hat', 'sprout'] as const;
export type Loco = typeof LOCOS[number];
export type BodyShape = typeof BODIES[number];
export type HeadKind = typeof HEADS[number];
export type Accessory = typeof ACCS[number];
// Číselné vlastnosti: rozsah a predvolená hodnota (všetko v políčkach, okrem pomerov)
export const NUM = {
  bw: { min: 0.24, max: 0.44, def: 0.32, name: 'Šírka trupu' },
  bh: { min: 0.18, max: 0.36, def: 0.28, name: 'Výška trupu' },
  bd: { min: 0.7, max: 1.1, def: 0.95, name: 'Hĺbka trupu (pomer)' },
  round: { min: 0, max: 1, def: 0.35, name: 'Zaoblenie' },
  legs: { min: 0, max: 1, def: 0.5, name: 'Veľkosť podvozku' },
  neck: { min: 0, max: 1, def: 0.5, name: 'Krk' },
  headS: { min: 0.75, max: 1.3, def: 1, name: 'Veľkosť hlavy' },
  eyeS: { min: 0.7, max: 1.4, def: 1, name: 'Veľkosť očí' },
  arm: { min: 0.16, max: 0.3, def: 0.24, name: 'Dĺžka rúk' },
  armT: { min: 0.014, max: 0.026, def: 0.02, name: 'Hrúbka rúk' },
  wear: { min: 0, max: 1, def: 0.3, name: 'Hrdza' }
} as const;
export type NumKey = keyof typeof NUM;
export const NUM_KEYS: readonly NumKey[] = ['bw', 'bh', 'bd', 'round', 'legs', 'neck', 'headS', 'eyeS', 'arm', 'armT', 'wear'];
export const FLAGS = { chimney: 'Komínik', panel: 'Štítok', rivets: 'Nity', leds: 'Svetielka' } as const;
export type FlagKey = keyof typeof FLAGS;
export const FLAG_KEYS: readonly FlagKey[] = ['chimney', 'panel', 'rivets', 'leds'];
export interface RobotLook {
  readonly loco: Loco; readonly body: BodyShape; readonly head: HeadKind; readonly eyes: 1 | 2;
  readonly bw: number; readonly bh: number; readonly bd: number; readonly round: number; readonly legs: number; readonly neck: number;
  readonly headS: number; readonly eyeS: number; readonly arm: number; readonly armT: number; readonly wear: number;
  readonly chimney: boolean; readonly panel: boolean; readonly rivets: boolean; readonly leds: boolean;
  readonly paint: string; readonly accent: string; readonly eye: string; readonly acc: Accessory;
}
// Slovenské mená dielov (pre výber v hre)
export const PART_NAMES: { readonly loco: Readonly<Record<Loco, string>>; readonly body: Readonly<Record<BodyShape, string>>; readonly head: Readonly<Record<HeadKind, string>>; readonly acc: Readonly<Record<Accessory, string>> } = {
  loco: { treads: 'Pásy', wheels: 'Dve kolesá', ball: 'Guľa', legs2: 'Dve nohy', legs3: 'Trojnožka' },
  body: { box: 'Skrinka', ball: 'Guľa', barrel: 'Kotol', can: 'Plechovka' },
  head: { bino: 'Ďalekohľad', dome: 'Kupola', ball: 'Guľka', tv: 'Televízor', none: 'Bez hlavy' },
  acc: { none: 'Nič', antenna: 'Anténa', hat: 'Klobúčik', sprout: 'Kvetináčik' }
};
export const ACCESSORIES = PART_NAMES.acc;

const BASE: RobotLook = {
  loco: 'treads', body: 'box', head: 'bino', eyes: 2, bw: 0.32, bh: 0.3, bd: 0.94, round: 0.33, legs: 0.5, neck: 0.6, headS: 1, eyeS: 1, arm: 0.26, armT: 0.022, wear: 0.45,
  chimney: false, panel: true, rivets: true, leds: false, paint: '#d9a441', accent: '#5b6b73', eye: '#9fe7ff', acc: 'none'
};
// Predvoľby: ručne naladené roboty
export type PresetId = 'hrdzavec' | 'kotul' | 'kotlik' | 'plechacik';
export interface Preset { readonly name: string; readonly desc: string; readonly look: RobotLook }
export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  hrdzavec: { name: 'Hrdzavec', desc: 'Hranatý záhradník na pásoch, oči ako ďalekohľad na krku.', look: BASE },
  kotul: { name: 'Kotúľ', desc: 'Guľatý robotík, ktorý sa vozí na jednej guli. Jedno veľké oko pod sklom.', look: { ...BASE, loco: 'ball', body: 'ball', head: 'dome', eyes: 1, bw: 0.44, bh: 0.35, bd: 1, neck: 0, arm: 0.2, armT: 0.018, wear: 0.15, panel: true, paint: '#f1efe6', accent: '#e0734f', eye: '#7cf0b0', acc: 'antenna' } },
  kotlik: { name: 'Kotlík', desc: 'Malý kotol na troch tenkých nohách, okrúhle okienko a komínik.', look: { ...BASE, loco: 'legs3', body: 'barrel', head: 'none', eyes: 1, bw: 0.34, bh: 0.2, bd: 1, legs: 0.6, eyeS: 1.3, arm: 0.24, armT: 0.018, wear: 0.6, chimney: true, panel: false, paint: '#6f9a7a', accent: '#c7923e', eye: '#ffd36b' } },
  plechacik: { name: 'Plecháčik', desc: 'Plechovka na krátkych nožičkách, okrúhla hlava a dve okrúhle oči.', look: { ...BASE, loco: 'legs2', body: 'can', head: 'ball', eyes: 2, bw: 0.28, bh: 0.24, bd: 1, legs: 0.4, neck: 0.4, headS: 1.1, eyeS: 0.9, arm: 0.2, armT: 0.018, wear: 0.3, rivets: false, leds: true, paint: '#7fa7d9', accent: '#e9d8a6', eye: '#ffb3c7', acc: 'sprout' } }
};
export const PRESET_IDS: readonly PresetId[] = ['hrdzavec', 'kotul', 'kotlik', 'plechacik'];
// Farby na výber (náter, doplnková farba, oči) – milé, trochu vyblednuté
export const PAINTS: readonly string[] = ['#d9a441', '#e0734f', '#c95b5b', '#f1efe6', '#7fa7d9', '#6f9a7a', '#9a7fc4', '#e7c86a', '#8a8f94', '#e89bb4'];
export const ACCENTS: readonly string[] = ['#5b6b73', '#3d4448', '#c7923e', '#e9d8a6', '#e0734f', '#4f7a5a', '#2f5f8a'];
export const EYES: readonly string[] = ['#9fe7ff', '#7cf0b0', '#ffd36b', '#ffb3c7', '#c9a6ff', '#ffffff'];

const HEX = /^#[0-9a-f]{6}$/;
const oneOf = <T extends string>(all: readonly T[], v: unknown): T | undefined => all.find(x => x === v);
const color = (v: unknown, def: string): string => typeof v === 'string' && HEX.test(v.toLowerCase()) ? v.toLowerCase() : def;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
// Genóm z nedôveryhodného JSON (správa klienta, uloženie): neznáme alebo zlé hodnoty → predvolené (Hrdzavec),
// čísla orezané do rozsahu a zaokrúhlené na tisíciny
export function robotLook(v: unknown): RobotLook {
  const j: JsonRecord = isRecord(v) ? v : {}, d = BASE;
  const num = (k: NumKey): number => { const x = j[k], r = NUM[k]; return typeof x === 'number' && Number.isFinite(x) ? r3(Math.max(r.min, Math.min(r.max, x))) : d[k]; };
  const flag = (k: FlagKey): boolean => { const x = j[k]; return typeof x === 'boolean' ? x : d[k]; };
  return {
    loco: oneOf(LOCOS, j['loco']) ?? d.loco, body: oneOf(BODIES, j['body']) ?? d.body, head: oneOf(HEADS, j['head']) ?? d.head, eyes: j['eyes'] === 1 ? 1 : j['eyes'] === 2 ? 2 : d.eyes,
    bw: num('bw'), bh: num('bh'), bd: num('bd'), round: num('round'), legs: num('legs'), neck: num('neck'), headS: num('headS'), eyeS: num('eyeS'), arm: num('arm'), armT: num('armT'), wear: num('wear'),
    chimney: flag('chimney'), panel: flag('panel'), rivets: flag('rivets'), leds: flag('leds'),
    paint: color(j['paint'], d.paint), accent: color(j['accent'], d.accent), eye: color(j['eye'], d.eye), acc: oneOf(ACCS, j['acc']) ?? d.acc
  };
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
// váhy: [hodnota, váha]
function weighted<T>(r: () => number, a: readonly (readonly [T, number])[]): T {
  let x = r() * a.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of a) { x -= w; if (x < 0) return v; }
  return must(a[a.length - 1])[0];
}
// Generátor: náhodný robot zo semienka (vždy ten istý pre to isté semienko). Diely sa vyberajú s váhami, aby vznikali
// skôr milé kombinácie (hlava „žiadna“ len pri okrúhlych trupoch, kde je oko ako okienko), čísla rovnomerne v rozsahu.
export function randomLook(seed: number): RobotLook {
  const r = rng(seed);
  const loco = weighted<Loco>(r, [['treads', 3], ['wheels', 2], ['ball', 2], ['legs2', 3], ['legs3', 2]]);
  const body = weighted<BodyShape>(r, [['box', 3], ['ball', 2], ['barrel', 2], ['can', 2]]);
  const head = weighted<HeadKind>(r, [['bino', 3], ['dome', 2], ['ball', 3], ['tv', 2], ['none', body === 'barrel' || body === 'ball' ? 3 : 0.5]]);
  const n = (k: NumKey): number => { const q = NUM[k]; return r3(q.min + r() * (q.max - q.min)); };
  const nums = Object.fromEntries(NUM_KEYS.map(k => [k, n(k)]));
  const paint = pick(r, PAINTS);
  let accent = pick(r, ACCENTS); if (accent === paint) accent = must(ACCENTS[0]);
  return robotLook({
    ...nums, loco, body, head, eyes: head === 'bino' ? (r() < 0.85 ? 2 : 1) : head === 'none' || head === 'dome' ? (r() < 0.7 ? 1 : 2) : (r() < 0.75 ? 2 : 1),
    wear: r3(r() * 0.8),
    chimney: r() < 0.25, panel: r() < 0.6, rivets: r() < 0.6, leds: r() < 0.35,
    paint, accent, eye: pick(r, EYES), acc: weighted<Accessory>(r, [['none', 4], ['antenna', 2], ['hat', 1.5], ['sprout', 1.5]])
  });
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
// Úchyt: kĺb, poloha a natočenie – v ruke sa náradie drží za rúčku
export interface Mount { readonly j: JointId; readonly p: V3; readonly r?: V3 }
// Koleso / guľa, ktorá sa pri chôdzi otáča (kĺb otočený okolo x o vzdialenosť / polomer)
export interface Wheel { readonly j: JointId; readonly r: number }
export interface RobotModel {
  readonly look: RobotLook; readonly joints: readonly Joint[]; readonly parts: readonly Part[];
  readonly mounts: Readonly<Record<MountId, Mount>>; readonly wheels: readonly Wheel[];
  readonly height: number; // po temeno hlavy (bez doplnku), už so zmenšením
  readonly scale: number;  // celý robot je zväčšený / zmenšený, aby bol vysoký HEIGHT_MIN…HEIGHT_MAX
  readonly gait: 'roll' | 'walk';
}
// Každý robot je zhruba taký vysoký ako hráč: menšie sa zväčšia, väčšie zmenšia (zachová sa tvar)
export const HEIGHT_MIN = 0.55, HEIGHT_MAX = 0.9;
// natočenie, ktoré otočí os y do smeru n (Euler XYZ s y = 0)
function alignY(n: V3): V3 {
  const l = Math.hypot(...n) || 1;
  return [Math.atan2(n[2] / l, n[1] / l), 0, Math.asin(Math.max(-1, Math.min(1, -n[0] / l)))];
}

// Stavba modelu: kĺby a diely
class Builder {
  joints: Joint[] = [{ id: 'root', parent: null, p: [0, 0, 0] }];
  parts: Part[] = [];
  wheels: Wheel[] = [];
  joint(id: JointId, parent: JointId, p: V3): JointId { this.joints.push({ id, parent, p }); return id; }
  add(j: JointId, shape: Shape, p: V3, m: Mat, r?: V3, tag?: string): void { this.parts.push({ j, shape, p, m, ...(r ? { r } : {}), ...(tag ? { tag } : {}) }); }
  // tyč (valec) z bodu a do bodu b
  rod(j: JointId, a: V3, b: V3, r: number, m: Mat): void {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    this.add(j, { k: 'cyl', r, h: Math.hypot(...d) }, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], m, alignY(d));
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
  // oko ako ďalekohľad: rúrka dopredu, šošovka, svietiaca dúhovka, odlesk a viečko (tag 'lid' – žmurkanie)
  binoEye(j: JointId, p: V3, r: number, depth: number): void {
    const f = p[2] + depth / 2;
    this.add(j, { k: 'cyl', r, r2: r * 0.92, h: depth }, p, 'paint', [Math.PI / 2, 0, 0]);
    this.add(j, { k: 'torus', r: r * 0.95, t: r * 0.14 }, [p[0], p[1], f], 'dark', [Math.PI / 2, 0, 0]);
    this.add(j, { k: 'sphere', r: r * 0.8, s: [1, 1, 0.35] }, [p[0], p[1], f], 'lens');
    this.add(j, { k: 'sphere', r: r * 0.45, s: [1, 1, 0.3] }, [p[0], p[1], f + r * 0.22], 'eye');
    this.add(j, { k: 'sphere', r: r * 0.2, s: [1, 1, 0.3] }, [p[0], p[1], f + r * 0.3], 'lens');
    this.add(j, { k: 'sphere', r: r * 0.12 }, [p[0] - r * 0.22, p[1] + r * 0.22, f + r * 0.36], 'glass');
    this.add(j, { k: 'box', s: [r * 2.1, r * 1.0, depth * 0.9], r: r * 0.4 }, [p[0], p[1] + r * 0.62, p[2] + depth * 0.06], 'paint', undefined, 'lid');
  }
  // okrúhle oko na povrchu (okienko): obruč, šošovka, svetlo, odlesk, viečko; povrch pozerá na +z, natočený o yaw
  roundEye(j: JointId, p: V3, r: number, yaw = 0, rim: Mat = 'metal', rivets = false): void {
    const [x, y, z] = p, fx = Math.sin(yaw), fz = Math.cos(yaw), at = (d: number, dx = 0, dy = 0): V3 => [x + fx * d + dx * fz, y + dy, z + fz * d - dx * fx];
    this.add(j, { k: 'torus', r: r * 1.05, t: r * 0.22 }, at(0), rim, [Math.PI / 2, yaw, 0]);
    this.add(j, { k: 'sphere', r, s: [1, 1, 0.3] }, at(0), 'lens', [0, yaw, 0]);
    this.add(j, { k: 'sphere', r: r * 0.5, s: [1, 1, 0.35] }, at(r * 0.15), 'eye', [0, yaw, 0]);
    this.add(j, { k: 'sphere', r: r * 0.17 }, at(r * 0.3, -r * 0.3, r * 0.35), 'glass');
    this.add(j, { k: 'box', s: [r * 2.3, r * 0.9, r * 0.6], r: r * 0.4 }, at(r * 0.05, 0, r * 0.85), 'paint', [0, yaw, 0], 'lid');
    if (rivets) for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; this.add(j, { k: 'sphere', r: r * 0.11 }, at(r * 0.22, Math.cos(a) * r * 1.07, Math.sin(a) * r * 1.07), 'metal'); }
  }
  // doplnok na temene (bod p)
  accessory(acc: Accessory, j: JointId, p: V3): void {
    const [x, y, z] = p;
    if (acc === 'antenna') {
      this.add(j, { k: 'cyl', r: 0.008, h: 0.16 }, [x, y + 0.08, z], 'dark', undefined, 'antenna');
      this.add(j, { k: 'sphere', r: 0.028 }, [x, y + 0.17, z], 'eye', undefined, 'antenna');
    } else if (acc === 'hat') {
      this.add(j, { k: 'cyl', r: 0.13, h: 0.015 }, [x, y + 0.008, z], 'accent');
      this.add(j, { k: 'cyl', r: 0.075, r2: 0.07, h: 0.09 }, [x, y + 0.055, z], 'accent');
      this.add(j, { k: 'cyl', r: 0.077, h: 0.02 }, [x, y + 0.03, z], 'rust');
    } else if (acc === 'sprout') {
      this.add(j, { k: 'cyl', r: 0.05, r2: 0.065, h: 0.07 }, [x, y + 0.035, z], 'pot');
      this.add(j, { k: 'cyl', r: 0.006, h: 0.08 }, [x, y + 0.1, z], 'leaf', undefined, 'sprout');
      for (const s of [-1, 1]) this.add(j, { k: 'sphere', r: 0.035, s: [1.4, 0.35, 0.8] }, [x + s * 0.035, y + 0.135, z], 'leaf', [0, 0, s * 0.5], 'sprout');
    }
  }
}

// ---------- trup ----------
// Povrch trupu (v súradniciach trupu, stred = 0): polovičné rozmery, kde je predok a bok vo výške y, bod a normála
// na povrchu pre smer (uhol okolo y, výška −1…1) – na hrdzu, nity a oči
interface Hull { hx: number; hy: number; hz: number; top: number; bottom: number; front(y: number): number; side(y: number): number; at(a: number, v: number): { p: V3; n: V3 } }
function hull(L: RobotLook): Hull {
  const hx = L.bw / 2, hy = L.bh / 2;
  if (L.body === 'box') {
    const hz = (L.bw * L.bd) / 2;
    return {
      hx, hy, hz, top: hy, bottom: hy,
      front: () => hz, side: () => hx,
      at: (a, v) => {
        // stena podľa uhla: predok / zadok alebo bok
        const sn = Math.sin(a), c = Math.cos(a), y = v * hy * 0.75;
        if (Math.abs(c) * hx >= Math.abs(sn) * hz) return { p: [sn * hx * 0.8, y, Math.sign(c) * (hz + 0.001)], n: [0, 0, Math.sign(c)] };
        return { p: [Math.sign(sn) * (hx + 0.001), y, c * hz * 0.8], n: [Math.sign(sn), 0, 0] };
      }
    };
  }
  if (L.body === 'ball') {
    const hz = (L.bw * L.bd) / 2, k = (y: number): number => Math.sqrt(Math.max(0, 1 - (y / hy) ** 2));
    return {
      hx, hy, hz, top: hy, bottom: hy,
      front: y => hz * k(y), side: y => hx * k(y),
      at: (a, v) => { const y = v * hy * 0.8, q = k(y); return { p: [Math.sin(a) * hx * q, y, Math.cos(a) * hz * q], n: [Math.sin(a) / hx * q, y / hy / hy, Math.cos(a) / hz * q] }; }
    };
  }
  // kotol a plechovka: valec (kotol má klenutý spodok a vrchnák)
  const dome = L.body === 'barrel';
  return {
    hx, hy, hz: hx, top: hy + (dome ? hx * 0.5 : 0.01), bottom: hy + (dome ? hx * 0.35 : 0),
    front: () => hx, side: () => hx,
    at: (a, v) => ({ p: [Math.sin(a) * (hx + 0.001), v * hy * 0.8, Math.cos(a) * (hx + 0.001)], n: [Math.sin(a), 0, Math.cos(a)] })
  };
}
function trunk(b: Builder, L: RobotLook, body: JointId, H: Hull): void {
  const { hx, hy, hz } = H;
  if (L.body === 'box') {
    b.add(body, { k: 'box', s: [L.bw, L.bh, hz * 2], r: Math.min(hx, hy, hz) * (0.12 + L.round * 0.7) }, [0, 0, 0], 'paint');
    b.add(body, { k: 'box', s: [L.bw + 0.02, 0.035, hz * 2 + 0.02], r: 0.015 }, [0, -hy + 0.02, 0], 'accent');
  } else if (L.body === 'ball') {
    b.add(body, { k: 'sphere', r: hx, s: [1, hy / hx, hz / hx] }, [0, 0, 0], 'paint');
    // pás okolo rovníka (sploštená guľa trochu väčšia než trup)
    b.add(body, { k: 'sphere', r: hx * 1.015, s: [1, 0.08, hz / hx * 1.0] }, [0, 0, 0], 'accent');
  } else {
    b.add(body, { k: 'cyl', r: hx, h: L.bh }, [0, 0, 0], 'paint');
    if (L.body === 'barrel') {
      b.add(body, { k: 'sphere', r: hx, s: [1, 0.35, 1] }, [0, -hy, 0], 'paint');
      for (const y of [-hy * 0.85, hy * 0.85]) b.add(body, { k: 'torus', r: hx * 1.01, t: 0.013 }, [0, y, 0], 'accent');
    } else {
      for (const y of [-0.33, 0, 0.33]) b.add(body, { k: 'torus', r: hx * 1.01, t: 0.008 }, [0, y * hy * 1.3, 0], 'metal');
      b.add(body, { k: 'cyl', r: hx * 1.04, h: 0.02 }, [0, hy, 0], 'accent');
      b.add(body, { k: 'cyl', r: hx * 1.02, h: 0.015 }, [0, -hy, 0], 'accent');
    }
  }
  // nity okolo pása
  if (L.rivets) {
    const y = L.body === 'barrel' ? hy * 0.85 : L.body === 'box' ? hy - 0.035 : 0;
    if (L.body === 'box') { for (const x of [-1, 1]) for (const yy of [-1, 1]) b.add(body, { k: 'sphere', r: 0.011 }, [x * (hx - 0.03), yy * (hy - 0.04), hz + 0.002], 'metal'); }
    else for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; const q = H.at(a, y / hy / 0.8); b.add(body, { k: 'sphere', r: 0.009 }, [q.p[0] * 1.03, q.p[1], q.p[2] * 1.03], 'metal'); }
  }
}
// štítok / dvierka vpredu, svetielka, komínik
function details(b: Builder, L: RobotLook, body: JointId, H: Hull, eyesOnBody: boolean): void {
  const { hx, hy } = H;
  const py = eyesOnBody ? -hy * 0.55 : L.body === 'box' ? 0 : -hy * 0.35;
  if (L.panel) {
    const w = Math.min(hx * 1.25, 0.2), h = Math.min(hy * (eyesOnBody ? 0.45 : 1), 0.15), z = H.front(py);
    const tilt = L.body === 'ball' ? -Math.atan2(py * (H.hz / hy) ** 2 / hy, 1) * 0.9 : 0;
    b.add(body, { k: 'box', s: [w, h, 0.02], r: 0.02 }, [0, py, z], 'accent', [tilt, 0, 0]);
    b.add(body, { k: 'box', s: [w * 0.3, 0.018, 0.02], r: 0.008 }, [0, py + h * 0.2, z + 0.012], 'dark', [tilt, 0, 0]);
  }
  if (L.leds) {
    const y = L.panel ? py - Math.min(hy * 0.5, 0.075) * 0.4 : eyesOnBody ? -hy * 0.6 : 0, z = H.front(y) + 0.012 + (L.panel ? 0.01 : 0);
    for (const x of [-0.03, 0, 0.03]) b.add(body, { k: 'sphere', r: 0.012 }, [x, y, z], x ? 'warm' : 'eye', undefined, 'led');
  }
  if (L.chimney) {
    const x = hx * 0.45, z = -H.hz * 0.35, y = H.top - (L.body === 'ball' ? hy * 0.15 : 0.01);
    b.add(body, { k: 'cyl', r: 0.025, r2: 0.03, h: 0.12 }, [x, y + 0.04, z], 'dark');
    b.add(body, { k: 'cyl', r: 0.04, r2: 0.032, h: 0.025 }, [x, y + 0.11, z], 'accent');
    for (const k of [0, 1, 2]) b.add(body, { k: 'sphere', r: 0.025 + k * 0.012 }, [x + k * 0.01, y + 0.15 + k * 0.05, z], 'glass', undefined, 'steam');
  }
}
// škvrny hrdze: náhodné body na povrchu trupu, koľko podľa wear (najviac 9)
function rust(b: Builder, L: RobotLook, body: JointId, H: Hull): void {
  const r = rng(hashStr(JSON.stringify(L)) ^ 0x9e3779b9), n = Math.round(L.wear * 9);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, v = r() * 1.6 - 0.8, q = H.at(a, v), k = 0.022 + r() * 0.022;
    b.add(body, { k: 'sphere', r: k, s: [1 + r() * 0.6, 0.12, 0.8 + r() * 0.5] }, q.p, 'rust', alignY(q.n));
  }
}

// ---------- podvozok ----------
// Postaví podvozok a vráti, v akej výške je spodok trupu
function chassis(b: Builder, L: RobotLook, H: Hull): number {
  const { hx, hz } = H;
  if (L.loco === 'treads') {
    // pásy: dlhé zaoblené kocky po bokoch, v nich tri kolesá, ktorých náboje vidno zboku
    const th = 0.15 + L.legs * 0.05, tl = Math.max(0.3, hz * 2 + 0.08), x = hx + 0.04;
    for (const sx of [-1, 1]) {
      b.add('root', { k: 'box', s: [0.11, th, tl], r: th * 0.44 }, [sx * x, th / 2, 0], 'rubber');
      const zs = [-tl / 2 + th / 2 - 0.01, 0, tl / 2 - th / 2 + 0.01];
      for (const [i, z] of zs.entries()) {
        const rr = i === 1 ? th * 0.29 : th * 0.36;
        const w = b.joint(`wheel${sx > 0 ? 'L' : 'R'}${i}`, 'root', [sx * x, th / 2, z]);
        b.add(w, { k: 'cyl', r: rr, h: 0.118 }, [0, 0, 0], 'metal', [0, 0, Math.PI / 2]);
        b.add(w, { k: 'box', s: [0.122, rr * 1.7, 0.016], r: 0.006 }, [0, 0, 0], 'accent');
        b.add(w, { k: 'box', s: [0.122, 0.016, rr * 1.7], r: 0.006 }, [0, 0, 0], 'accent');
        b.wheels.push({ j: w, r: rr });
      }
    }
    b.add('root', { k: 'box', s: [x * 2 - 0.08, 0.03, tl * 0.6], r: 0.01 }, [0, th * 0.75, 0], 'dark');
    return th + 0.035;
  }
  if (L.loco === 'wheels') {
    // dve veľké kolesá po bokoch, vzadu malé kolieska na podperu
    const rr = 0.09 + L.legs * 0.05, x = hx + 0.035;
    for (const sx of [-1, 1]) {
      const w = b.joint(`wheel${sx > 0 ? 'L' : 'R'}`, 'root', [sx * x, rr, 0]);
      b.add(w, { k: 'torus', r: rr * 0.82, t: rr * 0.2 }, [0, 0, 0], 'rubber', [0, 0, Math.PI / 2]);
      b.add(w, { k: 'cyl', r: rr * 0.66, h: 0.03 }, [0, 0, 0], 'metal', [0, 0, Math.PI / 2]);
      for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3]) b.add(w, { k: 'box', s: [0.036, rr * 1.25, 0.018], r: 0.006 }, [0, 0, 0], 'accent', [a, 0, 0]);
      b.add(w, { k: 'cyl', r: rr * 0.2, h: 0.045 }, [0, 0, 0], 'dark', [0, 0, Math.PI / 2]);
      b.wheels.push({ j: w, r: rr });
      b.add('root', { k: 'cyl', r: 0.015, h: x - hx + 0.02 }, [sx * (hx + (x - hx) / 2 - 0.01), rr, 0], 'dark', [0, 0, Math.PI / 2]);
    }
    const bottom = rr * 0.55;
    b.rod('root', [0, bottom + 0.01, -hz * 0.6], [0, 0.03, -hz * 0.9], 0.01, 'dark');
    const c = b.joint('caster', 'root', [0, 0.03, -hz * 0.9]);
    b.add(c, { k: 'sphere', r: 0.03 }, [0, 0, 0], 'rubber');
    b.wheels.push({ j: c, r: 0.03 });
    return bottom;
  }
  if (L.loco === 'ball') {
    const rr = 0.08 + L.legs * 0.06, ball = b.joint('ball', 'root', [0, rr, 0]);
    b.add(ball, { k: 'sphere', r: rr }, [0, 0, 0], 'rubber');
    b.add(ball, { k: 'torus', r: rr, t: 0.012 }, [0, 0, 0], 'accent', [0, 0, Math.PI / 2]);
    b.add(ball, { k: 'torus', r: rr, t: 0.012 }, [0, 0, 0], 'accent', [Math.PI / 2, 0, 0]);
    b.wheels.push({ j: ball, r: rr });
    const bottom = rr * 2 - 0.03;
    // sukienka nad guľou
    b.add('root', { k: 'cyl', r: rr * 1.05, r2: Math.min(hx, hz) * 0.85, h: 0.06 }, [0, bottom + 0.01, 0], 'accent');
    return bottom;
  }
  if (L.loco === 'legs2') {
    // dve krátke nohy s veľkými topánkami (bedrá sú na trupe – kĺby hipL/hipR pridá body())
    return 0.1 + L.legs * 0.12 + 0.05;
  }
  return 0.2 + L.legs * 0.12;
}
// nohy na trupe (bedrá sa kývu s trupom)
function legs(b: Builder, L: RobotLook, body: JointId, H: Hull, bottom: number): void {
  const yb = -H.bottom;
  if (L.loco === 'legs2') {
    const len = bottom - 0.05;
    for (const sx of [-1, 1]) {
      const hip = b.joint('hip' + (sx > 0 ? 'L' : 'R'), body, [sx * Math.max(0.06, H.hx * 0.45), yb, 0]);
      b.add(hip, { k: 'sphere', r: 0.032 }, [0, 0, 0], 'dark');
      b.add(hip, { k: 'capsule', r: 0.028, h: Math.max(0.01, len - 0.05) }, [0, -len / 2, 0], 'metal');
      b.add(hip, { k: 'box', s: [0.08, 0.05, 0.12], r: 0.022 }, [0, -len - 0.025, 0.02], 'accent');
    }
  } else if (L.loco === 'legs3') {
    // trojnožka: koleno vonku, chodidlo trochu bližšie pod trupom
    for (let i = 0; i < 3; i++) {
      const a = (i * 2 * Math.PI) / 3 + Math.PI, ax = Math.sin(a) * H.hx * 0.7, az = Math.cos(a) * H.hz * 0.7;
      const hip = b.joint('hip' + i, body, [ax, yb + 0.02, az]);
      b.add(hip, { k: 'sphere', r: 0.028 }, [0, 0, 0], 'dark');
      const kp: V3 = [ax * 0.6, -bottom * 0.42, az * 0.6];
      b.rod(hip, [0, 0, 0], kp, 0.014, 'metal');
      const knee = b.joint('knee' + i, hip, kp);
      b.add(knee, { k: 'sphere', r: 0.022 }, [0, 0, 0], 'accent');
      const foot: V3 = [-ax * 0.25, -(bottom + 0.02) * 0.58 + 0.01, -az * 0.25];
      b.rod(knee, [0, 0, 0], foot, 0.013, 'metal');
      b.add(knee, { k: 'cyl', r: 0.04, r2: 0.03, h: 0.018 }, [foot[0], foot[1] - 0.005, foot[2]], 'dark');
    }
  }
}

// ---------- hlava ----------
// Postaví hlavu na krku a vráti temeno (kĺb a bod) – kam patrí doplnok a úchyt top
function head(b: Builder, L: RobotLook, body: JointId, H: Hull): { j: JointId; p: V3 } {
  const s = L.headS, e = L.eyeS;
  if (L.head === 'none') {
    // oči na trupe ako okienka; „hlava“ je vrchnák trupu (pri kotli klenutý), na ňom doplnok
    const top = b.joint('head', body, [0, H.hy, 0]);
    if (L.body === 'barrel') { b.add(top, { k: 'sphere', r: H.hx * 0.99, s: [1, 0.5, 1] }, [0, 0, 0], 'paint'); b.add(top, { k: 'cyl', r: 0.03, h: 0.02 }, [0, H.hx * 0.5, 0], 'accent'); }
    const y = L.body === 'box' ? H.hy * 0.25 : L.body === 'ball' ? H.hy * 0.25 : 0, r = 0.055 * e;
    const eye = b.joint('eye', body, [0, y, 0]);
    if (L.eyes === 1) b.roundEye(eye, [0, 0, H.front(y) + 0.005], r * 1.25, 0, 'accent', L.rivets);
    else for (const sx of [-1, 1]) { const yaw = L.body === 'box' ? 0 : Math.asin(Math.min(0.8, (sx * r * 1.15) / H.hx)); b.roundEye(eye, [sx * r * 1.15, 0, H.front(y) * Math.cos(yaw) + 0.005], r, yaw, 'accent'); }
    return { j: top, p: [0, (H.top - H.hy) + 0.005, 0] };
  }
  const nl = L.head === 'bino' ? 0.04 + L.neck * 0.12 : L.neck * 0.08;
  const neck = b.joint('neck', body, [0, H.top, L.head === 'bino' ? -0.02 : 0]);
  if (nl > 0.005) {
    b.add(neck, { k: 'cyl', r: L.head === 'bino' ? 0.03 : 0.025, h: nl }, [0, nl / 2, 0], 'dark');
    b.add(neck, { k: 'torus', r: 0.03, t: 0.008 }, [0, nl * 0.35, 0], 'metal');
  }
  if (L.head === 'bino') {
    const hd = b.joint('head', neck, [0, nl + 0.01, 0]), r = 0.055 * e * Math.sqrt(s);
    b.add(hd, { k: 'box', s: [0.1 * s, 0.05 * s, 0.08 * s], r: 0.02 * s }, [0, 0.01, -0.01], 'accent');
    if (L.eyes === 2) for (const sx of [-1, 1]) b.binoEye(hd, [sx * (r + 0.02 * s), 0.03, 0], r, 0.11 * s);
    else b.binoEye(hd, [0, 0.03, 0.01], r * 1.3, 0.12 * s);
    return { j: hd, p: [0, 0.03 + r * (L.eyes === 2 ? 1.25 : 1.6), -0.01] };
  }
  if (L.head === 'dome') {
    const R = 0.125 * s, hd = b.joint('head', neck, [0, nl, 0]);
    b.add(hd, { k: 'cyl', r: R * 1.04, h: 0.03 }, [0, 0, 0], 'accent');
    const c = R * 0.72;
    b.add(hd, { k: 'sphere', r: R * 0.68 }, [0, c, 0.01], 'paint');
    const er = 0.045 * e * s;
    if (L.eyes === 1) b.roundEye(hd, [0, c + 0.005, 0.01 + R * 0.62], er, 0, 'dark');
    else for (const sx of [-1, 1]) b.roundEye(hd, [sx * er * 1.05, c + 0.005, 0.01 + R * 0.6 - er * 0.2], er * 0.8, sx * 0.45, 'dark');
    b.add(hd, { k: 'dome', r: R }, [0, 0.012, 0], 'glass');
    return { j: hd, p: [0, R + 0.012, 0] };
  }
  if (L.head === 'ball') {
    const R = 0.11 * s, hd = b.joint('head', neck, [0, nl + R * 0.85, 0]);
    b.add(hd, { k: 'sphere', r: R }, [0, 0, 0], 'paint');
    b.add(hd, { k: 'torus', r: R * 1.005, t: 0.008 }, [0, -R * 0.18, 0], 'accent');
    const er = 0.034 * e * s;
    if (L.eyes === 1) b.roundEye(hd, [0, R * 0.08, R * 0.93], er * 1.3, 0);
    else for (const sx of [-1, 1]) { const yaw = sx * 0.4; b.roundEye(hd, [Math.sin(yaw) * R * 0.93, R * 0.08, Math.cos(yaw) * R * 0.93], er, yaw); }
    for (const sx of [-1, 1]) b.add(hd, { k: 'cyl', r: 0.025 * s, h: 0.03 }, [sx * R, 0, 0], 'accent', [0, 0, Math.PI / 2]); // „uši“
    b.add(hd, { k: 'box', s: [0.05 * s, 0.012, 0.02], r: 0.006 }, [0, -R * 0.45, R * 0.9], 'dark', [-0.4, 0, 0]);
    return { j: hd, p: [0, R * 0.98, 0] };
  }
  // televízor: zaoblená skrinka, tmavá obrazovka, oči na nej svietia
  const w = 0.2 * s, h = 0.14 * s, d = 0.12 * s, hd = b.joint('head', neck, [0, nl + h / 2, 0]);
  b.add(hd, { k: 'box', s: [w, h, d], r: 0.025 * s }, [0, 0, 0], 'paint');
  b.add(hd, { k: 'box', s: [w * 0.8, h * 0.72, 0.02], r: 0.02 * s }, [0, 0, d / 2 - 0.004], 'lens');
  const er = 0.026 * e * s;
  for (const x of L.eyes === 1 ? [0] : [-1, 1]) {
    const k = L.eyes === 1 ? 1.4 : 1;
    b.add(hd, { k: 'sphere', r: er * k, s: [1, 1.15, 0.3] }, [x * w * 0.2, 0.005, d / 2 + 0.006], 'eye');
    b.add(hd, { k: 'box', s: [er * k * 2.6, er * k * 1.3, 0.012], r: 0.006 }, [x * w * 0.2, er * k * 1.4, d / 2 + 0.01], 'lens', undefined, 'lid');
  }
  for (const sx of [-1, 1]) b.add(hd, { k: 'sphere', r: 0.018 * s }, [sx * (w / 2 + 0.006), 0, 0], 'dark'); // gombíky
  b.add(hd, { k: 'cyl', r: 0.008, h: 0.05 }, [w * 0.3, h / 2 + 0.02, -d * 0.2], 'dark');
  return { j: hd, p: [0, h / 2, 0] };
}

// ---------- celý robot ----------
const MOUNT_HAND = (j: JointId): Mount => ({ j, p: [0, -0.03, 0], r: [Math.PI / 2, 0, 0] });
export function robotModel(look0: RobotLook): RobotModel {
  const L = robotLook(look0), b = new Builder(), H = hull(L);
  const bottom = chassis(b, L, H);
  const body = b.joint('body', 'root', [0, bottom + H.bottom, 0]);
  trunk(b, L, body, H);
  legs(b, L, body, H, bottom);
  const top = head(b, L, body, H);
  details(b, L, body, H, L.head === 'none');
  // ramená z bokov trupu, trochu nad stredom
  const sy = H.hy * 0.25, sx = H.side(sy) + L.armT * 0.6;
  // krátky robot má kratšie ruky, aby klieštiky neťahal po zemi (ruka je ~1,05 dĺžky pod plecom)
  const arm = Math.max(0.07, Math.min(L.arm, (bottom + H.bottom + sy - 0.08) / 1.05));
  b.arm(1, body, [sx, sy, L.body === 'box' ? 0.03 : 0], arm, L.armT);
  b.arm(-1, body, [-sx, sy, L.body === 'box' ? 0.03 : 0], arm, L.armT);
  // nosič na chrbte (dve priečky)
  for (const y of [H.hy * 0.5, -H.hy * 0.5]) b.add(body, { k: 'box', s: [Math.min(0.26, H.hx * 1.6), 0.02, 0.02], r: 0.008 }, [0, y, -H.front(y) - 0.012], 'metal');
  b.accessory(L.acc, top.j, top.p);
  rust(b, L, body, H);
  const mounts: Record<MountId, Mount> = { handR: MOUNT_HAND('handR'), handL: MOUNT_HAND('handL'), back: { j: body, p: [0, 0, -H.hz - 0.035] }, top: { j: top.j, p: top.p } };
  const m0: RobotModel = { look: L, joints: b.joints, parts: b.parts, wheels: b.wheels, mounts, height: 0, scale: 1, gait: L.loco === 'legs2' || L.loco === 'legs3' ? 'walk' : 'roll' };
  const h0 = mountAt(m0, null, 'top')[1], scale = Math.max(HEIGHT_MIN, Math.min(HEIGHT_MAX, h0)) / h0;
  return { ...m0, scale, height: Math.round(h0 * scale * 1000) / 1000 };
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
  let bodyR: V3 = [walk && m.look.loco === 'ball' ? 0.18 : 0, 0, walk && !roll ? sw * 0.06 : 0];
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
  if (j.parent) return mul(jointMatrix(m, pose, j.parent), local);
  // koreň nesie zmenšenie celého robota
  const k = m.scale;
  return [[local[0][0] * k, local[0][1] * k, local[0][2] * k], [local[1][0] * k, local[1][1] * k, local[1][2] * k], [local[2][0] * k, local[2][1] * k, local[2][2] * k], local[3]];
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
export const presetName = (s: string): string => lookup(PRESETS, s)?.name ?? s;
