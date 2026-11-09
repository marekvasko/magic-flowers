// Hra nad enginom (#122, fáza 3): svet v pamäti, výrezy návrhov, správy z návrhov a typ návrhu.
// Engine (engine.ts) je všeobecný; tu sa dosadí, čo je herný svet, prítomnosť a správa.
import type { AreaId } from '../shared/data.ts';
import type { ServerMessage } from '../shared/protocol.ts';
import type { Contracts, Dielna, Icehouse, Inventory, Market, MarketAccount, MarketOrder, PlayerKey, PlayerSave, SaveFile, Weather, Webs, WorldMode } from '../shared/save.ts';
import type { Ctx, EngineWorld, Keys, PeriodicDef, Proposer, Slices, Spec } from './engine.ts';
import type { Scav } from './scavenge.ts';
import type { AreaTilesWorld, Presence, StorageSlice, Tile } from './world.ts';

// ---- Svet v pamäti ----
// Uložené polia (save.ts) plus to, čo server pri načítaní postaví (políčka plôch so zemou) a čo sa neukladá.
export interface GameWorld extends EngineWorld, AreaTilesWorld {
  mode?: WorldMode;
  weather: Weather;
  saves: Partial<Record<PlayerKey, PlayerSave>>;
  storage: Inventory;
  storageFb: SaveFile['storageFb'];
  market: Market | null;
  contracts: Contracts | null;
  fairyNight: number;
  eternal: boolean;
  scav: Scav;
  scavSalt: number;
  icehouse: Icehouse;
  dielna: Dielna;
  redeem: Inventory;
  pomedzieSeed: number;
  up: { plots: number };
  lesSeed: number;
  glacierFed: number;
  plotsUsed: number;
  maxRep: number;
  webs?: Webs | null;
  corners?: Partial<Record<AreaId, string[]>> | null;   // kúty krížiaka sú len v CornerArea, kód ich hľadá podľa plochy
  migratedFrom?: number;
  // pavúky v lese a krížiaky na ceste do kúta – neukladajú sa (Spiders.load ich po načítaní postaví)
  sps?: Partial<Record<string, SpiderState>>;
  kz?: Partial<Record<AreaId, Kriziak | null>>;
}

// ---- Pavúky (spiders.ts) ----
// Miesto na kmeni (pavúk naň vylezie): bod pri kmeni a smer od kmeňa (nx, ny)
export interface TreeSpot { x: number; y: number; nx: number; ny: number }
// Čo sa hýbe po lese či záhrade: poloha, smer pohľadu, či sa práve hýbe
export interface Mover { x: number; y: number; a: number; moving: boolean }
export type SpiderStage = 'home' | 'walk' | 'pause' | 'return' | 'search' | 'totree' | 'guard' | 'alert' | 'chase';
// Pavúk v Lese divov (vlčiak 'v' alebo stará pradlena 'p'): nora (hx, hy), stav, cesta po políčkach (pi = koľko prešiel),
// koho naháňa (tgt), na kmeni výška z a miesto tr, pri ktorej pavučine čaká (web), kedy chce znova konať (next, null = spí)
export interface SpiderState extends Mover {
  id: string;
  k: 'v' | 'p';
  o: number;
  hx: number;
  hy: number;
  st: SpiderStage;
  until: number;
  cool: number;
  scared: number;
  path: number[] | null;
  pi?: number;
  tgt: PlayerKey | null;
  z: number;
  tr: TreeSpot | null;
  web: number | null;
  up: boolean;
  next: number | null;
  gz?: number;
  repath?: number;
  seen?: number;
  border?: number;
  fast?: boolean;
  goal?: number;
}
// Krížiak na ceste do kúta: cesta po políčkach plochy širokej w, kút (spot), stromy okolo cesty [cx, cz, r]; pri úteku
// smer (fx, fy) a strom (tree), na strome výška z
export interface Kriziak extends Mover {
  id: string;
  k: 'k';
  path: number[];
  w: number;
  spot: string;
  trees: [number, number, number][];
  st: 'go' | 'pause' | 'flee' | 'climb';
  until: number;
  left: number;
  next: number;
  fx?: number;
  fy?: number;
  tree?: TreeSpot | null;
  tr?: TreeSpot | null;
  z?: number;
  up?: boolean;
}

// ---- Správy z návrhov ----
// Pokyny len pre server (notify v server.ts), klient ich nedostane: pripojenie hotové, prechod do inej plochy,
// obnov batoh (me), hľadanie v tráve a ťahanie hodvábu začalo / skončilo
export type Directive =
  | { t: 'joined' }
  | { t: 'travel'; from: AreaId; area: AreaId }
  | { t: 'me' }
  | { t: 'scavStart'; i: number; n: string; seeds: boolean }
  | { t: 'scavDone' }
  | { t: 'pullStart'; id: number; n: string }
  | { t: 'pullDone' };
// Adresát: kľúč hráča, E.ALL = všetkým, E.area(plocha) = hráčom na ploche
export type To = PlayerKey | { readonly all: true } | { readonly area: AreaId };
export type Msg = { to: To } & (ServerMessage | Directive);

