// Cheaty z ladiacej stránky (#153): mince, reputácia, predmety (batoh, sklad), ľad v ľadovni, záhony a rastliny, zem
// (objekty z generátora) na hocijakom políčku, budovy, skok v čase a rýchlosť času. Úpravy sveta sú vstupom enginu 'cheat' (bez hráča): idú do denníka, ukáže ich záložka Engine a E.replay ich
// zopakuje. Hráčom sa nič neoznámi – zmenu uvidia len v batohu, sklade či na mape.
// Každá požiadavka (POST /api/debug/cheat) potrebuje tajný kľúč z prostredia (DEBUG_CHEATS_KEY, v nasadení z tajomstva
// GitHubu); bez nastaveného kľúča cheaty nejdú vôbec. Kľúč sa porovnáva v konštantnom čase a nikdy sa nezapíše do logu.
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as D from '../shared/data.ts';
import type { AreaId, Ground, ItemId, SpeciesId } from '../shared/data.ts';
import type { LotFor, PlayerKey, PlayerSave, Plant } from '../shared/save.ts';
import * as Obj from '../shared/objects.ts';
import { SPEEDS, isPlaceable, PLANT_STAGES } from '../shared/cheats.ts';
import type { PlantStage } from '../shared/cheats.ts';
import { isRecord } from '../shared/util.ts';
import type { JsonRecord } from '../shared/util.ts';
import * as I from './items.ts';
import * as Ice from './ice.ts';
import * as Econ from './economy.ts';
import * as Vehicles from './vehicles.ts';
import type { VehicleCheat } from './vehicles.ts';
import * as Dock from './dock.ts';
import type { DockCheat } from './dock.ts';
import * as Transport from './transport.ts';
import type { TransportCheat } from './transport.ts';
import * as Dielna from './dielna.ts';
import { ROOM_RE } from './debug.ts';
import { sl } from './game.ts';
import type { GameCtx, GameProposer, GameSlices } from './game.ts';
import type { Container, Tile } from './world.ts';

// Zmena čísla: pridať (aj záporné) alebo nastaviť
interface Amount { n: number; set: boolean }
// Vstup 'cheat': key = kľúč hráča; pri predmete key null = spoločný sklad
export type CheatData =
  | ({ op: 'coins'; key: PlayerKey } & Amount)
  | ({ op: 'rep'; key: PlayerKey } & Amount)
  | ({ op: 'item'; key: PlayerKey | null; id: ItemId } & Amount)
  | ({ op: 'ice' } & Amount)
  | ({ op: 'vehicle' } & VehicleCheat)   // fúrik a sane (#158): kúpiť, odstrániť, premiestniť, náklad, pustiť
  | TransportCheat // doprava (#161): všetko pustiť, posádku na breh, loďku k mólu
  | DockCheat // mólo a loďka (#160): postaviť / zbúrať, loďku inam, hráča do loďky (z nej), prevrátiť na zimu
  | { op: 'plot'; is: number[]; plot: PlotSpec | null }        // záhony na políčkach záhrady (null = zarovnať)
  | { op: 'ground'; area: AreaId; is: number[]; g: Ground | null }   // zem políčok (null = vrátiť zem z generátora)
  | { op: 'building'; what: Building; on: boolean }
  | { op: 'lot'; v: LotFor; at: { x: number; y: number } | null };   // pozemok budovy (#178): premiestniť (ľavý horný roh) alebo odstrániť (null)
// Záhon: poliaty, pohnojený, kto ho prekopal a rastlina (druh, štádium, kvalita, dni bez vody, uschnutá)
export interface PlotSpec { w: boolean; r: boolean; o: PlayerKey; plant: { sp: SpeciesId; stage: PlantStage; q: number; dry: number; dead: boolean } | null }
export type Building = 'icehouse' | 'dielna' | 'loom';
export const BUILDINGS: readonly Building[] = ['icehouse', 'dielna', 'loom'];

