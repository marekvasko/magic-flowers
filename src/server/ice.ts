// Ľad: hory (druhá hracia plocha), ľadovec, zamrznutá voda, krompáč a ľadovňa.
// Čisté funkcie nad výrezmi sveta – server (alebo návrh udalosti) im dá len to, s čím pracujú:
//   hory = políčka hôr [{ g, ice?, cut? }] (world.hory), tiles = políčka záhrady, icehouse = { built, ice } (world.icehouse),
//   st = sklad { inv, fb } (výrez 'storage'), occupied = množina políčok hôr, na ktorých stojí hráč (z prítomnosti).
// Na políčku ľadovca je ice = koľko vrstiev ľadu (po 1/4 bloku) na ňom ešte stojí; cut = 1 → do vody sa dnes už vysekal otvor.
import * as D from '../shared/data.ts';
import type { AreaId, Season } from '../shared/data.ts';
import type { Icehouse, PlayerSave, Soil } from '../shared/save.ts';
import { isArray, isRecord, lookup, must } from '../shared/util.ts';
import * as I from './items.ts';
import type { Presence, StorageSlice, Tile } from './world.ts';

// pôvodná (najvyššia) výška ľadu na každom políčku hôr
export const LEVELS: readonly number[] = D.glacierLevels(D.buildMountains());
const levelAt = (i: number): number => must(LEVELS[i]);

// Vodný kvet v plese (#38): pôda druhu 'water' s rastlinou známeho druhu (uloženie je neoverený JSON)
function isWaterSoil(v: unknown): v is Soil {
  if (!isRecord(v) || v['k'] !== 'water' || typeof v['o'] !== 'string') return false;
  const p = v['p'];
  return isRecord(p) && typeof p['sp'] === 'string' && D.isSpeciesId(p['sp']) && typeof p['prog'] === 'number' && typeof p['q'] === 'number';
}
// Políčka hôr: typy zeme z generátora, z uloženia len zásoba ľadu, otvory vo vode a vodné kvety v plese.
export function loadHory(saved: unknown): Tile[] {
  const base = D.buildMountains();
  const ok = isArray(saved) && saved.length === base.length;
  return base.map((g, i) => {
    const t: Tile = { g }, v = ok ? saved[i] : undefined, s = isRecord(v) ? v : {};
    if (g === 'glacier') t.ice = s['ice'] == null ? levelAt(i) : Math.max(0, Math.min(levelAt(i), Number(s['ice']) | 0));
    if (g === 'water' && s['cut']) t.cut = 1;
    if (g === 'water' && isWaterSoil(s['s'])) t.s = s['s'];
    return t;
  });
}
// Políčko hôr na uloženie (JSON vynechá chýbajúce polia – v súbore je to save.ts SavedHoryTile)
export function saveHory(hory: readonly Tile[]): ({ ice: number | undefined; cut: 1 | undefined; s: Soil | undefined } | 0)[] {
  return hory.map(t => t.ice != null || t.cut || t.s ? { ice: t.ice, cut: t.cut, s: t.s || undefined } : 0);
}

// Pozemok ľadovne v záhrade: kým nie je postavená 'lot', potom 'icehouse'.
export function lotIdx(): number[] {
  const L = D.ICEHOUSE.lot, out: number[] = [];
  for (let y = L.y0; y <= L.y1; y++) for (let x = L.x0; x <= L.x1; x++) out.push(y * D.W + x);
  return out;
}
export function applyIcehouse(icehouse: Pick<Icehouse, 'built'> | null | undefined, tiles: readonly Tile[]): void {
  for (const i of lotIdx()) must(tiles[i]).g = icehouse && icehouse.built ? 'icehouse' : 'lot';
}

// Vysekanie ľadu krompáčom na políčku i plochy tiles. Vráti { ok, msg } – pri ok sa hráčovi pridá 1 ľad.
export function digIce(tiles: readonly Tile[], i: number, season: Season): { ok: boolean; msg: string | null } {
  const t = must(tiles[i]);
  if (t.g === 'glacier') {
    if (!t.ice) return { ok: false, msg: 'Tu je ľad vysekaný až po dno. Ľadovec každé ráno trochu dorastie. 🧊' };
    t.ice--;
    return { ok: true, msg: `+1 🧊 Ľad (tu ešte ${String(t.ice)} ${t.ice === 1 ? 'vrstva' : t.ice >= 2 && t.ice <= 4 ? 'vrstvy' : 'vrstiev'}).` };
  }
  if (t.g === 'water') {
    if (season !== 3) return { ok: false, msg: 'Voda nie je zamrznutá. Ľad tu vysekáš až v zime. ❄️' };
    if (t.cut) return { ok: false, msg: 'Tu už je otvor v ľade. Cez noc zamrzne – skús iné miesto. 🧊' };
    t.cut = 1;
    return { ok: true, msg: '+1 🧊 Ľad zo zamrznutej vody.' };
  }
  return { ok: false, msg: null };
}

