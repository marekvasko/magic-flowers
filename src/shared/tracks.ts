// Stopy v snehu (#159): čo sa pohybuje po snehu, nechá za sebou stopu – ľudia šľapaje, pavúky drobné bodky, sane
// dve súbežné čiary (druh 'runner'; na sane sa napojí až prepojenie #161). Zdieľané serverom, hrou aj ladiacou stránkou:
//  - isSnowSurface: JEDINÉ pravidlo, kde je sneh, do ktorého sa dá šliapnuť (všetci volajúci používajú len toto);
//  - walk: generátor stôp – z polôh jedného tvora (hráč, pavúk, sane) robí stopy po krokoch;
//  - addMarks / pruneMarks / markFade: strop počtu stôp na plochu, miznutie podľa herného času;
//  - encode / decode: krátky tvar stopy do správy 'tracks'.
// Stopy sa neukladajú (len v pamäti servera, po reštarte zmiznú) a čerstvý sneh ich zasype (server.ts → server/tracks.ts).
import * as D from './data.ts';
import type { AreaId, Ground, Season } from './data.ts';
import type { Weather } from './save.ts';

export type TrackKind = 'foot' | 'spider' | 'runner';
export const TRACK_KINDS: readonly TrackKind[] = ['foot', 'spider', 'runner'];
// Stopa: druh, stred (políčka), smer pohybu (radiány, ako atan2(dy, dx)), krok vzniku t a krok, keď celkom zmizne e;
// s = 1 pravá šľapaj (ľavá bez s)
export interface TrackMark { k: TrackKind; x: number; y: number; a: number; t: number; e: number; s?: 1 }
// Stopa v správe: [x, y, smer, druh, t, e] – druh 0 ľavá šľapaj, 1 pravá, 2 pavúk, 3 sane
export type TrackWire = [number, number, number, number, number, number];

// Ladenie (maintainer potvrdí na náhľade): strop stôp na plochu, ako dlho stopa mizne (herné kroky), krok medzi stopami
export const TRACKS = {
  cap: 600,                              // najviac stôp na jednej ploche – najstaršie miznú prvé
  life: 3 * D.TICKS_PER_HOUR,            // stopa zmizne za 3 herné hodiny (pri 20-minútovom dni ≈ 2,5 min)
  snowLife: D.TICKS_PER_HOUR / 2,        // kým sneží, novú stopu zasype za pol hodiny
  stride: { foot: 0.55, spider: 0.32, runner: 0.4 } as Readonly<Record<TrackKind, number>>, // políčka medzi stopami
  side: 0.1,                             // šľapaj je o toľko vľavo / vpravo od stredu chôdze
  jump: 2                                // väčší skok polohy (prechod, oprava polohy servera) stopy nenechá
};

// Druhy zeme, na ktorých v zime v záhrade leží sneh (tráva, chodníky, piesok, kruh z húb…). Voda (ľad), budovy, skalka,
// stromy a obrobené záhony (políčko s pôdou) nie.
const GARDEN_SNOW: ReadonlySet<Ground> = new Set<Ground>(['grass', 'path', 'sand', 'gate', 'ring', 'shroom', 'majster', 'lot']);
// V horách: snehové pole (sneh je tam celý rok), v zime aj alpínska lúka a sutina
const HORY_WINTER: ReadonlySet<Ground> = new Set<Ground>(['alp', 'scree']);

// Je políčko snehom, do ktorého sa robia stopy? Záhrada len v zime (bez vody, budov a záhonov), v horách snehové pole
// vždy a lúka so sutinou v zime. Les na pomedzí a Les divov stopy nemajú (#150).
export function isSnowSurface(area: AreaId, season: Season, tile: { readonly g: Ground; readonly s?: unknown } | null | undefined): boolean {
  if (!tile) return false;
  if (area === 'garden') return season === 3 && GARDEN_SNOW.has(tile.g) && !tile.s;
  if (area === 'hory') return tile.g === 'snow' || (season === 3 && HORY_WINTER.has(tile.g));
  return false;
}
// Sneh v bode (x, y) plochy – políčko pod bodom podľa isSnowSurface
export function snowAt(area: AreaId, season: Season, tiles: readonly ({ readonly g: Ground; readonly s?: unknown } | undefined)[], w: number, h: number): (x: number, y: number) => boolean {
  return (x, y) => {
    const tx = Math.floor(x), ty = Math.floor(y);
    return tx >= 0 && ty >= 0 && tx < w && ty < h && isSnowSurface(area, season, tiles[ty * w + tx]);
  };
}
// Ako dlho nová stopa vydrží: kým sneží, kratšie (sneh ju zasype)
export const lifeFor = (weather: Weather): number => weather === 'snow' ? TRACKS.snowLife : TRACKS.life;