// Nová hodnota: celé číslo, nie záporné
export const target = (have: number, a: Amount): number => Math.max(0, Math.round(a.set ? a.n : have + a.n));
// Počet predmetu v kontajneri nastaví na want: pridá nové (vek 0) alebo odoberie najstaršie
export function setCount(c: Container, id: ItemId, want: number, tick: number): void {
  const have = c.inv[id] || 0;
  if (want > have) I.addItems(c, id, want - have, tick);
  else if (want < have) I.removeItems(c, id, have - want, tick);
}

// Rastlina zo zadania: klíčok (0 dní), rastie (polovica dní), kvitne (všetky dni, kvitne od tohto kroku – ako pri raste)
export function plantOf(p: NonNullable<PlotSpec['plant']>, tick: number): Plant {
  const days = D.SPECIES[p.sp].days, out: Plant = { sp: p.sp, prog: p.stage === 'bloom' ? days : p.stage === 'grow' ? days * 0.5 : 0, q: Math.max(0, Math.min(3, Math.round(p.q))), dry: Math.max(0, Math.round(p.dry)) };
  if (p.stage === 'bloom') out.bt = tick;
  if (p.dead) { out.d = 1; out.why = 'sucho'; }
  return out;
}
// Pôda na políčkach pozemku budovy sa zarovná (ako by ju hráč musel zarovnať pred stavbou); vráti, koľko záhonov zmizlo
function clearLot(tiles: readonly Tile[], idx: readonly number[]): number {
  let n = 0;
  for (const i of idx) { const t = tiles[i]; if (t && t.s) { t.s = null; n++; } }
  return n;
}
// Zmena jedného políčka: null = zmenené, inak prečo nie
type TileChange = (i: number) => string | null;
function each(is: readonly number[], fn: TileChange, ctx: GameCtx): void {
  let first: string | null = null, ok = 0;
  for (const i of is) { const why = fn(i); if (why === null) ok++; else first ??= why; }
  if (!ok) ctx.reject(first || 'nothing to change');
}
function plotAt(s: GameSlices, i: number, plot: PlotSpec | null, tick: number): string | null {
  const t = sl(s, `tile:garden:${i}`);
  if (!t) return 'no such tile';
  if (!plot) { if (t.s) { t.s = null; s.plotsUsed = Math.max(0, s.plotsUsed - 1); } return null; }
  const k = t.g !== 'ring' ? D.TILLABLE[t.g] : undefined;
  if (!k) return `${t.g} cannot be tilled`;
  if (!t.s) s.plotsUsed++; // cheat nehľadí na spoločné povolenie záhrady
  t.s = { k, w: plot.w ? 1 : 0, r: plot.r ? 1 : 0, p: plot.plant ? plantOf(plot.plant, tick) : null, o: plot.o };
  return null;
}
function groundAt(s: GameSlices, areaId: AreaId, i: number, to: Ground | null): string | null {
  const t = sl(s, `tile:${areaId}:${i}`);
  if (!t) return 'no such tile';
  if (areaId === 'garden' && D.DOCK.tiles.some(p => p.y * D.W + p.x === i)) return 'the dock tiles cannot be changed'; // mólo (#160) sa stavia na vodu
  const area = s.ground[areaId] ??= {}, was = area[String(i)]?.was ?? t.g, kind: string = was;
  if (!isPlaceable(kind)) { if (!Object.keys(area).length) delete s.ground[areaId]; return `${kind} cannot be changed`; }
  const g = to ?? was;
  if (g === was) delete area[String(i)]; else area[String(i)] = { g, was };
  if (!Object.keys(area).length) delete s.ground[areaId];
  t.g = g;
  if (g !== 'water') delete t.cut;
  const k = D.TILLABLE[g];
  if (areaId === 'garden' && t.s) { if (k) t.s.k = k; else { t.s = null; s.plotsUsed = Math.max(0, s.plotsUsed - 1); } } // záhon zmizne pod objektom, inak má pôdu novej zeme
  return null;
}
// Pozemok budovy v (#178) na nové miesto (at = ľavý horný roh) alebo preč (null). Len kým budova nestojí – postavená
// budova je tam, kde jej pozemok. Hráči pozemky nepresúvajú (neskôr plánovač, #156).
function lotCheat(s: GameSlices, v: LotFor, at: { x: number; y: number } | null, ctx: GameCtx): void {
  if (v === 'icehouse' ? s.icehouse.built : s.dielna.built) ctx.reject('the building stands on its lot; tear it down first');
  const tiles = sl(s, 'tile:garden:*'), objects = s.objects, was = Obj.lotOf(objects, v);
  if (at) {
    const changed = new Set(Object.keys(s.ground.garden ?? {}).map(Number));
    const why = Obj.lotPlaceError(i => tiles[i], objects, v, at.x, at.y, changed);
    if (why) ctx.reject(why);
  } else if (!was) ctx.reject('the building has no lot');
  for (const i of Obj.rectIdx(was && Obj.rectAt(was.x, was.y))) { const t = tiles[i]; if (t && t.g === 'lot') t.g = 'grass'; } // pozemok stál len na tráve
  if (!at) objects.list = objects.list.filter(o => o !== was);
  else if (was) { was.x = at.x; was.y = at.y; }
  else objects.list.push({ id: objects.nid++, area: 'garden', x: at.x, y: at.y, kind: 'lot', v });
  Obj.applyLot(tiles, objects, v, false);
}
const saveOf = (s: GameSlices, key: PlayerKey, ctx: GameCtx): PlayerSave => sl(s, `save:${key}`) || ctx.reject('no such player');
export const PROPOSERS: { cheat: GameProposer<CheatData> } = {
  cheat: {
    keys: (d, w) => {
      switch (d.op) {
        case 'coins': return { writes: [`save:${d.key}`] };
        case 'rep': return { writes: ['save:*', 'maxRep'] }; // najvyššia reputácia záhrady sa prepočíta zo všetkých hráčov
        case 'item': return d.key === null ? { writes: ['storage'], reads: ['icehouse'] } : { writes: [`save:${d.key}`] };
        case 'ice': return { writes: ['icehouse', 'storage'] };
        case 'vehicle': return Vehicles.cheatKeys();
        case 'dock': case 'boat': case 'seat': case 'boatFlip': return Dock.cheatKeys(d, w);
        case 'transport': return Transport.cheatKeys(w);
        case 'plot': return { writes: [...d.is.map(i => `tile:garden:${i}`), 'plotsUsed'] };
        case 'ground': return { writes: [...d.is.map(i => `tile:${d.area}:${i}`), 'ground', ...(d.area === 'garden' ? ['plotsUsed'] : [])] };
        case 'building': return { writes: ['tile:garden:*', 'icehouse', 'storage', 'dielna', 'plotsUsed'], reads: ['objects'] };
        case 'lot': return { writes: ['tile:garden:*', 'objects'], reads: ['icehouse', 'dielna', 'ground'] };
      }
    },
    run(s, d, ctx) {
      switch (d.op) {
        case 'coins': { const sv = saveOf(s, d.key, ctx); sv.coins = target(sv.coins, d); return; }
        case 'rep': {
          const saves = sl(s, 'save:*'), sv = saves[d.key] || ctx.reject('no such player');
          sv.rep = target(sv.rep || 0, d);
          s.maxRep = Econ.maxRepOf(saves);
          return;
        }
        case 'item': {
          const c = d.key === null ? I.storageC(s.storage, s.icehouse) : I.playerC(saveOf(s, d.key, ctx));
          setCount(c, d.id, target(c.inv[d.id] || 0, d), ctx.tick);
          return;
        }
        case 'ice': Ice.setIce(s.icehouse, s.storage, ctx.tick, target(s.icehouse.ice, d)); return;
        case 'vehicle': Vehicles.cheatRun(s, d, ctx); return;
        case 'dock': case 'boat': case 'seat': case 'boatFlip': Dock.cheatRun(s, d, ctx); return;
        case 'transport': Transport.cheatRun(s, ctx); return;
        // Viac políčok naraz: políčko, ktoré sa zmeniť nedá (budova, netillable…), sa preskočí; zlyhá, len keď nejde žiadne
        case 'plot': { each(d.is, i => plotAt(s, i, d.plot, ctx.tick), ctx); return; }
        case 'ground': { each(d.is, i => groundAt(s, d.area, i, d.g), ctx); return; }
        case 'building': {
          const tiles = sl(s, 'tile:garden:*'), dl = s.dielna;
          if (d.on && !Obj.lotOf(s.objects, d.what === 'icehouse' ? 'icehouse' : 'dielna')) ctx.reject('the building has no lot; place one first'); // krosná stavajú aj Dielňu
          if (d.what === 'icehouse') {
            if (d.on && !s.icehouse.built) { s.plotsUsed = Math.max(0, s.plotsUsed - clearLot(tiles, Ice.lotIdx(s.objects))); s.icehouse.built = true; s.icehouse.ice = 0; s.icehouse.bl = 0; }
            if (!d.on && s.icehouse.built) { Ice.setIce(s.icehouse, s.storage, ctx.tick, 0); s.icehouse.built = false; s.icehouse.bl = 0; }
            Ice.applyIcehouse(s.icehouse, tiles, s.objects);
            return;
          }
          if (d.on && !dl.built) { s.plotsUsed = Math.max(0, s.plotsUsed - clearLot(tiles, Dielna.lotIdx(s.objects))); dl.built = true; } // krosná potrebujú Dielňu
          const stopLoom = (): void => { if (dl.job) ctx.cancel(`loomDone:${dl.job.key}`); dl.job = null; dl.loom = false; };
          if (d.what === 'loom') { if (d.on) dl.loom = true; else stopLoom(); }
          else if (!d.on && dl.built) { stopLoom(); dl.built = false; dl.ready = {}; }
          Dielna.applyDielna(dl, tiles, s.objects);
          return;
        }
        case 'lot': lotCheat(s, d.v, d.at, ctx); return;
      }
    }
  }
};

