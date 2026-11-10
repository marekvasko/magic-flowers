// Stav klienta (#136): jeden objekt S zdieľaný hrou (game.ts) a 3D pohľadom (render3d.ts, spiders3d.ts, particles3d.ts).
// V konzole je to window.MF – jediný ladiaci háčik klienta (README).
import type { AreaId, BrewHint, Ground, ItemId, Look, MasterPos, PotionId, SpeciesId } from '../shared/data.ts';
import type { WebOverrides } from '../shared/webs.ts';
import type { Other } from '../shared/players.ts';
import type { BatchesView, CornerView, PlayerView, ServerMessage, SpiderKind, TileView, WebView } from '../shared/protocol.ts';
import type { Contract, Icehouse, Weather, WorldMode } from '../shared/save.ts';
import type { FadeConfig, FadeOverrides, Render3D } from './render3d.ts';
import type { IceClient } from './icewalk.ts';

export type MsgOf<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;
export interface Pt { x: number; y: number }

// Vlastná postavička: poloha, smer (dir 0–3, a = presný uhol), fáza chôdze, výška a rýchlosť skoku, plazenie
export interface Me {
  x: number; y: number; dir: number; a?: number; phase: number; moving: boolean; jz: number; jv: number; crawl: boolean;
  crouch?: boolean; vx?: number; vy?: number; pose?: 'fall' | 'swim' | null; poseK?: number;   // chôdza po ľade (#157): čupí, hybnosť, póza a jej priebeh 0 → 1
}
// Iný hráč: k polohe zo zdieľaného modulu (players.ts) cieľ pohybu (tx, ty) a údaje zo správy pl
export interface OtherPlayer extends Other {
  id: number; tx: number; ty: number; dir: number; a: number | undefined; look: Look | null; name: string;
  e: PlayerView['e']; cr: boolean; lp: boolean; si: number; wb: number;
  cq?: boolean; po?: 'fall' | 'swim' | null; poseAt?: number;   // chôdza po ľade (#157): čupí, leží / pláva, odkedy
}
// Pavúk na ploche: poloha plynulo dobieha cieľ zo servera (tx, ty, tz), fáza nôh podľa prejdenej dráhy
export interface Spider {
  id: string; k: SpiderKind; x: number; y: number; z?: number; phase: number;
  tx: number; ty: number; tz: number; a: number; m: boolean; c: boolean; h: boolean; n: [number, number] | null; u: boolean;
}
// Efekt (častica) nad svetom: obyčajná letí a padá, víla krúži okolo stredu (cx, cy)
export interface FxParticle {
  fairy?: undefined; x: number; y: number; vx: number; vy: number; g: number; life: number; max: number; size: number;
  color?: string | undefined; text?: string; star?: boolean;
  ox?: number; oy?: number; // kde efekt vznikol (kreslenie, render3d.ts)
}
export interface FxFairy { fairy: true; cx: number; cy: number; a: number; rad: number; life: number; max: number; color: string }
export type Fx = FxParticle | FxFairy;
export interface ScreenFx { k: 'rainbow' | 'gold'; life: number; max: number; coins?: { x: number; y: number; v: number }[] }
// Prechod do inej plochy (game.ts areaChange)
export interface AreaFx { phase: 'out' | 'build' | 'named'; msg: MsgOf<'area'>; queue: ServerMessage[]; timer?: ReturnType<typeof setTimeout>; tok?: symbol }
// Kontextová akcia na políčku: ikona, popis, okno (ui), len informácia, kde je majster…
export type UiKind = 'shop' | 'cauldron' | 'babka' | 'book' | 'menu' | 'help' | 'storage' | 'house' | 'wish' | 'icehouse' | 'dielna' | 'majster';
export interface CtxAction { i: string; l: string; ui?: UiKind; info?: boolean; only?: boolean; ma?: MasterPos }
export type Dir = 'u' | 'd' | 'l' | 'r';