// Topenie: n vrstiev od okrajov (najnižšie políčka ľadovca) dnu – ľadovec viditeľne ustupuje k skalám.
export function meltGlacier(hory: readonly Tile[], n: number): number {
  const list = hory.map((t, i) => i).filter(i => (must(hory[i]).ice ?? 0) > 0).sort((a, b) => levelAt(a) - levelAt(b) || a - b);
  let k = 0;
  for (const i of list) {
    const t = must(hory[i]);
    while (t.ice !== undefined && t.ice > 0 && k < n) { t.ice--; k++; }
    if (k >= n) break;
  }
  return k;
}
// Políčka hôr, na ktorých stojí hráč – pod nohami ľad nedorastá. presence: [{ area, x, y }] (snímka pripojených hráčov)
export function occupied(presence: readonly Pick<Presence, 'area' | 'x' | 'y'>[] | null | undefined): Set<number> {
  const s = new Set<number>();
  for (const p of presence || []) if (p.area === 'hory') s.add(Math.floor(p.y) * D.W + Math.floor(p.x));
  return s;
}
// Najnižšie priechodné susedné políčko (vo vrstvách ľadu) – ľadovec dorastá len tak, aby sa naň dalo vyliezť.
function lowestNeighbour(tiles: readonly Tile[], i: number): number {
  const x = i % D.W, y = (i / D.W) | 0;
  let m = Infinity;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= D.W || ny >= D.H) continue;
    const t = tiles[ny * D.W + nx];
    if (D.passable(t)) m = Math.min(m, D.level(t));
  }
  return m;
}
// Dorastanie: n vrstiev, rovnomerne od najvyšších políčok pod skalami nadol, najviac do pôvodnej výšky.
// Nedorastá pod hráčom (occ = occupied(prítomnosť)) a nikdy nie viac ako pol bloku nad najnižšieho suseda – nikoho nezamuruje.
export function growGlacier(hory: readonly Tile[], n: number, occ?: Set<number> | null): number {
  const list = hory.map((t, i) => i).filter(i => levelAt(i) > 0).sort((a, b) => levelAt(b) - levelAt(a) || a - b);
  const busy = occ || new Set<number>();
  let k = 0, any = true;
  while (k < n && any) {
    any = false;
    for (const i of list) {
      if (k >= n) break;
      const t = must(hory[i]);
      if (t.ice !== undefined && t.ice < levelAt(i) && !busy.has(i) && D.level(t) + 1 <= lowestNeighbour(hory, i) + D.GLACIER_STEP) { t.ice++; k++; any = true; }
    }
  }
  return k;
}
// Zrážky (dážď, sneh) – ľadovec dorastie. Vráti počet pribudnutých vrstiev. Najviac raz za deň: volajúci si pamätá
// deň posledného kŕmenia (world.glacierFed) a keď sa zhoduje s dnešným, nevolá.
export function feedGlacier(hory: readonly Tile[], weather: string | null, occ?: Set<number> | null): number {
  const n = weather === null ? undefined : lookup(D.GLACIER_GROW, weather);
  return n ? growGlacier(hory, n, occ) : 0;
}

// Ráno: otvory vo vode (v záhrade aj v horách) zamrznú, ľadovec sa podľa obdobia topí a v daždi/snehu dorastie.
// weather = dnešné počasie, ktorým sa ľadovec kŕmi; null, ak už dnes kŕmený bol (dážď z elixíru či studne pred ránom).
// Vráti zoznam plôch, ktoré sa zmenili.
export function dawnIce(tiles: readonly Tile[], hory: readonly Tile[], season: Season, weather: string | null, occ?: Set<number> | null): AreaId[] {
  const changed = new Set<AreaId>();
  for (const [area, list] of [['garden', tiles], ['hory', hory]] as const) for (const t of list) if (t.cut) { delete t.cut; changed.add(area); }
  if (meltGlacier(hory, must(D.GLACIER_MELT[season]))) changed.add('hory');
  if (feedGlacier(hory, weather, occ)) changed.add('hory');
  return [...changed];
}
export function glacierTotal(hory: readonly Tile[]): number { return hory.reduce((s, t) => s + (t.ice || 0), 0); }
export function glacierMax(): number { return LEVELS.reduce((s, v) => s + v, 0); }