// ---- Požiadavky z ladiacej stránky ----
export { SPEEDS };
const sha = (s: string): Buffer => crypto.createHash('sha256').update(s).digest();
// Zhoduje sa poslaný kľúč s tajomstvom? Bez tajomstva nikdy.
export function keyOk(given: string | undefined, secret: string | undefined): boolean {
  if (!secret || !given) return false;
  return crypto.timingSafeEqual(sha(given), sha(secret));
}

// Svet, ako ho cheaty vidia (server: Room)
export interface CheatRoom {
  id: string;
  tick: number;
  saves: Partial<Record<PlayerKey, PlayerSave>>;
  players: Map<number, { key: PlayerKey; name: string }>;
}
// Čo cheatom dá server: svet podľa mena (aj zo súboru; null = taký nie je), vykonanie vstupu, skok, rýchlosť a stav
export interface CheatHost<R extends CheatRoom> {
  room: (id: string) => R | null;
  apply: (room: R, data: CheatData) => string | null;           // null = vykonané, inak dôvod odmietnutia
  jump: (room: R, until: number | null) => void;                 // null = zastaviť prebiehajúci skok
  speed: (room: R, x: number) => void;
  status: (room: R) => { tick: number; speed: number; jump: number | null };
  keyId: (key: PlayerKey) => string;
}
// Chyba v požiadavke: kód odpovede a text
class Bad extends Error { readonly code: number; constructor(code: number, msg: string) { super(msg); this.code = code; } }
const num = (v: unknown, what: string): number => { const n = Number(v); if (typeof v !== 'number' && typeof v !== 'string' || !Number.isFinite(n)) throw new Bad(400, 'bad ' + what); return n; };
const amount = (b: JsonRecord): Amount => ({ n: num(b['n'], 'n'), set: b['set'] === true });

