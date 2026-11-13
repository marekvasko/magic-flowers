// Akcie hráčov ako návrhy (engine.js): každá správa klienta, ktorá mení herný stav, je vstup enginu
// { type, data: { key, … }, id: 'a#<n>', actor: key } a tu má svoj návrh { keys, run } – pozri docs/engine.md.
// Návrh deklaruje len to, čo akcia naozaj mení (políčko, uloženie hráča, položka trhu…), beží na kópiách týchto výrezov,
// odmieta cez ctx.reject (hráč dostane správu; null = potichu) a správy posiela cez ctx.emit. Obnovu políčok, batohov,
// trhu, nástenky a skladu si server odvodí zo zapísaných kľúčov, takže tu nie je žiadne sendMe ani tileMsg.
// Prítomnosť (kde hráči stoja, či hľadajú v tráve) je ctx.presence a ctx.actor (záznam konajúceho hráča) – nie je to stav.
// Správa 'act' (klik na políčko s predmetom v ruke) sa najprv rozloží (resolveAct) na konkrétnu akciu podľa políčka,
// predmetu a prítomnosti; server to urobí pri skladaní dávky, aby v denníku bolo, čo hráč naozaj urobil (pick, till…).
import * as D from '../shared/data.ts';
import type { AreaId, ItemId, Look, Point, PotionId } from '../shared/data.ts';
import type { FxKind, ToastKind, WishKind } from '../shared/protocol.ts';
import * as B from '../shared/book.ts';
import type { OrderSide, PlayerKey, PlayerSave } from '../shared/save.ts';
import { keys, lookup, must } from '../shared/util.ts';
import * as E from './engine.ts';
import * as Econ from './economy.ts';
import * as Mkt from './market.ts';
import * as I from './items.ts';
import * as Ice from './ice.ts';
import * as Scav from './scavenge.ts';
import * as Areas from './areas.ts';
import * as Events from './events.ts';
import * as Spiders from './spiders.ts';
import type { SpiderInputs } from './spiders.ts';
import * as Dielna from './dielna.ts';
import * as Vehicles from './vehicles.ts';
import * as Dock from './dock.ts';
import { gardenOf, put, redeemOf, savesOf, sl } from './game.ts';
import type { GameCtx, GameProposer, GameSlices, GameWorld, Msg, To } from './game.ts';
import type { MovedBatch, Presence, Tile } from './world.ts';

const TPD = D.TICKS_PER_DAY;
export const HOUSE: Point = { x: 3.5, y: 28.5 };
const DANCE_MS = 6500; // ako dlho po emócii „tanec“ sa hráč ráta za tancujúceho
const SCAV_MOVE = 0.35; // o koľko sa smie hľadajúci hráč pohnúť, kým hľadanie preruší
const season = (tick: number): D.Season => D.seasonOf(D.dayOfTick(tick));
// Poradové číslo obdobia od začiatku sveta (1, 2, …) – studňa dá papraďové semienko najviac raz za obdobie
export const seasonNo = (tick: number): number => Math.floor((D.dayOfTick(tick) - 1) / D.DAYS_PER_SEASON) + 1;
// Studňa prianí: horné prahy hodu r (kumulatívne) – tip 45 %, vrecúško 20 %, dážď 10 %, papraď 0,5 %, gejzír 0,5 %, elixír 0,5 %, inak nič
export const WELL = { tip: 0.45, seeds: 0.65, rain: 0.75, fern: 0.755, gold: 0.76, potion: 0.765 } as const;
export const WELL_GOLD = 60;
// Vrecúško zo studne: len obyčajné druhy, ktoré rastú kdekoľvek (bez čarovných a bez prísnych ako plesnivec)
export const WELL_SEEDS: readonly D.SpeciesId[] = keys(D.SPECIES).filter(k => !D.SPECIES[k].magic && !D.SPECIES[k].strict && !D.SPECIES[k].aqua);
export const WELL_POTIONS: readonly PotionId[] = ['rast', 'dazd'];
const toast$ = (to: To, text: string, kind?: ToastKind): Msg => ({ to, t: 'toast', text, kind: kind || 'info' });
const fx$ = (area: AreaId, k: FxKind, x: number, y: number, extra?: { c: string }): Msg => ({ to: E.area(area), t: 'fx', k, x, y, ...extra });

// Okamžitý obchod hráča cez knihu: limit je najhoršia cena, ktorú hráč videl (bez nej: kúpi za čokoľvek, čo zaplatí,
// predá za čokoľvek aspoň 1)
function instant(s: GameSlices, d: ActionInputs['buy'], side: OrderSide, ctx: GameCtx): void {
  if (!nearStall(who(ctx))) { ctx.reject(AT_STALL); return; }
  const item = d.id, sv = saveOf(s, d.key, ctx);
  if (!B.isBookItem(item)) { ctx.reject(side === 'buy' ? 'Toto sa na trhu nepredáva.' : 'Toto trh nevykupuje.'); return; }
  const lim = d.lim && d.lim > 0 ? d.lim : side === 'buy' ? Math.max(1, sv.coins) : 1;
  const mk = Mkt.mkOf(s, ctx, d.key), other = Mkt.side(mk.book(item), side === 'buy' ? 'sell' : 'buy', ctx.tick).some(o => o.pl !== d.key);
  const r = Mkt.playerOrder(mk, item, d.key, nameOf(ctx, d.key), side, d.n, lim, true);
  if ('err' in r) { ctx.reject(r.err); return; }
  if (r.cx) ctx.emit(toast$(d.key, Mkt.selfCancelText(item, side, r.cx), 'gift'));
  if (!r.got && !r.cx) {
    if (!other) ctx.reject(side === 'buy' ? 'Vypredané. Veľkoobchodník príde o pár dní.' : 'Toto teraz nikto nekúpi.');
    ctx.reject(side === 'buy' ? 'Za túto cenu tu teraz nikto nepredáva.' : 'Za túto cenu to teraz nikto nekúpi.');
  }
  Mkt.announce(mk);
  if (r.got) ctx.emit(toast$(d.key, `${side === 'buy' ? 'Kúpené' : 'Predané'}: ${String(r.got)}× ${D.itemName(item)} za ${String(r.coins)} 🪙`));
}

// Dáta akcií hráča (vstupy enginu; key = kľúč konajúceho hráča – server ho doplní, rovnaký ako actor)
export interface ActionInputs {
  pos: { key: PlayerKey; x: number; y: number };
  seen: { key: PlayerKey };
  leave: { key: PlayerKey };
  join: { key: PlayerKey; name: string; look: Look | null; start: { coins: number; rep: number }; quick: boolean };
  dance: { key: PlayerKey; now: number };
  till: { key: PlayerKey; i: number };
  level: { key: PlayerKey; i: number };
  clear: { key: PlayerKey; i: number; area?: AreaId };   // area: vodné kvety v plese (#38); bez nej záhrada
  water: { key: PlayerKey; i: number };
  compost: { key: PlayerKey; i: number };
  plant: { key: PlayerKey; i: number; item: string; area?: AreaId };
  plantWild: { key: PlayerKey; i: number; item: string };
  pick: { key: PlayerKey; i: number; area?: AreaId };
  scavStart: { key: PlayerKey; i: number; seeds: boolean };
  scavStop: { key: PlayerKey };
  digIce: { key: PlayerKey; area: AreaId; i: number };
  fillIce: { key: PlayerKey; n: number };
  insulate: { key: PlayerKey };
  drawWater: { key: PlayerKey; area: AreaId; i: number };
  well: { key: PlayerKey };
  potion: { key: PlayerKey; kind: string; area: AreaId; x: number; y: number };
  gift: { key: PlayerKey; to: PlayerKey; item: string };
  love: { key: PlayerKey; to: PlayerKey };
  wave: { key: PlayerKey; to: PlayerKey };
  buy: { key: PlayerKey; id: string; n: number; lim?: number };
  sell: { key: PlayerKey; id: string; n: number; lim?: number };
  order: { key: PlayerKey; id: string; side: OrderSide; n: number; p: number };
  cancelOrder: { key: PlayerKey; id: string };
  collect: { key: PlayerKey; id: string };
  upgrade: { key: PlayerKey; kind: string };
  buyTool: { key: PlayerKey; id: string };
  build: { key: PlayerKey; id: 'icehouse' | 'dielna' };
  buyLoom: { key: PlayerKey };
  masterWeave: { key: PlayerKey };
  loomStart: { key: PlayerKey };
  loomTake: { key: PlayerKey };
  ctake: { key: PlayerKey; id: number };
  cdeliver: { key: PlayerKey; id: number };
  brew: { key: PlayerKey; items: string[] };
  wish: { key: PlayerKey; kind: WishKind };
  store: { key: PlayerKey; id: string; n: number };
  unstore: { key: PlayerKey; id: string; n: number };
  compostWilted: { key: PlayerKey };
}
// Vstup z rozkladu kliknutia (resolveAct): akcia hráča alebo akcia s pavučinou
type ActInputs = ActionInputs & Pick<SpiderInputs, 'pullStart' | 'clearWeb'> & Pick<Dock.DockInputs, 'board' | 'unboard'>;
export type ActInput = { [T in keyof ActInputs]: { type: T; data: ActInputs[T] } }[keyof ActInputs];
const input = <T extends keyof ActInputs>(type: T, data: ActInputs[T]): { type: T; data: ActInputs[T] } => ({ type, data });