// Zmena množstva ľadu v ľadovni – ak sa tým zmení rýchlosť starnutia v sklade st, várky sa najprv prepočítajú (k času tick).
export function setIce(icehouse: Icehouse, st: Pick<StorageSlice, 'inv'> & Partial<Pick<StorageSlice, 'fb'>>, tick: number, ice: number): void {
  const before = I.storageC(st, icehouse);
  const next = Math.max(0, Math.min(D.ICEHOUSE.cap, ice));
  if ((icehouse.ice > 0) !== (next > 0)) I.rebase(before, tick);
  icehouse.ice = next;
}

// Každú hernú hodinu sa časť ľadu roztopí (v zime nič); izolácia z prikrývok topenie spomalí. Vráti true, ak sa ľadovňa práve vyprázdnila.
export function meltHourly(icehouse: Icehouse | null | undefined, st: Pick<StorageSlice, 'inv'> & Partial<Pick<StorageSlice, 'fb'>>, tick: number, season: Season): boolean {
  const h = icehouse;
  if (!h || !h.built || h.ice <= 0) return false;
  const left = h.ice - must(D.ICEHOUSE.melt[season]) * must(D.ICEHOUSE.insul[D.insulLevel(h.bl)]);
  setIce(h, st, tick, left < 1e-6 ? 0 : +left.toFixed(4));
  return h.ice === 0;
}

// Doplnenie ľadovne – vráti, koľko blokov sa zmestilo (hráčovi ich odoberie server).
export function fillIcehouse(icehouse: Icehouse | null | undefined, st: Pick<StorageSlice, 'inv'> & Partial<Pick<StorageSlice, 'fb'>>, tick: number, n: number): number {
  const h = icehouse;
  if (!h || !h.built) return 0;
  const k = Math.max(0, Math.min(n, Math.floor(D.ICEHOUSE.cap - h.ice + 1e-6)));
  if (k) setIce(h, st, tick, h.ice + k);
  return k;
}

// Izolácia (#23): hráč vloží do ľadovne 1 hodvábnu prikrývku (sv = jeho uloženie). Vráti chybu alebo null.
// icehouse.bl = koľko prikrývok v nej už je; úroveň izolácie je D.insulLevel(bl).
export function insulate(icehouse: Icehouse | null | undefined, sv: PlayerSave): string | null {
  const h = icehouse, B = D.ICEHOUSE, max = must(B.blankets[B.blankets.length - 1]);
  if (!h || !h.built) return 'Ľadovňa ešte nie je postavená. Kúpiš ju na trhu (záložka Vylepšiť). 🧊';
  if ((h.bl | 0) >= max) return 'Ľadovňa je už izolovaná najlepšie, ako sa dá. 🧶';
  if (!((sv.inv.blanket ?? 0) > 0)) return 'Nemáš hodvábnu prikrývku. Utká ti ju majster hodvábu v dedinke alebo krosná v Dielni. 🧶';
  I.removeItems(I.playerC(sv), 'blanket', 1, 0);
  h.bl = (h.bl | 0) + 1;
  return null;
}

// Kúpa ľadovne (spoločná stavba, platí ju hráč): icehouse sa mení na mieste, pozemok v tiles dostane budovu. Vráti chybu alebo null.
export function buildIcehouse(icehouse: Icehouse, tiles: readonly Tile[], sv: PlayerSave): string | null {
  const B = D.ICEHOUSE;
  if (icehouse.built) return 'Ľadovňa už v záhrade stojí.';
  if (D.repLevel(sv.rep || 0) < B.rep) return `Potrebuješ reputáciu úrovne ${String(B.rep)}.`;
  if (sv.coins < B.price) return 'Nemáš dosť mincí. 🪙';
  if (lotIdx().some(i => must(tiles[i]).s)) return 'Na pozemku vedľa domčeka je prekopaná zem. Najprv ju zarovnaj motykou.';
  sv.coins -= B.price;
  icehouse.built = true; icehouse.ice = 0; icehouse.bl = 0;
  applyIcehouse(icehouse, tiles);
  return null;
}

// Kúpa náradia (krompáč) – raz na hráča.
export function buyTool(sv: PlayerSave, id: string): string | null {
  if (id !== 'pick' && id !== 'lamp') return 'Toto sa na trhu nepredáva.';
  const T = D.TOOLS[id];
  if (sv.inv[id]) return `${T.name} už máš.`;
  if (D.repLevel(sv.rep || 0) < T.rep) return `Potrebuješ reputáciu úrovne ${String(T.rep)}.`;
  if (sv.coins < T.price) return 'Nemáš dosť mincí. 🪙';
  sv.coins -= T.price;
  sv.inv[id] = 1;
  return null;
}
