// Typy herného sveta na serveri (#122, fáza 3): svet v pamäti, políčka plôch, kontajnery predmetov, prítomnosť hráčov.
// Uložený tvar sveta opisuje src/shared/save.ts; tu je to, čo z neho server pri načítaní postaví a čo k nemu patrí len za behu.
import type { AreaId, Ground } from '../shared/data.ts';
import type { Batches, Inventory, PlayerKey, PlayerSave, Soil } from '../shared/save.ts';

// Políčko ktorejkoľvek plochy: zem z generátora; v záhrade pôda (s), v horách zásoba ľadu (ice), vo vode otvor (cut).
// Jeden typ pre všetky plochy, lebo návrhy pracujú s plochou z premennej (tile:<plocha>:<i>).
export interface Tile {
  g: Ground;
  s?: Soil | null;
  ice?: number;
  cut?: 1;
}

// Kontajner predmetov (batoh hráča alebo sklad): počty, várky s vekom, rýchlosť starnutia, pri hráčovi jeho uloženie (herbár)
export interface Container {
  inv: Inventory;
  fb: Batches;
  rate: number;
  sv?: PlayerSave;
}
// Várka presúvaná medzi kontajnermi: počet a vek v krokoch
export interface MovedBatch { n: number; age: number }

// Snímka prítomnosti hráča pre návrhy (server.js presenceOf): kto je pripojený, kde stojí, čo robí.
// Staršie záznamy denníka a testy nemajú všetky polia – preto voliteľné.
export interface Presence {
  key: PlayerKey;
  name: string;
  area: AreaId;
  x: number;
  y: number;
  scav: { i: number; n: string; px: number; py: number } | null;
  emote?: string | null;
  emoteAt?: number;
  lp?: boolean;
  vx?: number;
  vy?: number;
  pull?: { id: number; n: string; px: number; py: number } | null;
}