// ---- Výrezy ----
// Výrezy pomenované podľa vlastnosti sveta (bez dvojbodky): typované vlastnosti. Návrh smie siahnuť len na výrez,
// ktorý deklaroval (inak je undefined a siahnutie zlyhá nahlas) – preto nie sú voliteľné.
export interface GameSlices extends Slices {
  weather: Weather;
  contracts: Contracts;
  icehouse: Icehouse;
  dielna: Dielna;
  redeem?: Inventory;   // join ho deklaruje, len keď je čo odovzdať
  scav: Scav;
  scavSalt: number;
  up: { plots: number };
  plotsUsed: number;
  maxRep: number;
  eternal: boolean;
  fairyNight: number;
  glacierFed: number;
  lesSeed: number;
  daySeconds: number;
  webs: Webs;
  corners: Partial<Record<AreaId, string[]>>;
  storage: StorageSlice;
}
// Poloha hráča v uložení (výrez pos:<kľúč>)
export type PosSlice = Pick<PlayerSave, 'x' | 'y'> & Partial<Pick<PlayerSave, 'area' | 'lastTick'>>;
// Typ výrezu podľa kľúča s dvojbodkou (kľúče sú rovnaké ako v denníku – pozri engine.ts sliceOf)
export type KeyedSlice<K extends string> =
  K extends 'save:*' ? Partial<Record<PlayerKey, PlayerSave>>
  : K extends `save:${string}` ? PlayerSave | undefined
  : K extends `pos:${string}` ? PosSlice | undefined
  : K extends `tile:${string}:*` ? Tile[]
  : K extends `tile:${string}:${number}` ? Tile | undefined   // index mimo plochy → výrez bez hodnoty
  : K extends 'market:order:*' ? NonNullable<Market['book']>['orders']
  : K extends 'market:account:*' ? NonNullable<Market['book']>['accounts']
  : K extends 'market:trades:*' ? NonNullable<Market['book']>['trades']
  : K extends `market:order:${string}` ? MarketOrder | undefined
  : K extends `market:account:${string}` ? MarketAccount
  : K extends `market:trades:${string}` ? { tick: number; text: string }[] | undefined
  : K extends 'market:*' ? Market
  : K extends 'market:seed_*' ? Market['seeds']
  : K extends 'market:fl_*' ? Market['flowers']
  : K extends 'market:festival' ? Market['festival']
  : K extends 'market:news' ? Market['news']
  : K extends 'market:compost' ? Market['compost']
  : K extends `market:seed_${string}` ? NonNullable<Market['seeds'][keyof Market['seeds']]> | undefined
  : K extends `market:fl_${string}` ? NonNullable<Market['flowers'][keyof Market['flowers']]> | undefined
  : K extends 'spider:*' ? Partial<Record<string, SpiderState>>
  : K extends `spider:${string}` ? SpiderState | undefined
  : K extends `kz:${string}` ? Kriziak | null | undefined
  : never;
// Výrez s dvojbodkou v kľúči (save:ana, tile:garden:12, market:fl_mak…) s typom podľa kľúča.
// Jediné miesto, kde sa hodnota výrezu (JSON) prevedie na herný typ – tvar zaručuje kľúč (engine.ts sliceOf).
export function sl<K extends string>(s: Slices, key: K): KeyedSlice<K> { return s[key] as KeyedSlice<K>; }
// Výrez, ktorý návrh deklaruje len niekedy (napr. 'spider:*' pri príchode do lesa): undefined, keď ho nedeklaroval
export function maybe<K extends string>(s: Slices, key: K): KeyedSlice<K> | undefined { return s[key] as KeyedSlice<K> | undefined; }
// Zápis výrezu s dvojbodkou (keď ho návrh nahradí celý, nemení ho na mieste)
export function put<K extends string>(s: Slices, key: K, v: KeyedSlice<K>): void { s[key] = v; }

// Svety v testoch (a pri ladení) nemajú všetky polia – kľúče návrhov (keys) ich čítajú cez tieto pomocné funkcie,
// takže chýbajúce uloženia, dar Dielne či políčka záhrady sa správajú ako prázdne (ako predtým v JS)
/* eslint-disable @typescript-eslint/no-unnecessary-condition -- čiastočné svety v testoch; na serveri sú polia vždy */
export const savesOf = (w: Pick<GameWorld, 'saves'>): GameWorld['saves'] => w.saves || {};
export const redeemOf = (w: Pick<GameWorld, 'redeem'>): Inventory => w.redeem || {};
export const gardenOf = (w: Pick<GameWorld, 'tiles'>): Tile[] => w.tiles || [];
/* eslint-enable @typescript-eslint/no-unnecessary-condition -- koniec čiastočných svetov */

// ---- Návrhy ----
export type GameCtx = Ctx<Presence, Msg>;
export type GameProposer<D> = Proposer<D, GameWorld, Presence, Msg, GameSlices>;
export type GamePeriodic = PeriodicDef<GameWorld>;
export type GameSpec = Spec<GameWorld, Presence, Msg>;
export type { Keys };