// Hráč podľa odtlačku (p-…, ukazuje ho ladiaca stránka) alebo mena pripojeného hráča → kľúč
export function playerKey(room: CheatRoom, who: unknown, keyId: (k: PlayerKey) => string): PlayerKey {
  if (typeof who !== 'string' || !who) throw new Bad(400, 'missing player');
  for (const k of Object.keys(room.saves)) if (keyId(k) === who) return k;
  for (const p of room.players.values()) if (p.name === who && room.saves[p.key]) return p.key;
  throw new Bad(404, 'no such player: ' + who);
}
// Indexy políčok plochy: číslo alebo zoznam (x, y sa na index prevedú na stránke); najviac celá plocha, bez opakovaní
function tileIndexes(area: AreaId, v: unknown): number[] {
  const { w, h } = D.areaSize(area), list: unknown[] = Array.isArray(v) ? v : [v];
  if (!list.length || list.length > w * h) throw new Bad(400, 'bad tile list');
  const out = new Set<number>();
  for (const x of list) {
    const i = num(x, 'tile');
    if (!Number.isInteger(i) || i < 0 || i >= w * h) throw new Bad(400, 'tile outside the area');
    out.add(i);
  }
  return [...out];
}
// Záhon z tela požiadavky: { w, r, owner?, sp?, stage?, q?, dry?, dead? } (bez sp = prázdny záhon); vlastník = hráč
// podľa odtlačku, inak prvý hráč sveta
function plotSpec(room: CheatRoom, b: JsonRecord, keyId: (k: PlayerKey) => string): PlotSpec {
  const first = Object.keys(room.saves)[0];
  const o = b['owner'] != null && b['owner'] !== '' ? playerKey(room, b['owner'], keyId) : first;
  if (o === undefined) throw new Bad(409, 'the room has no players to own the plot');
  const sp = b['sp'];
  let plant: PlotSpec['plant'] = null;
  if (sp != null && sp !== '') {
    if (typeof sp !== 'string' || !D.isSpeciesId(sp)) throw new Bad(400, 'unknown species');
    const stage = PLANT_STAGES.find(x => x === b['stage']) ?? 'seed';
    plant = { sp, stage, q: b['q'] == null ? 3 : num(b['q'], 'quality'), dry: b['dry'] == null ? 0 : num(b['dry'], 'dry days'), dead: b['dead'] === true };
  }
  return { w: b['w'] === true, r: b['r'] === true, o, plant };
}
// Telo požiadavky → vstup enginu (null = nejde o úpravu sveta: skok, rýchlosť, stav)
export function parseCheat(room: CheatRoom, b: JsonRecord, keyId: (k: PlayerKey) => string): CheatData | null {
  switch (b['op']) {
    case 'coins': case 'rep': return { op: b['op'], key: playerKey(room, b['player'], keyId), ...amount(b) };
    case 'item': {
      const id = b['id'];
      if (typeof id !== 'string' || !D.isItemId(id)) throw new Bad(400, 'unknown item');
      return { op: 'item', key: b['player'] === 'storage' ? null : playerKey(room, b['player'], keyId), id, ...amount(b) };
    }
    case 'ice': return { op: 'ice', ...amount(b) };
    case 'vehicle': { const v = Vehicles.parseCheat(b); if (typeof v === 'string') throw new Bad(400, v); return { op: 'vehicle', ...v }; }
    case 'dock': return { op: 'dock', built: b['built'] === true };
    case 'boat': return { op: 'boat', x: num(b['x'], 'x'), y: num(b['y'], 'y') };
    case 'seat': return { op: 'seat', key: playerKey(room, b['player'], keyId), on: b['on'] !== false };
    case 'boatFlip': return { op: 'boatFlip', flip: b['flip'] === true };
    case 'transport': if (b['act'] !== 'reset') throw new Bad(400, 'unknown transport action'); return { op: 'transport', act: 'reset' };
    case 'plot': return { op: 'plot', is: tileIndexes('garden', b['i']), plot: b['till'] === false ? null : plotSpec(room, b, keyId) };
    case 'ground': {
      const area = D.AREAS.find(a => a === b['area']), g = b['g'];
      if (!area) throw new Bad(400, 'unknown area');
      if (g !== null && (typeof g !== 'string' || !isPlaceable(g))) throw new Bad(400, 'this ground cannot be placed');
      return { op: 'ground', area, is: tileIndexes(area, b['i']), g };
    }
    case 'building': {
      const what = BUILDINGS.find(x => x === b['what']);
      if (!what) throw new Bad(400, 'unknown building');
      return { op: 'building', what, on: b['on'] === true };
    }
    case 'lot': {
      const v = Obj.LOT_FOR.find(x => x === b['v']);
      if (!v) throw new Bad(400, 'unknown building');
      return { op: 'lot', v, at: b['remove'] === true ? null : { x: num(b['x'], 'x'), y: num(b['y'], 'y') } };
    }
    case 'jump': case 'jumpStop': case 'speed': case 'status': return null;
    default: throw new Bad(400, 'unknown op');
  }
}

