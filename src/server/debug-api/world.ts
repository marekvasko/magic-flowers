// Ladiaca stránka /debug, záložka World (#78): políčka jednej plochy presne tak, ako ich hra pošle hráčovi
// (základ z generátora + uložená pôda, rastliny, ľad a ľadovňa), a hráči na ploche. Len číta kópiu sveta.
//   GET /api/debug/world?room=<id>&area=<plocha>  – svet zo zoznamu
//   GET /api/debug/world?seed=<n>&area=<plocha>   – čerstvý svet len zo semienka (bez hráčov a bez uloženia)
import * as D from '../../shared/data.ts';
import type { AreaId, Look } from '../../shared/data.ts';
import type { TileView, VehicleView } from '../../shared/protocol.ts';
import type { Weather } from '../../shared/save.ts';
import * as Ice from '../ice.ts';
import * as Areas from '../areas.ts';
import * as Scav from '../scavenge.ts';
import * as Vehicles from '../vehicles.ts';
import { keyId } from '../debug.ts';
import type { DebugState, Tools } from '../debug.ts';
import type { Tile } from '../world.ts';

type TileSource = Pick<DebugState, 'tiles' | 'hory' | 'pomedzieSeed' | 'lesSeed' | 'les' | 'icehouse'>;
// Políčka plochy zo (skopírovaného) stavu sveta – rovnako ako getRoom + tilesView v server.ts
function areaTiles(state: TileSource, area: AreaId): TileView[] {
  if (area === 'hory') return Ice.loadHory(state.hory);
  if (area === 'pomedzie') return Areas.loadPomedzie(Number(state.pomedzieSeed)); // stav zo servera semienko má
  if (area === 'les') return Areas.loadLes(state.les, Number(state.lesSeed)); // uložené rozloženie, inak zo semienka
  const base = D.buildMap(), saved = state.tiles;
  const room = {
    icehouse: state.icehouse,
    tiles: base.map((g, i): Tile => {
      const sv = saved && saved.length === base.length && saved[i];
      const t: Tile = { g, s: (sv && sv.s) || null };
      if (g === 'water' && sv && sv.cut) t.cut = 1;
      return t;
    })
  };
  Ice.applyIcehouse(room.icehouse, room.tiles);
  return room.tiles.map(t => Scav.tileView(t)); // druh divej rastliny ostane skrytý ako v hre
}

export interface WorldPlayer { id: string; name: string | null; online: boolean; x: number; y: number; look: Look | null }
export interface WorldView {
  room: string | null; source?: 'memory' | 'file'; seed: number | undefined; area: AreaId; w: number; h: number; tick: number; weather: Weather;
  tiles: TileView[]; players: WorldPlayer[];
  vehicles: VehicleView[];   // fúrik a sane na ploche (#158): vodič a spolujazdec ako odtlačok kľúča (ako hráči)
}

export default function world(query: URLSearchParams, tools: Pick<Tools, 'load'>): WorldView | null {
  const area = D.AREAS.find(a => a === query.get('area')) ?? 'garden';
  const { w, h } = D.areaSize(area);
  const id = query.get('room');
  if (!id) {
    const seed = (parseInt(query.get('seed') ?? '', 10) || 0) >>> 0;
    const state: TileSource = { tiles: null, hory: null, pomedzieSeed: seed, lesSeed: seed, les: null, icehouse: { built: false, ice: 0, bl: 0 } };
    return { room: null, seed, area, w, h, tick: 0, weather: 'sun', tiles: areaTiles(state, area), players: [], vehicles: [] };
  }
  const r = tools.load(id);
  if (!r) return null;
  const st = r.state, online = new Map(r.online.map(o => [o.player, o]));
  // hráči na tejto ploche: online podľa mena, ostatní len ako posledné miesto, kde boli
  const players: WorldPlayer[] = [];
  for (const [key, sv] of Object.entries(st.saves || {})) {
    if (!sv) continue;
    const o = online.get(keyId(key)) || null;
    const pa = o ? o.area : D.AREAS.find(a => a === sv.area) ?? 'garden';
    if (pa !== area || typeof sv.x !== 'number' || typeof sv.y !== 'number') continue;
    players.push({ id: key, name: o ? o.name : null, online: !!o, x: sv.x, y: sv.y, look: sv.look || null });
  }
  return { room: r.id, source: r.source, seed: area === 'les' ? st.lesSeed : st.pomedzieSeed, area, w, h, tick: st.tick || 0, weather: st.weather || 'sun', tiles: areaTiles(st, area), players, vehicles: Vehicles.debugView(st.vehicles, area, st.tick || 0) };
}
