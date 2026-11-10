// Uloženie sveta (data/room-<id>.json) vo verzii SAVE_VERSION 11 – presne tak, ako ho zapíše serialize() v src/server/server.ts.
// Typ opisuje existujúci formát, nemení ho (#122, fáza 2). Staršie verzie prevedie migrate() na tento tvar.
// Kľúč hráča (PlayerKey) je meno malými písmenami; v uloženiach sa ním odkazuje na hráča (saves, vlastník pôdy, zákazky…).
// test/save-v11.fixture.ts drží uloženie zo skutočného servera a prekladač ho kontroluje voči SaveFile (npm run typecheck).
import type { AreaId, Batch, FestivalId, GiverId, ItemId, Look, SpeciesId, TillKind } from './data.ts';

export type PlayerKey = string;
export type Weather = 'sun' | 'rain' | 'snow';
export type WorldMode = 'running' | 'paused';
// Počty predmetov (id → kusy) a várky s vekom (odrezané kvety a ľad; súčet várok = počet v inv)
export type Inventory = Partial<Record<ItemId, number>>;
export type Batches = Partial<Record<ItemId, Batch[]>>;

// ---- Políčka ----
// Rastlina na obrobenom políčku. prog = dni rastu (od sp.days kvitne), q = kvalita 0–3, dry = dni bez vody;
// wild = z divého semienka, d = uschla / zahynula (why = prečo), oos = dni mimo svojho obdobia,
// b = požehnaná elixírom večnej jari, bt = krok, od ktorého kvitne (null = trvalka znova rastie)
export interface Plant {
  sp: SpeciesId;
  prog: number;
  q: number;
  dry: number;
  wild?: 1;
  d?: 1;
  why?: string;
  oos?: number;
  b?: 1;
  bt?: number | null;
}
// Obrobená pôda: k = druh pôdy, w = poliata (0/1), r = pohnojená kompostom (0/1), p = rastlina, o = kto políčko prekopal
export interface Soil {
  k: TillKind;
  w: number;
  r: number;
  p: Plant | null;
  o: PlayerKey;
}
// Políčko záhrady v uložení: len pôda (zem je z generátora) a otvor vysekaný v zamrznutej vode
export interface SavedTile {
  s: Soil | null;
  cut?: 1;
}
// Políčko hôr v uložení: 0 = nič, inak zásoba ľadu (vrstvy) a otvor vo vode
export type SavedHoryTile = 0 | { ice?: number; cut?: 1 };

// ---- Hráč ----
export interface PlayerSave {
  coins: number;
  water: number;
  inv: Inventory;
  fb?: Batches;
  recipes: string[];          // objavené recepty kotlíka (kľúč = zoradené id troch kvetov)
  seen: SpeciesId[];          // herbár
  vily: number;               // do ktorého kroku trvá elixír víl (0 = nie)
  look: Look | null;
  talked: boolean;            // už sa rozprával s babkou
  rep: number;
  up: { can: number; composter: number };
  x: number;
  y: number;
  area?: AreaId;              // staršie uloženia ju nemajú (= záhrada)
  lastTick?: number;          // kedy bol hráč naposledy v hre
  wellFern?: number;          // v ktorom období (seasonNo) mu studňa naposledy dala papraďové semienko
}
// Chôdza po ľade (#157, src/server/icewalk.ts): hybnosť (vx, vy v políčkach/s), čas posledného pohybu podľa klienta (t, ms),
// do ktorého kroku leží po pošmyknutí alebo čľapká po prepadnutí (fall) a či pláva vo vode (sw).
// Hráč ho má len na ľade, vo vode alebo kým leží; inak záznam chýba.
export interface IceWalk {
  vx: number;
  vy: number;
  t?: number;
  fall?: number;
  sw?: 1;
}

// ---- Udalosti v plánovači (engine.js) ----
interface EventBase<T extends string, D> {
  at: number;
  seq: number;
  type: T;
  data: D;
  key?: string;               // unikátna či periodická udalosť
  periodic?: true;
}
export type SavedEvent =
  | EventBase<'dawn' | 'hourly' | 'delivery' | 'npc_jano' | 'npc_fero' | 'npc_zuzka' | 'webDawn' | 'kriziakTrip', null>
  | EventBase<'festAnnounce' | 'festStart' | 'festEnd', { id: FestivalId }>
  | EventBase<'jano_sell', { sp: SpeciesId; n: number }>
  | EventBase<'cExpire' | 'cDue', { id: number }>
  | EventBase<'scavDone', { key: PlayerKey; n: string; i: number; seeds: boolean }>
  | EventBase<'vilyEnd' | 'loomDone', { key: PlayerKey }>
  | EventBase<'pullDone', { key: PlayerKey; id: number; n: string }>
  | EventBase<'spider', { id: string }>
  | EventBase<'kriziak', { area: AreaId }>
  | EventBase<'weave', { o: number }>;
