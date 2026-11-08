// Typy pre src/shared/webs.js – len to, čo z neho používa server (spiders.ts). webs.js sa prepíše do TypeScriptu
// vo fáze 5 (#122) spolu s klientom; dovtedy tento súbor opisuje jeho rozhranie (UMD, v Node je to module.exports).
import type { Ground } from './data.ts';

// Nora vlčiaka (k 'v') alebo čistina pradleny ('p'): index a poloha políčka
export interface Home { k: 'v' | 'p'; i: number; x: number; y: number }
// Miesto, kde môže visieť pavučina majiteľa o: n políčok od (x, y) pozdĺž osi ax
export interface WebCand { x: number; y: number; ax: 0 | 1; n: number; o: number; tiles: number[] }
// Rozbor Lesa divov: majiteľ každého políčka (-1 nikto), nory, miesta na pavučiny, políčka bez pavúkov, vzdialenosť od vstupu
export interface Analysis { owner: Int16Array; homes: Home[]; cands: WebCand[][]; nobody: Uint8Array; ent: Int16Array }
// Kút na pavučinu krížiaka: kľúč, políčko, smery dvoch stien a počet stien (2 = koniec steny, 3 = vnútorný roh)
export interface CornerSpot { k: string; i: number; x: number; y: number; dx: number; dy: number; ex: number; ey: number; faces: 2 | 3 }
// Opora pavučiny na políčku: druh zeme, stred kmeňa, polomer a výška
export interface Anchor { g: Ground; cx: number; cz: number; r: number; top: number }

// Funkcie ako vlastnosti (nie metódy): nepoužívajú this, server si ich berie aj samostatne (const { bfs } = Webs)
interface Webs {
  analyze: (les: readonly { g: Ground }[], seed: number) => Analysis;
  cornerSpots: (tiles: readonly { g: Ground }[], w: number, h: number) => CornerSpot[];
  bfs: (w: number, h: number, starts: readonly number[], ok: (n: number) => boolean, max?: number) => { dist: Int16Array; src: Int16Array };
  anchorAt: (tiles: readonly { g: Ground }[], w: number, h: number, x: number, y: number) => Anchor | null;
}
declare const Webs: Webs;
export default Webs;
