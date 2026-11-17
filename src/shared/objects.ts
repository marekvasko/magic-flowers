// Umiestnené objekty (#156, #178): spoločná vrstva nad políčkami záhrady. Pozemky budov (ľadovňa, Dielňa): kde budova
// stojí alebo bude stáť – hráči ich nepresúvajú, zatiaľ len cheat z ladiacej stránky (neskôr plánovač). Záhony (#179): 1 políčko.
// Pozemok má 2×2 políčka a ostane aj po postavení budovy (budova je tam, kde je jej pozemok).
// Zdieľa ho server (ice.ts, dielna.ts, cheaty) aj klient (kolíky pozemku, fúrik pri ľadovni) a ladiaca stránka (Mapa).
import * as D from './data.ts';
import type { Ground, Rect } from './data.ts';
import type { GardenObject, LotFor, LotObject, Objects, ZahonObject, ZahonSpot } from './save.ts';
import { isArray, isRecord } from './util.ts';
import { VEHICLE_HOME } from './vehicles.ts';

export const LOT_SIZE = 2;
export const LOT_FOR: readonly LotFor[] = ['icehouse', 'dielna'];
// Pozemky na pôvodných miestach (nový svet, migrácia v15): ľadovňa vedľa domčeka, Dielňa vedľa trhu
const DEFAULT: Readonly<Record<LotFor, Rect>> = { icehouse: D.ICEHOUSE.lot, dielna: D.DIELNA.lot };
export function defaultLots(): Objects {
  const list: GardenObject[] = LOT_FOR.map((v, k) => ({ id: k + 1, area: 'garden', x: DEFAULT[v].x0, y: DEFAULT[v].y0, kind: 'lot', v }));
  return { list, nid: list.length + 1 };
}
export const defaultRect = (v: LotFor): Rect => DEFAULT[v];

// Pozemok budovy (null = nie je vymeraný – cheat ho odstránil)
// Zoznam objektov na serveri (Objects) aj u klienta (správa objects: záhon bez druhu divého semienka) – pomocníci
// nižšie čítajú len spoločné polia
type AnyObj = LotObject | Pick<ZahonObject, 'id' | 'kind' | 'area' | 'x' | 'y'>;
export interface ObjList<T extends AnyObj = AnyObj> { readonly list: readonly T[] }
export function lotOf(objects: ObjList | null | undefined, v: LotFor): LotObject | null {
  return objects?.list.find((o): o is LotObject => o.kind === 'lot' && o.v === v && o.area === 'garden') ?? null;
}
// Záhon na políčku (x, y) záhrady (null = nie je)
export function zahonAt<T extends AnyObj>(objects: ObjList<T> | null | undefined, x: number, y: number): Extract<T, { kind: 'zahon' }> | null {
  return objects?.list.find((o): o is Extract<T, { kind: 'zahon' }> => o.kind === 'zahon' && o.area === 'garden' && o.x === x && o.y === y) ?? null;
}
export const zahony = (objects: Objects | null | undefined): ZahonObject[] => (objects?.list ?? []).filter((o): o is ZahonObject => o.kind === 'zahon');
// Políčka, ktoré objekt zaberá (pozemok 2 × 2, záhon 1 × 1)
export const objRect = (o: AnyObj): Rect => (o.kind === 'lot' ? rectAt(o.x, o.y) : { x0: o.x, y0: o.y, x1: o.x, y1: o.y });
export const rectAt = (x: number, y: number): Rect => ({ x0: x, y0: y, x1: x + LOT_SIZE - 1, y1: y + LOT_SIZE - 1 });
export function lotRect(objects: ObjList | null | undefined, v: LotFor): Rect | null {
  const o = lotOf(objects, v);
  return o ? rectAt(o.x, o.y) : null;
}
// Indexy políčok záhrady v obdĺžniku
export function rectIdx(r: Rect | null): number[] {
  const out: number[] = [];
  if (r) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) out.push(y * D.W + x);
  return out;
}
export const inRect = (r: Rect | null, x: number, y: number): boolean => !!r && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
// Stred obdĺžnika (na vzdialenosť hráča od budovy)
export const center = (r: Rect): { x: number; y: number } => ({ x: (r.x0 + r.x1 + 1) / 2, y: (r.y0 + r.y1 + 1) / 2 });

