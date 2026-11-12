// Väčšie jazierko, mólo a loďka pre dvoch (#160). Mólo je spoločná stavba (ako Dielňa), kúpi ju ktokoľvek na trhu
// (záložka Vylepšiť) a s ním aj jednu loďku. Loďka má dve miesta: prvý, kto sedí (seats[0]), vesluje – jeho pohyb (pos)
// posúva loďku po vode, druhý sa vezie. Nastupuje sa na móle alebo z brehu vedľa loďky, vystupuje sa na mólo či na breh
// vedľa loďky. Prázdna loďka ostane, kde ju nechali. V zime leží prevrátená na móle (flip) a na vodu nesmie.
// Stav sveta: world.dock = { built, boat: { x, y, a }, seats, flip } (save.ts Dock), políčka móla v záhrade ('dock').
// Návrhy: buildDock, board, unboard, boatDay (každú polnoc: zima, jar, zatúlaná loďka); háčiky do pos, leave a resolveAct
// (actions.ts) a migrácia v12 (server.ts migrate) – nová voda jazierka vráti, čo na nej rástlo, cez redeem.
import * as D from '../shared/data.ts';
import type { Ground, Point } from '../shared/data.ts';
import type { ServerMessage, ToastKind } from '../shared/protocol.ts';
import type { Dock, Inventory, PlayerKey, PlayerSave, SavedTile, Soil } from '../shared/save.ts';
import { isArray, isRecord } from '../shared/util.ts';
import * as V from '../shared/vehicles.ts';
import * as E from './engine.ts';
import type { Keys } from './engine.ts';
import * as Dielna from './dielna.ts';
import { dockOf, savesOf, sl } from './game.ts';
import type { GameCtx, GamePeriodic, GameProposer, GameSlices, GameWorld, Msg, PosSlice, To } from './game.ts';
import type { Presence, Tile } from './world.ts';

const K = D.DOCK;
const toast$ = (to: To, text: string, kind?: ToastKind): Msg => ({ to, t: 'toast', text, kind: kind || 'info' });
const season = (tick: number): D.Season => D.seasonOf(D.dayOfTick(tick));
const DOCK_IDX: readonly number[] = K.tiles.map(p => p.y * D.W + p.x);
const tileKey = (i: number): `tile:garden:${number}` => `tile:garden:${i}`;
const idxAt = (x: number, y: number): number => Math.floor(y) * D.W + Math.floor(x);

// ---------- Stav ----------
export const newDock = (): Dock => ({ built: false, boat: { x: K.moor.x, y: K.moor.y, a: -Math.PI / 2 }, seats: [], flip: false });
// Uloženie zo staršej verzie alebo poškodené → platný stav (loďka na mieste, kde sa dá, inak pri móle)
export function loadDock(saved: unknown): Dock {
  const src = isRecord(saved) ? saved : {}, b = src['boat'], out = newDock();
  out.built = !!src['built'];
  out.flip = out.built && !!src['flip'];
  if (isRecord(b)) {
    const x = b['x'], y = b['y'], a = b['a'];
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) out.boat = { x, y, a: typeof a === 'number' && Number.isFinite(a) ? a : out.boat.a };
  }
  const seats = src['seats'];
  if (out.built && isArray(seats)) out.seats = seats.filter((k): k is string => typeof k === 'string').slice(0, K.seats);
  return out;
}
// Políčka móla v záhrade: kým nie je postavené, voda; potom 'dock' (otvor v ľade tam nemá zmysel)
export function applyDock(dock: Pick<Dock, 'built'> | null | undefined, tiles: readonly Tile[]): void {
  for (const i of DOCK_IDX) {
    const t = tiles[i];
    if (!t) continue;
    t.g = dock && dock.built ? 'dock' : 'water';
    if (t.g === 'dock') { delete t.cut; t.s = null; }
  }
}
export const seatOf = (dock: Pick<Dock, 'seats'> | null | undefined, key: PlayerKey): number => (dock ? dock.seats.indexOf(key) : -1);
// Správa pre klientov: celý stav móla a loďky
export function view(dock: Dock): ServerMessage { return { t: 'dock', built: dock.built, boat: { ...dock.boat }, seats: [...dock.seats], flip: dock.flip }; }