// Kto robí stopy: posledná poloha (od nej sa meria krok), plocha, prejdená dráha od poslednej stopy, ktorá noha je na rade
export interface Walker { area: AreaId; x: number; y: number; acc: number; side: 0 | 1 }
const r2 = (v: number): number => Math.round(v * 100) / 100;
// Jeden pohyb tvora z prev na (x, y): nové stopy po každom kroku (stride) na snehu. Prvá poloha, iná plocha
// a skok väčší ako TRACKS.jump stopy nenechajú – len sa od nich začne merať znova.
export function walk(prev: Walker | undefined, k: TrackKind, area: AreaId, x: number, y: number, snow: (x: number, y: number) => boolean, tick: number, life: number): { w: Walker; marks: TrackMark[] } {
  const marks: TrackMark[] = [];
  if (!prev || prev.area !== area) return { w: { area, x, y, acc: 0, side: 0 }, marks };
  const dx = x - prev.x, dy = y - prev.y, d = Math.hypot(dx, dy);
  if (d > TRACKS.jump) return { w: { area, x, y, acc: 0, side: prev.side }, marks };
  if (d < 1e-6) return { w: prev, marks };
  const stride = TRACKS.stride[k], a = Math.atan2(dy, dx), ux = dx / d, uy = dy / d;
  let acc = prev.acc + d, side = prev.side;
  while (acc >= stride) {
    acc -= stride;
    const back = acc; // stopa je tam, kde krok skončil: o acc späť od novej polohy
    let mx = x - ux * back, my = y - uy * back;
    if (k === 'foot') { const o = side ? TRACKS.side : -TRACKS.side; mx += -uy * o; my += ux * o; } // vľavo od smeru je (uy, -ux)
    if (snow(mx, my)) {
      const m: TrackMark = { k, x: r2(mx), y: r2(my), a: r2(a), t: tick, e: tick + life };
      if (k === 'foot' && side) m.s = 1;
      marks.push(m);
    }
    side = side ? 0 : 1;
  }
  return { w: { area, x, y, acc, side }, marks };
}

// Pridá stopy do zoznamu plochy; nad strop vyhodí najstaršie (zoznam je v poradí vzniku)
export function addMarks(list: TrackMark[], marks: readonly TrackMark[], cap?: number): void {
  for (const m of marks) list.push(m);
  const over = list.length - (cap ?? TRACKS.cap);
  if (over > 0) list.splice(0, over);
}
// Vyhodí stopy, ktoré už celkom zmizli (e ≤ tick); vráti, koľko ich vyhodil
export function pruneMarks(list: TrackMark[], tick: number): number {
  const n = list.length;
  let j = 0;
  for (const m of list) if (m.e > tick) list[j++] = m;
  list.length = j;
  return n - j;
}
// Ako veľmi je stopa ešte vidno: 1 čerstvá → 0 zmizla
export function markFade(m: Pick<TrackMark, 't' | 'e'>, tick: number): number {
  if (tick >= m.e) return 0;
  if (tick <= m.t) return 1;
  return (m.e - tick) / (m.e - m.t);
}

const CODE: Readonly<Record<TrackKind, number>> = { foot: 0, spider: 2, runner: 3 };
export function encode(m: TrackMark): TrackWire { return [m.x, m.y, m.a, CODE[m.k] + (m.s ? 1 : 0), m.t, m.e]; }
// Stopa zo správy servera; neznámy druh → null
export function decode(w: readonly number[]): TrackMark | null {
  const [x, y, a, c, t, e] = w;
  if (x === undefined || y === undefined || a === undefined || c === undefined || t === undefined || e === undefined) return null;
  const k: TrackKind | null = c === 0 || c === 1 ? 'foot' : c === 2 ? 'spider' : c === 3 ? 'runner' : null;
  if (!k) return null;
  const m: TrackMark = { k, x, y, a, t, e };
  if (c === 1) m.s = 1;
  return m;
}

// Ukážková stopa pre ladiacu stránku: rovná cesta n krokov druhu k zo (x, y) smerom a (bez kontroly snehu)
export function demoTrail(k: TrackKind, x: number, y: number, a: number, n: number, tick: number, life?: number): TrackMark[] {
  const s = TRACKS.stride[k], ux = Math.cos(a), uy = Math.sin(a);
  let w: Walker | undefined = { area: 'garden', x, y, acc: 0, side: 0 };
  const out: TrackMark[] = [];
  for (let i = 1; i <= n; i++) {
    const r = walk(w, k, 'garden', x + ux * s * i, y + uy * s * i, () => true, tick, life ?? TRACKS.life);
    w = r.w; out.push(...r.marks);
  }
  return out;
}