// ---------- Prítomnosť ----------
// Záznam prítomnosti: { key, name, area, x, y, scav: { i, n, px, py } | null, emote, emoteAt } – snímka pripojeného hráča (server: presenceOf)
type Where = Pick<Presence, 'area' | 'x' | 'y'> | null | undefined;
// Prianie „zlatý dážď“: koľko dostane ten, kto si prial, a koľko každý ďalší pripojený hráč (#100)
export const WISH_GOLD = { me: 400, others: 100 } as const;
export function inRing(p: Where): boolean { if (!p || p.area !== 'garden') return false; const x = Math.floor(p.x), y = Math.floor(p.y); return x >= D.RING.x0 && x <= D.RING.x1 && y >= D.RING.y0 && y <= D.RING.y1; }
export function nearHouse(p: Where): boolean { return !!p && p.area === 'garden' && Math.hypot(p.x - HOUSE.x, p.y - HOUSE.y) <= 3.5; }
// Pri trhovom stánku (#112): tovar z trhu (na vyzdvihnutie, záloha zrušenej objednávky) sa dá zobrať len tu
export const STALL: Point = { x: 12.5, y: 28.5 };
export function nearStall(p: Where): boolean { return !!p && p.area === 'garden' && Math.hypot(p.x - STALL.x, p.y - STALL.y) <= 3; }
// Obchoduje sa len pri stánku: tovar z batohu do knihy a z knihy do batohu sa nikam neteleportuje
const AT_STALL = 'Obchoduje sa pri trhovom stánku – podíď bližšie.';
export function nearIcehouse(p: Where): boolean {
  const L = D.ICEHOUSE.lot;
  return !!p && p.area === 'garden' && Math.hypot(p.x - (L.x0 + L.x1 + 1) / 2, p.y - (L.y0 + L.y1 + 1) / 2) <= 3;
}
// Iný hráč stojaci na políčku (x, y) tej istej plochy
export function playerAt(presence: readonly Presence[] | null | undefined, me: Pick<Presence, 'key' | 'area'>, x: number, y: number): Presence | null {
  for (const o of presence || []) if (o.key !== me.key && o.area === me.area && Math.hypot(o.x - (x + 0.5), o.y - (y + 0.5)) < 0.8) return o;
  return null;
}
const byKey = (presence: readonly Presence[] | null | undefined, key: PlayerKey): Presence | null => (presence || []).find(p => p.key === key) || null;
// Konajúci hráč musí byť prítomný (odpojil sa medzi správou a dávkou → akcia potichu neprejde)
const who = (ctx: GameCtx): Presence => ctx.actor || ctx.reject(null);
const nameOf = (ctx: GameCtx, key: PlayerKey): string => (ctx.actor ? ctx.actor.name : key);

// ---------- Pomocníci nad výrezmi ----------
const saveOf = (s: GameSlices, key: PlayerKey, ctx: GameCtx): PlayerSave => sl(s, `save:${key}`) || ctx.reject(null);
const garden = (s: GameSlices, i: number): Tile => must(sl(s, `tile:garden:${i}`));
const tileIn = (s: GameSlices, area: AreaId, i: number): Tile => must(sl(s, `tile:${area}:${i}`));
// Vodné políčko (#38): kvet sa sadí priamo do vody a zaberá miesto v spoločnom povolení, kým na ňom niečo rastie
const waterKeys = (area: AreaId | undefined, i: number): string[] => (D.waterSpot(area || 'garden', i) ? ['plotsUsed'] : []);
const WATER_PERMIT = (lim: number): string => `Spoločné povolenie záhrady je na ${lim} políčok a všetky sú obsadené (ráta sa aj voda s kvetmi). Väčšie povolenie môže pre všetkých kúpiť ktokoľvek na trhu (záložka Vylepšiť).`;
// Políčko vody, kde sa sadia vodné kvety (jazierko, pleso): zber, odstránenie uhynutej rastliny, sadenie; undefined = nič z toho
function waterAct(t: Tile, area: AreaId, key: PlayerKey, i: number, item: string): ActInput | { toast: string } | null | undefined {
  if (t.g !== 'water' || !D.waterSpot(area, i)) return undefined;
  const p = t.s && t.s.p, a = area === 'garden' ? {} : { area };
  if (p && !p.d && p.prog >= D.SPECIES[p.sp].days) return input('pick', { key, i, ...a });
  if (item === 'hoe' && p && p.d) return input('clear', { key, i, ...a });
  if (item === 'hoe' && t.s) return null; // motyka pri rastúcom vodnom kvete nič nerobí (ako na záhone)
  if (item.startsWith('seed_')) return input('plant', { key, i, item, ...a });
  if (D.isWild(item)) return { toast: 'Divé semienko vo vode nevyrastie – sadí sa do prekopanej zeme. 🌱' };
  if (item === 'compost') return { toast: 'Vodné kvety kompost nepotrebujú – živí ich bahno na dne. 🌊' };
  return undefined;
}
function give(sv: PlayerSave, id: ItemId, n: number, tick: number, batches?: MovedBatch[]): void { I.addItems(I.playerC(sv), id, n, tick, batches); }
function take(sv: PlayerSave, id: ItemId, n: number, tick: number): MovedBatch[] | null { return I.removeItems(I.playerC(sv), id, n, tick); }
// Políčka záhrady okolo (x, y) v polomere r: indexy
function around(x: number, y: number, r: number): number[] {
  const out: number[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < D.W && ny < D.H) out.push(ny * D.W + nx);
  }
  return out;
}
const tileKeys = (idx: readonly number[]): string[] => idx.map(i => `tile:garden:${i}`);
// Políčka z výrezov ako „pole“ indexované políčkom (pre revealWild a spol.; ostatné miesta sú prázdne)
function tilesFrom(s: GameSlices, idx: readonly number[]): Tile[] { const t: Tile[] = []; for (const i of idx) t[i] = garden(s, i); return t; }
// Dážď (elixír, studňa): počasie, polievanie záhrady; živí aj ľadovec, najviac raz za deň (glacierFed)
const RAIN_KEYS = ['weather', 'tile:garden:*', 'tile:hory:*', 'glacierFed'];
function rain(s: GameSlices, ctx: GameCtx): void {
  s.weather = 'rain';
  for (const t of sl(s, 'tile:garden:*')) if (t.s) t.s.w = 1;
  const day = D.dayOfTick(ctx.tick);
  if (s.glacierFed === day) return;
  s.glacierFed = day;
  Ice.feedGlacier(sl(s, 'tile:hory:*'), 'rain', Ice.occupied(ctx.presence));
}
// Hľadá sa s čímkoľvek okrem motyky (kope) a elixírov (dajú sa použiť kdekoľvek)
export function searchesWith(item: string): boolean { return item !== 'hoe' && !item.startsWith('po_'); }
// Rohy tela hráča na (x, y): indexy políčok plochy, na ktorých telo leží (roh tesne za okrajom plochy sa ráta k okrajovému políčku –
// stred je v ploche vďaka clampPos a klient sa k okraju dostane rovnako blízko)
export function bodyTiles(area: string, x: number, y: number): Set<number> {
  const { w, h } = D.areaSize(area), out = new Set<number>();
  for (const dy of [-D.BODY.ry, D.BODY.ry]) for (const dx of [-D.BODY.rx, D.BODY.rx]) {
    const tx = Math.max(0, Math.min(w - 1, Math.floor(x + dx))), ty = Math.max(0, Math.min(h - 1, Math.floor(y + dy)));
    out.add(ty * w + tx);
  }
  return out;
}

// ---------- Uloženie hráča ----------
// Nový hráč začína chudobne: pár semienok sezónneho kvetu a malá krhla (povolenie na pole je spoločné pre záhradu).
// start = { coins, rep } zo serverového prostredia (v náhľadoch viac), aby bol záznam v denníku úplný.
export function newSave(tick: number, start: { coins: number; rep: number }): PlayerSave {
  const se = season(tick);
  const sp = must(Econ.PLANTABLE.filter(k => !D.SPECIES[k].strict && !D.SPECIES[k].aqua && D.SPECIES[k].seasons.includes(se))
    .sort((a, b) => D.SPECIES[a].seed - D.SPECIES[b].seed)[0]);
  return {
    coins: start.coins, water: 5, inv: { hoe: 1, can: 1, [`seed_${sp}`]: 4 },
    recipes: [], seen: [sp], vily: 0, look: null, talked: false, rep: start.rep, up: { can: 0, composter: 0 },
    x: D.SPAWN.x, y: D.SPAWN.y, area: 'garden'
  };
}
// Hráči zo starších verzií hry: nezoberieme im to, čo mali (krhla na 25; pole prešlo na záhradu v migrate).
export function migrateSave(sv: PlayerSave, tick: number): void {
  /* eslint-disable @typescript-eslint/no-unnecessary-condition -- uloženia zo starších verzií tieto polia nemajú */
  if (!sv.up) sv.up = { can: 2, composter: 0 };
  if (sv.rep == null) sv.rep = 0;
  /* eslint-enable @typescript-eslint/no-unnecessary-condition -- koniec doplnenia starého uloženia */
  sv.water = Math.min(sv.water || 0, Econ.canCap(sv));
  I.syncAll(I.playerC(sv), tick); // kvety bez várok dostanú vek 0 (čerstvo odrezané)
}

