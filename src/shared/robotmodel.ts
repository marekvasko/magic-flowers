// Hráč ako 3D robot (#194): procedurálny generátor robota bez Three.js. Robot je „genóm“ (RobotLook) zložený z dielov –
// podvozok (pásy, dve kolesá, guľa, dve nohy, trojnožka), trup (kocka, guľa, kotol, plechovka), hlava (ďalekohľad,
// sklenená kupola, guľa, televízor, žiadna – oči na trupe), počet očí, rozmery, ramená, drobnosti (komín, štítok, nity,
// svetielka), farby, hrdza a doplnok. randomLook(semienko) ho vygeneruje, robotModel z neho postaví kĺby (stromček),
// diely z hladkých tvarov a úchyty pre náradie (ruky, nosič na chrbte, temeno); robotPose dá pózu podľa toho, čo robí.
// Sieť stavia client/robot3d.ts (hra aj /debug → Robots); polohu ruky (lampáš, lano saní) vie spočítať aj test (mountAt).
// Päť ručne naladených robotov (Hrdzavec, Kotúľ, Kotlík, Plecháčik, Hranáč) sú predvoľby generátora (PRESETS).
// Roboty sú vlastné – inšpirované žánrom malých hrdzavých robotov po konci sveta, ale hladké a milé.
// Súradnice: 1 = políčko, y hore, robot pozerá na +z (dopredu), jeho pravá ruka je na −x. Stojí na y = 0.
import { isRecord, lookup, must } from './util.ts';
import type { JsonRecord } from './util.ts';
import type { ToolId } from './data.ts';

export type V3 = [number, number, number];

// ---------- genóm ----------
export const LOCOS = ['treads', 'wheels', 'rover', 'ball', 'legs2', 'legs3'] as const;
export const BODIES = ['box', 'ball', 'barrel', 'can'] as const;
export const HEADS = ['bino', 'dome', 'ball', 'tv', 'none'] as const;
export const ACCS = ['none', 'antenna', 'hat', 'sprout'] as const;
export const EDGES = ['soft', 'sharp'] as const;
export type Loco = typeof LOCOS[number];
export type BodyShape = typeof BODIES[number];
export type HeadKind = typeof HEADS[number];
export type Accessory = typeof ACCS[number];
// Hrany: oblé (hladké, zaoblené) alebo ostré (kocky s ostrými hranami, valce a gule ako mnohosteny)
export type Edges = typeof EDGES[number];
// Číselné vlastnosti: rozsah a predvolená hodnota (všetko v políčkach, okrem pomerov)
// Rozmery robota sú pre všetkých rovnaké (FRAME): výška, šírka a hĺbka trupu, výška spodku trupu nad zemou, poloha
// pliec, dĺžka a hrúbka rúk. Generátor mení len tvary a vzhľad. Číselné vlastnosti genómu sú preto len tvarové:
// výška trupu (krk ju vyrovná, celková výška ostáva), zaoblenie, veľkosť hlavy (zmenšená, ak by sa nezmestila),
// veľkosť očí a hrdza.
export const NUM = {
  bh: { min: 0.24, max: 0.34, def: 0.28, name: 'Výška trupu' },
  round: { min: 0, max: 1, def: 0.35, name: 'Zaoblenie' },
  headS: { min: 0.8, max: 1.3, def: 1, name: 'Veľkosť hlavy' },
  eyeS: { min: 0.7, max: 1.4, def: 1, name: 'Veľkosť očí' },
  wear: { min: 0, max: 1, def: 0.3, name: 'Hrdza' }
} as const;
export type NumKey = keyof typeof NUM;
export const NUM_KEYS: readonly NumKey[] = ['bh', 'round', 'headS', 'eyeS', 'wear'];
// Spoločné rozmery (políčka): výška po temeno, spodok trupu nad zemou, šírka a hĺbka trupu, plece (x, výška nad zemou, z),
// dĺžka a hrúbka ramena
export const FRAME = { height: 0.75, bottom: 0.2, bw: 0.32, depth: 0.3, shoulder: [0.215, 0.42, 0.02] as V3, arm: 0.24, armT: 0.02 } as const;
export const FLAGS = { chimney: 'Komínik', panel: 'Štítok', rivets: 'Nity', leds: 'Svetielka' } as const;
export type FlagKey = keyof typeof FLAGS;
export const FLAG_KEYS: readonly FlagKey[] = ['chimney', 'panel', 'rivets', 'leds'];
export interface RobotLook {
  readonly loco: Loco; readonly body: BodyShape; readonly head: HeadKind; readonly eyes: 1 | 2; readonly edges: Edges;
  readonly bh: number; readonly round: number; readonly headS: number; readonly eyeS: number; readonly wear: number;
  readonly chimney: boolean; readonly panel: boolean; readonly rivets: boolean; readonly leds: boolean;
  readonly paint: string; readonly accent: string; readonly eye: string; readonly acc: Accessory;
}
// Slovenské mená dielov (pre výber v hre)
export const PART_NAMES: { readonly loco: Readonly<Record<Loco, string>>; readonly body: Readonly<Record<BodyShape, string>>; readonly head: Readonly<Record<HeadKind, string>>; readonly acc: Readonly<Record<Accessory, string>>; readonly edges: Readonly<Record<Edges, string>> } = {
  loco: { treads: 'Pásy', wheels: 'Dve kolesá', rover: 'Šesť kolies', ball: 'Guľa', legs2: 'Dve nohy', legs3: 'Trojnožka' },
  body: { box: 'Skrinka', ball: 'Guľa', barrel: 'Kotol', can: 'Plechovka' },
  head: { bino: 'Ďalekohľad', dome: 'Kupola', ball: 'Guľka', tv: 'Televízor', none: 'Bez hlavy' },
  acc: { none: 'Nič', antenna: 'Anténa', hat: 'Klobúčik', sprout: 'Kvetináčik' },
  edges: { soft: 'Oblé', sharp: 'Ostré' }
};
export const ACCESSORIES = PART_NAMES.acc;

const BASE: RobotLook = {
  loco: 'treads', body: 'box', head: 'bino', eyes: 2, edges: 'soft', bh: 0.3, round: 0.33, headS: 1, eyeS: 1, wear: 0.45,
  chimney: false, panel: true, rivets: true, leds: false, paint: '#d9a441', accent: '#5b6b73', eye: '#9fe7ff', acc: 'none'
};
// Predvoľby: ručne naladené roboty
export type PresetId = 'hrdzavec' | 'kotul' | 'kotlik' | 'plechacik' | 'hranac';
export interface Preset { readonly name: string; readonly desc: string; readonly look: RobotLook }
export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  hrdzavec: { name: 'Hrdzavec', desc: 'Hranatý záhradník na pásoch, oči ako ďalekohľad na krku.', look: BASE },
  kotul: { name: 'Kotúľ', desc: 'Guľatý robotík, ktorý sa vozí na jednej guli. Jedno veľké oko pod sklom.', look: { ...BASE, loco: 'ball', body: 'ball', head: 'dome', eyes: 1, bh: 0.34, headS: 1.15, wear: 0.15, panel: true, paint: '#f1efe6', accent: '#e0734f', eye: '#7cf0b0', acc: 'antenna' } },
  kotlik: { name: 'Kotlík', desc: 'Malý kotol na troch tenkých nohách, okrúhle okienko a komínik.', look: { ...BASE, loco: 'legs3', body: 'barrel', head: 'none', eyes: 1, eyeS: 1.3, wear: 0.6, chimney: true, panel: false, paint: '#6f9a7a', accent: '#c7923e', eye: '#ffd36b' } },
  plechacik: { name: 'Plecháčik', desc: 'Plechovka na krátkych nožičkách, okrúhla hlava a dve okrúhle oči.', look: { ...BASE, loco: 'legs2', body: 'can', head: 'ball', eyes: 2, bh: 0.26, headS: 1.15, eyeS: 0.9, wear: 0.3, rivets: false, leds: true, paint: '#7fa7d9', accent: '#e9d8a6', eye: '#ffb3c7', acc: 'sprout' } },
  hranac: { name: 'Hranáč', desc: 'Hranatý stavebný robot s ostrými hranami, na pásoch, s televízorom namiesto hlavy.', look: { ...BASE, edges: 'sharp', head: 'tv', eyes: 2, bh: 0.28, headS: 1.1, wear: 0.5, leds: true, paint: '#e7c86a', accent: '#3d4448', eye: '#ffd36b', acc: 'none' } }
};
export const PRESET_IDS: readonly PresetId[] = ['hrdzavec', 'kotul', 'kotlik', 'plechacik', 'hranac'];
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
    loco: oneOf(LOCOS, j['loco']) ?? d.loco, body: oneOf(BODIES, j['body']) ?? d.body, head: oneOf(HEADS, j['head']) ?? d.head, edges: oneOf(EDGES, j['edges']) ?? d.edges, eyes: j['eyes'] === 1 ? 1 : j['eyes'] === 2 ? 2 : d.eyes,
    bh: num('bh'), round: num('round'), headS: num('headS'), eyeS: num('eyeS'), wear: num('wear'),
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
  const loco = weighted<Loco>(r, [['treads', 3], ['wheels', 2], ['rover', 2], ['ball', 2], ['legs2', 3], ['legs3', 2]]);
  const body = weighted<BodyShape>(r, [['box', 3], ['ball', 2], ['barrel', 2], ['can', 2]]);
  const head = weighted<HeadKind>(r, [['bino', 3], ['dome', 2], ['ball', 3], ['tv', 2], ['none', body === 'barrel' || body === 'ball' ? 3 : 0.5]]);
  const n = (k: NumKey): number => { const q = NUM[k]; return r3(q.min + r() * (q.max - q.min)); };
  const nums = Object.fromEntries(NUM_KEYS.map(k => [k, n(k)]));
  const paint = pick(r, PAINTS);
  let accent = pick(r, ACCENTS); if (accent === paint) accent = must(ACCENTS[0]);
  return robotLook({
    ...nums, loco, body, head, edges: r() < 0.35 ? 'sharp' : 'soft', eyes: head === 'bino' ? (r() < 0.85 ? 2 : 1) : head === 'none' || head === 'dome' ? (r() < 0.7 ? 1 : 2) : (r() < 0.75 ? 2 : 1),
    wear: r3(r() * 0.8),
    chimney: r() < 0.25, panel: r() < 0.6, rivets: r() < 0.6, leds: r() < 0.35,
    paint, accent, eye: pick(r, EYES), acc: weighted<Accessory>(r, [['none', 4], ['antenna', 2], ['hat', 1.5], ['sprout', 1.5]])
  });
}

// ---------- model ----------
export type Shape =
  | { readonly k: 'box'; readonly s: V3; readonly r: number }                 // zaoblená kocka (rozmery, polomer hrán)
  | { readonly k: 'cyl'; readonly r: number; readonly r2?: number; readonly h: number; readonly n?: number } // valec / kužeľ pozdĺž y (r dole, r2 hore)
  | { readonly k: 'sphere'; readonly r: number; readonly s?: V3; readonly n?: number } // guľa, s = natiahnutie v osiach
  | { readonly k: 'capsule'; readonly r: number; readonly h: number; readonly n?: number } // kapsula pozdĺž y (h = dĺžka rovnej časti)
