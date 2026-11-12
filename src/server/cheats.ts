// Cheaty z ladiacej stránky (#153): mince, reputácia, predmety (batoh, sklad), ľad v ľadovni, skok v čase a rýchlosť
// času. Úpravy sveta sú vstupom enginu 'cheat' (bez hráča): idú do denníka, ukáže ich záložka Engine a E.replay ich
// zopakuje. Hráčom sa nič neoznámi – zmenu uvidia len v batohu, sklade či na mape.
// Každá požiadavka (POST /api/debug/cheat) potrebuje tajný kľúč z prostredia (DEBUG_CHEATS_KEY, v nasadení z tajomstva
// GitHubu); bez nastaveného kľúča cheaty nejdú vôbec. Kľúč sa porovnáva v konštantnom čase a nikdy sa nezapíše do logu.
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as D from '../shared/data.ts';
import type { ItemId } from '../shared/data.ts';
import type { PlayerKey, PlayerSave } from '../shared/save.ts';
import { isRecord } from '../shared/util.ts';
import type { JsonRecord } from '../shared/util.ts';
import * as I from './items.ts';
import * as Ice from './ice.ts';
import * as Econ from './economy.ts';
import * as Vehicles from './vehicles.ts';
import type { VehicleCheat } from './vehicles.ts';
import * as Dock from './dock.ts';
import type { DockCheat } from './dock.ts';
import { ROOM_RE } from './debug.ts';
import { sl } from './game.ts';
import type { GameCtx, GameProposer, GameSlices } from './game.ts';
import type { Container } from './world.ts';

// Zmena čísla: pridať (aj záporné) alebo nastaviť
interface Amount { n: number; set: boolean }
// Vstup 'cheat': key = kľúč hráča; pri predmete key null = spoločný sklad
export type CheatData =
  | ({ op: 'coins'; key: PlayerKey } & Amount)
  | ({ op: 'rep'; key: PlayerKey } & Amount)
  | ({ op: 'item'; key: PlayerKey | null; id: ItemId } & Amount)
  | ({ op: 'ice' } & Amount)
  | ({ op: 'vehicle' } & VehicleCheat)   // fúrik a sane (#158): kúpiť, odstrániť, premiestniť, náklad, pustiť
  | DockCheat; // mólo a loďka (#160): postaviť / zbúrať, loďku inam, hráča do loďky (z nej), prevrátiť na zimu

// Nová hodnota: celé číslo, nie záporné
export const target = (have: number, a: Amount): number => Math.max(0, Math.round(a.set ? a.n : have + a.n));
// Počet predmetu v kontajneri nastaví na want: pridá nové (vek 0) alebo odoberie najstaršie
export function setCount(c: Container, id: ItemId, want: number, tick: number): void {
  const have = c.inv[id] || 0;
  if (want > have) I.addItems(c, id, want - have, tick);
  else if (want < have) I.removeItems(c, id, have - want, tick);
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
      }
    }
  }
};

// ---- Požiadavky z ladiacej stránky ----
// Rýchlosti času, ktoré sa dajú nastaviť (len v pamäti servera – po reštarte je zase 1×)
export const SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4, 8];
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
