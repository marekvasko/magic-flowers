// Pomocníci testov v TypeScripte (#122, fáza 3).
// Údaje v testoch sú zámerne čiastočné – svet, uloženie či trh majú len polia, ktoré test potrebuje (kód má na
// chýbajúce polia vlastné kontroly). Typ si drží, čo test naozaj zadal; doplnenie na plný typ je jediné pretypovanie testov.
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type WebSocket from 'ws';
import type { ServerMessage } from '../src/shared/protocol.ts';
import type { GameWorld } from '../src/server/game.ts';
export { must } from '../src/shared/util.ts';

// Čiastočný objekt typu T (napr. uloženie hráča len s mincami a batohom)
export function partial<T>(v: Partial<T>): T { return v as T; }
// Čiastočný svet hry; polia navyše (napr. presence pre špecifikáciu testu) ostanú v type
export const testWorld = <T extends Partial<GameWorld>>(w: T): GameWorld & T => w as GameWorld & T;
// V testoch chyba v návrhu nesmie prejsť potichu, ak ju test nečaká
export const rethrow = (err: unknown): never => { throw err; };

// JSON, ktorý zapísal server (uloženie, denník): tvar zaručuje server, test ho len číta
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- tvar súboru určuje volajúci (uloženie, denník…)
export function readJson<T>(file: string): T { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
// JSON v texte (odpoveď ladiacej stránky…): tvar zaručuje server, test ho len číta
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- tvar odpovede určuje volajúci
export function parseJson<T>(text: string): T { return JSON.parse(text) as T; }
// Port, na ktorom počúva testovací server (http, net)
export function portOf(srv: { address(): AddressInfo | string | null }): number {
  const a = srv.address();
  if (!a || typeof a === 'string') throw new Error('server nepočúva na porte');
  return a.port;
}
// Správa servera z WebSocketu (text JSON) – tvar opisuje protocol.ts ServerMessage
export function parseMsg(raw: WebSocket.RawData): ServerMessage {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : Buffer.from(raw).toString('utf8');
  return JSON.parse(text) as ServerMessage;
}
// Správa servera daného typu (wait('toast', m => …) dostane zúžený typ)
export type MsgType = ServerMessage['t'];
export type MsgOf<T extends MsgType> = Extract<ServerMessage, { t: T }>;
export const isMsg = <T extends MsgType>(m: ServerMessage, t: T): m is MsgOf<T> => m.t === t;