// n = počet stien okolo osi: s ním je diel mnohosten s ostrými hranami (ploché tieňovanie), bez neho hladký
  | { readonly k: 'torus'; readonly r: number; readonly t: number }           // prstenec v rovine xz (okolo y)
  | { readonly k: 'dome'; readonly r: number };                               // horná pologuľa
// Materiály: náter, doplnková farba, kov, tmavý kov, guma, svetlo očí, šošovka (tmavé sklo), sklo, hrdza, svieti (teplo)
export type Mat = 'paint' | 'accent' | 'metal' | 'dark' | 'rubber' | 'eye' | 'lens' | 'glass' | 'rust' | 'warm' | 'leaf' | 'pot';
export type JointId = string;
// Diel: tvar na kĺbe, poloha a natočenie (Euler XYZ, rad) voči kĺbu; tag = čo animovať zvlášť (žmurkanie, para…)
export interface Part { readonly j: JointId; readonly shape: Shape; readonly p: V3; readonly r?: V3; readonly m: Mat; readonly tag?: string; readonly flat?: boolean }
// Kĺb: rodič a poloha voči nemu; natočenie dáva póza
export interface Joint { readonly id: JointId; readonly parent: JointId | null; readonly p: V3 }
export type MountId = 'handR' | 'handL' | 'back' | 'top';
// Úchyt: kĺb, poloha a natočenie – v ruke sa náradie drží za rúčku
export interface Mount { readonly j: JointId; readonly p: V3; readonly r?: V3; readonly s?: number }
// Koleso / guľa, ktorá sa pri chôdzi otáča (kĺb otočený okolo x o vzdialenosť / polomer)
export interface Wheel { readonly j: JointId; readonly r: number }
// Pás: slučka (dve polkružnice s polomerom R so stredmi v z = zb a zf, výška stredov y) z článkov; článok k je kĺb,
// ktorý póza posúva po slučke (s0 = jeho poloha na slučke v pokoji). Horná vetva ide pri jazde dopredu (+z).
export interface Track { readonly x: number; readonly y: number; readonly R: number; readonly zb: number; readonly zf: number; readonly links: readonly { readonly j: JointId; readonly s0: number }[] }
export const trackLength = (t: Track): number => 2 * (t.zf - t.zb) + 2 * Math.PI * t.R;
// Bod slučky vo vzdialenosti s od začiatku hornej vetvy (vzadu hore): výška, z a natočenie článku okolo x (0 = hore)
export function trackAt(t: Track, s0: number): { y: number; z: number; a: number } {
  const L = t.zf - t.zb, P = trackLength(t), R = t.R;
  let s = ((s0 % P) + P) % P;
  if (s < L) return { y: t.y + R, z: t.zb + s, a: 0 };
  s -= L;
  if (s < Math.PI * R) { const th = s / R; return { y: t.y + R * Math.cos(th), z: t.zf + R * Math.sin(th), a: th }; }
  s -= Math.PI * R;
  if (s < L) return { y: t.y - R, z: t.zf - s, a: Math.PI };
  s -= L;
  const th = Math.PI + s / R;
  return { y: t.y + R * Math.cos(th), z: t.zb + R * Math.sin(th), a: th };
}
export interface RobotModel {
  readonly look: RobotLook; readonly joints: readonly Joint[]; readonly parts: readonly Part[];
  readonly mounts: Readonly<Record<MountId, Mount>>; readonly wheels: readonly Wheel[]; readonly tracks: readonly Track[];
  // miesto každého náradia na nosiči na chrbte (puzdro alebo háčik); náradie v ruke tu chýba, prázdne miesto je vidieť
  readonly slots: Readonly<Record<ToolId, Mount>>;
  readonly height: number; // po temeno hlavy (bez doplnku), už so zmenšením
  readonly scale: number;  // celý robot je zväčšený / zmenšený, aby bol vysoký HEIGHT_MIN…HEIGHT_MAX
  readonly swingBack: number; // koľko z kroku dozadu smie ruka urobiť (menej, keď by narazila do nosiča), 0–1
  readonly shoulder: V3;      // pravé plece je zrkadlo (−x); v súradniciach trupu
  readonly armLen: number;
  readonly front: number;     // najďalej dopredu trup aj podvozok (z) – pred tým robot hrabe
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
const HAT_BRIM = 0.11; // polomer striešky klobúčika
const HARD: readonly Mat[] = ['paint', 'accent', 'metal', 'dark'];
class Builder {
  joints: Joint[] = [{ id: 'root', parent: null, p: [0, 0, 0] }];
  parts: Part[] = [];
  wheels: Wheel[] = [];
  tracks: Track[] = [];
  readonly sharp: boolean; readonly simple: boolean;
  constructor(sharp: boolean, simple: boolean) { this.sharp = sharp; this.simple = simple; }
  joint(id: JointId, parent: JointId, p: V3): JointId { this.joints.push({ id, parent, p }); return id; }
  // ostré hrany: kocky bez zaoblenia, väčšie valce osemboké a gule mnohosteny (sklo, guma a oči ostanú hladké)
  // Jednoduchý štýl (hra): svet je z hranatých kociek s plochými farbami, preto bez drobností (nity, skrutky, tenké
  // obruče, odlesky, ostrohy pásov), tenké tyčky hrubšie a štvorhranné, všetko s málo stenami a plochým tieňovaním.
  add(j: JointId, shape: Shape, p: V3, m: Mat, r?: V3, tag?: string): void {
    let sh = shape;
    if (this.simple) {
      // (oči a zreničky ostávajú vždy – robia robotovi tvár)
      if (sh.k === 'sphere' && m !== 'eye' && m !== 'lens' && ((sh.r < 0.0135 && tag !== 'led') || (m === 'glass' && sh.r < 0.02))) return;
      if (sh.k === 'torus' && sh.t < 0.009) return;
      if (sh.k === 'box' && Math.min(...sh.s) < 0.009) return;
      if (sh.k === 'cyl' && sh.r < 0.016) { if (sh.h < 0.03) return; sh = { ...sh, r: Math.max(sh.r, 0.014), ...(sh.r2 !== undefined ? { r2: Math.max(sh.r2, 0.014) } : {}), n: 4 }; }
      if (sh.k === 'box') sh = { ...sh, r: Math.min(sh.r, Math.min(...sh.s) * 0.18) };
      else if (sh.k === 'cyl' && sh.n === undefined) sh = { ...sh, n: sh.r < 0.03 ? 6 : 8 };
      else if (sh.k === 'sphere' && sh.n === undefined && m !== 'glass') sh = { ...sh, n: sh.r < 0.04 ? 5 : 8 };
      else if (sh.k === 'capsule' && sh.n === undefined) sh = { ...sh, n: 5 };
      this.parts.push({ j, shape: sh, p, m, ...(r ? { r } : {}), ...(tag ? { tag } : {}), flat: true });
      return;
    }
    if (this.sharp && HARD.includes(m)) {
      if (sh.k === 'box') sh = { ...sh, r: Math.min(sh.r, 0.004) };
      else if (sh.k === 'cyl' && sh.r >= 0.025 && sh.n === undefined) sh = { ...sh, n: 8 };
      else if (sh.k === 'sphere' && sh.r >= 0.04 && sh.n === undefined) sh = { ...sh, n: 8 };
      else if (sh.k === 'capsule' && sh.n === undefined) sh = { ...sh, n: 6 };
    }
    const flat = (sh.k === 'cyl' || sh.k === 'sphere' || sh.k === 'capsule') && sh.n !== undefined;
    this.parts.push({ j, shape: sh, p, m, ...(r ? { r } : {}), ...(tag ? { tag } : {}), ...(flat ? { flat } : {}) });
  }
  // tyč (valec) z bodu a do bodu b
  rod(j: JointId, a: V3, b: V3, r: number, m: Mat): void {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    this.add(j, { k: 'cyl', r, h: Math.hypot(...d) }, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], m, alignY(d));
  }
  // hranol z bodu a do bodu b v rovine xy (šírka w, hĺbka v z dz) – článok prsta
  bar(j: JointId, a: V3, b: V3, w: number, dz: number, m: Mat): void {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    this.add(j, { k: 'box', s: [w, Math.hypot(...d), dz], r: Math.min(w, dz) * 0.3 }, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], m, alignY(d));
  }
  gripY = -0.03; // stred úchopu (kde ide rúčka) pod kĺbom ruky
  // rameno: plece → lakeť → ruka (zápästie, dlaň a klepeto z dvoch prstov v tvare C); vracia kĺb ruky
  arm(side: 1 | -1, parent: JointId, p: V3, len: number, thick: number): JointId {
    const s = side > 0 ? 'L' : 'R';
    const sh = this.joint('shoulder' + s, parent, p);
    this.add(sh, { k: 'sphere', r: thick * 1.35 }, [0, 0, 0], 'dark');
    this.add(sh, { k: 'capsule', r: thick, h: len * 0.5 }, [0, -len * 0.3, 0], 'metal');
    const el = this.joint('elbow' + s, sh, [0, -len * 0.6, 0]);
    this.add(el, { k: 'sphere', r: thick * 1.15 }, [0, 0, 0], 'dark');
    this.add(el, { k: 'capsule', r: thick * 0.9, h: len * 0.35 }, [0, -len * 0.22, 0], 'accent');
    const hd = this.joint('hand' + s, el, [0, -len * 0.45, 0]);
    // Klepeto: prsty sa zatvárajú pozdĺž x a obopínajú rúčku, ktorá ide pozdĺž z cez stred úchopu (gripY);
    // otvor je dole. Veľkosť podľa rúčky náradia (GRIP_R), nie podľa hrúbky ruky, aby každá rúčka sedela.
    const rh = GRIP_R + 0.003, fw = Math.max(0.012, thick * 0.6), dz = 0.026;
    this.add(hd, { k: 'cyl', r: thick * 1.15, h: thick * 0.9 }, [0, 0, 0], 'dark');                          // zápästie
    const palmY = -thick * 0.45 - 0.008, palmW = (rh + fw) * 2 + 0.008;
    this.add(hd, { k: 'box', s: [palmW, 0.016, dz + 0.008], r: 0.004 }, [0, palmY, 0], 'accent');             // dlaň
    const cy = palmY - 0.008 - rh - 0.002;
    this.gripY = cy;
    for (const f of [-1, 1]) {
      const a: V3 = [f * (rh + fw / 2), palmY - 0.004, 0], b: V3 = [f * (rh + fw / 2 + 0.002), cy - rh * 0.2, 0], c: V3 = [f * rh * 0.35, cy - rh - fw * 0.35, 0];
      this.bar(hd, a, b, fw, dz, 'metal');
      this.bar(hd, b, c, fw * 0.85, dz * 0.9, 'metal');
      this.add(hd, { k: 'cyl', r: fw * 0.62, h: dz + 0.004 }, b, 'dark', [Math.PI / 2, 0, 0]);               // kĺbik prsta
      this.add(hd, { k: 'sphere', r: fw * 0.5, s: [1, 1, 1.6] }, c, 'rubber');                               // gumené bruško
    }
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
      this.add(j, { k: 'cyl', r: HAT_BRIM, h: 0.015 }, [x, y + 0.008, z], 'accent');
      this.add(j, { k: 'cyl', r: 0.075, r2: 0.07, h: 0.09 }, [x, y + 0.055, z], 'accent');
      this.add(j, { k: 'cyl', r: 0.077, h: 0.02 }, [x, y + 0.03, z], 'rust');
    } else if (acc === 'sprout') {
      this.add(j, { k: 'cyl', r: 0.05, r2: 0.065, h: 0.07 }, [x, y + 0.035, z], 'pot');
      this.add(j, { k: 'cyl', r: 0.006, h: 0.08 }, [x, y + 0.1, z], 'leaf', undefined, 'sprout');
      for (const s of [-1, 1]) this.add(j, { k: 'sphere', r: 0.035, s: [1.4, 0.35, 0.8] }, [x + s * 0.035, y + 0.135, z], 'leaf', [0, 0, s * 0.5], 'sprout');
    }
  }
}

