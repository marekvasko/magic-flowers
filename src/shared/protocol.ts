// Správy cez WebSocket medzi serverom (src/server/server.ts) a klientom (src/client/game.ts) – #122, fáza 2.
// Typy opisujú existujúci protokol, nemenia ho. Každá správa je objekt s diskriminátorom t.
//  - ClientMessage: čo posiela klient (server každú správu ešte overí – hodnoty mimo typu zahodí alebo opraví)
//  - ServerMessage: čo dostane klient (posiela server sám alebo ide z návrhov enginu cez ctx.emit)
// Pokyny návrhov len pre server (joined, travel, me, scavStart, scavDone, pullStart, pullDone) klient nedostane;
// typuje ich engine (fáza 3). Správa webbed ide aj klientovi.
import type { AreaId, BrewHint, Ground, ItemId, Look, PotionId, SpeciesId, UpgradeId } from './data.ts';
import type { ActiveFestival, Contract, CornerArea, Icehouse, Plant, Soil, Weather, WorldMode } from './save.ts';
import type { TrackWire } from './tracks.ts';

// ---- Klient → server ----
export type Emote = 'dance' | 'wave' | 'heart' | 'laugh' | 'flower';
export type WishKind = 'zlato' | 'jar' | 'poklad';
export type ClientMessage =
  | { t: 'join'; room: string; name: string; look?: Look | null }   // bez vzhľadu: z uloženia alebo predvolený
  // a = presný smer pohľadu, cr = plazí sa, lp = drží lampáš, ar = poradie plochy (pohyb z predchádzajúcej plochy sa zahodí)
  | { t: 'move'; x: number; y: number; dir: number; a?: number | undefined; cr?: boolean; lp?: boolean; ar: number }
  | { t: 'act'; x: number; y: number; item: ItemId | '' }   // '' = prázdna ruka
  | { t: 'buy' | 'sell' | 'store' | 'unstore'; id: ItemId; n: number }
  | { t: 'upgrade'; kind: UpgradeId }
  | { t: 'ctake' | 'cdeliver'; id: number }
  | { t: 'brew'; items: ItemId[] }                          // tri kvety fl_*
  | { t: 'wish'; kind: WishKind }
  | { t: 'buyTool'; id: 'pick' | 'lamp' }
  | { t: 'build'; id: 'icehouse' | 'dielna' }
  | { t: 'icehouse'; n: number }                            // vložiť ľad do ľadovne
  | { t: 'compostWilted' | 'buyLoom' | 'masterWeave' | 'loomStart' | 'loomTake' | 'jump' }
  | { t: 'sleep'; on: boolean }
  | { t: 'emote'; e: Emote }
  | { t: 'settings'; mode: WorldMode }
  | { t: 'chat'; text: string };
export type ClientMessageType = ClientMessage['t'];

// ---- Server → klient ----
// Políčko, ako ho vidí klient: zem, na záhrade pôda (druh divej rastliny je skrytý ako 'wild'), v horách ľad a otvor vo vode
export interface PlantView extends Omit<Plant, 'sp'> { sp: SpeciesId | 'wild' }
export interface SoilView extends Omit<Soil, 'p'> { p: PlantView | null }
export interface TileView {
  g: Ground;
  s?: SoilView | null;
  ice?: number;
  cut?: 1;
}
// Várky s vekom pre klienta (vek prepočítaný k aktuálnemu kroku)
export type BatchesView = Partial<Record<ItemId, { n: number; age: number }[]>>;
// Položka trhu: cena, zásoba a posledné ceny
export interface MarketItemView { p: number; st: number; h: number[] }
export interface UpcomingFestival {
  id: ActiveFestival['id'];
  name: string;
  icon: string;
  mult: ActiveFestival['mult'];
  len: number;
  start: number;
  end: number;
  announce: number;
  announced: boolean;
}
// Hráč na ploche (správa pl, 10× za sekundu): e = čo práve robí, si = políčko, kde hľadá (-1 nič),
// j = počítadlo skokov, wb = koľko pavučiny ešte na ňom zostáva (1 → 0)
export interface PlayerView {
  id: number;
  name: string;
  x: number;
  y: number;
  dir: number;
  a?: number;
  look: Look | null;
  cr: 0 | 1;
  lp: 0 | 1;
  j: number;
  si: number;
  area: AreaId;
  e: Emote | 'sleep' | 'search' | 'pull' | null;
  wb: number;
}
export type SpiderKind = 'v' | 'p' | 'k';   // v = vlčiak, p = stará pradlena, k = krížiak
// Pavúk na ploche: m = hýbe sa, h = doma; na kmeni výška z, strana kmeňa n a u = lezie hore
export interface SpiderView {
  id: string;
  k: SpiderKind;
  x: number;
  y: number;
  a: number;
  m: 0 | 1;
  h?: 0 | 1;
  z?: number;
  n?: [number, number];
  u?: 0 | 1;
}
export interface WebView { id: number; x: number; y: number; ax: 0 | 1; n: number; silk: number; in?: Partial<Record<string, 1 | -1>> }
// Kútová pavučina krížiaka: políčko, smery dvoch stien a počet stien (2 = koniec steny, 3 = vnútorný roh)
export interface CornerView { x: number; y: number; dx: number; dy: number; ex: number; ey: number; f: 2 | 3 }
export type ToastKind = 'info' | 'day' | 'magic' | 'gift';
export type FxKind =
  | 'fairies' | 'glimmer' | 'dirt' | 'drops' | 'sparkle' | 'pop' | 'ice' | 'splash' | 'burp' | 'gift' | 'hearts' | 'wave' | 'brew'
  | 'gold' | 'rainbow' | 'cobweb';