// ---------- Pevná zem a voda ----------
// Kam postaviť hráča zo stredu (x, y) políčka (tx, ty): bod políčka najbližšie k (x, y), celé telo ostane na políčku
function onTile(tx: number, ty: number, x: number, y: number): Point {
  const { rx, ry } = D.BODY;
  return { x: Math.min(tx + 1 - rx, Math.max(tx + rx, x)), y: Math.min(ty + 1 - ry, Math.max(ty + ry, y)) };
}
// Najbližšia pevná zem k bodu (x, y): priechodné políčko, nie voda, prechod ani pozemok stavby. tiles = políčka záhrady.
export function nearestLand(tiles: readonly ({ readonly g: Ground } | null | undefined)[], x: number, y: number): Point {
  let best: Point = { x: D.SPAWN.x, y: D.SPAWN.y }, bd = Infinity;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (!t || !D.isLand(t) || t.g === 'gate' || t.g === 'lot') continue;
    const tx = i % D.W, ty = Math.floor(i / D.W), p = onTile(tx, ty, x, y), d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
// Dá sa do loďky na (x, y) nastúpiť z nejakého kúsku pevnej zeme? (inak sa prázdna loďka vráti k mólu – boatDay)
export function boardable(tiles: readonly (Tile | null | undefined)[], x: number, y: number): boolean {
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (!D.isLand(t) || t.g === 'gate') continue;
    const p = onTile(i % D.W, Math.floor(i / D.W), x, y);
    if (Math.hypot(p.x - x, p.y - y) <= K.reach) return true;
  }
  return false;
}
// Políčka, ktoré zaberá loďka so stredom (x, y)
export function boatTiles(x: number, y: number): number[] {
  return [...new Set(D.boatCorners(x, y).map(([cx, cy]) => Math.max(0, Math.min(D.W * D.H - 1, idxAt(cx, cy)))))];
}
// Je telo hráča na (x, y) aspoň kúskom na novej vode jazierka?
const NEW_SET = new Set(D.NEW_POND);
function bodyInNewPond(x: number, y: number): boolean {
  const { rx, ry } = D.BODY;
  for (const dy of [-ry, ry]) for (const dx of [-rx, rx]) {
    const tx = Math.max(0, Math.min(D.W - 1, Math.floor(x + dx))), ty = Math.max(0, Math.min(D.H - 1, Math.floor(y + dy)));
    if (NEW_SET.has(ty * D.W + tx)) return true;
  }
  return false;
}

// ---------- Migrácia v12 ----------
// Nové políčka vody (D.NEW_POND): pôda sa zmaže a čo na nej bolo, sa pridá do redeem (dostane to prvý hráč, ktorý príde –
// ako pri Dielni v11: kvitnúca rastlina → kvety, rastúca → semienko, pohnojená zem → kompost). Hráči, ktorí v záhrade
// stoja (aj kúskom tela) na novej vode, sa presunú na najbližšiu pevnú zem. Mólo ešte nie je (dock = nové).
// saved = uložené políčka záhrady (pole { s } v poradí záhrady), redeem = doterajšie redeem (môže už niečo mať z v11).
// Fúrik a sane (#158, voliteľné pole vehicles), ktoré v záhrade stoja na novej vode, sa tiež presunú na pevnú zem.
export function migrate(out: { tiles?: SavedTile[] | undefined; saves: Partial<Record<PlayerKey, PlayerSave>>; redeem: Inventory; dock: Dock; vehicles?: unknown }): void {
  /* eslint-disable @typescript-eslint/no-unnecessary-condition -- staré a poškodené uloženia: polia môžu chýbať */
  const redeem: Inventory = isRecord(out.redeem) ? out.redeem : {}, saved: unknown = out.tiles;
  if (isArray(saved) && saved.length === D.W * D.H) {
    for (const i of D.NEW_POND) {
      const t = saved[i];
      if (!isRecord(t)) continue;
      // pôda zo staršieho uloženia (v11 a skôr) má tvar Soil – zapísal ju server, nie klient
      if (t['s']) for (const [id, n] of Dielna.redeemOf(t['s'] as Soil)) redeem[id] = (redeem[id] || 0) + n;
      t['s'] = null;
      delete t['cut'];
    }
  }
  out.redeem = redeem;
  const ground = D.buildMap().map(g => ({ g }));
  for (const sv of Object.values(out.saves || {})) {
    if (!sv || (sv.area && sv.area !== 'garden') || typeof sv.x !== 'number' || typeof sv.y !== 'number') continue;
    if (!bodyInNewPond(sv.x, sv.y)) continue;
    const p = nearestLand(ground, sv.x, sv.y);
    sv.x = p.x; sv.y = p.y;
  }
  const vs: unknown = out.vehicles;
  if (isRecord(vs)) for (const v of Object.values(vs)) {
    if (!isRecord(v) || (v['area'] != null && v['area'] !== 'garden')) continue;
    const x = v['x'], y = v['y'];
    if (typeof x !== 'number' || typeof y !== 'number' || !NEW_SET.has(Math.floor(y) * D.W + Math.floor(x))) continue;
    const p = nearestLand(ground, x, y);
    v['x'] = p.x; v['y'] = p.y;
  }
  /* eslint-enable @typescript-eslint/no-unnecessary-condition -- koniec starých uložení */
  out.dock = newDock();
}
// Po načítaní sveta (server.ts getRoom): kto ostal sedieť v loďke (server spadol či sa reštartoval), vystúpi na najbližší breh.
// Svet ešte nebeží, preto priamo – ako Spiders.load.
export function load(world: Pick<GameWorld, 'dock' | 'saves' | 'tiles'>): void {
  const dock = world.dock;
  for (const key of dock.seats) {
    const sv = world.saves[key];
    if (!sv) continue;
    const p = nearestLand(world.tiles, dock.boat.x, dock.boat.y);
    sv.x = p.x; sv.y = p.y; sv.area = 'garden';
  }
  dock.seats = [];
}