// Genóm so spoločnými rozmermi (pre stavbu): šírka, pomer hĺbky, ramená; bh je pri robotovi bez hlavy vyššie
type Built = RobotLook & { readonly bw: number; readonly bd: number; readonly arm: number; readonly armT: number };

// ---------- trup ----------
// Povrch trupu (v súradniciach trupu, stred = 0): polovičné rozmery, kde je predok a bok vo výške y, bod a normála
// na povrchu pre smer (uhol okolo y, výška −1…1) – na hrdzu, nity a oči
interface Hull { hx: number; hy: number; hz: number; top: number; bottom: number; front(y: number): number; side(y: number): number; at(a: number, v: number): { p: V3; n: V3 } }
function hull(L: Built): Hull {
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
function trunk(b: Builder, L: Built, body: JointId, H: Hull): void {
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
function details(b: Builder, L: Built, body: JointId, H: Hull, eyesOnBody: boolean): void {
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
// Hrdza nie sú diely: je to textúra v nátere (client/robot3d.ts) – škvrny podľa wear.

// ---------- podvozok ----------
// Postaví podvozok a vráti, v akej výške je spodok trupu
// Podvozok: výška spodku trupu a čo z neho trčí do strán pod ramenami – out = najďalej od stredu (x), top = do akej
// výšky (aby ruka visiaca vedľa trupu nezasahovala do pásov a kolies)
interface Chassis { bottom: number; out: number; top: number; front: number } // front = najďalej dopredu (z)
function chassis(b: Builder, L: Built, H: Hull): Chassis {
  const { hx, hz } = H;
  if (L.loco === 'treads') {
    // skutočné pásy: slučka z ostrých článkov s ostrohami okolo ozubeného hnacieho kolesa vpredu, napínacieho vzadu
    // a dvoch pojazdových koliesok dole; bočný kryt s nitmi. Články sa pri jazde posúvajú po slučke (póza).
    // Užšie pásy (0,07) väčšinou pod okrajom trupu, aby ramená visiace vedľa trupu išli mimo nich.
    const R = (FRAME.bottom - 0.034) / 2, y0 = R + 0.009, tl = Math.max(0.32, hz * 2 + 0.1), zf = tl / 2 - R, zb = -zf, tw = 0.07, x = hx - tw / 2 - 0.004;
    // (v jednoduchom štýle menej, väčších článkov)
    const Ls = zf - zb, n = b.simple ? Math.max(10, Math.round((2 * Ls + 2 * Math.PI * R) / 0.055)) : Math.max(18, Math.round((2 * Ls + 2 * Math.PI * R) / 0.03));
    for (const sx of [-1, 1]) {
      const side = sx > 0 ? 'L' : 'R', links: { j: JointId; s0: number }[] = [];
      const tr: Track = { x: sx * x, y: y0, R, zb, zf, links };
      const pitch = trackLength(tr) / n;
      for (let k = 0; k < n; k++) {
        const s0 = k * pitch, q = trackAt(tr, s0);
        const j = b.joint(`track${side}${k}`, 'root', [tr.x, q.y, q.z]);
        b.add(j, { k: 'box', s: [tw, 0.011, pitch * 0.84], r: 0.0015 }, [0, 0, 0], 'rubber');
        b.add(j, { k: 'box', s: [tw * 0.94, 0.008, pitch * 0.24], r: 0.001 }, [0, 0.009, 0], 'rubber'); // ostroha
        links.push({ j, s0 });
      }
      b.tracks.push(tr);
      const wheels: [number, number, number, boolean][] = [[zf, y0, R * 0.78, true], [zb, y0, R * 0.78, true], [zb + Ls / 3, y0 - R * 0.42, R * 0.5, false], [zb + (2 * Ls) / 3, y0 - R * 0.42, R * 0.5, false]];
      for (const [i, [z, y, rr, teeth]] of wheels.entries()) {
        const w = b.joint(`wheel${side}${i}`, 'root', [tr.x, y, z]);
        b.add(w, { k: 'cyl', r: rr, h: tw * 0.62, n: 8 }, [0, 0, 0], 'metal', [0, 0, Math.PI / 2]);
        b.add(w, { k: 'cyl', r: rr * 0.38, h: tw * 0.75, n: 6 }, [0, 0, 0], 'accent', [0, 0, Math.PI / 2]);
        if (teeth) for (let t = 0; t < 8; t++) { const a = (t / 8) * Math.PI * 2; b.add(w, { k: 'box', s: [tw * 0.3, 0.02, 0.013], r: 0.001 }, [0, Math.cos(a) * rr, Math.sin(a) * rr], 'metal', [a, 0, 0]); }
        else for (let t = 0; t < 3; t++) { const a = (t / 3) * Math.PI * 2; b.add(w, { k: 'box', s: [tw * 0.64, 0.008, rr * 0.9], r: 0.001 }, [0, Math.cos(a) * rr * 0.55, Math.sin(a) * rr * 0.55], 'dark', [a, 0, 0]); }
        b.wheels.push({ j: w, r: rr });
      }
      // bočný kryt medzi kolesami (koncové kolesá ostanú vidieť) s nitmi
      const gx = tr.x + sx * (tw / 2 + 0.005);
      b.add('root', { k: 'box', s: [0.008, R * 0.62, Ls * 0.7], r: 0.001 }, [gx, y0 + R * 0.12, 0], 'accent');
      for (const z of [-0.3, 0, 0.3]) b.add('root', { k: 'cyl', r: 0.007, h: 0.006, n: 6 }, [gx + sx * 0.006, y0 + R * 0.12, z * Ls], 'metal', [0, 0, Math.PI / 2]);
    }
    b.add('root', { k: 'box', s: [x * 2 - tw - 0.01, 0.03, Ls], r: 0.002 }, [0, y0 + R * 0.4, 0], 'dark');
    for (const sx of [-1, 1]) b.add('root', { k: 'box', s: [0.02, 0.03, 0.03], r: 0.002 }, [sx * (x - tw / 2 - 0.01), y0, zf], 'dark'); // náprava hnacieho kolesa
    return { bottom: y0 + R + 0.025, out: x + tw / 2 + 0.013, top: y0 + R + 0.012, front: tl / 2 + 0.012 };
  }
  if (L.loco === 'wheels') {
    // dve veľké kolesá pod okrajmi trupu (ramená idú mimo nich), vzadu malé kolieska na podperu
    const rr = (FRAME.bottom - 0.01) / 2, ww = 0.05, x = hx - ww / 2 - 0.005;
    for (const sx of [-1, 1]) {
      const w = b.joint(`wheel${sx > 0 ? 'L' : 'R'}`, 'root', [sx * x, rr, 0]);
      b.add(w, { k: 'torus', r: rr * 0.82, t: rr * 0.2 }, [0, 0, 0], 'rubber', [0, 0, Math.PI / 2]);
      b.add(w, { k: 'cyl', r: rr * 0.66, h: 0.03 }, [0, 0, 0], 'metal', [0, 0, Math.PI / 2]);
      for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3]) b.add(w, { k: 'box', s: [0.036, rr * 1.25, 0.018], r: 0.006 }, [0, 0, 0], 'accent', [a, 0, 0]);
      b.add(w, { k: 'cyl', r: rr * 0.2, h: 0.045 }, [0, 0, 0], 'dark', [0, 0, Math.PI / 2]);
      b.wheels.push({ j: w, r: rr });
      b.add('root', { k: 'box', s: [0.03, FRAME.bottom - rr, 0.03], r: 0.004 }, [sx * (x - ww / 2 - 0.02), (FRAME.bottom + rr) / 2, 0], 'dark'); // vidlica
      b.add('root', { k: 'cyl', r: 0.012, h: 0.045 }, [sx * (x - ww / 2 - 0.012), rr, 0], 'dark', [0, 0, Math.PI / 2]);
    }
    const bottom = FRAME.bottom;
    b.rod('root', [0, bottom + 0.01, -hz * 0.6], [0, 0.03, -hz * 0.9], 0.01, 'dark');
    const c = b.joint('caster', 'root', [0, 0.03, -hz * 0.9]);
    b.add(c, { k: 'sphere', r: 0.03 }, [0, 0, 0], 'rubber');
    b.wheels.push({ j: c, r: 0.03 });
    return { bottom, out: x + 0.025, top: rr * 2 + 0.005, front: rr + 0.01 };
  }
  if (L.loco === 'ball') {
    const rr = (FRAME.bottom + 0.03) / 2, ball = b.joint('ball', 'root', [0, rr, 0]);
    b.add(ball, { k: 'sphere', r: rr }, [0, 0, 0], 'rubber');
    b.add(ball, { k: 'torus', r: rr, t: 0.012 }, [0, 0, 0], 'accent', [0, 0, Math.PI / 2]);
    b.add(ball, { k: 'torus', r: rr, t: 0.012 }, [0, 0, 0], 'accent', [Math.PI / 2, 0, 0]);
    b.wheels.push({ j: ball, r: rr });
    const bottom = rr * 2 - 0.03;
    // sukienka nad guľou
    b.add('root', { k: 'cyl', r: rr * 1.05, r2: Math.min(hx, hz) * 0.85, h: 0.06 }, [0, bottom + 0.01, 0], 'accent');
    return { bottom, out: rr * 1.05, top: bottom + 0.04, front: rr * 1.05 };
  }
  if (L.loco === 'legs2') {
    // dve krátke nohy s veľkými topánkami (bedrá sú na trupe – kĺby hipL/hipR pridá body())
    const bottom = FRAME.bottom;
    return { bottom, out: Math.max(0.06, hx * 0.45) + 0.042, top: bottom, front: 0.08 + 0.01 };
  }
  if (L.loco === 'rover') {
    // Šesť kolies na podvozku rocker-bogie (ako marsovské vozidlo): na každej strane kolíska (rocker) otočná pod bokom
    // trupu; vpredu nesie predné koleso, vzadu na otočnom kĺbe vahadlo (bogie) so stredným a zadným kolesom.
    // Kolesá sú pod okrajom trupu (ramená idú mimo nich), kovové s ostrohami.
    const rr = 0.055, ww = 0.042, zl = Math.max(0.17, hz + 0.06);
    const xw = hx - ww / 2 - 0.006, xr = xw - ww / 2 - 0.014;          // stred kolesa, rovina kolísky
    const yP = FRAME.bottom - 0.035, zP = zl * 0.18;                // kĺb kolísky
    const zf = zl, zm = -zl * 0.12, zr = -zl, zB = (zm + zr) / 2, yB = rr + 0.065; // kolesá a kĺb vahadla
    for (const sx of [-1, 1]) {
      const side = sx > 0 ? 'L' : 'R', X = sx * xr, P: V3 = [X, yP, zP], B: V3 = [X, yB, zB];
      b.add('root', { k: 'cyl', r: 0.02, h: 0.034, n: 8 }, P, 'dark', [0, 0, Math.PI / 2]);           // kĺb kolísky
      b.add('root', { k: 'box', s: [0.024, 0.03, 0.03], r: 0.002 }, [X * 0.8, yP + 0.03, zP], 'dark'); // úchyt pod trupom
      const knee: V3 = [X, rr + 0.055, zf - 0.02];
      b.bar('root', P, knee, 0.016, 0.022, 'paint');                                                  // predné rameno kolísky
      b.bar('root', knee, [X, rr, zf], 0.014, 0.018, 'dark');                                         // vidlica predného kolesa
      b.bar('root', P, B, 0.016, 0.022, 'paint');                                                     // zadné rameno kolísky
      b.add('root', { k: 'cyl', r: 0.016, h: 0.03, n: 8 }, B, 'dark', [0, 0, Math.PI / 2]);           // kĺb vahadla
      b.bar('root', B, [X, rr, zm], 0.014, 0.018, 'accent');                                          // vahadlo
      b.bar('root', B, [X, rr, zr], 0.014, 0.018, 'accent');
      for (const [i, z] of [zf, zm, zr].entries()) {
        b.add('root', { k: 'cyl', r: 0.006, h: xw - xr, n: 6 }, [sx * (xr + xw) / 2, rr, z], 'metal', [0, 0, Math.PI / 2]); // náprava
        const w = b.joint(`wheel${side}${i}`, 'root', [sx * xw, rr, z]);
        b.add(w, { k: 'cyl', r: rr, h: ww, n: 12 }, [0, 0, 0], 'metal', [0, 0, Math.PI / 2]);
        b.add(w, { k: 'cyl', r: rr * 0.4, h: ww + 0.006, n: 6 }, [0, 0, 0], 'accent', [0, 0, Math.PI / 2]);
        for (let t = 0; t < 6; t++) { const a = (t / 6) * Math.PI * 2; b.add(w, { k: 'box', s: [ww * 0.96, 0.01, 0.012], r: 0.001 }, [0, Math.cos(a) * rr, Math.sin(a) * rr], 'dark', [a, 0, 0]); } // ostrohy
        b.wheels.push({ j: w, r: rr });
      }
    }
    // vyrovnávacia tyč (diferenciál) naprieč pod trupom medzi kĺbmi kolísok
    b.add('root', { k: 'box', s: [xr * 2, 0.014, 0.014], r: 0.002 }, [0, yP + 0.012, zP], 'metal');
    return { bottom: yP + 0.035, out: xw + ww / 2 + 0.006, top: yP + 0.04, front: zl + rr + 0.008 };
  }
  // trojnožka: nohy sú pod trupom (kolená najďalej 0,88 šírky trupu)
  const bottom = FRAME.bottom;
  return { bottom, out: H.hx * 0.88 + 0.025, top: bottom, front: H.hz * 0.7 + 0.05 };
}
// Dve nohy: dĺžka stehna a predkolenia, výška členka nad zemou a výška topánky
const LEG2 = { thigh: 0.095, shin: 0.085, ankle: 0.04, sole: 0.05 } as const;
// nohy na trupe (bedrá sa kývu s trupom)
function legs(b: Builder, L: Built, body: JointId, H: Hull, bottom: number): void {
  const yb = -H.bottom;
  if (L.loco === 'legs2') {
    // dve nohy s kolenom a členkom: stehno → koleno → predkolenie → členok s topánkou. Nohy sú spolu dlhšie ako výška
    // bedra nad členkom, takže koleno je vždy trochu pokrčené dopredu; uhly dáva póza (IK – chodidlá stoja na zemi).
    for (const sx of [-1, 1]) {
      const side = sx > 0 ? 'L' : 'R', hip = b.joint('hip' + side, body, [sx * Math.max(0.06, H.hx * 0.45), yb, 0]);
      b.add(hip, { k: 'sphere', r: 0.032 }, [0, 0, 0], 'dark');
      b.add(hip, { k: 'capsule', r: 0.026, h: LEG2.thigh - 0.04 }, [0, -LEG2.thigh / 2, 0], 'metal');
      const knee = b.joint('knee' + side, hip, [0, -LEG2.thigh, 0]);
      b.add(knee, { k: 'sphere', r: 0.026 }, [0, 0, 0], 'accent');
      b.add(knee, { k: 'capsule', r: 0.022, h: LEG2.shin - 0.04 }, [0, -LEG2.shin / 2, 0], 'metal');
      const foot = b.joint('foot' + side, knee, [0, -LEG2.shin, 0]);
      b.add(foot, { k: 'box', s: [0.08, 0.05, 0.12], r: 0.022 }, [0, LEG2.sole / 2 - LEG2.ankle, 0.02], 'accent');
    }
  } else if (L.loco === 'legs3') {
    // trojnožka: koleno vonku, chodidlo trochu bližšie pod trupom
    for (let i = 0; i < 3; i++) {
      const a = (i * 2 * Math.PI) / 3 + Math.PI, ax = Math.sin(a) * H.hx * 0.55, az = Math.cos(a) * H.hz * 0.7;
      const hip = b.joint('hip' + i, body, [ax, yb + 0.02, az]);
      b.add(hip, { k: 'sphere', r: 0.028 }, [0, 0, 0], 'dark');
      const kp: V3 = [ax * 0.6, -bottom * 0.42, az * 0.6];
      b.rod(hip, [0, 0, 0], kp, 0.014, 'metal');
      const knee = b.joint('knee' + i, hip, kp);
      b.add(knee, { k: 'sphere', r: 0.022 }, [0, 0, 0], 'accent');
      const foot: V3 = [-ax * 0.25, -(bottom + 0.02) * 0.58 + 0.01, -az * 0.25];
      b.rod(knee, [0, 0, 0], foot, 0.013, 'metal');
      // chodidlo má vlastný kĺb (členok), aby pri pokrčení nohy ostalo naplocho na zemi
      const fj = b.joint('foot' + i, knee, foot);
      b.add(fj, { k: 'sphere', r: 0.016 }, [0, 0, 0], 'accent');
      b.add(fj, { k: 'cyl', r: 0.04, r2: 0.03, h: 0.018 }, [0, -0.005, 0], 'dark');
    }
  }
}

// ---------- hlava ----------
// Postaví hlavu na krku a vráti temeno (kĺb a bod) – kam patrí doplnok a úchyt top
// Hlava sa zmestí do spoločnej výšky: výška hlavy nad krkom (bez krku) a polovica šírky pri veľkosti s
function headSize(L: Built, s: number): { up: number; half: number } {
  const e = L.eyeS;
  if (L.head === 'bino') { const r = 0.055 * e * Math.sqrt(s); return { up: 0.04 + r * (L.eyes === 2 ? 1.25 : 1.6), half: L.eyes === 2 ? 2 * r + 0.02 * s : r * 1.3 }; }
  if (L.head === 'dome') return { up: 0.125 * s + 0.012, half: 0.125 * s * 1.06 };
  if (L.head === 'ball') return { up: 0.11 * s * 1.83, half: 0.11 * s + 0.016 };
  if (L.head === 'tv') return { up: 0.14 * s, half: 0.1 * s + 0.024 * s };
  return { up: 0, half: 0 };
}
// Veľkosť hlavy (najviac podľa genómu, nie širšia ako trup) a dĺžka krku tak, aby temeno bolo v spoločnej výške
function fitHead(L: Built, bodyTop: number, hx: number): { s: number; nl: number } {
  const room = FRAME.height - bodyTop, minNeck = L.head === 'bino' ? 0.04 : 0;
  let s = L.headS;
  while (s > 0.5 && (headSize(L, s).half > hx || room - headSize(L, s).up < minNeck)) s -= 0.01;
  return { s, nl: Math.max(minNeck, room - headSize(L, s).up) };
}
// back = ako ďaleko dozadu siaha hlava od osi krku (aby nosič s náradím nezasahoval do veľkej hlavy),
// half = polovica šírky hlavy (aby ramená išli aj mimo hlavy, keď je širšia ako trup)
function head(b: Builder, L: Built, body: JointId, H: Hull, s: number, nl: number): { j: JointId; p: V3; back: number; half: number } {
  const e = L.eyeS;
  if (L.head === 'none') {
    // oči na trupe ako okienka; „hlava“ je vrchnák trupu (pri kotli klenutý), na ňom doplnok
    const top = b.joint('head', body, [0, H.hy, 0]);
    if (L.body === 'barrel') { b.add(top, { k: 'sphere', r: H.hx * 0.99, s: [1, 0.5, 1] }, [0, 0, 0], 'paint'); b.add(top, { k: 'cyl', r: 0.03, h: 0.02 }, [0, H.hx * 0.5, 0], 'accent'); }
    const y = L.body === 'box' ? H.hy * 0.25 : L.body === 'ball' ? H.hy * 0.25 : 0, r = 0.055 * e;
    const eye = b.joint('eye', body, [0, y, 0]);
    if (L.eyes === 1) b.roundEye(eye, [0, 0, H.front(y) + 0.005], r * 1.25, 0, 'accent', L.rivets);
    else for (const sx of [-1, 1]) { const yaw = L.body === 'box' ? 0 : Math.asin(Math.min(0.8, (sx * r * 1.15) / H.hx)); b.roundEye(eye, [sx * r * 1.15, 0, H.front(y) * Math.cos(yaw) + 0.005], r, yaw, 'accent'); }
    return { j: top, p: [0, (H.top - H.hy) + 0.005, 0], back: H.hz * 1.05 + 0.03, half: 0 }; // trup (s horným lemom) siaha až po temeno – nosič ďalej dozadu ako pri širokej hlave
  }
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
    return { j: hd, p: [0, 0.03 + r * (L.eyes === 2 ? 1.25 : 1.6), -0.01], back: 0.07 * s, half: L.eyes === 2 ? 2 * r + 0.02 * s : r * 1.3 };
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
    return { j: hd, p: [0, R + 0.012, 0], back: R * 1.06, half: R * 1.06 };
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
    return { j: hd, p: [0, R * 0.98, 0], back: R, half: R + 0.016 };
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
  return { j: hd, p: [0, h / 2, 0], back: d / 2 + 0.01, half: w / 2 + 0.024 * s };
}

// ---------- ramená ----------
// Ramená musia byť v každej póze mimo trupu, podvozku aj nosiča. Plece je tesne za najširším miestom trupu (s nitmi,
// obručami a hrdzou) o polovicu šírky ramena (guľa plecia, klepeto). Ak pod ramenom trčí podvozok (veľké kolesá, guľa),
// ruka sa skráti, aby visela nad ním; keby bola príliš krátka, plece sa posunie von za podvozok na držiaku.
// Dozadu ruka pri chôdzi kýve menej, ak by narazila do puzdier nosiča.
const RACK_OUT = 0.35 * 0.43 + 0.024 + 0.012; // najďalej od stredu na nosiči (puzdro + rezerva; 0,35 = RACK_W)
function arms(b: Builder, L: Built, body: JointId, H: Hull, ch: Chassis, hd: { back: number; half: number }): { sx: number; sy: number; sz: number; arm: number; swingBack: number } {
  // plece je pre všetkých na tom istom mieste (FRAME.shoulder) – trup aj hlava sú užšie, podvozok pod ramenom nič nemá
  const t = FRAME.armT, [sx, shY, sz] = FRAME.shoulder, sy = shY - (ch.bottom + H.bottom), arm = FRAME.arm;
  // držiak plecia od boku trupu
  const side = H.side(sy), gap = sx - t * 1.2 - side;
  if (gap > 0.004) for (const s of [-1, 1]) b.add(body, { k: 'box', s: [gap + 0.012, t * 1.6, t * 1.8], r: 0.003 }, [s * (side + gap / 2 - 0.006), sy, sz], 'dark', undefined, 'armmount');
  b.arm(1, body, [sx, sy, sz], arm, t);
  b.arm(-1, body, [-sx, sy, sz], arm, t);
  // krok dozadu: ruka (s klepetom) ostane pred puzdrami nosiča, ak je rameno v ich šírke
  const half = Math.max(t * 1.35, GRIP_R + 0.003 + Math.max(0.012, t * 0.6) + 0.004), clawDrop = t * 0.45 + 0.018 + (GRIP_R + 0.003) * 2 + 0.012;
  let swingBack = 1;
  if (sx - half < RACK_OUT) {
    const rackFront = Math.min(-H.front(0) - 0.03, -hd.back - 0.045) - 0.016; // z čela puzdier
    const room = sz - 0.022 - (rackFront + 0.008), len = arm * 1.05 + clawDrop;
    swingBack = Math.max(0, Math.min(1, Math.asin(Math.max(0, Math.min(1, room / len))) / 0.5));
  }
  return { sx, sy, sz, arm, swingBack };
}
// ---------- celý robot ----------
// Úchop ruky: stred klepeta; rúčka náradia ide cez neho pozdĺž osi z ruky
const MOUNT_HAND = (j: JointId, y: number): Mount => ({ j, p: [0, y, 0] });
// Polomer rúčky náradia, na ktorý je klepeto (motyka 0,011, krompáč 0,012)
export const GRIP_R = 0.012;
// Ako sa náradie nesie: palica (motyka, krompáč – rúčka zvislo pred sebou) alebo zavesené (krhla, lampáš – predlaktie
// vodorovne dopredu, klepeto otočené tak, že držadlo je vodorovne a náradie visí dole)
export type HoldKind = 'staff' | 'hang';
export const TOOL_HOLD: Readonly<Record<ToolId, HoldKind>> = { hoe: 'staff', pick: 'staff', can: 'hang', lamp: 'hang' };
// Nosič na chrbte: doska pripevnená k trupu a na nej pre každé náradie jeho držiak, aby nič nezasahovalo do trupu ani
// do iného náradia: po krajoch dve puzdrá (rúry) – motyka vpravo (čepeľou dozadu), krompáč vľavo (hlavicou do strán,
// nad ostatným náradím) – a medzi nimi pod sebou nič; hore vpravo od stredu priečka na dvoch stĺpikoch, na ktorej visí
// krhla za oblúk držadla (hubicou dozadu), vľavo od stredu kolík so zahnutým koncom, na ktorom visí lampáš za krúžok.
// Prázdny držiak je vidieť, takže je jasné, kam čo patrí.
// Náradie je na nosiči rovnako veľké ako v ruke (TOOL_ON_BACK = 1); nosič je taký široký, aby sa medzi puzdrá zmestili
// krhla (priemer 0,13) a lampáš (0,09) vedľa seba.
const RACK_W = 0.35, TOOL_ON_BACK = 1;
// Kde v modeli krhly (client/robot3d.ts) leží hák: vnútro vrcholu oblúka držadla (stred oblúka y 0,02, polomer 0,035,
// hrúbka 0,008) mínus polomer háku 0,005
export const CAN_HOOK = 0.02 + 0.035 - 0.008 - 0.005;
function rack(b: Builder, body: JointId, H: Hull, headBack: number): Record<ToolId, Mount> {
  // doska tesne za chrbtom; keď hlava siaha dozadu skoro ako trup alebo viac, posunie sa ďalej, aby rúčky v puzdrách
  // išli za hlavou a vystrelené náradie ju pri stúpaní minulo
  const hh = Math.max(0.14, Math.min(0.2, H.hy * 1.5)), back = -H.front(0), bz = Math.min(back - 0.03, -headBack - 0.045);
  const j = b.joint('rack', body, [0, 0, bz]);
  b.add(j, { k: 'box', s: [RACK_W * 0.8, hh, 0.02], r: 0.006 }, [0, 0, 0], 'accent');
  // úchyty k trupu (dlhšie, keď je doska odsunutá)
  const bl = back - bz + 0.012;
  for (const x of [-1, 1]) for (const y of [-1, 1]) b.add(j, { k: 'box', s: [0.022, 0.022, bl], r: 0.004 }, [x * RACK_W * 0.25, y * hh * 0.32, bl / 2], 'dark');
  const slots: Partial<Record<ToolId, Mount>> = {};
  // Každý držiak je vlastný kĺb (holder:<náradie>) – vystreľovač: pri výmene náradia sa natočí do smeru výstrelu
  // (puzdro okolo svojho stredu) a krátkym zdvihom pozdĺž neho náradie vymrští (client/robot3d.ts počíta dráhu).
  // puzdrá: rúra s obručou hore, mierne vyklonené do strán; otočný čap k doske ostáva na nosiči
  for (const [tool, sx] of [['hoe', -1], ['pick', 1]] as const) {
    const tilt = -sx * 0.1, qx = sx * RACK_W * 0.43, qy = -hh * 0.1, qz = -0.05, len = 0.15;
    const ux = -Math.sin(tilt), uy = Math.cos(tilt); // os puzdra (hore)
    const hold = 'holder:' + tool, hj = b.joint(hold, j, [qx, qy, qz]);
    b.add(hj, { k: 'cyl', r: 0.024, h: len }, [0, 0, 0], 'dark', [0, 0, tilt], hold);
    b.add(hj, { k: 'torus', r: 0.025, t: 0.006 }, [ux * len / 2, uy * len / 2, 0], 'metal', [0, 0, tilt], hold);
    b.add(hj, { k: 'torus', r: 0.026, t: 0.005 }, [0, 0, 0], 'accent', [0, 0, tilt], hold);
    // čap priamo medzi puzdrom a doskou (nie do strany, kde visí krhla a lampáš)
    b.add(j, { k: 'box', s: [0.016, 0.02, 0.018], r: 0.003 }, [qx, qy, -0.017], 'dark', undefined, hold);
    // náradie: rúčka zasunutá do puzdra, hlavica trčí nad ním; motyka čepeľou dozadu (nie do trupu)
    slots[tool] = { j: hj, p: [ux * (len / 2 - 0.05), uy * (len / 2 - 0.05), 0], r: tool === 'hoe' ? [0, Math.PI, -tilt] : [0, 0, tilt], s: TOOL_ON_BACK };
  }
  const top = hh / 2 - 0.012;
  // krhla: hák z jednej strany – stĺpik od dosky, rameno naprieč (pozdĺž x) so zahnutým koncom. Oblúk držadla krhly
  // (v rovine yz, kolmo na rameno) je na ramene navlečený tak, že rameno leží vo vrchole oblúka; hubica smeruje dozadu.
  // Kĺb háku je v strede ramena; celý hák sa pri výstrele vysunie v smere letu.
  const cx = -0.052, cz = -0.085, px = 0.03, ex = -0.024, cj = b.joint('holder:can', j, [cx, top, cz]);
  b.add(cj, { k: 'cyl', r: 0.005, h: -cz }, [px, 0, -cz / 2], 'metal', [Math.PI / 2, 0, 0], 'holder:can');   // stĺpik
  b.add(cj, { k: 'sphere', r: 0.0065 }, [px, 0, 0], 'metal', undefined, 'holder:can');                        // ohyb
  b.add(cj, { k: 'cyl', r: 0.005, h: px - ex }, [(px + ex) / 2, 0, 0], 'metal', [0, 0, Math.PI / 2], 'holder:can'); // rameno
  b.add(cj, { k: 'cyl', r: 0.005, h: 0.024 }, [ex, 0.01, 0], 'metal', undefined, 'holder:can');               // zahnutý koniec
  slots.can = { j: cj, p: [0, -CAN_HOOK * TOOL_ON_BACK, 0], r: [0, Math.PI, 0], s: TOOL_ON_BACK };
  // lampáš: kolík dozadu so zahnutým koncom; krúžok lampáša je na ňom navlečený
  const lx = 0.072, lj = b.joint('holder:lamp', j, [lx, top, -0.068]);
  b.add(lj, { k: 'cyl', r: 0.005, h: 0.09 }, [0, 0, 0.023], 'metal', [Math.PI / 2, 0, 0], 'holder:lamp');
  b.add(lj, { k: 'cyl', r: 0.005, h: 0.022 }, [0, 0.009, -0.022], 'metal', undefined, 'holder:lamp');
  slots.lamp = { j: lj, p: [0, 0.005, 0], s: TOOL_ON_BACK };
  return { hoe: must(slots.hoe), pick: must(slots.pick), can: must(slots.can), lamp: must(slots.lamp) };
}
// simple = jednoduchý štýl pre hru (menej drobností, hranaté ploché diely); rozmery, kĺby a úchyty sú rovnaké
export function robotModel(look0: RobotLook, simple = false): RobotModel {
  const L0 = robotLook(look0);
  // spoločné rozmery; robot bez hlavy má vyšší trup (po spoločnú výšku), hlavu nahrádza vrchnák
  const base: Built = { ...L0, bw: FRAME.bw, bd: FRAME.depth / FRAME.bw, arm: FRAME.arm, armT: FRAME.armT };
  const lid = (h: Hull): number => h.top - h.hy + (h.bottom - h.hy); // čo pridá klenutý vrchnák a spodok
  // s hlavou: trup najviac taký vysoký, aby sa nad neho zmestila aspoň malá hlava (0,8) s najkratším krkom
  const minHead = headSize(base, 0.8).up + (L0.head === 'bino' ? 0.04 : 0);
  const L: Built = L0.head === 'none' ? { ...base, bh: FRAME.height - FRAME.bottom - lid(hull(base)) - 0.005 }
    : { ...base, bh: Math.min(L0.bh, FRAME.height - FRAME.bottom - lid(hull(base)) - minHead) };
  const b = new Builder(L.edges === 'sharp', simple), H = hull(L);
  const ch = chassis(b, L, H), bottom = ch.bottom;
  const body = b.joint('body', 'root', [0, bottom + H.bottom, 0]);
  trunk(b, L, body, H);
  legs(b, L, body, H, bottom);
  const fit = fitHead(L, bottom + H.bottom + H.top, H.hx);
  const top0 = head(b, L, body, H, fit.s, fit.nl);
  // klobúčik má širokú striešku (0,13) – siaha dozadu ďalej ako hlava; nosič a vystrelené náradie ju musia minúť
  // (náradie dopadá do držiaka šikmo, preto ešte 5 cm navyše)
  const top = L.acc === 'hat' ? { ...top0, back: Math.max(top0.back, HAT_BRIM + 0.065 - (L.head === 'bino' ? -0.02 : 0) - top0.p[2]) } : top0;
  details(b, L, body, H, L.head === 'none');
  const { sx, sy, sz, arm, swingBack } = arms(b, L, body, H, ch, top);
  const slots = rack(b, body, H, top.back);
  b.accessory(L.acc, top.j, top.p);
  const mounts: Record<MountId, Mount> = { handR: MOUNT_HAND('handR', b.gripY), handL: MOUNT_HAND('handL', b.gripY), back: { j: 'rack', p: [0, 0, -0.03] }, top: { j: top.j, p: top.p } };
  const m0: RobotModel = { look: L, joints: b.joints, parts: b.parts, wheels: b.wheels, tracks: b.tracks, slots, mounts, swingBack, shoulder: [sx, sy, sz], armLen: arm, front: Math.max(ch.front, H.front(0)), height: 0, scale: 1, gait: L.loco === 'legs2' || L.loco === 'legs3' ? 'walk' : 'roll' };
  const h0 = mountAt(m0, null, 'top')[1], scale = Math.max(HEIGHT_MIN, Math.min(HEIGHT_MAX, h0)) / h0;
  return { ...m0, scale, height: Math.round(h0 * scale * 1000) / 1000 };
}

// ---------- póza ----------
// Čo robot práve robí (ako CharOpts postavičky): fáza kroku (rastie s prejdenou dráhou), plazenie, tanec, hrabanie (čas),
// výška skoku, čas (žmurkanie, rozhliadanie), náradie v ruke
export interface PoseOpts { phase?: number; t?: number; crawl?: boolean; dance?: boolean; dig?: number; digWith?: ToolId | null; use?: { tool: ToolId; t: number } | null; arm?: ArmTarget | null; jz?: number; hold?: HoldKind | null; walking?: boolean }
export interface JointPose { r: V3; d?: V3 }
// pour = ako veľmi je krhla naklonená (0–1, voda tečie od ~0,6); rigid = zavesené náradie drží pevne (nevisí podľa gravitácie)
export interface RobotPose { readonly joints: ReadonlyMap<JointId, JointPose>; readonly blink: number; readonly steam: number; readonly pour: number; readonly rigid: boolean }
const sin = Math.sin, cos = Math.cos;
// Hrabanie. Hrot náradia od úchopu (podľa modelov náradia v client/robot3d.ts): lh pozdĺž rúčky, lb kolmo na ňu
// k zemi (čepeľ motyky, hrot krompáča); bez náradia hrabe hrot klepeta.
const DIG_TOOL: Partial<Record<ToolId, { lh: number; lb: number }>> = { hoe: { lh: 0.36, lb: 0.07 }, pick: { lh: 0.32, lb: 0.11 } };
const CLAW_TIP = 0.03;
// hrabanie (hľadanie) má pokojnejší ťah ako okopávanie motykou: jeden ťah za 1/DIG_RATE s
export const DIG_RATE = 0.75;
// Kde hrot hrabe (z pred robotom, v súradniciach trupu): near → far; a natočenie rúčky α (od vodorovnej nadol).
// Hrot je vždy pred podvozkom aj trupom (front + 0,05). Hra podľa toho postaví robota pred políčko, ktoré kope.
export function digZone(m: RobotModel, tool: ToolId | null): { near: number; far: number; alpha: number; ground: number } {
  const t = tool ? DIG_TOOL[tool] ?? null : null, lh = t?.lh ?? 0, lb = t ? t.lb : CLAW_TIP;
  const [, sy, sz] = m.shoulder, R = m.armLen * 1.05 * 0.97, g = -m.mounts.handR.p[1];
  // klepeto samo na zem nedosiahne (ruka je schválne kratšia, aby nevisela do podvozku) – hrabe tak nízko, ako dočiahne
  const ground = Math.max(-(m.joints.find(j => j.id === 'body')?.p[1] ?? 0), t ? -Infinity : sy - 0.85 * R - (lb + g));
  // α: kĺb ruky je pri dotyku zeme asi 0,55 R pod plecom (pohodlne natiahnutá ruka)
  let alpha = t ? 0.75 : 0.25, best = Infinity;
  for (let a = t ? 0.35 : 0; a <= 1.35; a += 0.02) { const e = Math.abs(sy - (ground + lh * sin(a) + (lb + g) * cos(a)) - 0.55 * R); if (e < best) { best = e; alpha = a; } }
  const hy = ground + lh * sin(alpha) + (lb + g) * cos(alpha), dzOff = -lh * cos(alpha) + (lb + g) * sin(alpha);
  const maxDz = Math.sqrt(Math.max(0, R * R - (hy - sy) ** 2));
  const far = Math.max(sz + 0.92 * maxDz - dzOff, m.front + 0.09);
  const near = Math.min(far - 0.04, Math.max(m.front + 0.05, sz + 0.25 * maxDz - dzOff));
  return { near, far, alpha, ground };
}
// Póza ramena pri hrabaní vo fáze ťahu s (0–1): zdvih a natiahnutie dopredu, zaseknutie, ťahanie k sebe, zdvih.
// Ruka sa počíta spätne (dve články ramena, lakeť dozadu) tak, aby hrot išiel presne po tejto dráhe.
function digArm(m: RobotModel, s: number, tool: { lh: number; lb: number } | null): { sh: number; el: number; hd: number } {
  const z = digZone(m, tool === DIG_TOOL.hoe ? 'hoe' : tool === DIG_TOOL.pick ? 'pick' : null), { alpha } = z;
  const lh = tool?.lh ?? 0, lb = tool ? tool.lb : CLAW_TIP, g = -m.mounts.handR.p[1];
  const ease = (x: number): number => x * x * (3 - 2 * x), lift = 0.1, gy = z.ground - 0.008;
  let ty: number, tz: number;
  if (s < 0.2) { tz = z.near + (z.far - z.near) * ease(s / 0.2); ty = gy + lift; }
  else if (s < 0.35) { tz = z.far; ty = gy + lift * (1 - ease((s - 0.2) / 0.15)); }
  else if (s < 0.85) { tz = z.far + (z.near - z.far) * ease((s - 0.35) / 0.5); ty = gy; }
  else { tz = z.near; ty = gy + lift * ease((s - 0.85) / 0.15); }
  // kĺb ruky z hrotu: hrot = úchop + rúčka (lh) + čepeľ (lb); úchop = kĺb ruky + g pozdĺž −y ruky
  return ikArm(m, ty + lh * sin(alpha) + (lb + g) * cos(alpha), tz - lh * cos(alpha) + (lb + g) * sin(alpha), -alpha);
}
// Rameno spätne (v rovine boku, súradnice trupu): kĺb ruky má byť v (hy, hz) a ruka natočená o phiHand. Uhly sa merajú
// od smeru dolu k smeru dopredu (otočenie kĺbu okolo x je záporný uhol), lakeť ide dozadu; nedosiahnuteľné sa natiahne.
interface ArmPose { sh: number; el: number; hd: number }
function ikArm(m: RobotModel, hy: number, hz: number, phiHand: number): ArmPose {
  const [, sy, sz] = m.shoulder, l1 = m.armLen * 0.6, l2 = m.armLen * 0.45;
  // ruka sa nevystrie úplne (najviac 95 % dĺžky): pri úplnom vystretí by sa lakeť pri malom pohybe cieľa otáčal veľmi rýchlo
  const dy = hy - sy, dz = hz - sz, d = Math.max(Math.abs(l1 - l2) + 1e-4, Math.min((l1 + l2) * 0.95, Math.hypot(dy, dz)));
  // uhly v rozsahu −90° … 270° (dolu = 0, dopredu = 90°, hore = 180°), aby pri prechode nad plecom neskočili o 360°
  const unwrap = (a: number): number => (a < -Math.PI / 2 ? a + 2 * Math.PI : a);
  const phiD = unwrap(Math.atan2(dz, -dy)), beta = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
  const phi1 = phiD - beta, ey = sy - l1 * cos(phi1), ez = sz + l1 * sin(phi1);
  let phi12 = Math.atan2(hz - ez, -(hy - ey));
  while (phi12 < phi1 - Math.PI / 2) phi12 += 2 * Math.PI; // predlaktie je od ramena otočené dopredu (lakeť sa ohýba jedným smerom)
  return { sh: -phi1, el: -(phi12 - phi1), hd: -(phiHand - phi12) };
}
const ease = (x: number): number => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };

