// Pomocníci testov v TypeScripte (#122, fáza 3).
// Údaje v testoch sú zámerne čiastočné – svet, uloženie či trh majú len polia, ktoré test potrebuje (kód má na
// chýbajúce polia vlastné kontroly). Typ si drží, čo test naozaj zadal; doplnenie na plný typ je jediné pretypovanie testov.
import type { GameWorld } from '../src/server/game.ts';
export { must } from '../src/shared/util.ts';

// Čiastočný objekt typu T (napr. uloženie hráča len s mincami a batohom)
export function partial<T>(v: Partial<T>): T { return v as T; }
// Čiastočný svet hry; polia navyše (napr. presence pre špecifikáciu testu) ostanú v type
export const testWorld = <T extends Partial<GameWorld>>(w: T): GameWorld & T => w as GameWorld & T;
// V testoch chyba v návrhu nesmie prejsť potichu, ak ju test nečaká
export const rethrow = (err: unknown): never => { throw err; };