// ---------- Vstupy ----------
export interface DockInputs {
  buildDock: { key: PlayerKey };
  board: { key: PlayerKey };
  unboard: { key: PlayerKey; x: number; y: number };
  boatDay: null;
}
const actor = (ctx: GameCtx): Presence => ctx.actor || ctx.reject(null);
const nameOf = (ctx: GameCtx, key: PlayerKey): string => (ctx.actor ? ctx.actor.name : key);
const posOf = (s: GameSlices, key: PlayerKey, ctx: GameCtx): PosSlice => sl(s, `pos:${key}`) || ctx.reject(null);
// Loďka vo výrezoch: návrh pos (a leave, boatDay) ju deklaruje len niekedy – inak vo výrezoch nie je
const dockIn = (s: GameSlices): Dock | undefined => (Object.hasOwn(s, 'dock') ? s.dock : undefined);
// Sedí hráč v loďke? (pre iné návrhy, ktoré si deklarujú 'dock' – napr. fúrik, #158: z loďky sa nechytá)
export const inBoat = (s: GameSlices, key: PlayerKey): boolean => seatOf(dockIn(s), key) >= 0;
const noBoat = (dock: Dock, tick: number): string | null => {
  if (!dock.built) return `Pri jazierku ešte nie je mólo. Postaviť ho môže ktokoľvek na trhu (záložka Vylepšiť) za ${String(K.price)} 🪙. 🛶`;
  if (dock.flip || season(tick) === 3) return 'V zime leží loďka prevrátená na móle. Na vodu pôjde až na jar. ❄️';
  return null;
};
// Kto vystúpi z loďky (seat), aby si ďalší sadol veslovať, a správa pre toho, kto ostal
function leaveSeat(dock: Dock, key: PlayerKey, ctx: GameCtx): void {
  const i = dock.seats.indexOf(key);
  if (i < 0) return;
  dock.seats.splice(i, 1);
  const rest = dock.seats[0];
  if (i === 0 && rest) ctx.emit(toast$(rest, '🛶 Teraz vesluješ ty.'));
}