// ---------- použitie náradia ----------
// Každé náradie má svoj pohyb (fáza s 0–1, dĺžka cyklu USE_CYCLE sekúnd):
//  - motyka: ťah ako pri hrabaní – zdvih, natiahnutie, zaseknutie do zeme pred robotom, ťahanie k sebe;
//  - krompáč: náprah nad plece, rýchly úder hrotom do zeme pred robotom, chvíľu v ľade, späť do náprahu;
//  - krhla: vystrie ju pred seba (trochu bokom, mimo trupu a podvozku), nakloní hubicou dolu, leje (pour 0–1), narovná;
//  - lampáš: zdvihne ho vysoko pred seba, chvíľu ním kýve a hlava sa naň pozerá, spustí ho.
export const USE_CYCLE: Readonly<Record<ToolId, number>> = { hoe: 0.85, pick: 1.6, can: 3, lamp: 3 };
export interface UseState { arm: ArmPose; spread: number; wrist: number; pour: number; head: number }
// Cieľ ruky pre IK: kĺb ruky (y, z v súradniciach trupu) a natočenie ruky phi; ciele sa interpolujú a ruka sa počíta
// v každom snímku (nie miešanie uhlov kĺbov)
interface Target { y: number; z: number; phi: number }
const lerpT = (a: Target, b: Target, k: number): Target => ({ y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, phi: a.phi + (b.phi - a.phi) * k });
const ik = (m: RobotModel, t: Target): ArmPose => ikArm(m, t.y, t.z, t.phi);
// kĺb ruky, keď je hrot náradia v (ty, tz) a rúčka sklonená o alpha (rovnako ako pri hrabaní)
function tipTarget(m: RobotModel, tool: ToolId, ty: number, tz: number, alpha: number): Target {
  const t = DIG_TOOL[tool], lh = t?.lh ?? 0, lb = t?.lb ?? CLAW_TIP, g = -m.mounts.handR.p[1];
  return { y: ty + lh * sin(alpha) + (lb + g) * cos(alpha), z: tz - lh * cos(alpha) + (lb + g) * sin(alpha), phi: -alpha };
}
function useTool(m: RobotModel, tool: ToolId, s: number): UseState {
  const g = -m.mounts.handR.p[1], [, sy, sz] = m.shoulder;
  if (tool === 'hoe') return { arm: digArm(m, s, DIG_TOOL.hoe ?? null), spread: 0, wrist: 0, pour: 0, head: 0.35 };
  if (tool === 'pick') {
    // náprah (ruka nad plecom, rúčka dozadu) → úder: hrot do zeme na konci zóny pred robotom → chvíľu v ľade → späť
    const z = digZone(m, 'pick'), strike = tipTarget(m, 'pick', z.ground - 0.008, z.far, z.alpha), wind: Target = { y: sy + 0.13, z: sz + 0.04, phi: 2.3 };
    const tg = s < 0.4 ? lerpT(strike, wind, ease(s / 0.4)) : s < 0.72 ? lerpT(wind, strike, ease((s - 0.4) / 0.32)) : strike;
    return { arm: ik(m, tg), spread: 0, wrist: 0, pour: 0, head: 0.3 };
  }
  if (tool === 'can') {
    // klepeto mieri dolu, krhla visí pod ním hubicou dopredu; vystrie ju pred seba (bokom), nakloní ju (ruka sa otočí
    // späť, dno krhly ide dozadu, hubica dolu), leje s malým kývaním, narovná a vráti
    const tilt = s < 0.2 ? 0 : s < 0.35 ? ease((s - 0.2) / 0.15) : s < 0.78 ? 1 : 1 - ease((s - 0.78) / 0.12);
    const ph = -(0.95 * tilt + (s > 0.35 && s < 0.78 ? Math.sin(s * 25) * 0.04 : 0)), up = ease(s / 0.18) * (1 - ease((s - 0.88) / 0.12));
    const rest: Target = { y: sy - 0.16, z: sz + 0.14, phi: 0 }, pour: Target = { y: sy - 0.16 + g * cos(ph), z: m.front + 0.07 - g * sin(ph), phi: ph }; // nižšie a ďalej: predlaktie mieri dolu-dopredu, zápästie sa ohne menej
    return { arm: ik(m, lerpT(rest, pour, up)), spread: 0.26, wrist: 0, pour: tilt, head: 0.3 };
  }
  // lampáš: ruka sa zdvihne pred seba nad hlavu (lampáš visí na krúžku dolu), kýve sa, potom ho spustí
  const up = s < 0.25 ? ease(s / 0.25) : s < 0.75 ? 1 : 1 - ease((s - 0.75) / 0.25);
  const low: Target = { y: sy - 0.17, z: sz + 0.15, phi: 0 }, high: Target = { y: sy + 0.1, z: sz + 0.15 + Math.sin(s * 12) * 0.015 * up, phi: 1.2 };
  return { arm: ik(m, lerpT(low, high, up)), spread: 0.24, wrist: -Math.PI / 2, pour: 0, head: -0.35 * up };
}

