// Plochy sveta (záhrada, hory, Les na pomedzí, Les divov): políčka každej plochy, hranice, prechody a príchodové miesta.
// Čisté funkcie nad stavom sveta (room) – server ich len volá.
// room.tiles = záhrada, room.hory = hory (ice.js), room.pomedzie = Les na pomedzí (len zo semienka room.pomedzieSeed),
// room.les = Les divov (rozloženie zo semienka room.lesSeed, uložené so svetom – saveLes / loadLes)
import crypto from 'node:crypto';
import * as D from '../shared/data.ts';
import type { AreaId } from '../shared/data.ts';
import { lookup, must } from '../shared/util.ts';
import type { AreaTilesWorld, Tile } from './world.ts';

const AREA_TILES: Readonly<Partial<Record<AreaId, 'hory' | 'pomedzie' | 'les'>>> = { hory: 'hory', pomedzie: 'pomedzie', les: 'les' };
export function areaTiles(room: AreaTilesWorld, area: string): Tile[] { return room[lookup(AREA_TILES, area) || 'tiles']; }
export function newSeed(): number { return crypto.randomBytes(4).readUInt32LE(0); }

// Les na pomedzí sa nemení – rozloženie je celé zo semienka sveta, uloží sa len semienko.
export function loadPomedzie(seed: number): Tile[] { return D.buildPomedzie(seed).map(g => ({ g })); }

// Les divov sa ukladá celý (jeden znak na políčko) – rozloženie sveta ostane rovnaké, aj keď sa generátor neskôr zmení.
// Neplatné alebo chýbajúce uloženie → rozloženie zo semienka.
export const LES_CODE = D.LES_CODE;
export function saveLes(room: Pick<AreaTilesWorld, 'les'>): string { return room.les.map(t => lookup(LES_CODE, t.g) ?? '').join(''); }
export function loadLes(saved: unknown, seed: number): Tile[] { return (D.decodeLes(saved) || D.buildLes(seed)).map(g => ({ g })); }

// Je políčko (x, y) na ploche?
export function inside(area: string, x: number, y: number): boolean { const { w, h } = D.areaSize(area); return x >= 0 && y >= 0 && x < w && y < h; }
// Poloha hráča vždy vnútri plochy (kúsok od okraja) – z mriežky sa vyjsť nedá
export function clampPos(area: string, x: number, y: number): { x: number; y: number } {
  const { w, h } = D.areaSize(area);
  return { x: Math.max(0.2, Math.min(w - 0.2, x)), y: Math.max(0.2, Math.min(h - 0.2, y)) };
}

// Na ktorom prechode stojí hráč: vráti cieľovú plochu, alebo null.
export function gateTarget(tiles: readonly Tile[], area: string, x: number, y: number): AreaId | null {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (!inside(area, tx, ty)) return null;
  if (must(tiles[ty * D.areaSize(area).w + tx]).g !== 'gate') return null;
  const g = D.gateAt(area, tx, ty);
  return g ? g.to : null;
}