export const PROPOSERS: { [T in keyof DockInputs]: GameProposer<DockInputs[T]> } = {
  // Kúpa móla (s loďkou) na trhu: spoločné pre celú záhradu, platí ho hráč. Políčka móla dostanú 'dock' (svet sa prestavia).
  buildDock: {
    keys: d => ({ writes: ['dock', `save:${d.key}`, ...DOCK_IDX.map(tileKey)] }),
    run(s, d, ctx) {
      const dock = s.dock, sv = sl(s, `save:${d.key}`) || ctx.reject(null);
      if (dock.built) ctx.reject('Mólo už pri jazierku stojí. 🛶');
      if (D.repLevel(sv.rep || 0) < K.rep) ctx.reject(`Potrebuješ reputáciu úrovne ${String(K.rep)}.`);
      if (sv.coins < K.price) ctx.reject('Nemáš dosť mincí. 🪙');
      // na mieste móla (voda pri brehu) môže rásť vodný kvet (#38) – mólo by ho zakrylo
      if (DOCK_IDX.some(i => sl(s, tileKey(i))?.s)) ctx.reject('Na mieste móla pri brehu rastie vodný kvet. Najprv ho zober (uhynutý odstráň motykou). 🪷');
      sv.coins -= K.price;
      const winter = season(ctx.tick) === 3;
      Object.assign(dock, newDock(), { built: true, flip: winter });
      for (const i of DOCK_IDX) { const t = sl(s, tileKey(i)); if (t) { t.g = 'dock'; delete t.cut; t.s = null; } }
      ctx.emit(toast$(E.ALL, `🛶 ${nameOf(ctx, d.key)} postavil(a) pri jazierku mólo s loďkou! Zmestia sa do nej dvaja a doveslujú aj tam, kam z brehu nikto nedočiahne.`
        + (winter ? ' Teraz v zime leží prevrátená na móle – na vodu pôjde na jar.' : ' Nastúpiš na móle.'), 'gift'));
    }
  },
  // Nastúpiť (ťuknutie na loďku): na móle alebo z brehu vedľa loďky; prvý vesluje, druhý sa vezie
  board: {
    keys: d => ({ writes: ['dock', `pos:${d.key}`], reads: ['vehicles'] }), // fúrik a sane (#158)
    run(s, d, ctx) {
      const me = actor(ctx), dock = s.dock, pos = posOf(s, d.key, ctx);
      // kto tlačí fúrik (ťahá sane) alebo sa v nich vezie, do loďky nenastúpi (#158)
      if (Object.hasOwn(s, 'vehicles') && (V.drivenBy(s.vehicles, d.key) || V.ridden(s.vehicles, d.key))) ctx.reject('Najprv pusti fúrik či sane (alebo z nich vystúp) – do loďky sa s nimi nezmestíš. 🛶');
      const why = noBoat(dock, ctx.tick);
      if (why) ctx.reject(why);
      if (dock.seats.includes(d.key)) ctx.reject(null);
      if (dock.seats.length >= K.seats) ctx.reject('V loďke už sedia dvaja. 🛶');
      if (me.area !== 'garden' || Math.hypot(me.x - dock.boat.x, me.y - dock.boat.y) > K.reach) ctx.reject('Podíď bližšie k loďke – nastúpiš na móle alebo z brehu hneď vedľa nej.');
      if (me.scav) { ctx.cancel(`scavDone:${d.key}`); ctx.emit({ to: d.key, t: 'scavDone' }); }
      dock.seats.push(d.key);
      pos.x = dock.boat.x; pos.y = dock.boat.y; pos.lastTick = ctx.tick;
      ctx.emit({ to: d.key, t: 'aboard', x: pos.x, y: pos.y });
      const rower = dock.seats[0];
      ctx.emit(toast$(d.key, dock.seats.length === 1
        ? '🛶 Sedíš v loďke a vesluješ – ovládaš ju ako chôdzu. Vystúpiš ťuknutím na mólo alebo breh hneď vedľa loďky.'
        : `🛶 Prisadol(a) si do loďky. Vesluje ${(ctx.presence || []).find(p => p.key === rower)?.name ?? rower ?? ''}; vystúpiš ťuknutím na mólo alebo breh vedľa loďky.`));
      if (rower && rower !== d.key) ctx.emit(toast$(rower, `🛶 ${me.name} si prisadol(a) do loďky.`));
    }
  },
  // Vystúpiť na políčko (x, y): pevná zem (aj mólo) hneď vedľa loďky
  unboard: {
    keys: d => ({ writes: ['dock', `pos:${d.key}`], reads: [tileKey(Math.max(0, Math.min(D.W * D.H - 1, (d.y | 0) * D.W + (d.x | 0))))] }),
    run(s, d, ctx) {
      const dock = s.dock, pos = posOf(s, d.key, ctx), x = d.x | 0, y = d.y | 0;
      if (seatOf(dock, d.key) < 0) ctx.reject(null);
      const t = x >= 0 && y >= 0 && x < D.W && y < D.H ? sl(s, tileKey(y * D.W + x)) : undefined;
      if (!D.isLand(t) || t.g === 'gate') ctx.reject('Tu sa vystúpiť nedá – vyber mólo alebo breh hneď vedľa loďky.');
      if (Math.hypot(x + 0.5 - dock.boat.x, y + 0.5 - dock.boat.y) > K.reach) ctx.reject('Priveslujte bližšie k brehu.');
      const p = onTile(x, y, dock.boat.x, dock.boat.y);
      leaveSeat(dock, d.key, ctx);
      pos.x = p.x; pos.y = p.y; pos.lastTick = ctx.tick;
      ctx.emit({ to: d.key, t: 'aboard', x: p.x, y: p.y });
      ctx.emit(toast$(d.key, '🛶 Vystúpil(a) si z loďky.'));
    }
  },
  // Každú polnoc: prvý deň zimy loďku vytiahnu na mólo a prevrátia (posádka vystúpi na mólo), na jar ju zase spustia
  // na vodu pri móle; prázdnu loďku, ku ktorej sa z brehu nedá dostať (veslár sa odpojil uprostred jazierka), pritiahne
  // vietor k mólu.
  boatDay: {
    keys: (d, w) => { const dock = dockOf(w); return { writes: ['dock', ...(dock ? dock.seats : []).map(k => `pos:${k}`)], reads: ['tile:garden:*'] }; },
    run(s, d, ctx) {
      const dock = dockIn(s);
      if (!dock || !dock.built) return;
      const winter = season(ctx.tick) === 3;
      if (winter && !dock.flip) {
        for (const key of dock.seats) {
          const pos = sl(s, `pos:${key}`);
          if (pos) { pos.x = K.land.x; pos.y = K.land.y; ctx.emit({ to: key, t: 'aboard', x: K.land.x, y: K.land.y }); }
        }
        Object.assign(dock, { seats: [], flip: true, boat: { x: K.moor.x, y: K.moor.y, a: -Math.PI / 2 } });
        ctx.emit(toast$(E.area('garden'), '❄️ Prišla zima – loďku vytiahli na mólo a prevrátili. Na vodu pôjde až na jar.', 'day'));
      } else if (!winter && dock.flip) {
        Object.assign(dock, { flip: false, boat: { x: K.moor.x, y: K.moor.y, a: -Math.PI / 2 } });
        ctx.emit(toast$(E.area('garden'), '🛶 Jar! Loďka je zase na vode pri móle.', 'day'));
      } else if (!dock.flip && !dock.seats.length && !boardable(sl(s, 'tile:garden:*'), dock.boat.x, dock.boat.y)) {
        dock.boat = { x: K.moor.x, y: K.moor.y, a: -Math.PI / 2 };
      }
    }
  }
};
export const PERIODIC: GamePeriodic[] = [{ key: 'boatDay', type: 'boatDay', next: E.daily(0) }];