// ---------- výmena náradia: fyzika ----------
// Ruka na nosič na chrbte nedočiahne, náradie sa preto hádže. Všetko sa deje v zvislej rovine, ktorá prechádza držiakom
// náradia na nosiči a pravým plecom (rameno sa do nej natočí), v súradniciach trupu:
//  - odhodenie: švih spodom – ruka klesne (náprah) a natiahnutá sa okolo pleca rozbieha dopredu a hore; zápästie drží
//    náradie stále rovnako natočené. V bode oblúka, kde je rýchlosť ruky presne štartová rýchlosť v0 (smerom aj
//    veľkosťou), náradie pustí a ruka ešte dobehne. Náradie letí po parabole (gravitácia GRAVITY) a padne do svojho
//    držiaka, ktorý sa vopred natočil proti smeru dopadu (rúčka vkĺzne do puzdra);
//  - výstrel: držiak sa natočí do smeru v0, krátkym zdvihom (stroke) náradie zrýchli na |v0| a pustí; parabola končí
//    v klepete, ktoré čaká presne tam, kde to isté náradie pri odhodení púšťa, natočené rovnako ako letiace náradie
//    (výstrel je tá istá parabola ako hod, opačným smerom).
// Počas letu sa náradie neotáča (okrem malého rovnomerného dotočenia) – smer mu dá ruka alebo držiak.
// Časy v sekundách, dĺžky v políčkach. V hre bude výmena chvíľu trvať (herná mechanika neskôr).
export const GRAVITY = 9.8;
export const SWAP = {
  wind: 0.35,                    // náprah: ruka do začiatku hodu, držiak sa natočí
  swingFrom: 0.5,                // hod: natiahnutá ruka sa rozbieha od tohto uhla (rad od zvislice dolu, dopredu)…
  follow: 0.6,                   // …a po pustení ešte dobieha o tento uhol, kým zastane
  reach: 0.93,                   // ako veľmi je ruka pri švihu natiahnutá (podiel dĺžky ramena)
  aim: 0.3,                      // natočenie držiaka pred výstrelom
  stroke: 0.05,                  // zdvih vystreľovača
  apex: 0.3                      // vrchol dráhy nad temenom robota
} as const;
// Šikmý vrh: z bodu p0 do bodu p1 cez vrchol vo výške apex (najmenej kúsok nad oboma bodmi) → štartová rýchlosť,
// čas letu a rýchlosť pri dopade
export function ballistic(p0: V3, p1: V3, apex: number): { v0: V3; T: number; vEnd: V3 } {
  const top = Math.max(apex, p0[1] + 0.02, p1[1] + 0.02);
  const vy = Math.sqrt(2 * GRAVITY * (top - p0[1])), T = vy / GRAVITY + Math.sqrt((2 * (top - p1[1])) / GRAVITY);
  const v0: V3 = [(p1[0] - p0[0]) / T, vy, (p1[2] - p0[2]) / T];
  return { v0, T, vEnd: [v0[0], vy - GRAVITY * T, v0[2]] };
}
export const ballisticAt = (p0: V3, v0: V3, t: number): V3 => [p0[0] + v0[0] * t, p0[1] + v0[1] * t - 0.5 * GRAVITY * t * t, p0[2] + v0[2] * t];
// Cieľ pravej ruky v zvislej rovine cez plece natočenej o yaw (okolo zvislej osi; 0 = dopredu): úchop (stred klepeta)
// má byť f pred plecom a y nad ním; phi = natočenie ruky (os klepeta mieri pod uhlom phi nad smer dopredu),
// null = ruka v predĺžení predlaktia so zápästím otočeným o 90° (os klepeta vodorovne naprieč, von od trupu – zavesené náradie)
export interface ArmTarget { yaw: number; f: number; y: number; phi: number | null }
export function armPlane(m: RobotModel, a: ArmTarget): { sh: V3; el: V3; hd: V3 } {
  const g = -m.mounts.handR.p[1], [, sy, sz] = m.shoulder;
  let phi = a.phi ?? 1.2, r = ikArm(m, sy + a.y + g * cos(phi), sz + a.f - g * sin(phi), phi);
  if (a.phi === null) for (let i = 0; i < 8; i++) { phi += r.hd; r = ikArm(m, sy + a.y + g * cos(phi), sz + a.f - g * sin(phi), phi); }
  // plece: otočenie Ry(yaw) · Rx(th) ako Eulerove uhly XYZ (lakeť a zápästie sa ďalej ohýbajú okolo osi kolmej na rovinu)
  const th = r.sh, cy = cos(a.yaw), sn = sin(a.yaw);
  const sh: V3 = [Math.atan2(sin(th), cy * cos(th)), Math.asin(Math.max(-1, Math.min(1, sn * cos(th)))), Math.atan2(-sn * sin(th), cy)];
  return { sh: clampJoint('shoulderR', sh), el: clampJoint('elbowR', [r.el, 0, 0]), hd: clampJoint('handR', a.phi === null ? [0, -Math.PI / 2, 0] : [r.hd, 0, 0]) }; // zápästie −90°: os klepeta (hubica krhly) mieri von od trupu
}