// Dá sa pozemok budovy v premiestniť na (x, y)? null = áno, inak prečo nie (anglicky, pre ladiacu stránku).
// ground(i) = zem a pôda políčka záhrady; changed = indexy so zemou zmenenou cheatom (#153, pri načítaní by pozemok prepísali).
export function lotPlaceError(ground: (i: number) => { readonly g: string; readonly s?: unknown } | undefined, objects: ObjList | null | undefined, v: LotFor, x: number, y: number, changed: ReadonlySet<number>): string | null {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return 'bad position';
  const r = rectAt(x, y);
  if (r.x0 < 0 || r.y0 < 0 || r.x1 >= D.W || r.y1 >= D.H) return 'the lot must be inside the garden';
  const own = rectIdx(lotRect(objects, v)), home = Object.values(VEHICLE_HOME).map(h => Math.floor(h.y) * D.W + Math.floor(h.x));
  for (const o of objects?.list ?? []) if (o.area === 'garden' && !(o.kind === 'lot' && o.v === v) && rectIdx(objRect(o)).some(i => inRect(r, i % D.W, Math.floor(i / D.W)))) return 'another object is there';
  for (const i of rectIdx(r)) {
    const t = ground(i);
    if (!t) return 'no such tile';
    if (!(t.g === 'grass' || (t.g === 'lot' && own.includes(i)))) return `${t.g} is not plain grass`;
    if (t.s) return 'the ground is tilled';
    if (changed.has(i)) return 'the ground was changed by a cheat';
    if (home.includes(i)) return 'the cart and sledge park there';
  }
  return null;
}

// Objekty z uloženia (nedôveryhodný JSON): neplatné vynechá; bez zoznamu = pozemky na pôvodných miestach
export function loadObjects(saved: unknown): Objects {
  if (!isRecord(saved) || !isArray(saved['list'])) return defaultLots();
  const list: GardenObject[] = [];
  const free = (x: number, y: number, w: number): boolean => !list.some(p => rectIdx(objRect(p)).some(i => i % D.W >= x && i % D.W < x + w && Math.floor(i / D.W) >= y && Math.floor(i / D.W) < y + w));
  for (const o of saved['list']) {
    if (!isRecord(o)) continue;
    const { id, x, y, v, o: by } = o;
    if (o['area'] !== 'garden' || typeof id !== 'number' || typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (o['kind'] === 'lot') {
      if (v !== 'icehouse' && v !== 'dielna') continue;
      if (list.some(p => p.kind === 'lot' && p.v === v)) continue; // jeden pozemok na budovu
      if (x < 0 || y < 0 || x + LOT_SIZE > D.W || y + LOT_SIZE > D.H || !free(x, y, LOT_SIZE)) continue;
      list.push({ id, area: 'garden', x, y, kind: 'lot', v, ...(typeof by === 'string' ? { o: by } : {}) });
    } else if (o['kind'] === 'zahon') {
      if (typeof v !== 'string' || !D.isZahonFrame(v) || x < 0 || y < 0 || x >= D.W || y >= D.H || !free(x, y, 1)) continue;
      const sh = o['sh'], rot = Number(o['rot']) & 3;
      const shape = typeof sh === 'string' && D.isZahonCorner(sh) ? { sh, rot: rot as 0 | 1 | 2 | 3 } : {}; // rohový záhon (#186)
      list.push({ id, area: 'garden', x, y, kind: 'zahon', v, ...shape, w: o['w'] ? 1 : 0, r: o['r'] ? 1 : 0, spots: loadSpots(o['spots']), o: typeof by === 'string' ? by : '' });
    }
  }
  const nid = Number(saved['nid']);
  return { list, nid: Number.isInteger(nid) && nid > Math.max(0, ...list.map(o => o.id)) ? nid : Math.max(0, ...list.map(o => o.id)) + 1 };
}
// Body záhonu z uloženia: bod v mriežke 8 × 8, nanajvýš raz; kvet (zapísal ho server) alebo pokryv
function loadSpots(saved: unknown): ZahonSpot[] {
  const out: ZahonSpot[] = [];
  if (!isArray(saved)) return out;
  for (const s of saved) {
    if (!isRecord(s)) continue;
    const { sx, sy, p, c } = s;
    if (typeof sx !== 'number' || typeof sy !== 'number' || !Number.isInteger(sx) || !Number.isInteger(sy) || sx < 0 || sy < 0 || sx > 7 || sy > 7) continue;
    if (out.some(q => q.sx === sx && q.sy === sy)) continue;
    // rastlinu zapísal tento server (tvar Plant), overí sa len druh
    if (isRecord(p) && typeof p['sp'] === 'string' && D.isSpeciesId(p['sp'])) out.push({ sx, sy, p: p as unknown as NonNullable<ZahonSpot['p']> });
    else if (typeof c === 'string' && D.isCoverId(c)) out.push({ sx, sy, c });
  }
  return out;
}

// Zem pozemku budovy v podľa objektu: kým nie je postavená 'lot', potom budova. Pôvodné miesto pozemku (z generátora
// mapy), ak tam pozemok už nie je a nezaberá ho iný objekt, je znova tráva.
export function applyLot(tiles: readonly ({ g: Ground } | undefined)[], objects: ObjList | null | undefined, v: LotFor, built: boolean): void {
  const taken = new Set((objects?.list ?? []).filter(o => o.area === 'garden').flatMap(o => rectIdx(objRect(o))));
  for (const i of rectIdx(DEFAULT[v])) { const t = tiles[i]; if (t && !taken.has(i) && (t.g === 'lot' || t.g === v)) t.g = 'grass'; }
  for (const i of rectIdx(lotRect(objects, v))) { const t = tiles[i]; if (t) t.g = built ? v : 'lot'; }
}