export type ServerMessage =
  | { t: 'welcome'; id: number; room: string; w: number; h: number; tiles: TileView[]; area: AreaId; seq: number; x: number; y: number }
  | { t: 'area'; area: AreaId; seq: number; w: number; h: number; tiles: TileView[]; x: number; y: number }
  | { t: 'tiles'; tiles: TileView[] }
  | { t: 'tile'; i: number; v: TileView }
  | { t: 'pos'; x: number; y: number }                     // server pohyb odmietol – späť na potvrdené miesto
  | {
    t: 'me'; coins: number; water: number; inv: Partial<Record<ItemId, number>>; recipes: string[]; seen: SpeciesId[]; vily: boolean;
    rep: number; up: { can: number; composter: number; plots: number }; canCap: number; plotLimit: number; plotsUsed: number; maxActive: number;
    fb: BatchesView; tick: number; loom: { busy: boolean; mine: number | null; ready: number };
  }
  | {
    t: 'room'; eternal: boolean; mode: WorldMode; daySeconds: number; storage: Partial<Record<ItemId, number>>; storageFb: BatchesView;
    storageRate: number; icehouse: Icehouse; dielna: { built: boolean; loom: boolean }; tick: number; names: string[];
  }
  | { t: 'time'; tick: number; tickMs: number; weather: Weather; mode: WorldMode; daySeconds: number }
  | { t: 'plots'; used: number; limit: number }
  | {
    t: 'market'; seeds: Partial<Record<SpeciesId, MarketItemView>>; flowers: Partial<Record<SpeciesId, MarketItemView>>; compost: MarketItemView;
    festival: ActiveFestival | null; upcoming: UpcomingFestival | null; news: { tick: number; text: string }[];
  }
  | { t: 'board'; list: Contract[] }
  | { t: 'pl'; list: PlayerView[] }
  | { t: 'sleep'; ids: number[]; total: number; ff: boolean }
  | { t: 'toast'; text: string; kind: ToastKind }
  | { t: 'chat'; name: string; text: string; id: number }
  | { t: 'fx'; k: FxKind; x?: number; y?: number; c?: string }
  | { t: 'webs'; webs: WebView[]; homes: { k: 'v' | 'p'; x: number; y: number }[] }   // v = nora vlčiaka, p = pradlena
  | { t: 'corner'; area: CornerArea; list: CornerView[] }
  | { t: 'sp'; list: SpiderView[] }
  | { t: 'webbed'; stuck: number; ms: number; k: number; sp: SpiderKind }   // pavúk hráča zabalil do pavučiny
  | { t: 'shove'; x: number; y: number }                   // stará pradlena hráča odhodila
  | { t: 'brewed'; k: PotionId; hint?: BrewHint }        // hint len pri slize (rada kotlíka)
  | { t: 'error'; text: string }
  | { t: 'tracks'; area: AreaId; full?: 1; add: TrackWire[] };   // stopy v snehu (#159): full = celý zoznam plochy, inak nové stopy
export type ServerMessageType = ServerMessage['t'];