export interface ClientState {
  ws: WebSocket | null; id: number; room: string; name: string; look: Look | null;
  tiles: TileView[]; tick: number; market: MsgOf<'market'> | null; board: Contract[]; rep: number; up: Partial<MsgOf<'me'>['up']>;
  canCap: number; plotLimit: number; plotsUsed: number; maxActive: number; day: number; min: number; weather: Weather;
  timeAt: number; tickMs: number; daySeconds: number; mode: WorldMode; storage: Partial<Record<ItemId, number>>;
  me: Me; crawlKey: boolean; crawlTgl: boolean; myEmote: PlayerView['e']; mySi?: number;
  others: Map<number, OtherPlayer>; inv: Partial<Record<ItemId, number>>; coins: number; water: number; recipes: string[]; seen: SpeciesId[]; vily: boolean;
  fb?: BatchesView; fbTick?: number; storageFb?: BatchesView; storageTick?: number;
  sel: ItemId | ''; area: AreaId; areaSeq: number; W: number; H: number; tilesGen: number; worldGen?: number; storageRate: number;
  icehouse: Icehouse; dielna: { built: boolean; loom: boolean }; loom: MsgOf<'me'>['loom']; eternal: boolean; names: string[];
  keys: Partial<Record<Dir, boolean>>; kbd?: boolean; stick: Pt; path: Pt[] | null; pendingAct: (Pt & { onTile?: boolean }) | null;
  tapMark: (Pt & { t: number; act: boolean }) | null; lastSent: string; sentAt: number;
  fx: Fx[]; screenFx: ScreenFx[]; bubbles: Partial<Record<number, { text: string; until: number }>>; modal: { refresh: () => void } | null;
  cauldron: ItemId[]; brewed: PotionId | null; brewHint: BrewHint | null; anchors: Partial<Record<Ground, Pt>>; joined: boolean;
  skyTaps: number[]; tipIdx: number; stuckT: number;
  asleep?: boolean; ff?: boolean; sleepN?: number; sleepTotal?: number; areaFx?: AreaFx | null;
  // pavúky (#57): pavučiny v Lese divov (webTile: políčko → pavučina), nory a čistina pradleny, kútové pavučiny krížiaka,
  // pavúky na ploche (plynulo dobiehajú polohu zo servera) a spomalenie (lepkavá pavučina, pavúk na chrbte)
  webs: WebView[]; webTile: Map<number, WebView>; homes: MsgOf<'webs'>['homes']; websGen: number; corner: CornerView[]; cornerGen: number;
  spiders: Map<string, Spider>; slowK: number; slowUntil: number; web: { start: number; stuck: number; end: number; k: number } | null;
  webLeft?: () => number; // koľko pavučiny je ešte na mne (1 → 0); na ladiacej stránke chýba
  r3: Render3D | null; // 3D pohľad (pre ladenie v konzole: MF.r3.pick(x, y))
  ice?: IceClient; crouchKey?: boolean; crouchTgl?: boolean; // chôdza po ľade (#157): leží / pláva, čupnutie (C, tlačidlo 🧎)
}

// Stav, ktorý kreslí 3D pohľad (render3d.ts, spiders3d.ts, particles3d.ts): hra mu dá celé S, ladiaca stránka /debug
// (záložka World) len to, čo pohľad naozaj číta – bez stavu budov a hráčov s id podľa odtlačku kľúča (reťazec)
export type ViewOther = Pick<OtherPlayer, 'x' | 'y' | 'name' | 'look' | 'a' | 'dir' | 'e' | 'phase' | 'jz' | 'cr' | 'lp' | 'si' | 'wb' | 'cq' | 'po' | 'poseAt'> & { id: number | string };
export type ViewState = Pick<ClientState, 'W' | 'H' | 'tiles' | 'area' | 'tilesGen' | 'tick' | 'day' | 'weather' | 'me' | 'look' | 'name' | 'id'
  | 'myEmote' | 'sel' | 'anchors' | 'fx' | 'screenFx' | 'bubbles' | 'tapMark' | 'webs' | 'homes' | 'websGen' | 'corner' | 'cornerGen' | 'spiders'>
  & Partial<Pick<ClientState, 'icehouse' | 'dielna' | 'webLeft' | 'kbd' | 'mySi' | 'worldGen'>>
  & { others: ReadonlyMap<number | string, ViewOther> };

// Ladiace prepínače z konzoly (README): čítajú sa za behu, hra ich sama nenastavuje
declare global {
  interface Window {
    MF: ClientState;
    MF_TIME?: { season?: number; min?: number };
    MF_WEB?: WebOverrides;
    MF_FADE?: FadeOverrides;
    MF_FADE_DEFAULTS?: FadeConfig;
    MF_NOFADE?: boolean;
    MF_LES_SUN?: 'dapple';
    MF_RAY_K?: number;
    MF_STEP?: 'snap' | 'lerp';
    webkitAudioContext?: typeof AudioContext;
  }
}
