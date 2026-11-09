// Spoločný testovací svet pre akcie hráčov (studňa, priania, výkup semienok – #100): svet ako na serveri po načítaní,
// ana a bob stoja v záhrade pri domčeku; vstupy ako ich skladá server. Rovnaký ako makeWorld v actions.test.ts.
import * as D from '../src/shared/data.ts';
import type { ItemId } from '../src/shared/data.ts';
import type { ServerMessage } from '../src/shared/protocol.ts';
import type { Contracts, Icehouse, Market, PlayerSave } from '../src/shared/save.ts';
import type * as E from '../src/server/engine.ts';
import * as Econ from '../src/server/economy.ts';
import * as Mkt from '../src/server/market.ts';
import * as Events from '../src/server/events.ts';
import * as Actions from '../src/server/actions.ts';
import * as I from '../src/server/items.ts';
import * as Ice from '../src/server/ice.ts';
import type { GameWorld, Msg } from '../src/server/game.ts';
import type { Presence } from '../src/server/world.ts';
import { must, partial, rethrow, testWorld } from './helpers.ts';

export const TPD = D.TICKS_PER_DAY;
export type W = GameWorld & { market: Market; contracts: Contracts; presence?: Presence[] | undefined };
const ready = (w: GameWorld): w is W => !!w.market && !!w.contracts;
export function newPlayer(): PlayerSave {
  return partial<PlayerSave>({ coins: 500, water: 5, inv: { hoe: 1, can: 1 }, fb: {}, recipes: [], seen: [], vily: 0, rep: 0, up: { can: 0, composter: 1 }, area: 'garden' });
}
export function makeWorld(seed: number, tick?: number): W {
  const w = testWorld<Partial<GameWorld> & { presence?: Presence[] }>({
    tick: tick == null ? D.DAWN_TICK + 6 : tick, wall: 0, daySeconds: 1200, seed: 'svet-' + seed, step: 0, seq: 0, events: [],
    weather: 'sun', saves: {}, storage: {}, storageFb: {}, market: null, contracts: null, fairyNight: -1, eternal: false, scav: {}, scavSalt: 4242,
    icehouse: partial<Icehouse>({ built: true, ice: 0 }), up: { plots: 1 }, glacierFed: -1, plotsUsed: 0, maxRep: 0,
    tiles: D.buildMap().map(g => ({ g, s: null })), hory: Ice.loadHory(null)
  });
  Ice.applyIcehouse(w.icehouse, w.tiles);
  Econ.initEconomy(w);
  for (const key of ['ana', 'bob']) w.saves[key] = newPlayer();
  w.presence = [{ key: 'ana', name: 'Ana', area: 'garden', x: Actions.HOUSE.x, y: Actions.HOUSE.y, scav: null }, { key: 'bob', name: 'Bob', area: 'garden', x: Actions.HOUSE.x + 1, y: Actions.HOUSE.y, scav: null }];
  if (!ready(w)) throw new Error('trh a nástenka chýbajú');
  return w;
}
export const SPEC: E.Spec<W, Presence, Msg> = { proposers: { ...Events.PROPOSERS, ...Actions.PROPOSERS }, periodic: Events.PERIODIC, presence: w => w.presence, onError: rethrow };
let seq = 0;
export const act = <T extends keyof Actions.ActionInputs>(type: T, key: string, data?: Partial<Omit<Actions.ActionInputs[T], 'key'>>): E.Input => ({ type, data: Object.assign({ key }, data), id: 'a#' + String(++seq), actor: key });
export const save = (w: GameWorld, key: string): PlayerSave => must(w.saves[key]);
export function give(sv: PlayerSave, id: ItemId, n: number, tick: number): void { I.addItems(I.playerC(sv), id, n, tick); }
export const textOf = (m: Msg | ServerMessage): string => ('text' in m ? m.text : '');
export const json = (v: unknown): string => JSON.stringify(v);
// Zásoba veľkoobchodníka (#112: jeho tovar je v ponukách knihy): stiahne ponuky tovaru, nastaví zásobu a vypíše ceny znova
export function setStock(w: Pick<GameWorld, 'saves' | 'tick' | 'market'>, item: ItemId, n: number): void {
  const m = must(w.market ?? undefined), mk = Mkt.mkWorld(w, m, null), c = Mkt.npcC(must(m.books[item]).vo);
  Mkt.npcWithdrawAll(mk, 'vo', [item]);
  I.removeItems(c, item, c.inv[item] || 0, w.tick);
  I.addItems(c, item, n, w.tick);
  Mkt.requote(mk, item);
}
