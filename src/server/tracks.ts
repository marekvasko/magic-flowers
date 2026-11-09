// Stopy v snehu na serveri (#159): server je jediný zdroj stôp, aby všetci hráči videli tie isté (aj ten, kto príde
// neskôr). Stopy nie sú stav sveta – nejdú cez engine ani do denníka a neukladajú sa: držia sa len v pamäti (stores,
// svet → plochy → stopy) a po reštarte servera zmiznú. Pravidlá (kde je sneh, krok, strop, miznutie) sú v shared/tracks.ts.
//  - frame(): raz za 100 ms (spolu s polohami hráčov) – stopy z potvrdených polôh hráčov a pavúkov, zasypanie snehom;
//  - view(): celý zoznam plochy (pripojenie, prechod do inej plochy, vyčistenie);
//  - clear() / demo(): ladiaca stránka (cheaty) – vyčistenie stôp a ukážkové stopy všetkých druhov.
import * as D from '../shared/data.ts';
import type { AreaId } from '../shared/data.ts';
import type { ServerMessage } from '../shared/protocol.ts';
import type { Weather } from '../shared/save.ts';
import * as T from '../shared/tracks.ts';
import type { TrackKind, TrackMark, Walker } from '../shared/tracks.ts';
import * as Areas from './areas.ts';
import type { AreaTilesWorld } from './world.ts';

// Stopy jedného sveta: zoznam na plochu (v poradí vzniku), kto kde naposledy stál, počasie pri poslednom rámci
export interface TrackStore { areas: Partial<Record<AreaId, TrackMark[]>>; walkers: Map<string, Walker>; weather: Weather | null }
// Svet, ako ho stopy potrebujú (server: Room)
export type TrackWorld = AreaTilesWorld & { id: string; tick: number; weather: Weather };
// Čo sa hýbe: id (hráč 'p<id>', pavúk 's<id>', sane 'r<id>'), druh stopy, plocha a poloha
export interface Mover { id: string; k: TrackKind; area: AreaId; x: number; y: number }
export type TracksMsg = Extract<ServerMessage, { t: 'tracks' }>;

// Stopy všetkých svetov v pamäti (id sveta → stopy); ladiaca stránka ich číta cez /api/debug/tracks
export const stores = new Map<string, TrackStore>();
export function storeOf(id: string): TrackStore {
  let s = stores.get(id);
  if (!s) { s = { areas: {}, walkers: new Map(), weather: null }; stores.set(id, s); }
  return s;
}
const listOf = (s: TrackStore, area: AreaId): TrackMark[] => (s.areas[area] ??= []);

// Celý zoznam stôp plochy (správa pre jedného hráča alebo všetkých na ploche)
export function view(id: string, area: AreaId): TracksMsg {
  return { t: 'tracks', area, full: 1, add: (storeOf(id).areas[area] || []).map(T.encode) };
}
// Počet stôp na každej ploche
export function counts(id: string): Record<AreaId, number> {
  const s = stores.get(id);
  const out: Partial<Record<AreaId, number>> = {};
  for (const a of D.AREAS) out[a] = s?.areas[a]?.length ?? 0;
  return out as Record<AreaId, number>; // každá plocha z D.AREAS
}

// Jeden rámec: zasypanie (začalo snežiť), miznutie, nové stopy z pohybov. Vráti správy pre hráčov na plochách.
// Klienti zoznam orezávajú rovnako (strop, miznutie podľa kroku) – posielajú sa len nové stopy.
export function frame(room: TrackWorld, movers: readonly Mover[]): [AreaId, TracksMsg][] {
  const s = storeOf(room.id), out: [AreaId, TracksMsg][] = [];
  // čerstvý sneh zasype všetky stopy – raz, keď začne snežiť (ráno so snehom aj cheat z ladiacej stránky)
  if (room.weather === 'snow' && s.weather !== null && s.weather !== 'snow') for (const a of clearStore(s, null)) out.push([a, view(room.id, a)]);
  s.weather = room.weather;
  for (const a of D.AREAS) { const l = s.areas[a]; if (l) T.pruneMarks(l, room.tick); }
  const season = D.seasonOf(D.dayOfTick(room.tick)), life = T.lifeFor(room.weather), added = new Map<AreaId, TrackMark[]>();
  const snow = new Map<AreaId, (x: number, y: number) => boolean>();
  const seen = new Set<string>();
  for (const m of movers) {
    seen.add(m.id);
    let at = snow.get(m.area);
    if (!at) { const { w, h } = D.areaSize(m.area); at = T.snowAt(m.area, season, Areas.areaTiles(room, m.area), w, h); snow.set(m.area, at); }
    const r = T.walk(s.walkers.get(m.id), m.k, m.area, m.x, m.y, at, room.tick, life);
    s.walkers.set(m.id, r.w);
    if (!r.marks.length) continue;
    T.addMarks(listOf(s, m.area), r.marks);
    const l = added.get(m.area);
    if (l) l.push(...r.marks); else added.set(m.area, r.marks.slice());
  }
  for (const id of [...s.walkers.keys()]) if (!seen.has(id)) s.walkers.delete(id); // odišiel, zmizol – začne sa odznova
  for (const [area, marks] of added) out.push([area, { t: 'tracks', area, add: marks.slice(-T.TRACKS.cap).map(T.encode) }]);
  return out;
}

// Vyčistí stopy plochy (null = všetkých plôch); vráti plochy, kde nejaké boli
function clearStore(s: TrackStore, area: AreaId | null): AreaId[] {
  const out: AreaId[] = [];
  for (const a of D.AREAS) {
    if (area !== null && a !== area) continue;
    const l = s.areas[a];
    if (l && l.length) { l.length = 0; out.push(a); }
  }
  return out;
}
// Ladiaca stránka: vyčistí stopy; vráti správy pre hráčov na vyčistených plochách
export function clear(id: string, area: AreaId | null): [AreaId, TracksMsg][] {
  return clearStore(storeOf(id), area).map(a => [a, view(id, a)]);
}
// Ladiaca stránka: ukážkové stopy všetkých troch druhov (šľapaje, pavúk, sane) vedľa seba od bodu (x, y) na sever –
// aj na ploche bez snehu, nech je vidieť, ako vyzerajú (sane sa na stopy napoja až v #161)
export function demo(room: TrackWorld, area: AreaId, x: number, y: number): [AreaId, TracksMsg][] {
  const { w, h } = D.areaSize(area), marks: TrackMark[] = [];
  T.TRACK_KINDS.forEach((k, i) => {
    const sx = Math.max(0.5, Math.min(w - 0.5, x + (i - 1) * 0.9));
    for (const m of T.demoTrail(k, sx, y, -Math.PI / 2, Math.round(3 / T.TRACKS.stride[k]), room.tick)) if (m.y > 0 && m.y < h) marks.push(m);
  });
  T.addMarks(listOf(storeOf(room.id), area), marks);
  return [[area, { t: 'tracks', area, add: marks.map(T.encode) }]];
}