export type EventType = SavedEvent['type'];

// ---- Trh a zákazky (economy.js) ----
export interface ActiveFestival {
  id: FestivalId;
  name: string;
  icon: string;
  mult: Partial<Record<SpeciesId, number>>;
  until: number;
}
export interface Market {
  seeds: Partial<Record<SpeciesId, { stock: number }>>;
  flowers: Partial<Record<SpeciesId, { stock: number; fest?: number }>>;   // fest = sviatočný násobok výkupnej ceny
  compost: { stock: number };
  hist: Partial<Record<ItemId, number[]>>;   // posledné ceny (graf na trhu)
  news: { tick: number; text: string }[];    // najnovšia prvá
  festival: ActiveFestival | null;
  npcs: { jano: { coins: number }; fero: { coins: number; hold: Partial<Record<SpeciesId, number>> } };
}
export type ContractKind = 'short' | 'long' | 'big';
export interface Contract {
  id: number;
  kind: ContractKind;
  giver: GiverId;
  sp: SpeciesId;
  n: number;
  got: number;
  reward: number;
  item: { id: ItemId; n: number } | null;   // odmena navyše (veľké zákazky)
  rep: number;
  posted: number;
  openUntil: number;
  due: number;
  takenBy: PlayerKey | null;
}
export interface Contracts {
  list: Contract[];
  nextId: number;
}

// ---- Stavby, pavučiny ----
export interface Icehouse {
  built: boolean;
  ice: number;
  bl: number;                 // vložené prikrývky (izolácia)
}
export interface Dielna {
  built: boolean;
  loom: boolean;
  job: { key: PlayerKey; at: number } | null;   // kto tká a kedy bude prikrývka hotová
  ready: Partial<Record<PlayerKey, number>>;    // hotové prikrývky čakajúce na tkáča
}
// Pavučina zaberá n políčok od (x, y), ax 0 = vodorovne, 1 = zvisle; o = majiteľ (index pavúka);
// in = kto je práve v pavučine a z ktorej strany prišiel (±1)
export interface Web {
  id: number;
  x: number;
  y: number;
  ax: 0 | 1;
  n: number;
  silk: number;
  o: number;
  in?: Partial<Record<PlayerKey, 1 | -1>> | undefined;   // návrh ho po vyjdení z pavučiny nastaví na undefined (v JSON chýba)
}
export interface Webs {
  list: Web[];
  nid: number;
  pend: Partial<Record<string, number[]>>;   // index pavúka → kroky, kedy znova utká roztrhnutú pavučinu
}
export type CornerArea = 'garden' | 'hory';

// ---- Celé uloženie ----
export interface SaveFile {
  v: 11;
  tick: number;
  wall: number;               // reálny čas (ms) k času tick
  mode: WorldMode;
  daySeconds: number;
  seed: string;               // semienko sveta (náhoda návrhov)
  step: number;               // počítadlo kôl enginu
  seq: number;                // počítadlo udalostí
  events: SavedEvent[];
  weather: Weather;
  saves: Partial<Record<PlayerKey, PlayerSave>>;
  storage: Inventory;
  storageFb: Batches;
  market: Market;
  contracts: Contracts;
  fairyNight: number;
  eternal: boolean;
  migratedFrom?: number;      // z ktorej verzie bol svet prevedený (nový svet ju nemá)
  scav: Partial<Record<string, number>>;   // index políčka → hodina, v ktorej ho niekto prehľadal
  scavSalt: number;
  icehouse: Icehouse;
  dielna: Dielna;
  redeem: Inventory;          // čo dostane prvý hráč po migrácii v11 (veci z uvoľnených políčok)
  pomedzieSeed: number;
  up: { plots: number };
  lesSeed: number;
  glacierFed: number;
  plotsUsed: number;
  maxRep: number;
  webs: Webs;
  corners: Record<CornerArea, string[]>;
  tiles: SavedTile[];
  hory: SavedHoryTile[];
  les: string;                // rozloženie Lesa divov, jeden znak na políčko (D.LES_CODE)
  icewalk?: Partial<Record<PlayerKey, IceWalk>>;   // chôdza po ľade (#157); staršie uloženia ju nemajú (= nikto nie je na ľade)
}
