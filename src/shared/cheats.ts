// Cheaty z ladiacej stránky (#153) – čo je spoločné pre server (src/server/cheats.ts) a záložku Cheats.
import type { Ground } from './data.ts';

// Rýchlosti času, ktoré sa dajú nastaviť (len v pamäti servera – po reštarte je zase 1×)
export const SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4, 8];
// Zem, ktorú cheat smie položiť alebo nahradiť: len objekty z generátora na jednom políčku. Budovy, prechody, pozemky,
// obrie stromy (2 × 2), ľadovec a skalné steny ostávajú, ako ich postavil generátor či hra.
export const PLACEABLE: readonly Ground[] = ['grass', 'meadow', 'path', 'sand', 'water', 'rock', 'boulder', 'tree', 'spruce', 'bush', 'fern',
  'forest', 'shroom', 'moss', 'roots', 'fungi', 'log', 'alp', 'snow', 'scree'];
export const isPlaceable = (g: string): g is Ground => PLACEABLE.some(x => x === g);
// Štádium rastliny pri sadení cheatom: klíčok, rastie (polovica dní), kvitne
export type PlantStage = 'seed' | 'grow' | 'bloom';
export const PLANT_STAGES: readonly PlantStage[] = ['seed', 'grow', 'bloom'];
