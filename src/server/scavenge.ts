// Hľadanie divých semienok v tráve a divé semienka, ktoré „poznajú trh“.
// Stav (len na serveri): world.scavSalt – tajné číslo, z ktorého sa odvodí, kde sú semienka (klient ho nikdy nedostane);
// world.scav = { index políčka: hodina (okno), v ktorej ho niekto prehľadal }.
// Funkcie dostávajú výrezy: tiles = políčka záhrady, scav = world.scav, salt = world.scavSalt, tick = herný čas, g = generátor náhody.
import * as D from '../shared/data.ts';
import type { Ground, Season, SpeciesId } from '../shared/data.ts';
import type { SaveFile } from '../shared/save.ts';
import type { TileView } from '../shared/protocol.ts';
import { keys, must } from '../shared/util.ts';
import type { Rng, Tile } from './world.ts';

// Prehľadané políčka: index políčka → hodina (okno), v ktorej ho niekto prehľadal (world.scav)
export type Scav = SaveFile['scav'];
const C = D.SCAVENGE;

const WILDISH: Readonly<Partial<Record<Ground, 1>>> = { forest: 1, tree: 1, shroom: 1, ring: 1 };
const TRAMPLED: Readonly<Partial<Record<Ground, 1>>> = { path: 1, house: 1, hut: 1, stall: 1, well: 1, cauldron: 1, babka: 1 };

// Hľadať sa dá len v neprekopanej tráve
export function canSearch(tile: Tile | null | undefined): boolean { return !!tile && tile.g === 'grass' && !tile.s; }

// Okolie: okraj lesa pomáha, udupaná tráva pri cestách a budovách škodí
export function tileFactor(tiles: readonly Tile[], i: number): number {
  const x = i % D.W, y = Math.floor(i / D.W);
  let wild = 0, trampled = false;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy;
    if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= D.W || ny >= D.H) continue;
    const g = must(tiles[ny * D.W + nx]).g;
    if (WILDISH[g]) wild++;
    if (TRAMPLED[g]) trampled = true;
  }
  return (1 + C.edge * Math.min(4, wild)) * (trampled ? C.trampled : 1);
}
export function timeFactor(min: number): number {
  const h = min / 60;
  for (const [a, b, k] of C.hours) if (h >= a && h < b) return k;
  return 1;
}
const windowOf = (tick: number): number => Math.floor(tick / C.window);
// Deterministický hash (políčko, hodina) → 0–1
function hash01(a: number, b: number, c: number): number {
  let h = (a ^ Math.imul(b + 1, 0x9E3779B1) ^ Math.imul(c + 1, 0x85EBCA77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7FEB352D); h = Math.imul(h ^ (h >>> 15), 0x846CA68B); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// Hustota semienok na políčku teraz (pravdepodobnosť, že tam v tejto hodine nejaké je)
export function density(tiles: readonly Tile[], tick: number, i: number): number {
  return C.density * tileFactor(tiles, i) * timeFactor(D.minOfTick(tick)) * must(C.seasons[D.seasonOf(D.dayOfTick(tick))]);
}
// Je teraz v políčku semienko? Prehľadané políčko je do konca hodiny prázdne.
export function hasSeed(salt: number, scav: Scav | null | undefined, tiles: readonly Tile[], tick: number, i: number): boolean {
  const w = windowOf(tick);
  if (scav && scav[i] === w) return false;
  return hash01(salt, i, w) < density(tiles, tick, i);
}
export function chance(salt: number, scav: Scav | null | undefined, tiles: readonly Tile[], tick: number, i: number): number { return hasSeed(salt, scav, tiles, tick, i) ? C.find : 0; }
// Políčko je prehľadané – v tejto hodine už nič nedá (aj keď sa nič nenašlo)
export function empty(scav: Scav, tick: number, i: number): void { scav[i] = windowOf(tick); }
// Hod kockou na konci hľadania (náhoda z g); vráti, či sa našlo divé semienko
export function roll(salt: number, scav: Scav, tiles: readonly Tile[], tick: number, i: number, g: Pick<Rng, 'rand'>): boolean {
  const c = chance(salt, scav, tiles, tick, i);
  empty(scav, tick, i);
  return c > 0 && g.rand() < c;
}
// Staré hodiny netreba pamätať – udrží to uloženie malé
export function prune(scav: Scav, tick: number): void {
  const w = windowOf(tick);
  for (const i in scav) if (scav[i] !== w) delete scav[i];
}

// Druhy, ktoré môžu vyrásť z divého semienka daného obdobia (bez magických a bez tých, čo rastú len na jednej pôde)
export function wildCandidates(season: Season): SpeciesId[] {
  return keys(D.SPECIES).filter(k => { const s = D.SPECIES[k]; return !s.magic && !s.strict && s.seasons.includes(season); });
}
// Druh sa vyberie raz, pri sadení: váha = výkupná cena kvetu v tej chvíli ^ C.priceExp (náhoda z g)
export function pickWild(g: Pick<Rng, 'rand'>, season: Season, priceOf: (sp: SpeciesId) => number): SpeciesId {
  const list = wildCandidates(season);
  const w = list.map(sp => Math.pow(Math.max(1, priceOf(sp)), C.priceExp));
  let r = g.rand() * w.reduce((a, b) => a + b, 0);
  for (let k = 0; k < list.length; k++) { r -= must(w[k]); if (r < 0) return must(list[k]); }
  return must(list[list.length - 1]);
}

// Klient nesmie vedieť, čo z divého semienka vyrastie, kým nevyklíči
export function tileView(t: Tile): TileView {
  const p = t.s && t.s.p;
  if (!t.s || !p || !p.wild) return t;
  return { g: t.g, s: { ...t.s, p: { ...p, sp: 'wild' } } };
}
