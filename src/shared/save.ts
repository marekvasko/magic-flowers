// Uloženie sveta (data/room-<id>.json) vo verzii SAVE_VERSION 11 – presne tak, ako ho zapíše serialize() v src/server/server.js.
// Typ opisuje existujúci formát, nemení ho (#122, fáza 2). Staršie verzie prevedie migrate() na tento tvar.
import type { SpeciesId } from './data.ts';

// Rastlina na obrobenom políčku
export interface Plant {
  sp: SpeciesId;
  prog: number;
}