// ---------- Rozklad správy 'act' ----------
// Z kliknutia na políčko (x, y) s predmetom item urobí konkrétny vstup { type, data }, alebo { toast } (odmietnutie
// podľa prítomnosti či plochy, nič sa nemení), alebo null (nič sa nedeje). world = svet (len číta), me = záznam
// prítomnosti konajúceho hráča, presence = snímka všetkých. Stav políčka si návrh overí znova sám (kolá enginu).
// m = správa act od klienta (neoverená: x, y sa zaokrúhlia na celé, item na reťazec)
export function resolveAct(world: GameWorld, presence: readonly Presence[] | null | undefined, me: Presence, m: { x?: unknown; y?: unknown; item?: unknown }): ActInput | { toast: string } | null {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- item je od klienta v ľubovoľnom tvare; String() ako doteraz
  const x = Number(m.x) | 0, y = Number(m.y) | 0, item = String(m.item || '');
  const area = me.area, tiles = Areas.areaTiles(world, area), key = me.key;
  if (!Areas.inside(area, x, y)) return null;
  const dist = Math.hypot(me.x - (x + 0.5), me.y - (y + 0.5));
  if (dist > 2.4) return { toast: 'Si príliš ďaleko.' };
  const sv = world.saves[key];
  if (!sv || (item && !(D.isItemId(item) && sv.inv[item]))) return null;
  const i = y * D.areaSize(area).w + x, t = must(tiles[i]);
  // Loďka (#160): nastúpiť (ťuknutie na loďku), vystúpiť (ťuknutie na breh či mólo vedľa loďky)
  const boat = Dock.resolveAct(world, me, x, y, item);
  if (boat) return boat;

  // Iný hráč – darovanie (alebo len zamávanie)
  // spoluhráč v tej istej loďke (#161) sedí na tom istom mieste – ťuknutie pod loďku (sadenie, voda) mu nič nedaruje
  const other = playerAt(presence, me, x, y);
  if (other && !Dock.sameBoat(world, me.key, other.key)) {
    if (item === 'po_laska') return input('love', { key, to: other.key });
    if (D.isTool(item) || !item) return input('wave', { key, to: other.key });
    return input('gift', { key, to: other.key, item });
  }
  // Pavučina: v Lese divov ťahať hodváb; kútovú (záhrada, hory) odstráni prázdna ruka či predmet, ktorý na políčku nič nerobí –
  // nástroj (motyka, krhla, semienka…) najprv urobí svoje a pavučinu odstráni, len keď tu nemá čo robiť
  const web = Spiders.resolveAct(world, me, area, i);
  if (web && ('toast' in web || area === 'les' || !onTile(item))) return web;
  const none = (): ActInput | null => (web && !('toast' in web) ? web : null);
  // Ľad: krompáčom na ľadovci alebo (v zime) na zamrznutej vode
  if (item === 'pick' && (t.g === 'glacier' || t.g === 'water')) return input('digIce', { key, area, i });
  // Ľadovňa: ľad sa vkladá, prikrývka ju izoluje; s čímkoľvek iným hráč dostane vysvetlenie, na čo ľadovňa je (#63)
  if (t.g === 'icehouse') {
    if (item === 'ice') return input('fillIce', { key, n: sv.inv.ice ?? 0 });
    if (item === 'blanket') return input('insulate', { key });
    return { toast: ICEHOUSE_ONLY };
  }
  if (area !== 'garden') {
    if (t.g === 'water' && item === 'can') return input('drawWater', { key, area, i });
    const wa = waterAct(t, area, key, i, item);
    if (wa !== undefined) return wa;
    if (t.g === 'glacier') return { toast: 'Na ľad potrebuješ krompáč – kúpiš ho na trhu (záložka Vylepšiť). ⛏️' };
    if (item === 'hoe' || item.startsWith('seed_') || D.isWild(item) || item === 'compost') {
      return { toast: area === 'hory'
        ? 'V horách je pôda kamenistá a studená. Pestuj radšej v záhrade. 🏔️'
        : area === 'les' ? 'V Lese divov je príliš tma – nič by tu nevyrástlo. Pestuj v záhrade. 🌲'
          : 'Les na pomedzí je divý – tu sa nepestuje. Pestuj v záhrade. 🌳' };
    }
    if (item.startsWith('po_')) {
      if (['rast', 'jar', 'hojnost'].includes(item.slice(3))) return { toast: 'Tento elixír pôsobí na záhony – použi ho v záhrade. 🌱' };
      return input('potion', { key, kind: item.slice(3), area, x, y });
    }
    return none();
  }
  // Studňa prianí a voda do krhly
  if (t.g === 'well' && item !== 'can') return input('well', { key });
  if ((t.g === 'water' || t.g === 'well') && item === 'can') return input('drawWater', { key, area, i });
  const wa = waterAct(t, area, key, i, item);
  if (wa !== undefined) return wa;
  // Zber
  const p = t.s && t.s.p;
  if (p && !p.d && p.prog >= D.SPECIES[p.sp].days) return input('pick', { key, i });
  // Neprekopaná tráva a v ruke nič, čo by tu niečo robilo → hľadanie divých semienok
  if (Scav.canSearch(t) && searchesWith(item)) {
    if (dist > 0.45) return { toast: 'Postav sa priamo na to políčko trávy. 🔍' };
    return input('scavStart', { key, i, seeds: !!item && (item.startsWith('seed_') || D.isWild(item)) });
  }
  if (item === 'hoe') {
    if (p && p.d) return input('clear', { key, i });
    if (!t.s && D.TILLABLE[t.g]) return input('till', { key, i });
    if (D.canLevel(t)) return input('level', { key, i });
    if (t.g === 'ring' || t.g === 'shroom') return { toast: 'Kruh z húb radšej nechaj tak… niekto tu v noci tancuje. 🍄' };
    return none();
  }
  if (item === 'can') return t.s ? input('water', { key, i }) : none();
  if (item === 'compost') return t.s && !t.s.r ? input('compost', { key, i }) : none();
  if (item.startsWith('seed_')) return input('plant', { key, i, item });
  if (D.isWild(item)) return input('plantWild', { key, i, item });
  if (item.startsWith('po_')) return input('potion', { key, kind: item.slice(3), area, x, y });
  return none();
}
const ICEHOUSE_ONLY = 'Do ľadovne patrí len ľad 🧊 (a hodvábne prikrývky na izoláciu). Kvety ulož do skladu v domčeku – ľad v ľadovni ho chladí, takže v ňom vädnú 4× pomalšie.';
// Predmet, ktorý na políčku niečo robí (kope, polieva, sadí, seká ľad, elixír)
function onTile(item: string): boolean { return item === 'hoe' || item === 'can' || item === 'pick' || item === 'compost' || item === 'ice' || item.startsWith('seed_') || D.isWild(item) || item.startsWith('po_'); }

