// Umiestnené objekty (#156, #178): spoločná vrstva nad políčkami záhrady. Zatiaľ len pozemky budov (ľadovňa, Dielňa):
// kde budova stojí alebo bude stáť. Hráči pozemky nepresúvajú – zatiaľ len cheat z ladiacej stránky (neskôr plánovač).
// Pozemok má 2×2 políčka a ostane aj po postavení budovy (budova je tam, kde je jej pozemok).
// Zdieľa ho server (ice.ts, dielna.ts, cheaty) aj klient (kolíky pozemku, fúrik pri ľadovni) a ladiaca stránka (Mapa).
import * as D from './data.ts';
import type { Ground, Rect } from './data.ts';
import type { GardenObject, LotFor, Objects } from './save.ts';
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
export function lotOf(objects: Objects | null | undefined, v: LotFor): GardenObject | null {
  return objects?.list.find(o => o.v === v && o.area === 'garden') ?? null;
}
export const rectAt = (x: number, y: number): Rect => ({ x0: x, y0: y, x1: x + LOT_SIZE - 1, y1: y + LOT_SIZE - 1 });
export function lotRect(objects: Objects | null | undefined, v: LotFor): Rect | null {
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
export function lotPlaceError(ground: (i: number) => { readonly g: string; readonly s?: unknown } | undefined, objects: Objects | null | undefined, v: LotFor, x: number, y: number, changed: ReadonlySet<number>): string | null {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return 'bad position';
  const r = rectAt(x, y);
  if (r.x0 < 0 || r.y0 < 0 || r.x1 >= D.W || r.y1 >= D.H) return 'the lot must be inside the garden';
  const own = rectIdx(lotRect(objects, v)), home = Object.values(VEHICLE_HOME).map(h => Math.floor(h.y) * D.W + Math.floor(h.x));
  for (const o of objects?.list ?? []) if (o.area === 'garden' && o.v !== v && rectIdx(rectAt(o.x, o.y)).some(i => inRect(r, i % D.W, Math.floor(i / D.W)))) return 'another object is there';
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
  for (const o of saved['list']) {
    if (!isRecord(o)) continue;
    const { id, x, y, v, o: by } = o;
    if (o['kind'] !== 'lot' || o['area'] !== 'garden' || typeof id !== 'number' || typeof x !== 'number' || typeof y !== 'number') continue;
    if (v !== 'icehouse' && v !== 'dielna') continue;
    if (list.some(p => p.v === v)) continue; // jeden pozemok na budovu
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x + LOT_SIZE > D.W || y + LOT_SIZE > D.H) continue;
    list.push({ id, area: 'garden', x, y, kind: 'lot', v, ...(typeof by === 'string' ? { o: by } : {}) });
  }
  const nid = Number(saved['nid']);
  return { list, nid: Number.isInteger(nid) && nid > Math.max(0, ...list.map(o => o.id)) ? nid : Math.max(0, ...list.map(o => o.id)) + 1 };
}

// Zem pozemku budovy v podľa objektu: kým nie je postavená 'lot', potom budova. Pôvodné miesto pozemku (z generátora
// mapy), ak tam pozemok už nie je a nezaberá ho iný objekt, je znova tráva.
export function applyLot(tiles: readonly ({ g: Ground } | undefined)[], objects: Objects | null | undefined, v: LotFor, built: boolean): void {
  const taken = new Set((objects?.list ?? []).filter(o => o.area === 'garden').flatMap(o => rectIdx(rectAt(o.x, o.y))));
  for (const i of rectIdx(DEFAULT[v])) { const t = tiles[i]; if (t && !taken.has(i) && (t.g === 'lot' || t.g === v)) t.g = 'grass'; }
  for (const i of rectIdx(lotRect(objects, v))) { const t = tiles[i]; if (t) t.g = built ? v : 'lot'; }
}