// ---------- Háčiky do actions.ts ----------
// pos (actions.ts): veslár posúva loďku – kľúče pridajú loďku, polohu spolujazdca a políčka pod loďkou
export function posKeys(d: { key: PlayerKey; x: number; y: number }, w: Pick<GameWorld, 'dock'>): Keys {
  const dock = dockOf(w);
  if (!dock || seatOf(dock, d.key) !== 0 || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return {};
  return { writes: ['dock', ...dock.seats.slice(1).map(k => `pos:${k}`)], reads: boatTiles(d.x, d.y).map(tileKey) };
}
// pos.run: hráč v loďke. Vráti true, ak pohyb vybavila loďka (veslár), inak false (bežná chôdza).
// p = nová poloha (už v ploche), pos = poloha veslára. Celá loďka musí byť na vode; spolujazdec ide s ňou.
export function onRow(s: GameSlices, d: { key: PlayerKey }, ctx: GameCtx, pos: { x: number; y: number; lastTick?: number | undefined }, p: Point): boolean {
  const dock = dockIn(s);
  const seat = seatOf(dock, d.key);
  if (!dock || seat < 0) return false;
  if (seat > 0 || dock.flip) ctx.reject(null); // spolujazdec nevesluje
  const fits = D.boatCorners(p.x, p.y).every(([cx, cy]) => cx >= 0 && cy >= 0 && cx < D.W && cy < D.H && sl(s, tileKey(idxAt(cx, cy)))?.g === 'water');
  if (!fits) ctx.reject(null);
  const b = dock.boat, dx = p.x - b.x, dy = p.y - b.y;
  if (Math.hypot(dx, dy) > 0.02) b.a = Math.round(Math.atan2(dy, dx) * 1000) / 1000;
  b.x = p.x; b.y = p.y;
  pos.x = p.x; pos.y = p.y; pos.lastTick = ctx.tick;
  for (const key of dock.seats.slice(1)) {
    const o = sl(s, `pos:${key}`);
    if (!o) continue;
    o.x = p.x; o.y = p.y; o.lastTick = ctx.tick;
    ctx.emit({ to: key, t: 'aboard', x: p.x, y: p.y });
  }
  return true;
}
// leave (actions.ts): kto sa odpojí v loďke, vystúpi na najbližší breh; loďka ostane, kde je
export function leaveKeys(d: { key: PlayerKey }, w: Pick<GameWorld, 'dock'>): Keys {
  const dock = dockOf(w);
  return dock && seatOf(dock, d.key) >= 0 ? { writes: ['dock'], reads: ['tile:garden:*'] } : {};
}
export function onLeave(s: GameSlices, d: { key: PlayerKey }, ctx: GameCtx, pos: { x: number; y: number; area?: D.AreaId | undefined }): void {
  const dock = dockIn(s);
  if (!dock || seatOf(dock, d.key) < 0) return;
  const p = nearestLand(sl(s, 'tile:garden:*'), dock.boat.x, dock.boat.y);
  leaveSeat(dock, d.key, ctx);
  pos.x = p.x; pos.y = p.y; pos.area = 'garden';
}
// resolveAct (actions.ts): ťuknutie na loďku (nastúpiť) alebo, kým hráč sedí v loďke, na breh či mólo vedľa nej (vystúpiť).
// Nastupuje sa s prázdnou rukou alebo s náradím (inak ťuknutie na hráča v loďke daruje predmet). V loďke ťuknutie
// na záhon s predmetom robí to, čo vždy (zalievanie z loďky); vystupuje sa na zem bez záhonu alebo s prázdnou rukou.
// null = loďky sa to netýka (pokračuje bežný rozklad).
export function resolveAct(world: Pick<GameWorld, 'dock' | 'tiles'>, me: Pick<Presence, 'key' | 'area' | 'x' | 'y'>, x: number, y: number, item: string):
  { type: 'board'; data: DockInputs['board'] } | { type: 'unboard'; data: DockInputs['unboard'] } | { toast: string } | null {
  const dock = dockOf(world);
  if (!dock || !dock.built || me.area !== 'garden') return null;
  const t = world.tiles[y * D.W + x], b = dock.boat;
  if (seatOf(dock, me.key) >= 0) {
    if (!t || !D.isLand(t) || t.g === 'gate' || (t.s && item)) return null;
    if (Math.hypot(x + 0.5 - b.x, y + 0.5 - b.y) > K.reach) return { toast: 'Priveslujte bližšie k brehu – vystúpiť sa dá len hneď vedľa loďky.' };
    return { type: 'unboard', data: { key: me.key, x, y } };
  }
  if (dock.flip) return t && t.g === 'dock' && !item ? { toast: 'V zime leží loďka prevrátená na móle. Na vodu pôjde až na jar. ❄️' } : null;
  // loďka je dlhá ~2 bloky: nastupuje sa ťuknutím na vodu, ktorú zaberá (stred políčka najviac 1 blok od stredu loďky)
  if (!t || t.g !== 'water' || Math.hypot(x + 0.5 - b.x, y + 0.5 - b.y) > 1 || (item && !D.isTool(item))) return null;
  return { type: 'board', data: { key: me.key } };
}

// ---------- Cheaty z ladiacej stránky (#153) ----------
// op 'dock': postaviť / zbúrať mólo; 'boat': loďku na (x, y) (musí byť na vode); 'seat': hráča do loďky (alebo z nej);
// 'boatFlip': vynútiť zimu (loďka prevrátená na móle) alebo ju zase spustiť na vodu
export type DockCheat =
  | { op: 'dock'; built: boolean }
  | { op: 'boat'; x: number; y: number }
  | { op: 'seat'; key: PlayerKey; on: boolean }
  | { op: 'boatFlip'; flip: boolean };
export function cheatKeys(d: DockCheat, w: Pick<GameWorld, 'dock' | 'saves'>): Keys {
  const dock = dockOf(w), seated = (dock ? dock.seats : []).map(k => `pos:${k}`);
  switch (d.op) {
    case 'dock': return { writes: ['dock', 'tile:garden:*', ...(d.built ? [] : Object.keys(savesOf(w)).map(k => `pos:${k}`))] };
    case 'boat': return { writes: ['dock', ...seated], reads: boatTiles(d.x, d.y).map(tileKey) };
    case 'seat': return { writes: ['dock', `pos:${d.key}`], reads: ['tile:garden:*'] };
    case 'boatFlip': return { writes: ['dock', ...seated] };
  }
}
export function cheatRun(s: GameSlices, d: DockCheat, ctx: GameCtx): void {
  const dock = s.dock, tiles = (): Tile[] => sl(s, 'tile:garden:*');
  const unseat = (to: Point): void => {
    for (const key of dock.seats) { const pos = sl(s, `pos:${key}`); if (pos) { pos.x = to.x; pos.y = to.y; ctx.emit({ to: key, t: 'aboard', x: to.x, y: to.y }); } }
    dock.seats = [];
  };
  switch (d.op) {
    case 'dock': {
      if (d.built === dock.built) ctx.reject(d.built ? 'the dock is already built' : 'there is no dock');
      if (d.built) Object.assign(dock, newDock(), { built: true, flip: season(ctx.tick) === 3 });
      else {
        const shore = nearestLand(D.buildMap().map(g => ({ g })), K.land.x, K.land.y + 2);
        unseat(shore);
        // kto stojí na móle, ten by po zbúraní stál na vode – presunie sa na breh
        for (const key of Object.keys(s)) {
          if (!key.startsWith('pos:')) continue;
          const pos = sl(s, `pos:${key.slice(4)}`);
          if (pos && (!pos.area || pos.area === 'garden') && DOCK_IDX.includes(idxAt(pos.x, pos.y))) { pos.x = shore.x; pos.y = shore.y; }
        }
        Object.assign(dock, newDock());
      }
      applyDock(dock, tiles());
      return;
    }
    case 'boat': {
      if (!dock.built) ctx.reject('there is no dock');
      const fits = D.boatCorners(d.x, d.y).every(([cx, cy]) => cx >= 0 && cy >= 0 && cx < D.W && cy < D.H && sl(s, tileKey(idxAt(cx, cy)))?.g === 'water');
      if (!fits) ctx.reject('the boat must be on water');
      dock.boat.x = d.x; dock.boat.y = d.y;
      for (const key of dock.seats) { const pos = sl(s, `pos:${key}`); if (pos) { pos.x = d.x; pos.y = d.y; ctx.emit({ to: key, t: 'aboard', x: d.x, y: d.y }); } }
      return;
    }
    case 'seat': {
      const pos = sl(s, `pos:${d.key}`) || ctx.reject('no such player');
      if (!d.on) {
        if (seatOf(dock, d.key) < 0) ctx.reject('the player is not in the boat');
        const p = nearestLand(tiles(), dock.boat.x, dock.boat.y);
        leaveSeat(dock, d.key, ctx);
        pos.x = p.x; pos.y = p.y;
        ctx.emit({ to: d.key, t: 'aboard', x: p.x, y: p.y });
        return;
      }
      if (!dock.built || dock.flip) ctx.reject(!dock.built ? 'there is no dock' : 'the boat is flipped (winter)');
      if (seatOf(dock, d.key) >= 0) ctx.reject('the player is already in the boat');
      if (dock.seats.length >= K.seats) ctx.reject('the boat is full (2 seats)');
      dock.seats.push(d.key);
      pos.x = dock.boat.x; pos.y = dock.boat.y; pos.area = 'garden';
      ctx.emit({ to: d.key, t: 'aboard', x: pos.x, y: pos.y });
      return;
    }
    case 'boatFlip': {
      if (!dock.built) ctx.reject('there is no dock');
      if (d.flip) unseat(K.land);
      Object.assign(dock, { flip: d.flip, boat: { x: K.moor.x, y: K.moor.y, a: -Math.PI / 2 } });
      return;
    }
  }
}