const BODY_MAX = 16 * 1024;
type Res = Pick<ServerResponse, 'writeHead' | 'end' | 'headersSent'>;
function json(res: Res, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.end(JSON.stringify(obj));
}
// POST /api/debug/cheat s hlavičkou X-Cheat-Key a telom JSON { room, op, … }; odpoveď je stav sveta (krok, rýchlosť, skok).
// Vráti true, ak požiadavku vybavil.
export function http<R extends CheatRoom>(secret: string | undefined, host: CheatHost<R>): (req: IncomingMessage, res: Res) => boolean {
  return (req, res) => {
    if ((req.url || '').split('?')[0] !== '/api/debug/cheat') return false;
    const refuse = (code: number, error: string): true => { req.resume(); json(res, code, { error }); return true; }; // telo sa zahodí
    if (!secret) return refuse(404, 'cheats are disabled (no DEBUG_CHEATS_KEY on the server)');
    if (req.method !== 'POST') return refuse(405, 'POST only');
    const given = req.headers['x-cheat-key'];
    if (!keyOk(typeof given === 'string' ? given : undefined, secret)) return refuse(403, 'wrong cheat key');
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size <= BODY_MAX) chunks.push(c); });
    req.on('end', () => {
      try {
        if (size > BODY_MAX) throw new Bad(413, 'body too large');
        let b: unknown;
        try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Bad(400, 'bad JSON'); }
        if (!isRecord(b) || Array.isArray(b)) throw new Bad(400, 'body must be an object');
        json(res, 200, run(host, b));
      } catch (e) {
        if (e instanceof Bad) { json(res, e.code, { error: e.message }); return; }
        console.error('[cheat]', e);
        if (!res.headersSent) json(res, 500, { error: 'internal error' });
      }
    });
    return true;
  };
}
function run<R extends CheatRoom>(host: CheatHost<R>, b: JsonRecord): ReturnType<CheatHost<R>['status']> {
  const id = b['room'];
  if (typeof id !== 'string' || !ROOM_RE.test(id)) throw new Bad(400, 'bad room id');
  const room = host.room(id);
  if (!room) throw new Bad(404, 'no such room');
  const data = parseCheat(room, b, host.keyId);
  if (data) { const why = host.apply(room, data); if (why) throw new Bad(409, why); }
  else if (b['op'] === 'jump') {
    const until = Math.floor(num(b['tick'], 'tick'));
    if (until <= room.tick) throw new Bad(400, 'the target time must be in the future');
    host.jump(room, until);
  }
  else if (b['op'] === 'jumpStop') host.jump(room, null);
  else if (b['op'] === 'speed') {
    const x = num(b['x'], 'speed');
    if (!SPEEDS.includes(x)) throw new Bad(400, 'speed must be one of ' + SPEEDS.join(', '));
    host.speed(room, x);
  }
  return host.status(room);
}