// ---------- obmedzenia kĺbov ----------
// Rozsah otočenia kĺbov ramena (Euler x, y, z v radiánoch, pravá strana; ľavá má y a z zrkadlovo): plece sa zdvihne
// dopredu až nad hlavu, dozadu len trochu, do strán a okolo zvislej osi obmedzene (rovina hodu pri výmene náradia); lakeť sa ohýba len jedným smerom; zápästie má obmedzený
// sklon aj otočenie. Póza (aj IK) sa do nich vždy oreže.
type Range = readonly [number, number];
export const JOINT_LIMITS: Readonly<Record<'shoulder' | 'elbow' | 'hand', readonly [Range, Range, Range]>> = {
  shoulder: [[-3.0, 0.9], [-1.1, 1.1], [-1.1, 0.4]],
  elbow: [[-2.5, 0], [0, 0], [0, 0]],
  hand: [[-2.2, 2.2], [-1.7, 1.7], [-0.2, 0.2]]
};
// Najväčšia rýchlosť kĺbu (rad/s): kĺby sa nehýbu okamžite – robot3d ich ťahá k póze najviac touto rýchlosťou.
// Kolesá a články pásu idú presne s dráhou (Infinity).
// Hod: ruka dlhá 0,24 políčka musí náradiu dať ~3 políčka/s, čo je ~14 rad/s v pleci (rýchlosť / rameno páky) –
// viac, ako kĺby bežne smú. Počas švihu pri hode preto kĺby pravej ruky smú až THROW_SPEED.
export const THROW_SPEED = 18;
export function jointSpeed(id: JointId): number {
  if (/^shoulder/.test(id)) return 10;
  if (/^elbow/.test(id)) return 12;
  if (/^hand/.test(id)) return 14;
  if (/^(hip|knee|foot)/.test(id)) return 12;
  if (id === 'body') return 5;
  if (id === 'head' || id === 'neck' || id === 'eye') return 6;
  return Infinity;
}
// Orezanie otočenia kĺbu ramena do rozsahu (ostatné kĺby bez zmeny)
export function clampJoint(id: JointId, r: V3): V3 {
  const kind = /^shoulder/.test(id) ? 'shoulder' : /^elbow/.test(id) ? 'elbow' : /^hand/.test(id) ? 'hand' : null;
  if (!kind) return r;
  const L = JOINT_LIMITS[kind], left = id.endsWith('L');
  const c = (i: 0 | 1 | 2): number => {
    const [a, b] = L[i], lo = left && i > 0 ? -b : a, hi = left && i > 0 ? -a : b;
    return Math.max(lo, Math.min(hi, r[i]));
  };
  return [c(0), c(1), c(2)];
}
const JMAP = new WeakMap<RobotModel, Map<JointId, Joint>>();
function jointMap(m: RobotModel): Map<JointId, Joint> { let s = JMAP.get(m); if (!s) JMAP.set(m, s = new Map(m.joints.map(j => [j.id, j]))); return s; }
// Otočenie o uhol ang okolo osi w (jednotkový vektor) ako Eulerove uhly XYZ
function axisEuler(w: V3, ang: number): V3 {
  const c = cos(ang), sn = sin(ang), k = 1 - c, [x, y, z] = w;
  const m13 = k * x * z + sn * y, m23 = k * y * z - sn * x, m33 = c + k * z * z, m12 = k * x * y - sn * z, m11 = c + k * x * x;
  return [Math.atan2(-m23, m33), Math.asin(Math.max(-1, Math.min(1, m13))), Math.atan2(-m12, m11)];
}
const IDS = new WeakMap<RobotModel, Set<JointId>>();
function jointIds(m: RobotModel): Set<JointId> { let s = IDS.get(m); if (!s) IDS.set(m, s = new Set(m.joints.map(j => j.id))); return s; }
// Póza kĺbov: rameno sa kýve pri chôdzi, pri hrabaní ruka kope, pri tanci sa trup vlní a ruky sú hore,
// pri plazení sa robot prikrčí (krk sa zasunie, telo sa skloní). Kolesá sa krútia podľa prejdenej dráhy.
export function robotPose(m: RobotModel, o: PoseOpts): RobotPose {
  const J = new Map<JointId, JointPose>();
  const ids = jointIds(m);
  const set = (j: JointId, r0: V3, d?: V3): void => { if (!ids.has(j)) return; const r = clampJoint(j, r0); J.set(j, d ? { r, d } : { r }); };
  const ph = o.phase ?? 0, t = o.t ?? 0, walk = !!o.walking && !o.dance && !o.dig;
  const sw = walk ? sin(ph) : 0;
  const roll = m.gait === 'roll';
  // kolesá: dráha ≈ fáza × 0,09 políčka
  for (const w of m.wheels) set(w.j, [ph * 0.09 / w.r, 0, 0]);
  // články pásu: posun po slučke o prejdenú dráhu (horná vetva dopredu ako vrch kolies)
  for (const tr of m.tracks) for (const l of tr.links) {
    const q = trackAt(tr, l.s0 + ph * 0.09), q0 = trackAt(tr, l.s0);
    set(l.j, [q.a, 0, 0], [0, q.y - q0.y, q.z - q0.z]);
  }
  // trup: pohupovanie, predklon pri plazení, tanec
  // roboty na nohách sa pri kroku trochu prikrčia (nie nadvihnú – nohy by na zem nedočiahli)
  const bob = roll ? (walk ? Math.abs(sin(ph * 2)) * 0.008 : 0) : -Math.abs(sw) * 0.012;
  const crawl = o.crawl ? 1 : 0;
  let bodyR: V3 = [walk && m.look.loco === 'ball' ? 0.18 : 0, 0, walk && !roll ? sw * 0.06 : 0];
  // na nohách si čupne: dve nohy o 6 cm, trojnožka o 4 cm (viac by kolená išli do trupu)
  let bodyD: V3 = [0, bob - crawl * (roll ? 0.04 : m.look.loco === 'legs3' ? 0.04 : 0.06), 0];
  if (o.dance) { bodyR = [0, sin(t * 3) * 0.5, sin(t * 6) * 0.12]; bodyD = [0, Math.abs(sin(t * 6)) * 0.04, 0]; }
  // pri plazení sa kolesové roboty predklonia; roboty na nohách si čupnú (nohy sa pokrčia, chodidlá ostanú na zemi)
  if (crawl && roll) bodyR = [bodyR[0] + 0.35, bodyR[1], bodyR[2]];
  set('body', bodyR, bodyD);
  // krk: pri plazení zasunutý, inak sa hlava zvedavo rozhliada
  const look = o.dance ? 0 : sin(t * 0.7) * 0.35 * (walk ? 0.3 : 1);
  set('neck', [-crawl * 0.3, 0, 0], [0, -crawl * 0.07, 0]);
  set('head', [crawl * -0.1 + (o.dig ? 0.35 : 0), look, sin(t * 1.3) * 0.06 + (o.dance ? sin(t * 6) * 0.25 : 0)]);
  set('eye', [0, 0, 0]);
  // ramená: [predpaženie (−x = dopredu), 0, odpaženie]
  const fwd = (a: number): V3 => [-a, 0, 0];
  // krok dozadu najviac swingBack (ruka nesmie naraziť do nosiča)
  const swing = (x: number): number => (x < 0 ? x * m.swingBack : x) * 0.5;
  let armR = fwd(swing(sw)), armL = fwd(swing(-sw)), elbR: V3 = [-0.3, 0, 0], elbL: V3 = [-0.3, 0, 0];
  // palica: rúčka zvislo pred sebou (rameno trochu dopredu, predlaktie dopredu); zavesené: predlaktie vodorovne dopredu
  // a zápästie otočené o 90°, takže držadlo je vodorovne naprieč a náradie visí pred robotom
  let wristR = 0;
  if (o.hold === 'staff') { armR = fwd(0.4 + sw * 0.12); elbR = [-1.05, 0, 0]; }
  // zavesené náradie nesie trochu bokom (rameno odklonené von), aby viselo mimo trupu aj podvozku
  if (o.hold === 'hang') { armR = [-(0.75 + sw * 0.1), 0, -0.24]; elbR = [-0.85, 0, 0]; wristR = -Math.PI / 2; } // zápästie −90°: os klepeta (hubica krhly) mieri von od trupu
  // pri tanci a plazení ruka so zaveseným náradím (krhla, lampáš) ostane v polohe nesenia
  const carry = o.hold === 'hang';
  if (o.dance) { if (!carry) { armR = [-2.6 + sin(t * 6) * 0.3, 0, -0.3]; elbR = [-0.4, 0, 0]; } armL = [-2.6 - sin(t * 6) * 0.3, 0, 0.3]; elbL = [-0.4, 0, 0]; }
  // plazenie: trup sa predkloní a zníži – ruka so zaveseným náradím sa zdvihne viac (predlaktie trochu hore), aby nedrhlo o zem
  if (crawl && !o.dig) { if (carry) { armR = [-1.35, 0, -0.24]; elbR = [-0.75, 0, 0]; } else armR = fwd(0.9); armL = fwd(0.9); }
  let handR: V3 = [0, o.dance && !carry ? 0 : wristR, 0], handL: V3 = [0, 0, 0];
  // pri tanci drží zápästie palicu (motyku, krompáč) zvislo nad hlavou – inak by mierila dozadu do náradia na nosiči
  if (o.dance && o.hold === 'staff') handR = [-armR[0] - elbR[0] - Math.PI / 2, 0, 0];
  // hrabanie: motyka / krompáč (pravá ruka) alebo samotné klepeto (ľavá ruka, keď pravá nesie krhlu či lampáš) robí
  // ťah pred robotom – zdvihne sa, natiahne dopredu, zasekne do zeme a ťahá k robotovi (digArm)
  if (o.dig) {
    const tool = o.digWith ? DIG_TOOL[o.digWith] ?? null : null, left = !!o.digWith && !tool;
    const a = digArm(m, ((o.dig * DIG_RATE) % 1 + 1) % 1, tool);
    if (left) { armL = [a.sh, 0, 0]; elbL = [a.el, 0, 0]; handL = [a.hd, 0, 0]; }
    else { armR = [a.sh, 0, 0]; elbR = [a.el, 0, 0]; handR = [a.hd, 0, 0]; armL = fwd(0.3); elbL = [-0.5, 0, 0]; }
  }
  // cieľ pravej ruky zadaný priamo (výmena náradia: hod a chytanie v rovine hodu)
  if (o.arm) { const a = armPlane(m, o.arm); armR = a.sh; elbR = a.el; handR = a.hd; }
  // použitie náradia v pravej ruke (vlastný pohyb každého náradia)
  let pour = 0, rigid = false;
  if (o.use) {
    const u = useTool(m, o.use.tool, ((o.use.t / USE_CYCLE[o.use.tool]) % 1 + 1) % 1);
    armR = [u.arm.sh, 0, -u.spread]; elbR = [u.arm.el, 0, 0]; handR = [u.arm.hd, u.wrist, 0];
    armL = fwd(0.25); elbL = [-0.5, 0, 0];
    pour = u.pour; rigid = o.use.tool === 'can';
    set('head', [u.head, look * 0.3, 0]); // hlava sa pozerá na prácu (pri lampáši hore)
  }
  set('shoulderR', armR); set('shoulderL', armL);
  set('elbowR', elbR); set('elbowL', elbL);
  set('handR', handR); set('handL', handL);
  // Nohy: IK – chodidlá stoja na zemi, nech trup klesne (plazenie), pohupuje sa alebo poskakuje (tanec); pri chôdzi sa
  // chodidlo zdvihne, prenesie dopredu a položí. Dve nohy sa ohýbajú v kolene dopredu, trojnožka kolenami von.
  if (!roll) {
    const jm = jointMap(m), bodyY = (jm.get('body')?.p[1] ?? 0) + bodyD[1];
    for (const [side, th] of [['L', ph], ['R', ph + Math.PI]] as const) {
      const hip = jm.get('hip' + side), knee = jm.get('knee' + side), foot = jm.get('foot' + side);
      if (!hip || !knee || !foot) continue;
      const l1 = -knee.p[1], l2 = -foot.p[1], stride = crawl ? 0.03 : 0.045;
      // členok voči bedru (v súradniciach trupu): výška nad zemou + zdvih kroku, dopredu / dozadu podľa kroku;
      // kývanie trupu do strán dvíha a spúšťa bedrá
      const dz = walk ? stride * sin(th) : 0, lift = walk ? (crawl ? 0.012 : 0.03) * Math.max(0, cos(th)) : 0;
      const dy = LEG2.ankle + lift - bodyY - hip.p[1] - hip.p[0] * sin(bodyR[2]);
      const d = Math.max(Math.abs(l1 - l2) + 1e-4, Math.min((l1 + l2) * 0.995, Math.hypot(dy, dz)));
      const phiD = Math.atan2(dz, -dy), beta = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
      const phi1 = phiD + beta, phi12 = Math.atan2(dz - l1 * sin(phi1), -(dy + l1 * cos(phi1)));
      set('hip' + side, [-phi1, 0, 0]); set('knee' + side, [-(phi12 - phi1), 0, 0]); set('foot' + side, [phi12, 0, 0]);
    }
    for (let i = 0; i < 3; i++) {
      const hip = jm.get('hip' + i), knee = jm.get('knee' + i), foot = jm.get('foot' + i);
      if (!hip || !knee || !foot) continue;
      // rovina nohy: smer von od stredu (e) a hore; os otáčania w = e × hore (kladný uhol dvíha nohu von a hore)
      const r0 = Math.hypot(hip.p[0], hip.p[2]), e: V3 = [hip.p[0] / r0, 0, hip.p[2] / r0], w: V3 = [-e[2], 0, e[0]];
      const K0 = [knee.p[0] * e[0] + knee.p[2] * e[2], knee.p[1]] as const, F0 = [foot.p[0] * e[0] + foot.p[2] * e[2], foot.p[1]] as const;
      const l1 = Math.hypot(...K0), l2 = Math.hypot(...F0), lift = walk ? (crawl ? 0.012 : 0.03) * Math.max(0, sin(ph + (i * 2 * Math.PI) / 3)) : 0;
      // chodidlo voči bedru: ako v pokoji, o toľko vyššie, o koľko trup klesol (+ zdvih kroku)
      // (kývanie trupu do strán dvíha a spúšťa bedrá – aj to noha vyrovná)
      const u = K0[0] + F0[0], v = K0[1] + F0[1] - bodyD[1] + lift - hip.p[0] * sin(bodyR[2]);
      const d = Math.max(Math.abs(l1 - l2) + 1e-4, Math.min((l1 + l2) * 0.995, Math.hypot(u, v)));
      const a1 = Math.atan2(v, u) + Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
      const a2 = Math.atan2(v - l1 * sin(a1), u - l1 * cos(a1));
      const d1 = a1 - Math.atan2(K0[1], K0[0]), d2 = a2 - Math.atan2(F0[1], F0[0]);
      set('hip' + i, axisEuler(w, d1)); set('knee' + i, axisEuler(w, d2 - d1)); set('foot' + i, axisEuler(w, -d2));
    }
  }
  // žmurkanie: každé ~4 s na 0,15 s (0 = otvorené, 1 = zavreté)
  const bt = ((t % 4.1) + 4.1) % 4.1;
  const blink = bt < 0.15 ? sin((bt / 0.15) * Math.PI) : 0;
  return { joints: J, blink, steam: (t * 0.6) % 1, pour, rigid };
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
// Kde je miesto náradia na nosiči (v súradniciach robota)
export function slotAt(m: RobotModel, pose: RobotPose | null, tool: ToolId): V3 {
  const sl = m.slots[tool];
  return apply(jointMatrix(m, pose, sl.j), sl.p);
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
