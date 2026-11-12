// Doprava (#161): prepojenie fúrika a saní (#158), móla a loďky (#160) a vodných kvetov (#38).
// Pravidlá medzi nimi žijú v moduloch jednotlivých častí (vehicles.ts, dock.ts, actions.ts); tu je spoločný cheat
// ladiacej stránky (všetko pustiť a loďku vrátiť k mólu) a prehľad dopravy pre /debug → Transport (debug-api/transport.ts).
import * as D from '../shared/data.ts';
import type { AreaId } from '../shared/data.ts';
import type { Dock as DockState, PlayerKey, Vehicle, VehicleId } from '../shared/save.ts';
import { isRecord } from '../shared/util.ts';
import * as V from '../shared/vehicles.ts';
import type { Keys } from './engine.ts';
import * as Dock from './dock.ts';
import { dockOf, sl } from './game.ts';
import type { GameCtx, GameSlices, GameWorld } from './game.ts';

// ---------- Cheat 'transport' ----------
// reset: kto tlačí fúrik či ťahá sane, ho pustí, spolujazdci vystúpia (stoja tam, kde vozidlo), posádka loďky vystúpi
// na najbližší breh a loďka sa vráti k mólu (v zime ostane prevrátená na móle)
export type TransportCheat = { op: 'transport'; act: 'reset' };
export function cheatKeys(w: Pick<GameWorld, 'dock'>): Keys {
  const dock = dockOf(w);
  return { writes: ['vehicles', 'dock', ...(dock ? dock.seats : []).map(k => `pos:${k}`)], reads: ['tile:garden:*'] };
}
export function cheatRun(s: GameSlices, ctx: GameCtx): void {
  const vs = Object.hasOwn(s, 'vehicles') ? s.vehicles : undefined;
  if (vs) for (const id of V.VEHICLE_IDS) { vs[id].driver = null; vs[id].passenger = null; }
  const dock = s.dock;
  if (!dock.built) return;
  const tiles = sl(s, 'tile:garden:*');
  for (const key of dock.seats) {
    const pos = sl(s, `pos:${key}`);
    if (!pos) continue;
    const p = Dock.nearestLand(tiles, dock.boat.x, dock.boat.y);
    pos.x = p.x; pos.y = p.y; pos.area = 'garden';
    ctx.emit({ to: key, t: 'aboard', x: p.x, y: p.y });
  }
  dock.seats = [];
  dock.boat = { x: D.DOCK.moor.x, y: D.DOCK.moor.y, a: -Math.PI / 2 };
}

// ---------- Prehľad pre ladiacu stránku ----------
export interface TransportVehicle {
  id: VehicleId; name: string; bought: boolean; usable: boolean; inSeason: boolean; area: AreaId; x: number; y: number; a: number;
  ice: number; cap: number; driver: PlayerKey | null; passenger: PlayerKey | null;
}
export interface TransportPlayer { key: PlayerKey; area: AreaId; x: number; y: number; role: string | null }
export interface TransportView {
  tick: number; season: D.Season;
  vehicles: TransportVehicle[];
  dock: DockState & { moor: { x: number; y: number }; tiles: { x: number; y: number }[] };
  events: { key: string; type: string; at: number }[];     // ďalšie udalosti dopravy (vehSeason, boatDay)
  players: TransportPlayer[];                              // kto vezie, vesluje či sa vezie
  deep: number;                                            // políčka hlbokej vody, kam sa dá len loďkou
}
// Stav sveta (uložený alebo v pamäti, JSON) → prehľad dopravy. vehicles = už načítané vozidlá (vehicles.ts parseVehicles).
export function overview(state: { tick?: unknown; dock?: unknown; saves?: unknown; events?: unknown }, vehicles: Readonly<Record<VehicleId, Vehicle>>): TransportView {
  const tick = typeof state.tick === 'number' ? state.tick : 0, season = D.seasonOf(D.dayOfTick(tick));
  const dock = Dock.loadDock(state.dock);
  const role = (key: PlayerKey): string | null => {
    const i = dock.seats.indexOf(key);
    if (i >= 0) return i === 0 ? 'rows the boat' : 'rides in the boat';
    for (const id of V.VEHICLE_IDS) {
      if (vehicles[id].driver === key) return `${id === 'sane' ? 'tows' : 'pushes'} the ${id === 'sane' ? 'sled' : 'wheelbarrow'}`;
      if (vehicles[id].passenger === key) return `rides in the ${id === 'sane' ? 'sled' : 'wheelbarrow'}`;
    }
    return null;
  };
  const players: TransportPlayer[] = [];
  if (isRecord(state.saves)) for (const [key, sv] of Object.entries(state.saves)) {
    if (!isRecord(sv)) continue;
    const area = D.AREAS.find(a => a === sv['area']) ?? 'garden', x = sv['x'], y = sv['y'];
    players.push({ key, area, x: typeof x === 'number' ? x : D.SPAWN.x, y: typeof y === 'number' ? y : D.SPAWN.y, role: role(key) });
  }
  const events = (Array.isArray(state.events) ? state.events : []).flatMap(e => {
    if (!isRecord(e) || typeof e['type'] !== 'string' || typeof e['at'] !== 'number') return [];
    const key = typeof e['key'] === 'string' ? e['key'] : e['type'];
    return e['type'] === 'vehSeason' || e['type'] === 'boatDay' ? [{ key, type: e['type'], at: e['at'] }] : [];
  }).sort((a, b) => a.at - b.at);
  const tiles = D.buildMap().map(g => ({ g }));
  if (dock.built) for (const p of D.DOCK.tiles) tiles[p.y * D.W + p.x] = { g: 'dock' };
  return {
    tick, season,
    vehicles: V.VEHICLE_IDS.map(id => {
      const v = vehicles[id];
      return { id, name: V.VEHICLES[id].name, bought: v.bought, usable: v.usable, inSeason: V.inSeason(id, season), area: v.area, x: v.x, y: v.y, a: v.a, ice: v.ice, cap: V.VEHICLE_ICE, driver: v.driver, passenger: v.passenger };
    }),
    dock: { ...dock, moor: { ...D.DOCK.moor }, tiles: D.DOCK.tiles.map(p => ({ x: p.x, y: p.y })) },
    events, players, deep: D.deepWater(tiles).length
  };
}