// ---------- Návrhy ----------
export const PROPOSERS: { [T in keyof ActionInputs]: GameProposer<ActionInputs[T]> } = {
  // --- pohyb (d: { key, x, y }): poloha je stav sveta (pos:<kľúč>); prítomnosť ju už má, tu sa overí a zapíše ---
  // Overenie: v ploche, celé telo na priechodnej zemi (rovnaké pravidlo ako klient, bez výšky skoku, ktorú server nepozná);
  // dvaja hráči smú stáť na jednom políčku. Odmietnutý pohyb server vráti hráčovi ako opravu polohy (správa pos).
  // Brána: prechod do inej plochy zapíše príchodové miesto a pošle pokyn travel. Hľadajúci hráč, ktorý sa pohol, prestane hľadať.
  pos: {
    keys(d, w) {
      const sv = savesOf(w)[d.key], area = sv && sv.area && D.AREAS.includes(sv.area) ? sv.area : 'garden';
      const reads = new Set<string>(), { w: aw } = D.areaSize(area);
      if (Number.isFinite(d.x) && Number.isFinite(d.y)) {
        const p = Areas.clampPos(area, d.x, d.y);
        for (const i of bodyTiles(area, p.x, p.y)) reads.add(`tile:${area}:${i}`);
        reads.add(`tile:${area}:${Math.floor(p.y) * aw + Math.floor(p.x)}`);
      }
      return E.mergeKeys({ writes: [`pos:${d.key}`], reads: [...reads] }, Spiders.posKeys(d, w), Vehicles.posKeys(d, w), Dock.posKeys(d, w)); // pavučiny v lese, pavúky, fúrik (#158), loďka (#160)
    },
    run(s, d, ctx) {
      const pos = sl(s, `pos:${d.key}`) || ctx.reject(null);
      const area = pos.area && D.AREAS.includes(pos.area) ? pos.area : 'garden';
      const from = { area, x: pos.x, y: pos.y };
      if (!(Number.isFinite(d.x) && Number.isFinite(d.y))) ctx.reject(null);
      const p = Areas.clampPos(area, d.x, d.y);
      if (Dock.onRow(s, d, ctx, pos, p)) return; // v loďke: veslár ňou pohne po vode (#160)
      const body = bodyTiles(area, p.x, p.y);
      for (const i of body) if (!D.passable(sl(s, `tile:${area}:${i}`))) ctx.reject(null);
      pos.x = p.x; pos.y = p.y; pos.lastTick = ctx.tick;
      const me = ctx.actor;
      if (me && me.scav && Math.hypot(p.x - me.scav.px, p.y - me.scav.py) > SCAV_MOVE) {
        ctx.cancel(`scavDone:${d.key}`);
        ctx.emit({ to: d.key, t: 'scavDone' });
        ctx.emit(toast$(d.key, 'Pohol(a) si sa skôr, než si dohľadal(a).'));
      }
      Vehicles.onPos(s, d, ctx, from, p); // fúrik či sane, ktoré hráč drží, idú s ním; spolujazdec sám nechodí (#158)
      const { w: aw } = D.areaSize(area), under = sl(s, `tile:${area}:${Math.floor(p.y) * aw + Math.floor(p.x)}`);
      if (under && under.g === 'gate') {
        const g = D.gateAt(area, Math.floor(p.x), Math.floor(p.y)), a = g && D.arrival(area, g.to);
        if (g && a) {
          if (me && me.scav) { ctx.cancel(`scavDone:${d.key}`); ctx.emit({ to: d.key, t: 'scavDone' }); }
          pos.area = g.to; pos.x = a.x; pos.y = a.y;
          ctx.emit({ to: d.key, t: 'travel', from: area, area: g.to });
        }
      }
      Spiders.onPos(s, d, ctx, from, pos); // vbehnutie do pavučiny, koniec ťahania hodvábu, príchod do Lesa divov
    }
  },
  // hráč je pripojený (každých 15 s) / odišiel: „naposledy videný“ (d: { key })
  seen: { keys: d => ({ writes: [`pos:${d.key}`] }), run(s, d, ctx) { const pos = sl(s, `pos:${d.key}`) || ctx.reject(null); pos.lastTick = ctx.tick; } },
  leave: {
    keys: (d, w) => E.mergeKeys({ writes: [`pos:${d.key}`] }, Vehicles.leaveKeys(d, w), Dock.leaveKeys(d, w)), // fúrik pustí, spolujazdec vystúpi (#158); z loďky na breh (#160)
    run(s, d, ctx) { const pos = sl(s, `pos:${d.key}`) || ctx.reject(null); pos.lastTick = ctx.tick; Vehicles.onLeave(s, d); Dock.onLeave(s, d, ctx, pos); }
  },
  // pripojenie (d: { key, name, look, start: { coins, rep }, quick }): nové alebo prevedené uloženie, vzhľad, uvítanie;
  // server po vykonaní pošle hráčovi svet (pokyn joined). quick = rýchle znovupripojenie (bez hlásení)
  join: {
    keys: (d, w) => E.mergeKeys({ writes: [`save:${d.key}`, 'maxRep'].concat(Object.keys(redeemOf(w)).length ? ['redeem'] : []), reads: savesOf(w)[d.key] ? [`pos:${d.key}`] : [] }, Spiders.joinKeys(d, w)),
    run(s, d, ctx) {
      let sv = sl(s, `save:${d.key}`);
      const fresh = !sv;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- staršie záznamy denníka štartový kapitál nemajú
      if (fresh || !sv) { sv = newSave(ctx.tick, d.start || { coins: 30, rep: 0 }); put(s, `save:${d.key}`, sv); s.maxRep = Math.max(s.maxRep || 0, sv.rep); }
      else migrateSave(sv, ctx.tick);
      sv.look = d.look && typeof d.look === 'object' ? { shirt: (d.look.shirt || '#4a90d9').slice(0, 9), hair: (d.look.hair || '#5b3a1a').slice(0, 9), hat: d.look.hat } : sv.look;
      const pos = sl(s, `pos:${d.key}`), area = pos && pos.area && D.AREAS.includes(pos.area) ? pos.area : 'garden';
      ctx.emit({ to: d.key, t: 'joined' });
      if (!d.quick) ctx.emit(toast$(E.ALL, area === 'garden' ? `${d.name} prišiel(a) do záhrady 🌼` : `${d.name} prišiel(a) – je ${D.AREA_IN[area]} ${D.AREA_FX[area].icon}`));
      const days = d.quick || !pos || pos.lastTick == null ? 0 : Math.max(0, Math.floor((ctx.tick - pos.lastTick) / TPD));
      if (days) ctx.emit(toast$(d.key, `Kým si bol(a) preč, ubehlo ${days} ${days === 1 ? 'deň' : days < 5 ? 'dni' : 'dní'}. Pozri sa, čo sa v záhrade zmenilo. 🌱`, 'day'));
      Spiders.onJoin(s, d, ctx, area); // pripojil sa priamo v Lese divov – pavúky sa zobudia
      if (s.redeem) { // to, čo v záhrade stálo na pozemku Dielne (#23) či na novej vode jazierka (#160), dostane prvý hráč, ktorý príde
        const got = Dielna.handRedeem(s.redeem, sv, ctx.tick);
        if (got.length) ctx.emit(toast$(d.key, `🎁 Záhrada sa zmenila: pri trhu je pozemok pre Dielňu s majstrom hodvábu a jazierko pri domčeku sa zväčšilo. Čo rástlo na týchto miestach, dostávaš ty: ${got.map(([id, n]) => `${n}× ${D.itemName(id)}`).join(', ')}. 🎁`, 'gift'));
      }
      const away = Mkt.awaySummary(sv); // obchody z knihy objednávok, kým nebol v hre (#112)
      if (away) ctx.emit(toast$(d.key, away, 'gift'));
      if (!sv.talked) { sv.talked = true; ctx.emit(toast$(d.key, 'Vitaj! Začínaš s pár semienkami a prázdnym vreckom. Pri babke na severe je nástenka so zákazkami. 👵', 'gift')); }
    }
  },
  // tanec v kruhu z húb (d: { key, now }): v noci sa k dvom tancujúcim (alebo jednému, ktorý vidí víly) zlietnu víly,
  // raz za noc; now = reálny čas správy (prítomnosť má emoteAt v ms), aby záznam v denníku bol úplný
  dance: {
    keys(d, w, presence) {
      const dancers = (presence || []).filter(p => inRing(p) && p.emote === 'dance' && d.now - (p.emoteAt ?? NaN) < DANCE_MS);
      return { writes: ['fairyNight', ...new Set(dancers.map(p => `save:${p.key}`))] };
    },
    run(s, d, ctx) {
      const me = who(ctx), tick = ctx.tick, min = D.minOfTick(tick);
      if (!inRing(me)) ctx.reject(null);
      if (!D.isNight(min)) ctx.reject('Huby pokojne spia. Možno v noci… 🌙');
      const day = D.dayOfTick(tick), nightId = min / 60 >= 12 ? day : day - 1;
      if (s.fairyNight === nightId) ctx.reject('Víly už dnes v noci odleteli. Príď zajtra. 🧚');
      const dancers = (ctx.presence || []).filter(p => inRing(p) && p.emote === 'dance' && d.now - (p.emoteAt ?? NaN) < DANCE_MS && sl(s, `save:${p.key}`));
      const saveOfDancer = (p: Presence): PlayerSave => must(sl(s, `save:${p.key}`));
      const seeFairies = dancers.some(p => saveOfDancer(p).vily > tick);
      if (dancers.length >= 2 || (dancers.length >= 1 && seeFairies)) {
        s.fairyNight = nightId;
        for (const p of dancers) { give(saveOfDancer(p), 'seed_papradie', 1, tick); give(saveOfDancer(p), 'seed_duhova', 1, tick); }
        ctx.emit(fx$('garden', 'fairies', 3.5, 3.5));
        ctx.emit(toast$(E.ALL, '🧚✨ Z húb sa vzniesli víly a roztancovali sa s ' + dancers.map(p => p.name).join(' a ') + '! Každému darovali papraďové semienko a dúhové semienko.', 'magic'));
      } else {
        ctx.emit(fx$('garden', 'glimmer', 3.5, 3.5));
        ctx.emit(toast$(d.key, 'Huby sa jemne rozžiarili… akoby čakali, kým sa k tancu pridá ešte niekto. ✨', 'magic'));
      }
    }
  },

  // --- políčka záhrady (d: { key, i }) ---
  till: {
    keys: d => ({ writes: [`tile:garden:${d.i}`, 'plotsUsed'], reads: ['up', 'weather'] }),
    run(s, d, ctx) {
      const t = garden(s, d.i);
      if (t.s) ctx.reject('Tu už je záhon.');
      const k = D.TILLABLE[t.g];
      if (!k || t.g === 'ring') ctx.reject(null);
      const lim = Econ.plotLimit(s.up);
      if (s.plotsUsed >= lim) ctx.reject(`Spoločné povolenie záhrady je na ${lim} políčok a všetky sú obrobené. Väčšie pole môže pre všetkých kúpiť ktokoľvek na trhu (záložka Vylepšiť), alebo motykou zarovnaj niektoré prázdne políčko.`);
      t.s = { k: must(k), w: s.weather === 'rain' ? 1 : 0, r: 0, p: null, o: d.key };
      s.plotsUsed++;
      ctx.emit(fx$('garden', 'dirt', d.i % D.W + 0.5, Math.floor(d.i / D.W) + 0.5));
    }
  },
  // zarovnať prázdne políčko (ktorýkoľvek hráč) – uvoľní miesto v spoločnom povolení; čerstvo zarovnaná zem semienka nemá
  level: {
    keys: d => ({ writes: [`tile:garden:${d.i}`, 'plotsUsed', 'scav'] }),
    run(s, d, ctx) {
      const t = garden(s, d.i);
      if (!D.canLevel(t)) ctx.reject(null);
      t.s = null; s.plotsUsed--;
      Scav.empty(s.scav, ctx.tick, d.i);
    }
  },
  // motykou odstrániť uhynutú rastlinu (záhon ostáva)
  // (na vode zmizne aj „záhon“ a uvoľní miesto v povolení)
  clear: {
    keys: d => ({ writes: [`tile:${d.area || 'garden'}:${d.i}`, ...waterKeys(d.area, d.i)] }),
    run(s, d, ctx) {
      const t = tileIn(s, d.area || 'garden', d.i), p = t.s && t.s.p;
      if (!t.s || !p || !p.d) ctx.reject(null);
      else if (t.s.k === 'water') { t.s = null; s.plotsUsed--; } else t.s.p = null;
    }
  },
  water: {
    keys: d => ({ writes: [`tile:garden:${d.i}`, `save:${d.key}`] }),
    run(s, d, ctx) {
      const t = garden(s, d.i), sv = saveOf(s, d.key, ctx);
      if (!t.s) { ctx.reject(null); return; }
      if (sv.water <= 0) ctx.reject('Krhla je prázdna – načri vodu v jazierku alebo v studni. 💧');
      sv.water--; t.s.w = 1;
      ctx.emit(fx$('garden', 'drops', d.i % D.W + 0.5, Math.floor(d.i / D.W) + 0.5));
    }
  },
  compost: {
    keys: d => ({ writes: [`tile:garden:${d.i}`, `save:${d.key}`] }),
    run(s, d, ctx) {
      const t = garden(s, d.i), sv = saveOf(s, d.key, ctx);
      if (!t.s || t.s.r) { ctx.reject(null); return; }
      if (!take(sv, 'compost', 1, ctx.tick)) ctx.reject(null);
      t.s.r = 1;
    }
  },
  // d: { key, i, item: 'seed_<druh>', area? }; vodný druh sa sadí priamo do vody svojej vodnej plochy a zóny (#38)
  plant: {
    keys: d => ({ writes: [`tile:${d.area || 'garden'}:${d.i}`, `save:${d.key}`, ...waterKeys(d.area, d.i)], reads: ['eternal', ...(D.waterSpot(d.area || 'garden', d.i) ? ['up'] : [])] }),
    run(s, d, ctx) {
      const area = d.area || 'garden', t = tileIn(s, area, d.i), sv = saveOf(s, d.key, ctx), spId = d.item.slice(5), sp = lookup(D.SPECIES, spId);
      if (!sp || !D.isSpeciesId(spId)) { ctx.reject(null); return; }
      const spot = t.g === 'water' ? D.waterSpot(area, d.i) : null, err = D.aquaPlantError(spId, spot ? spot.body : null, spot ? spot.zone : null);
      if (err) ctx.reject(err);
      if (spot) {
        if (t.s) ctx.reject(t.s.p && t.s.p.d ? 'Tu je uhynutá rastlina – najprv ju odstráň motykou.' : null);
        if (!sp.seasons.includes(season(ctx.tick)) && !s.eternal) ctx.reject(`${sp.name} sa sadí v období: ${sp.seasons.map(x => must(D.SEASONS[x])).join(', ')}.`);
        const lim = Econ.plotLimit(s.up);
        if (s.plotsUsed >= lim) ctx.reject(WATER_PERMIT(lim));
        if (!D.isItemId(d.item) || !take(sv, d.item, 1, ctx.tick)) ctx.reject(null);
        t.s = { k: 'water', w: 1, r: 0, p: { sp: spId, prog: 0, q: 3, dry: 0 }, o: d.key };
        s.plotsUsed++;
        ctx.emit(fx$(area, 'splash', d.i % D.W + 0.5, Math.floor(d.i / D.W) + 0.5));
        return;
      }
      if (area !== 'garden') ctx.reject(null);
      if (!t.s) { ctx.reject('Najprv zem prekopaj motykou.'); return; }
      if (t.s.p) ctx.reject(null);
      if (!sp.seasons.includes(season(ctx.tick)) && !s.eternal) ctx.reject(`${sp.name} sa sadí v období: ${sp.seasons.map(x => must(D.SEASONS[x])).join(', ')}.`);
      if (!D.isItemId(d.item) || !take(sv, d.item, 1, ctx.tick)) ctx.reject(null);
      t.s.p = { sp: spId, prog: 0, q: 3, dry: 0 };
      if (sp.strict && t.s.k !== sp.soil) ctx.emit(toast$(d.key, `Hmm, ${sp.name} tu asi nebude rásť…`));
    }
  },
  // divé semienko (d.item = 'wild_<obdobie>'): druh sa určí teraz podľa cien kvetov a už sa nezmení; hráč ho uvidí, až keď vyklíči
  plantWild: {
    keys: d => ({ writes: [`tile:garden:${d.i}`, `save:${d.key}`], reads: ['eternal', 'market:fl_*'] }),
    run(s, d, ctx) {
      const t = garden(s, d.i), sv = saveOf(s, d.key, ctx), item = d.item;
      if (!D.isWild(item)) { ctx.reject(null); return; }
      if (!t.s) { ctx.reject('Najprv zem prekopaj motykou.'); return; }
      if (t.s.p) ctx.reject(null);
      const ws = D.wildSeason(item);
      if (ws !== season(ctx.tick) && !s.eternal) ctx.reject(`Toto divé semienko je z obdobia ${must(D.SEASONS[ws]).toLowerCase()} – vtedy ho aj zasaď.`);
      if (!take(sv, item, 1, ctx.tick)) ctx.reject(null);
      const m = { flowers: sl(s, 'market:fl_*') };
      t.s.p = { sp: Scav.pickWild(ctx.rng, ws, sp => Econ.flowerPrice(m, ctx.tick, sp)), prog: 0, q: 3, dry: 0, wild: 1 };
      ctx.emit(toast$(d.key, 'Zasadil(a) si divé semienko. Čo z neho vyrastie? 🤔'));
    }
  },
  pick: {
    keys: d => ({ writes: [`tile:${d.area || 'garden'}:${d.i}`, `save:${d.key}`, ...waterKeys(d.area, d.i)] }),
    run(s, d, ctx) {
      const area = d.area || 'garden', t = tileIn(s, area, d.i), sv = saveOf(s, d.key, ctx), p = t.s && t.s.p;
      if (!t.s || !p || p.d || p.prog < D.SPECIES[p.sp].days) { ctx.reject('Tu nič nekvitne.'); return; }
      const sp = D.SPECIES[p.sp];
      if (p.sp === 'papradie' && !D.isNight(D.minOfTick(ctx.tick))) ctx.reject('Papraď drží púčik pevne zatvorený… vraj sa otvára len v noci. 🌙');
      const n = Math.min(4, p.q + (t.s.r ? 1 : 0));
      give(sv, `fl_${p.sp}`, n, ctx.tick);
      t.s.r = 0;
      if (sp.perennial) { p.prog = sp.days * 0.5; p.q = 3; p.bt = null; } else if (t.s.k === 'water') { t.s = null; s.plotsUsed--; } else t.s.p = null;
      ctx.emit(toast$(d.key, `+${n}× ${sp.name}` + (n >= 3 ? ' ⭐ výborná kvalita!' : '')));
      if (p.sp === 'papradie') ctx.emit(toast$(E.ALL, `✨ ${nameOf(ctx, d.key)} našiel(a) papraďový kvet! Môže si niečo priať…`, 'magic'));
      ctx.emit(fx$(area, p.sp === 'papradie' ? 'sparkle' : 'pop', d.i % D.W + 0.5, Math.floor(d.i / D.W) + 0.5, { c: sp.color }));
    }
  },

  // --- hľadanie divých semienok v tráve: hráč sa prikrčí na D.SCAVENGE.ticks krokov (udalosť scavDone, events.js) ---
  // d: { key, i, seeds }; server po vykonaní nastaví prítomnosť (pl.scav) podľa správy scavStart; značka n = id vstupu
  scavStart: {
    keys: d => ({ reads: [`tile:garden:${d.i}`] }),
    run(s, d, ctx) {
      who(ctx);
      if (!Scav.canSearch(sl(s, `tile:garden:${d.i}`))) ctx.reject(null);
      ctx.emit({ to: d.key, t: 'scavStart', i: d.i, n: ctx.id, seeds: d.seeds });
      ctx.scheduleUnique(`scavDone:${d.key}`, ctx.tick + D.SCAVENGE.ticks, 'scavDone', { key: d.key, n: ctx.id, i: d.i, seeds: d.seeds });
    }
  },
  // hráč prestal hľadať (pohol sa, urobil niečo iné, ide spať, odišiel z plochy): zruší čakajúcu udalosť
  scavStop: {
    keys: () => ({}),
    run(s, d, ctx) { ctx.cancel(`scavDone:${d.key}`); }
  },

  // --- ľad a voda (d: { key, area, i }) ---
  digIce: {
    keys: d => ({ writes: [`tile:${d.area}:${d.i}`, `save:${d.key}`] }),
    run(s, d, ctx) {
      const t = sl(s, `tile:${d.area}:${d.i}`), sv = saveOf(s, d.key, ctx);
      if (!t) { ctx.reject(null); return; }
      if ((sv.inv.ice || 0) >= D.ICE_CARRY) ctx.reject(`Viac ľadu neunesieš (najviac ${D.ICE_CARRY}). Odnes ho do ľadovne – kým sa neroztopí. 🧊`);
      const r = Ice.digIce([t], 0, season(ctx.tick));
      if (!r.ok) ctx.reject(r.msg);
      give(sv, 'ice', 1, ctx.tick);
      const w = D.areaSize(d.area).w;
      ctx.emit(toast$(d.key, r.msg ?? ''));
      ctx.emit(fx$(d.area, 'ice', d.i % w + 0.5, Math.floor(d.i / w) + 0.5));
    }
  },
  // Ľadovňa: hráč do nej vloží ľad z batohu (najviac toľko, koľko sa zmestí). d: { key, n }
  fillIce: {
    keys: d => ({ writes: ['icehouse', 'storage', `save:${d.key}`] }),
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx);
      if (!s.icehouse.built) ctx.reject('Ľadovňa ešte nie je postavená. Kúpiš ju na trhu (záložka Vylepšiť). 🧊');
      if (!nearIcehouse(me)) ctx.reject('Podíď bližšie k ľadovni.');
      const n = Math.min(d.n | 0, sv.inv.ice || 0);
      if (n <= 0) ctx.reject('Nemáš ľad. Vysekáš ho krompáčom na ľadovci v horách, v zime aj na jazierku. ⛏️');
      const k = Ice.fillIcehouse(s.icehouse, s.storage, ctx.tick, n);
      if (!k) ctx.reject('Ľadovňa je plná. 🧊');
      take(sv, 'ice', k, ctx.tick);
      ctx.emit(toast$(d.key, `🧊 Vložil(a) si ${k}× ľad. V ľadovni je ${Math.ceil(s.icehouse.ice)}/${D.ICEHOUSE.cap}.`));
      ctx.emit(fx$('garden', 'ice', D.ICEHOUSE.lot.x0 + 1, D.ICEHOUSE.lot.y0 + 1));
    }
  },
  // Izolácia ľadovne (#23): hráč vloží 1 hodvábnu prikrývku. d: { key }
  insulate: {
    keys: d => ({ writes: ['icehouse', `save:${d.key}`] }),
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx);
      if (!nearIcehouse(me)) ctx.reject('Podíď bližšie k ľadovni.');
      const before = D.insulLevel(s.icehouse.bl);
      const err = Ice.insulate(s.icehouse, sv);
      if (err) ctx.reject(err);
      const B = D.ICEHOUSE, bl = s.icehouse.bl, lvl = D.insulLevel(bl), next = B.blankets[lvl + 1];
      const pct = Math.round(must(B.insul[lvl]) * 100);
      if (lvl > before) ctx.emit(toast$(E.ALL, `🧶 ${nameOf(ctx, d.key)} izoloval(a) ľadovňu hodvábnymi prikrývkami – izolácia úrovne ${lvl}! Ľad sa v nej topí už len na ${pct} %.`, 'gift'));
      else ctx.emit(toast$(d.key, `🧶 Vložil(a) si prikrývku do ľadovne (${bl}/${String(next)}). Pri ${String(next)} prikrývkach bude izolácia úrovne ${lvl + 1}.`));
      ctx.emit(fx$('garden', 'ice', B.lot.x0 + 1, B.lot.y0 + 1));
    }
  },
  // krhla do vody (jazierko, pleso, studňa); v zime voda zamrzne – načrieť sa dá len cez vysekaný otvor (#87)
  drawWater: {
    keys: d => ({ writes: [`save:${d.key}`], reads: [`tile:${d.area}:${d.i}`] }),
    run(s, d, ctx) {
      const t = sl(s, `tile:${d.area}:${d.i}`), sv = saveOf(s, d.key, ctx);
      if (!t || (t.g !== 'water' && t.g !== 'well')) { ctx.reject(null); return; }
      if (t.g === 'water' && !t.cut && season(ctx.tick) === 3) ctx.reject(D.frozenWaterText(d.area));
      sv.water = Econ.canCap(sv);
      const w = D.areaSize(d.area).w;
      ctx.emit(fx$(d.area, 'splash', d.i % w + 0.5, Math.floor(d.i / w) + 0.5));
    }
  },

  // --- studňa prianí (d: { key }): 5 mincí za náhodu; dážď mení počasie a záhradu, preto ich deklaruje vždy ---
  // Výsledok podľa jedného hodu r (prahy WELL): keď dážď nemôže prísť (už prší, v zime), je to „nič“ – žiadny prepad
  // do ďalšieho riadku. Papraďové semienko najviac raz za obdobie (sv.wellFern = číslo obdobia), inak tiež nič.
  well: {
    keys: d => ({ writes: [`save:${d.key}`, ...RAIN_KEYS] }),
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx), g = ctx.rng;
      if (sv.coins < 5) ctx.reject('Na prianie potrebuješ hodiť do studne 5 🪙.');
      sv.coins -= 5;
      const r = g.rand();
      if (r < WELL.tip) ctx.emit(toast$(d.key, '🪙 Žbluňk… Zo studne zašepkal hlas: „' + must(g.pick(D.TIPS)) + '“', 'magic'));
      else if (r < WELL.seeds) {
        const sp = must(g.pick(WELL_SEEDS));
        give(sv, `seed_${sp}`, 2, ctx.tick);
        ctx.emit(toast$(d.key, `🪙 Žbluňk… Z hĺbky vyletelo vrecúško: 2× semienka ${D.SPECIES[sp].name}!`, 'gift'));
      } else if (r < WELL.rain) {
        if (s.weather !== 'rain' && season(ctx.tick) !== 3) {
          rain(s, ctx);
          ctx.emit(toast$(E.ALL, '🪙 Studňa zahučala a z neba sa spustil dážď!', 'magic'));
        } else ctx.emit(toast$(d.key, '🪙 Studňa zahučala, ale obloha ostala bez zmeny. Možno inokedy.'));
      } else if (r < WELL.fern) {
        const no = seasonNo(ctx.tick);
        if (sv.wellFern === no) ctx.emit(toast$(d.key, '🪙 Na dne sa niečo zalesklo… no studňa si papraď tento raz nechala. Skús to v ďalšom období.', 'magic'));
        else {
          sv.wellFern = no;
          give(sv, 'seed_papradie', 1, ctx.tick);
          ctx.emit(toast$(d.key, '🪙 Na dne studne sa niečo zalesklo… Papraďové semienko!', 'magic'));
        }
      } else if (r < WELL.gold) {
        sv.coins += WELL_GOLD;
        ctx.emit(toast$(d.key, `🪙 Studňa zabublala a vystrelil z nej gejzír mincí! +${String(WELL_GOLD)} 🪙`, 'gift'));
      } else if (r < WELL.potion) {
        const k = must(g.pick(WELL_POTIONS));
        give(sv, `po_${k}`, 1, ctx.tick);
        ctx.emit(toast$(d.key, `🪙 Na hladine sa vynorila fľaštička… ${D.POTIONS[k].name}!`, 'gift'));
      } else ctx.emit(toast$(d.key, '🪙 Žbluňk. Nič sa nestalo. Možno nabudúce.'));
      ctx.emit(fx$('garden', 'splash', 7.5, 28.5));
    }
  },

  // --- elixíry (d: { key, kind, area, x, y }); kľúče podľa druhu: okolité záhony, dážď, všetci prítomní (dúha)… ---
  potion: {
    keys(d, w, presence) {
      const sv = `save:${d.key}`;
      switch (d.kind) {
        case 'rast': { // okrem záhonov aj herbár vlastníkov divých rastlín, ktoré vyklíčia (revealWild)
          const idx = around(d.x, d.y, 1), writes = new Set([sv, ...tileKeys(idx)]);
          for (const i of idx) { const t = gardenOf(w)[i], p = t && t.s && t.s.p; if (t && t.s && p && p.wild && t.s.o && Object.hasOwn(savesOf(w), t.s.o)) writes.add(`save:${t.s.o}`); }
          return { writes: [...writes] };
        }
        case 'jar': return { writes: [sv, ...tileKeys(around(d.x, d.y, 1))] };
        case 'hojnost': return { writes: [sv, ...tileKeys(around(d.x, d.y, 2))] };
        case 'dazd': return { writes: [sv, ...RAIN_KEYS] };
        case 'duha': return { writes: [...new Set([sv, ...(presence || []).map(p => `save:${p.key}`)]), 'tile:garden:*'] };
        default: return { writes: [sv] };
      }
    },
    run(s, d, ctx) {
      const k = d.kind, sv = saveOf(s, d.key, ctx), name = nameOf(ctx, d.key);
      if (k === 'laska') ctx.reject('Tento elixír treba darovať niekomu milému – postav sa k inému hráčovi. 💕');
      if (!D.isPotionId(k) || !take(sv, `po_${k}` satisfies `po_${PotionId}`, 1, ctx.tick)) { ctx.reject(null); return; }
      const cx = d.x + 0.5, cy = d.y + 0.5;
      if (k === 'rast') {
        const idx = around(d.x, d.y, 1), tiles = tilesFrom(s, idx), saves: Partial<Record<PlayerKey, PlayerSave>> = {};
        for (const key of Object.keys(s)) if (key.startsWith('save:')) saves[key.slice(5)] = sl(s, `save:${key.slice(5)}`);
        for (const i of idx) {
          const t = must(tiles[i]);
          if (t.s && t.s.p && !t.s.p.d) { const sp = D.SPECIES[t.s.p.sp]; t.s.p.prog = Math.min(sp.days, t.s.p.prog + 1); t.s.w = 1; Events.revealWild(tiles, saves, i); }
        }
        ctx.emit(fx$('garden', 'sparkle', cx, cy, { c: '#7ed957' }));
      } else if (k === 'dazd') {
        rain(s, ctx);
        ctx.emit(toast$(E.ALL, `🌧️ ${name} privolal(a) dážď!`, 'magic'));
      } else if (k === 'jar') {
        for (const i of around(d.x, d.y, 1)) { const t = garden(s, i); if (t.s && t.s.p && !t.s.p.d) t.s.p.b = 1; }
        ctx.emit(fx$('garden', 'sparkle', cx, cy, { c: '#f48fb1' }));
        ctx.emit(toast$(d.key, 'Tieto kvety teraz rastú v každom ročnom období. 🌸'));
      } else if (k === 'hojnost') {
        for (const i of around(d.x, d.y, 2)) { const t = garden(s, i); if (t.s) { t.s.r = 1; if (t.s.p && !t.s.p.d) t.s.p.q = 3; } }
        ctx.emit(fx$('garden', 'sparkle', cx, cy, { c: '#ffd54f' }));
      } else if (k === 'vily') {
        sv.vily = ctx.tick + TPD;
        ctx.scheduleUnique(`vilyEnd:${d.key}`, sv.vily, 'vilyEnd', { key: d.key });
        ctx.emit(toast$(d.key, 'Svet sa zatrblietal… Teraz vidíš víly. Možno by si v noci mal(a) zájsť do lesa ku kruhu z húb. 🧚', 'magic'));
      } else if (k === 'duha') { // všetci pripojení hráči dostanú mince, kvety v záhrade najvyššiu kvalitu
        for (const p of ctx.presence || []) { const o = sl(s, `save:${p.key}`); if (o) o.coins += 300; }
        for (const t of sl(s, 'tile:garden:*')) if (t.s && t.s.p && !t.s.p.d) t.s.p.q = 3;
        ctx.emit({ to: E.ALL, t: 'fx', k: 'rainbow' });
        ctx.emit(toast$(E.ALL, `🌈 ${name} uvaril(a) Dúhový elixír! Nad záhradou sa klenie dúha. Všetci dostávajú 300 🪙 a kvety najvyššiu kvalitu!`, 'magic'));
      } else if (k === 'sliz') {
        const me = who(ctx);
        ctx.emit(toast$(d.key, 'Vypil(a) si čudný sliz. Chvíľu si videl(a) farby, ktoré neexistujú. 🫠'));
        ctx.emit(fx$(me.area, 'burp', me.x, me.y));
      }
    }
  },

  // --- iný hráč (d: { key, to, item? }) ---
  gift: {
    keys: d => ({ writes: [`save:${d.key}`, `save:${d.to}`] }),
    run(s, d, ctx) {
      const me = who(ctx), other = byKey(ctx.presence, d.to), sv = saveOf(s, d.key, ctx), osv = saveOf(s, d.to, ctx), item = d.item;
      if (!other) { ctx.reject(null); return; }
      if (item === 'ice' && (osv.inv.ice || 0) >= D.ICE_CARRY) ctx.reject(`${other.name} už viac ľadu neunesie (najviac ${D.ICE_CARRY}).`);
      const b = D.isItemId(item) ? take(sv, item, 1, ctx.tick) : null;
      if (!b || !D.isItemId(item)) { ctx.reject(null); return; }
      give(osv, item, 1, ctx.tick, b);
      ctx.emit(toast$(d.key, `Daroval(a) si ${other.name}: ${D.itemName(item)} 🎁`));
      ctx.emit(toast$(d.to, `${me.name} ti daroval(a): ${D.itemName(item)} 🎁`, 'gift'));
      ctx.emit(fx$(me.area, 'gift', other.x, other.y));
    }
  },
  love: {
    keys: d => ({ writes: [`save:${d.key}`, `save:${d.to}`] }),
    run(s, d, ctx) {
      const me = who(ctx), other = byKey(ctx.presence, d.to), sv = saveOf(s, d.key, ctx), osv = saveOf(s, d.to, ctx);
      if (!other || !take(sv, 'po_laska', 1, ctx.tick)) { ctx.reject(null); return; }
      give(sv, 'seed_duhova', 2, ctx.tick); give(osv, 'seed_duhova', 2, ctx.tick);
      sv.coins += 50; osv.coins += 50;
      ctx.emit(fx$(me.area, 'hearts', (me.x + other.x) / 2, (me.y + other.y) / 2));
      ctx.emit(toast$(E.ALL, `💕 ${me.name} daroval(a) ${other.name} Elixír lásky! Obaja dostávajú dúhové semienka.`, 'magic'));
    }
  },
  // zamávanie (náradie alebo prázdna ruka pri inom hráčovi) – nič sa nemení, len efekt
  wave: {
    keys: () => ({}),
    run(s, d, ctx) { const me = who(ctx), other = byKey(ctx.presence, d.to); if (!other) { ctx.reject(null); return; } ctx.emit(fx$(me.area, 'wave', other.x, other.y)); }
  },

  // --- trh (#112): všetko ide cez knihu objednávok tovaru (market.ts). Návrh deklaruje knihu tovaru, svoje uloženie
  // a účty vlastníkov všetkých objednávok v knihe (Mkt.bookKeys). Tovar bez knihy (elixíry, zvädnuté kvety, ľad,
  // čarovné semienka) trh vykúpi za pevnú cenu (Econ.sellFixed) – len batoh hráča.
  // Okamžitý nákup / predaj (d: { key, id, n, lim }): príkaz, ktorý zoberie, čo v knihe je (najviac za lim / aspoň za lim
  // za kus), a zvyšok zruší
  buy: {
    keys: (d, w) => ({ writes: B.isBookItem(d.id) ? Mkt.bookKeys(w, d.id, d.key) : [`save:${d.key}`] }),
    run(s, d, ctx) { instant(s, d, 'buy', ctx); }
  },
  sell: {
    keys: (d, w) => ({ writes: B.isBookItem(d.id) ? Mkt.bookKeys(w, d.id, d.key) : [`save:${d.key}`] }),
    run(s, d, ctx) {
      if (B.isBookItem(d.id)) { instant(s, d, 'sell', ctx); return; }
      if (!nearStall(who(ctx))) { ctx.reject(AT_STALL); return; }
      const r = Econ.sellFixed({ seeds: {}, flowers: {}, compost: null }, ctx.tick, saveOf(s, d.key, ctx), d.id, d.n);
      if (!r.n) ctx.reject(r.msg);
      ctx.emit(toast$(d.key, r.msg));
    }
  },
  // Dopyt / Ponuka (d: { key, id, side, n, p }): limitná objednávka; čo sa prekrýva s knihou, vybaví sa hneď, zvyšok čaká
  order: {
    keys: (d, w) => ({ writes: B.isBookItem(d.id) ? Mkt.bookKeys(w, d.id, d.key) : [`save:${d.key}`] }),
    run(s, d, ctx) {
      const item = d.id;
      if (!nearStall(who(ctx))) { ctx.reject(AT_STALL); return; }
      if (!B.isBookItem(item)) { ctx.reject('Toto sa na trhu neobchoduje.'); return; }
      const mk = Mkt.mkOf(s, ctx, d.key), r = Mkt.playerOrder(mk, item, d.key, nameOf(ctx, d.key), d.side, d.n, d.p, false);
      if ('err' in r) { ctx.reject(r.err); return; }
      Mkt.announce(mk);
      if (r.cx) ctx.emit(toast$(d.key, Mkt.selfCancelText(item, d.side, r.cx), 'gift'));
      const name = D.itemName(item), buy = d.side === 'buy';
      const now = r.got ? `${buy ? 'Kúpené' : 'Predané'} hneď ${String(r.got)}× ${name} za ${String(r.coins)} 🪙${buy ? ' (čaká v Moje)' : ''}. ` : '';
      const wait = r.rest ? `${buy ? 'Dopyt' : 'Ponuka'}: ${String(r.rest)}× ${name} za ${String(d.p)} 🪙/ks čaká v knihe (Moje).` : '';
      if (now || wait) ctx.emit(toast$(d.key, '🏷️ ' + (now + wait).trim(), 'gift'));
    }
  },
  // Vyzdvihnutie tovaru z trhu (d: { key, id: tovar }): z Moje → Na vyzdvihnutie do batohu – len pri stánku
  collect: {
    keys: d => ({ writes: [`save:${d.key}`] }),
    run(s, d, ctx) {
      if (!nearStall(who(ctx))) { ctx.reject('Tovar si vyzdvihneš pri trhovom stánku – podíď bližšie.'); return; }
      const sv = saveOf(s, d.key, ctx), n = D.isItemId(d.id) ? Mkt.collect(sv, d.id, ctx.tick) : 0;
      if (!n) { ctx.reject('Tu nič nečaká.'); return; }
      ctx.emit(toast$(d.key, `📦 Vyzdvihnuté: ${String(n)}× ${D.itemName(d.id)}`));
    }
  },
  // Zrušenie vlastnej objednávky (d: { key, id: '<tovar>#<n>' }): len tá objednávka a uloženie hráča; záloha ide do
  // batohu, preto len pri stánku
  cancelOrder: {
    keys: d => { const r = Mkt.parseOrderId(d.id); return { writes: r ? [`market:book:${r.item}:${String(r.n)}`, `save:${d.key}`] : [`save:${d.key}`] }; },
    run(s, d, ctx) {
      if (!nearStall(who(ctx))) { ctx.reject('Objednávku zrušíš pri trhovom stánku – podíď bližšie.'); return; }
      const r = Mkt.parseOrderId(d.id), err = r ? Mkt.cancelOrder(s, d.key, r.item, r.n, ctx) : 'Táto objednávka už nie je otvorená.';
      if (err || !r) { ctx.reject(err); return; }
      ctx.emit(toast$(d.key, `Objednávka zrušená – záloha (${D.itemName(r.item)}) sa ti vrátila.`));
    }
  },
  // vylepšenie (d: { key, kind }); spoločné (povolenie na pole) patrí záhrade – kľúč 'up'
  upgrade: {
    keys: d => { const u = lookup(D.UPGRADES, d.kind); return { writes: u && u.shared ? [`save:${d.key}`, 'up'] : [`save:${d.key}`] }; },
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx), kind = d.kind;
      const err = Econ.upgrade(s.up, sv, kind);
      if (err || !Econ.isUpgradeId(kind)) { ctx.reject(err); return; }
      const u = D.UPGRADES[kind], lvl = kind === 'plots' ? s.up.plots : sv.up[kind];
      if (u.shared) ctx.emit(toast$(E.ALL, `${u.icon} ${nameOf(ctx, d.key)} kúpil(a) pre celú záhradu ${u.name}: ${must(u.levels[lvl]).v} ${u.unit} pre všetkých!`, 'gift'));
      else ctx.emit(toast$(d.key, `${u.icon} ${u.name}: úroveň ${lvl} (${must(u.levels[lvl]).v} ${u.unit})`, 'gift'));
    }
  },
  buyTool: {
    keys: d => ({ writes: [`save:${d.key}`] }),
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx), id = d.id;
      const err = Ice.buyTool(sv, id);
      if (err) ctx.reject(err);
      const T = must(lookup(D.TOOLS, id));
      ctx.emit(toast$(d.key, `${T.icon} Kúpil(a) si: ${T.name}. ${T.desc}`, 'gift'));
    }
  },
  // stavba (d: { key, id: 'icehouse' | 'dielna' }): spoločná stavba, platí ju hráč; pozemok v záhrade dostane budovu
  build: {
    keys: d => ({ writes: [d.id === 'dielna' ? 'dielna' : 'icehouse', 'tile:garden:*', `save:${d.key}`, 'corners'] }),
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx), dielna = d.id === 'dielna', tiles = sl(s, 'tile:garden:*');
      const err = dielna ? Dielna.buildDielna(s.dielna, tiles, sv) : Ice.buildIcehouse(s.icehouse, tiles, sv);
      if (err) ctx.reject(err);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- svet bez pavúkov (testy) kúty nemá
      if (s.corners) Spiders.pruneCorners(s.corners, tiles, 'garden'); // kúty, ktoré budova zakryla
      ctx.emit(toast$(E.ALL, dielna
        ? `🪚 ${nameOf(ctx, d.key)} postavil(a) pri trhu Dielňu! Kúp do nej krosná – utkajú prikrývky z hodvábu lacnejšie než majster.`
        : `🧊 ${nameOf(ctx, d.key)} postavil(a) pri domčeku ľadovňu! Naplň ju ľadom – kým v nej je, kvety v sklade vädnú 4× pomalšie.`, 'gift'));
    }
  },
  // --- pavúčí hodváb (#23): majster hodvábu a krosná v Dielni (d: { key }) ---
  buyLoom: {
    keys: d => ({ writes: ['dielna', `save:${d.key}`] }),
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx);
      if (!Dielna.nearDielna(me)) ctx.reject('Podíď bližšie k Dielni.');
      const err = Dielna.buyLoom(s.dielna, sv);
      if (err) ctx.reject(err);
      ctx.emit(toast$(E.ALL, `🧶 ${nameOf(ctx, d.key)} kúpil(a) do Dielne krosná! Utkajú prikrývku zo ${D.BLANKET_SILK} hodvábu – bez platenia, len to chvíľu trvá. Majster hodvábu sa s dedinkou rozlúčil – už ho tu netreba.`, 'gift'));
    }
  },
  masterWeave: {
    keys: d => ({ writes: [`save:${d.key}`], reads: ['dielna'] }), // keď sú v Dielni krosná, majster nechodí
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx);
      const why = Dielna.masterCheck(me, ctx.tick, s.dielna);
      if (why) ctx.reject(why);
      const err = Dielna.masterWeave(sv);
      if (err) ctx.reject(err);
      ctx.emit(toast$(d.key, '🧶 Majster ti utkal hodvábnu prikrývku. Vlož ju do ľadovne – ťukni na ňu s prikrývkou v ruke.', 'gift'));
      const m = must(D.masterAt(D.dayOfTick(ctx.tick), D.minOfTick(ctx.tick)) ?? undefined);
      ctx.emit(fx$('garden', 'sparkle', m.x, m.y, { c: '#f3efe6' }));
    }
  },
  loomStart: {
    keys: d => ({ writes: ['dielna', `save:${d.key}`] }),
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx);
      if (!Dielna.nearDielna(me)) ctx.reject('Podíď bližšie k Dielni.');
      const r = Dielna.loomStart(s.dielna, sv, d.key, ctx.tick, ctx.rng.rand());
      if ('err' in r) { ctx.reject(r.err); return; }
      ctx.scheduleUnique(`loomDone:${d.key}`, r.at, 'loomDone', { key: d.key });
      ctx.emit(toast$(d.key, `🧶 Krosná tkajú tvoju prikrývku. Hotová bude asi o ${Math.round((r.at - ctx.tick) / D.TICKS_PER_HOUR)} h herného času.`));
    }
  },
  loomTake: {
    keys: d => ({ writes: ['dielna', `save:${d.key}`] }),
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx);
      if (!Dielna.nearDielna(me)) ctx.reject('Podíď bližšie k Dielni.');
      const n = Dielna.loomTake(s.dielna, sv, d.key);
      if (!n) ctx.reject('V Dielni na teba nečaká žiadna prikrývka.');
      ctx.emit(toast$(d.key, `🧶 Vzal(a) si si ${n}× hodvábnu prikrývku. Vlož ju do ľadovne – ťukni na ňu s prikrývkou v ruke.`, 'gift'));
    }
  },

  // --- zákazky u babky (d: { key, id }) ---
  ctake: {
    keys: d => ({ writes: ['contracts'], reads: [`save:${d.key}`] }),
    run(s, d, ctx) {
      const err = Econ.takeContract(s.contracts, ctx.tick, saveOf(s, d.key, ctx), d.key, d.id | 0);
      if (err) ctx.reject(err);
      ctx.emit(toast$(d.key, '📋 Zákazka je tvoja. Termín platí – nezabudni!'));
    }
  },
  cdeliver: {
    keys: d => ({ writes: ['contracts', `save:${d.key}`, 'maxRep'] }),
    run(s, d, ctx) {
      const r = Econ.deliverContract(s.contracts, ctx.tick, saveOf(s, d.key, ctx), d.key, d.id | 0, s.maxRep, ctx);
      if (!r.n) ctx.reject(r.msg);
      s.maxRep = r.maxRep;
      ctx.emit(toast$(d.key, r.msg, r.done ? 'gift' : 'info'));
      if (r.done) ctx.emit(fx$('garden', 'hearts', D.BABKA.x + 0.5, D.BABKA.y + 0.5));
    }
  },

  // --- kotlík (d: { key, items: [3× 'fl_…'] }) ---
  brew: {
    keys: d => ({ writes: [`save:${d.key}`] }),
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx);
      const items = Array.isArray(d.items) ? d.items.map(String).slice(0, 3) : [];
      if (items.length !== 3 || !items.every(id => id.startsWith('fl_'))) ctx.reject(null);
      const need: Record<string, number> = {};
      for (const id of items) need[id] = (need[id] || 0) + 1;
      for (const [id, n] of Object.entries(need)) if ((D.isItemId(id) ? sv.inv[id] || 0 : 0) < n) ctx.reject('Tieto kvety nemáš.');
      for (const [id, n] of Object.entries(need)) if (D.isItemId(id)) take(sv, id, n, ctx.tick);
      const recipe = items.map(id => id.slice(3)).sort().join('+');
      const k = lookup(D.RECIPES, recipe) || 'sliz';
      give(sv, `po_${k}`, 1, ctx.tick);
      if (k !== 'sliz' && !sv.recipes.includes(recipe)) sv.recipes.push(recipe);
      ctx.emit(fx$('garden', 'brew', 17.5, 5.5, { c: D.POTIONS[k].color }));
      // sliz: rada podľa najbližšieho receptu (počíta sa pred zápisom nového receptu – ten pri slize aj tak nepribudne)
      ctx.emit(k === 'sliz' ? { to: d.key, t: 'brewed', k, hint: D.brewHint(items.map(id => D.speciesOfItem(id)).filter(x => x !== null), sv.recipes) } : { to: d.key, t: 'brewed', k });
      if (k === 'duha') ctx.emit(toast$(E.ALL, `🌈 V kotlíku babky sa niečo dúhovo rozžiarilo… ${nameOf(ctx, d.key)} uvaril(a) niečo, čo tu ešte nebolo!`, 'magic'));
    }
  },
  // prianie za papraďový kvet (d: { key, kind }): zlato platí len pripojeným hráčom (podľa prítomnosti)
  wish: {
    keys(d, w, presence) {
      const sv = `save:${d.key}`;
      if (d.kind === 'zlato') return { writes: [...new Set([sv, ...(presence || []).map(p => `save:${p.key}`)])] };
      if (d.kind === 'jar') return { writes: [sv, 'eternal', 'tile:garden:*'] };
      return { writes: [sv] };
    },
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx);
      if (!take(sv, 'fl_papradie', 1, ctx.tick)) ctx.reject(null);
      if (d.kind === 'zlato') {
        // celú sumu dostane ten, kto si prial, ostatní pripojení menší podiel – inak by sa zlato s hráčmi násobilo (#100)
        let others = 0;
        for (const p of ctx.presence || []) { const o = sl(s, `save:${p.key}`); if (o && p.key !== d.key) { o.coins += WISH_GOLD.others; others++; } }
        sv.coins += WISH_GOLD.me;
        ctx.emit({ to: E.ALL, t: 'fx', k: 'gold' });
        ctx.emit(toast$(E.ALL, others
          ? `✨ ${me.name} si prial(a) zlatý dážď! ${me.name} dostáva ${String(WISH_GOLD.me)} 🪙 a každý ďalší hráč ${String(WISH_GOLD.others)} 🪙.`
          : `✨ ${me.name} si prial(a) zlatý dážď a dostáva ${String(WISH_GOLD.me)} 🪙.`, 'magic'));
      } else if (d.kind === 'jar') {
        s.eternal = true;
        for (const t of sl(s, 'tile:garden:*')) if (t.s) t.s.w = 1;
        ctx.emit({ to: E.ALL, t: 'fx', k: 'rainbow' });
        ctx.emit(toast$(E.ALL, `✨ ${me.name} si prial(a) večnú jar! Záhrada sa odteraz polieva sama a kvetom nevadí ročné obdobie.`, 'magic'));
      } else {
        // bez papraďového semienka: inak by sa papraď z pokladu množila sama (#100)
        give(sv, 'seed_duhova', 3, ctx.tick); give(sv, 'seed_plesnivec', 3, ctx.tick);
        ctx.emit(toast$(E.ALL, `✨ ${me.name} si prial(a) poklad! Zo zeme vyrástla truhlica plná vzácnych semienok.`, 'magic'));
        ctx.emit(fx$(me.area, 'sparkle', me.x, me.y, { c: '#ffd700' }));
      }
    }
  },

  // --- sklad v domčeku (d: { key, id, n }); kvety si pri presune nesú svoj vek, v sklade starnú pomalšie ---
  store: {
    keys: d => ({ writes: ['storage', `save:${d.key}`], reads: ['icehouse'] }),
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx), id = d.id, n = d.n | 0;
      storeCheck(id, ctx);
      const b = D.isItemId(id) ? take(sv, id, n, ctx.tick) : null;
      if (!b || !D.isItemId(id)) { ctx.reject(null); return; }
      I.addItems(I.storageC(s.storage, s.icehouse), id, n, ctx.tick, b);
    }
  },
  unstore: {
    keys: d => ({ writes: ['storage', `save:${d.key}`], reads: ['icehouse'] }),
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx), id = d.id, n = d.n | 0;
      storeCheck(id, ctx);
      const b = D.isItemId(id) ? I.removeItems(I.storageC(s.storage, s.icehouse), id, n, ctx.tick) : null;
      if (!b || !D.isItemId(id)) { ctx.reject(null); return; }
      give(sv, id, n, ctx.tick, b);
    }
  },
  compostWilted: {
    keys: d => ({ writes: [`save:${d.key}`] }),
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx);
      const k = Math.floor((sv.inv.wilted || 0) / D.WILTED_PER_COMPOST);
      if (!k) ctx.reject(`Na 1 kompost treba ${D.WILTED_PER_COMPOST} zvädnuté kvety.`);
      take(sv, 'wilted', k * D.WILTED_PER_COMPOST, ctx.tick); give(sv, 'compost', k, ctx.tick);
      ctx.emit(toast$(d.key, `♻️ Zo zvädnutých kvetov vznikol ${k}× kompost.`, 'gift'));
    }
  }
};
// Spoločné podmienky skladu: náradie sa neukladá, ľad patrí do ľadovne, hráč musí stáť pri domčeku
function storeCheck(id: string, ctx: GameCtx): void {
  if (D.isTool(id)) ctx.reject(null);
  if (id === 'ice') ctx.reject('Ľad patrí do ľadovne – v sklade by sa roztopil. 🧊');
  if (!nearHouse(who(ctx))) ctx.reject('Sklad je v domčeku – podíď bližšie.');
}
