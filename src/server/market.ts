// Kniha objednávok trhu (#112): jedna kniha na tovar a záhradu, spoločná pre hráčov aj postavy (veľkoobchodník, Jano,
// Fero, Zuzka). Každá objednávka nesie vlastnú zálohu (mince dopytu, tovar ponuky s vekom kvetov). Obchod vzniká len
// v knihe: nová alebo zmenená objednávka sa hneď spáruje s čakajúcimi (settle), kým sa dopyt a ponuka prekrývajú;
// cena obchodu je limit staršej (čakajúcej) objednávky. Poradie výberu: najlepšia cena, pri rovnakej skôr zadaná,
// čakanie posúva dopredu (B.aging). Veľkoobchodník drží celú zásobu v ponukách po kusoch za ceny z prices.ts
// (každý kúpený kus zdraží ďalší, ako doteraz) a vykupuje cez dopyty kryté svojimi mincami; po každom obchode
// s ním sa jeho ponuky a dopyty toho tovaru prepočítajú (requote) – nič sa nepredáva ani nekupuje mimo knihy.
//
// Výrezy (engine.ts sliceOf): market:book:<tovar>:* = kniha tovaru (aj koordinačný kľúč párovania – dve objednávky
// toho istého tovaru sa v jednom kole nestretnú), market:book:<tovar>:<n> = jedna objednávka (zrušenie, vypršanie),
// market:npc:<postava> = účet postavy, market:seed_<druh> / market:fl_<druh> / market:compost = zásoba veľkoobchodníka
// (odvodená, pre ceny), market:news = správy. Návrh hráča deklaruje knihu tovaru, svoje uloženie a účty všetkých
// vlastníkov objednávok v knihe (bookKeys) – s kýmkoľvek sa spáruje, má ho deklarovaný.
import * as D from '../shared/data.ts';
import type { ItemId, SpeciesId } from '../shared/data.ts';
import * as B from '../shared/book.ts';
import type { Level } from '../shared/book.ts';
import type { OrderView } from '../shared/protocol.ts';
import type { Book, Market, NpcAccount, NpcId, Order, OrderSide, PlayerKey, PlayerSave, Trader } from '../shared/save.ts';
import { entries, keys, lookup, must, plural } from '../shared/util.ts';
import { maybe, sl } from './game.ts';
import type { GameCtx, GameSlices, GameWorld, Msg } from './game.ts';
import * as I from './items.ts';
import * as P from './prices.ts';
import type { MarketPart } from './prices.ts';
import type { Container, MovedBatch } from './world.ts';
export type { Container };

const TPD = D.TICKS_PER_DAY;
export const TRADERS: readonly Trader[] = ['jano', 'fero', 'zuzka'];
export const NPC_NAME: Readonly<Record<NpcId, string>> = { vo: '', jano: 'Jano', fero: 'Fero', zuzka: 'Zuzka' };
// Veľkoobchodník: koľko kusov vykupuje dopredu (hĺbka dopytov). Peniaze má v pokladni každého tovaru zvlášť; každé ráno
// mu odberatelia (zvonka) doplnia pokladňu tak, aby pokryla celý rebrík výkupu pri dnešnej zásobe (`need`), a čo má nad
// `skim` × need, odvedie (zisk). Tak výkup nikdy nevyschne, ale peniaze ani nerastú donekonečna.
export const WHOLESALE = { bidDepth: 20, compostBidDepth: 10, skim: 2, step: 5 } as const;   // step = najviac kusov v jednej objednávke cenníka
// Zuzka: každý deň dostane od svojich zákazníkov `budget` mincí na kvety (doplní na túto sumu); platí o `markup` viac než
// výkup veľkoobchodníka, `perSpecies` kusov každého druhu v sezóne, počas sviatku `festExtra` navyše. Kúpené kvety
// predá v kyticiach (zmiznú z jej účtu pri ďalšej návšteve).
export const ZUZKA = { budget: 250, markup: 1.15, perSpecies: 2, festExtra: 3 } as const;
// Záhradník Jano si nechá najviac purse mincí na nákup semienok; čo zarobí navyše, pri návšteve minie na živobytie
// (mince z hry odídu) – inak by mu za rok narástli do desiatok tisíc
export const JANO = { purse: 1000 } as const;

// Tovar s knihou (kľúče kníh): semienka a kvety pestovateľných druhov a kompost
export const BOOK_ITEMS: readonly ItemId[] = ['compost', ...P.PLANTABLE.flatMap(sp => [`seed_${sp}` as const, `fl_${sp}` as const])];
export const SEED_ITEMS: readonly ItemId[] = P.PLANTABLE.map(sp => `seed_${sp}` as const);
export const FLOWER_ITEMS: readonly ItemId[] = P.PLANTABLE.map(sp => `fl_${sp}` as const);
export const orderId = (item: ItemId, n: number): string => `${item}#${String(n)}`;
export function parseOrderId(id: string): { item: ItemId; n: number } | null {
  const i = id.lastIndexOf('#'), item = id.slice(0, i), n = Number(id.slice(i + 1));
  return i > 0 && B.isBookItem(item) && Number.isInteger(n) && n > 0 ? { item, n } : null;
}
// Kľúč výrezu so zásobou veľkoobchodníka (z nej sú jeho ceny)
export function stockKey(item: ItemId): string {
  if (item === 'compost') return 'market:compost';
  const sp = must(D.speciesOfItem(item) ?? undefined);
  return item.startsWith('seed_') ? `market:seed_${sp}` : `market:fl_${sp}`;
}
const speciesOf = (item: ItemId): SpeciesId | null => D.speciesOfItem(item);
const isFlower = B.isFlowerItem;

// ---------- Trh v návrhu ----------
// Čo potrebuje kniha od návrhu: knihu tovaru, účty, uloženia, zásobu veľkoobchodníka, správy, kontext.
// mkOf ich vezme z výrezov – buď celý trh a všetky uloženia (udalosti trhu: market:*, save:*), alebo úzke kľúče
// (akcia hráča nad jedným tovarom: bookKeys).
export interface Trade { item: ItemId; k: number; pay: number; buyer: Order; seller: Order }
// Zrušený prekryv dvoch objednávok toho istého hráča: k kusov z dopytu b aj z ponuky a
export interface SelfCancel { item: ItemId; k: number; buyer: Order; seller: Order }
// Kontext návrhu, ktorý kniha potrebuje (náhoda, plánovanie vypršania, prítomnosť, správy hráčom)
export type MkCtx = Pick<GameCtx, 'tick' | 'rng' | 'presence' | 'schedule' | 'scheduleUnique' | 'cancel'> & { emit(msg: Msg): void };
export interface Mk {
  tick: number;
  ctx: MkCtx | null;                  // null len pri založení trhu nad živým svetom (nikto nie je pripojený)
  actor: PlayerKey | null;              // hráč, ktorý návrh spustil – súhrn dostane od akcie, nie od knihy
  book(item: ItemId): Book;
  npc(id: Trader): NpcAccount;
  save(key: PlayerKey): PlayerSave | undefined;
  entry(item: ItemId): { stock: number; fest?: number };
  news(text: string): void;
  trades: Trade[];
  selfx: SelfCancel[];
  requote: Set<ItemId>;
}
export function mkOf(s: GameSlices, ctx: MkCtx, actor: PlayerKey | null): Mk {
  const all = maybe(s, 'market:*'), saves = maybe(s, 'save:*'), books = maybe(s, 'market:book:*'), npcs = maybe(s, 'market:npc:*');
  const seeds = maybe(s, 'market:seed_*'), flowers = maybe(s, 'market:fl_*'), compost = maybe(s, 'market:compost');
  const part = all ?? (seeds && flowers && compost ? { seeds, flowers, compost } : null);
  return {
    tick: ctx.tick, ctx, actor, trades: [], selfx: [], requote: new Set(),
    book: item => must(all ? all.books[item] : books ? books[item] : maybe(s, `market:book:${item}:*`)),
    npc: id => must(all ? all.npcs[id] : npcs ? npcs[id] : maybe(s, `market:npc:${id}`)),
    save: key => (saves ? saves[key] : maybe(s, `save:${key}`)),
    // kľúč zásoby tovaru (stockKey) vedie na položku { stock, fest? }
    entry: item => (part ? entryOf(part, item) : must(s[stockKey(item)] as { stock: number; fest?: number } | undefined)),
    news: text => { P.news({ news: all ? all.news : must(maybe(s, 'market:news')) }, ctx.tick, text); }
  };
}
// Kľúče udalosti postáv (návšteva, dodávka, Jano s kvetmi): knihy a zásoby tovaru items, účty postáv npcs, správy –
// a účty všetkých vlastníkov objednávok v týchto knihách (hráčov aj postáv – s nikým iným sa spárovať nedá)
export function npcEventKeys(world: Pick<GameWorld, 'market'>, items: readonly ItemId[], npcs: readonly Trader[], extra: readonly string[] = []): string[] {
  // zásoby veľkoobchodníka všetkého tovaru (malé položky – stratégia postáv ich číta), knihy len vybraného tovaru
  const set = new Set<string>(['market:news', 'market:seed_*', 'market:fl_*', 'market:compost', ...extra]);
  for (const id of npcs) set.add(`market:npc:${id}`);
  for (const item of items) {
    set.add(`market:book:${item}:*`);
    const b = world.market ? world.market.books[item] : undefined;
    for (const o of Object.values(b ? b.orders : {})) if (o && o.npc !== 'vo') set.add(ownerKey(item, o));
  }
  return [...set];
}
// Tovar, v ktorom má postava objednávky
export function npcOrderItems(m: Market, npc: Trader): ItemId[] {
  return BOOK_ITEMS.filter(item => Object.values(m.books[item]?.orders ?? {}).some(o => o?.npc === npc));
}
// Cena veľkoobchodníka (najlacnejší kus) pri zásobe stock
export const wholesaleAskAt = (item: ItemId, stock: number, tick: number): number => P.buyQuote(partAt(item, stock, undefined), tick, item)?.price ?? 0;
// Jano: semienko s najlepším očakávaným ziskom za deň (z dostupných, nie príliš drahých); stock = zásoba veľkoobchodníka
export function janoPick(stock: (item: ItemId) => number, tick: number): { sp: SpeciesId; p: number } | null {
  const se = P.season(tick);
  const cands = P.PLANTABLE.filter(sp => !D.SPECIES[sp].strict && !D.isAqua(sp) && stock(`seed_${sp}`) >= 3 && P.phase(sp, se) !== 'off') // jazierko nemá (#38)
    .map(sp => { const sc = D.SPECIES[sp], p = wholesaleAskAt(`seed_${sp}`, stock(`seed_${sp}`), tick); return { sp, p, score: (sc.sell * 2 - p) / sc.days, cheap: p <= sc.seed * 1.25 }; })
    .filter(c => c.cheap && c.score > 0).sort((a, b) => b.score - a.score);
  return cands[0] ?? null;
}
// Fero: semienka na ďalšie obdobie, ktorých je dosť a sú lacné
export function feroCands(stock: (item: ItemId) => number, tick: number): SpeciesId[] {
  const se = P.season(tick);
  return P.PLANTABLE.filter(sp => !D.SPECIES[sp].strict && P.phase(sp, se) === 'next' && stock(`seed_${sp}`) >= 8 && wholesaleAskAt(`seed_${sp}`, stock(`seed_${sp}`), tick) <= D.SPECIES[sp].seed * 1.05);
}
// Zuzka: kvety, ktoré chce (v sezóne, počas sviatku sviatočné), od sviatočných a najdrahších
export function zuzkaWanted(tick: number, festMult: Partial<Record<SpeciesId, number>> | null): SpeciesId[] {
  const se = P.season(tick);
  return P.PLANTABLE.filter(sp => (festMult && festMult[sp]) || D.SPECIES[sp].seasons.includes(se))
    .sort((a, b) => Number(!!(festMult && festMult[b])) - Number(!!(festMult && festMult[a])) || D.SPECIES[b].sell - D.SPECIES[a].sell);
}
// Knihy, ktorých sa návšteva postavy môže dotknúť (kľúče jej udalosti): kde má objednávky, čo drží, čo jej stratégia vyberie
export function visitItems(m: Market, npc: Trader, tick: number): ItemId[] {
  const set = new Set<ItemId>(npcOrderItems(m, npc)), a = m.npcs[npc];
  const stock = (item: ItemId): number => { const sp = speciesOf(item); return !sp ? m.compost.stock : (item.startsWith('seed_') ? m.seeds[sp] : m.flowers[sp])?.stock ?? 0; };
  for (const item of keys(a.inv)) if (B.isBookItem(item)) set.add(item);
  if (npc === 'jano') { const c = janoPick(stock, tick); if (c) set.add(`seed_${c.sp}`); }
  if (npc === 'fero') for (const sp of feroCands(stock, tick)) set.add(`seed_${sp}`);
  if (npc === 'zuzka') for (const sp of zuzkaWanted(tick, m.festival ? m.festival.mult : null)) set.add(`fl_${sp}`);
  return [...set];
}

// Trh nad celým svetom (založenie a prevod trhu pri načítaní)
export function mkWorld(world: Pick<GameWorld, 'saves' | 'tick'>, m: Market, ctx: MkCtx | null): Mk {
  return {
    tick: world.tick, ctx, actor: null, trades: [], selfx: [], requote: new Set(),
    book: item => must(m.books[item]), npc: id => m.npcs[id], save: key => world.saves[key], entry: item => entryOf(m, item),
    news: text => { P.news(m, world.tick, text); }
  };
}
function entryOf(m: Pick<Market, 'seeds' | 'flowers' | 'compost'>, item: ItemId): { stock: number; fest?: number } {
  if (item === 'compost') return m.compost;
  const sp = must(speciesOf(item) ?? undefined);
  return must(item.startsWith('seed_') ? m.seeds[sp] : m.flowers[sp]);
}
// Kľúče návrhu hráča nad tovarom item: kniha, zásoba a účet veľkoobchodníka (prepočet cien), správy, vlastné uloženie
// a účty všetkých vlastníkov objednávok v knihe. Čítajú sa z potvrdeného sveta; ak knihu v tom istom kole zmenil
// iný návrh, kľúče sa stretnú, návrh počká na ďalšie kolo a kľúče sa vypočítajú znova.
export function bookKeys(world: Pick<GameWorld, 'market'>, item: ItemId, key: PlayerKey): string[] {
  const set = new Set([`market:book:${item}:*`, stockKey(item), `save:${key}`]);
  const b = world.market ? world.market.books[item] : undefined;
  for (const o of Object.values(b ? b.orders : {})) if (o && o.npc !== 'vo') { set.add(ownerKey(item, o)); if (o.pl !== key) set.add('market:news'); }
  return [...set];
}
// Kľúč účtu vlastníka objednávky (veľkoobchodník má pokladňu v knihe tovaru)
export const ownerKey = (item: ItemId, o: Pick<Order, 'pl' | 'npc'>): string =>
  (o.pl != null ? `save:${o.pl}` : o.npc === 'vo' ? `market:book:${item}:*` : `market:npc:${must(o.npc)}`);

// ---------- Účty a záloha ----------
interface Acct { coins: { coins: number }; c: Container }
function acctOf(mk: Mk, item: ItemId, o: Pick<Order, 'pl' | 'npc'>): Acct {
  if (o.pl != null) { const sv = must(mk.save(o.pl)); return { coins: sv, c: I.playerC(sv) }; }
  const a = npcAcct(mk, item, must(o.npc));
  return { coins: a, c: npcC(a) };
}
const npcAcct = (mk: Mk, item: ItemId, id: NpcId): NpcAccount => (id === 'vo' ? mk.book(item).vo : mk.npc(id));
export function npcC(a: NpcAccount): Container { return { inv: a.inv, fb: a.fb, rate: 1 }; }
// Na vyzdvihnutie na trhu (#112): sem ide, čo hráč kúpil cez Dopyt, čo sa vrátilo z vypršanej ponuky a čo v ponuke
// zvädlo – nič sa neteleportuje do batohu, kým hráč nie je pri trhu. Kvety tu starnú normálne.
export function boxC(sv: PlayerSave): Container { const b = sv.box = sv.box || { inv: {}, fb: {} }; return { inv: b.inv, fb: b.fb, rate: 1 }; }
// Vyzdvihne všetok tovar item z trhu do batohu; vráti počet kusov
export function collect(sv: PlayerSave, item: ItemId, tick: number): number {
  const c = boxC(sv), n = c.inv[item] || 0;
  if (n > 0) I.addItems(I.playerC(sv), item, n, tick, I.removeItems(c, item, n, tick));
  if (!Object.keys(c.inv).length) delete sv.box;
  return n;
}
// Záloha ponuky ako kontajner (kvety vo várkach s vekom; v knihe starnú normálne, rýchlosťou 1)
function escrowC(item: ItemId, o: Order): Container {
  return { inv: { [item]: o.rem }, fb: o.fb ? { [item]: o.fb } : {}, rate: 1 };
}
// Odoberie k kusov zo zálohy ponuky (najstaršie prvé); vráti várky s vekom
function takeEscrow(item: ItemId, o: Order, k: number, tick: number): MovedBatch[] {
  const c = escrowC(item, o), out = must(I.removeItems(c, item, k, tick) ?? undefined);
  o.rem = c.inv[item] || 0;
  if (isFlower(item)) o.fb = c.fb[item] || [];
  return out;
}
// Vráti vlastníkovi celú zálohu objednávky (mince alebo tovar)
function release(item: ItemId, o: Order, a: Acct, tick: number): void {
  if (o.side === 'buy') { a.coins.coins += o.coins; o.coins = 0; return; }
  if (o.rem > 0) { const n = o.rem; I.addItems(a.c, item, n, tick, takeEscrow(item, o, n, tick)); }
}

// ---------- Zadanie, párovanie, zrušenie ----------
export interface NewOrder { side: OrderSide; pl?: PlayerKey; npc?: NpcId; nm: string; p: number; q: number; exp: number | null; ioc?: boolean }
// Vloží objednávku do knihy; zálohu (coins alebo várky batches) už vlastníkovi odobral volajúci
export function insert(mk: Mk, item: ItemId, o: NewOrder, coins: number, batches: MovedBatch[] | null): Order {
  const book = mk.book(item), n = book.next++;
  const ord: Order = { n, side: o.side, nm: o.nm, p: o.p, q: o.q, rem: o.side === 'sell' ? 0 : o.q, at: mk.tick, exp: o.exp, coins };
  if (o.pl != null) ord.pl = o.pl; else ord.npc = must(o.npc);
  if (o.ioc) ord.ioc = 1;
  if (o.side === 'sell') { const c = escrowC(item, ord); I.addItems(c, item, o.q, mk.tick, batches); ord.rem = c.inv[item] || 0; if (isFlower(item)) ord.fb = c.fb[item] || []; }
  book.orders[String(n)] = ord;
  if (o.pl != null && !o.ioc) { const sv = must(mk.save(o.pl)); (sv.orders = sv.orders || []).push(orderId(item, n)); }
  if (o.exp != null && !o.ioc && mk.ctx) mk.ctx.scheduleUnique('oExpire:' + orderId(item, n), o.exp, 'oExpire', { item, n });
  if (o.side === 'sell' && !o.ioc && mk.ctx) planWilt(mk.ctx, item, ord);
  return ord;
}
// Odstráni objednávku z knihy (záloha už musí byť vydaná)
function drop(mk: Mk, item: ItemId, o: Order): void {
  delete mk.book(item).orders[String(o.n)];
  if (o.pl != null) { const sv = mk.save(o.pl); if (sv && sv.orders) sv.orders = sv.orders.filter(x => x !== orderId(item, o.n)); }
  if (o.exp != null && !o.ioc && mk.ctx) mk.ctx.cancel('oExpire:' + orderId(item, o.n));
  if (o.side === 'sell' && isFlower(item) && !o.ioc && mk.ctx) mk.ctx.cancel('oWilt:' + orderId(item, o.n));
}
// Zruší objednávku v knihe (vráti zálohu vlastníkovi)
export function withdraw(mk: Mk, item: ItemId, o: Order): void { release(item, o, acctOf(mk, item, o), mk.tick); drop(mk, item, o); }

const prio = (o: Order, tick: number): number => (o.side === 'buy' ? o.p + B.aging(tick - o.at) : o.p - B.aging(tick - o.at));
// Objednávky jednej strany v poradí výberu: najlepšia (aj so starnutím) prvá, pri zhode skôr zadaná
export function side(book: Book, s: OrderSide, tick: number): Order[] {
  const list = Object.values(book.orders).filter((o): o is Order => !!o && o.side === s);
  return list.sort((a, b) => (s === 'buy' ? prio(b, tick) - prio(a, tick) : prio(a, tick) - prio(b, tick)) || a.n - b.n);
}
const sameOwner = (a: Order, b: Order): boolean => (a.pl != null ? a.pl === b.pl : a.npc === b.npc);

// Spáruje knihu tovaru, kým sa v nej nejaký dopyt a ponuka rôznych vlastníkov prekrývajú; po obchode veľkoobchodníka
// prepočíta jeho ponuky a dopyty (môžu sa znova prekryť – preto slučka). Každý krok buď vybaví kusy, alebo prepočíta
// ceny po obchode, takže slučka skončí; poistka len pre istotu.
export function settle(mk: Mk, item: ItemId): void {
  for (let guard = 0; guard < 1000; guard++) {
    if (crossOnce(mk, item)) continue;
    if (mk.requote.delete(item)) { requote(mk, item); continue; }
    return;
  }
}
function crossOnce(mk: Mk, item: ItemId): boolean {
  const book = mk.book(item), asks = side(book, 'sell', mk.tick);
  for (const b of side(book, 'buy', mk.tick)) for (const a of asks) {
    if (a.p > b.p) continue;
    if (!sameOwner(a, b)) { if (fill(mk, item, b, a)) return true; continue; }
    if (a.pl != null && selfCancel(mk, item, b, a)) return true;
  }
  return false;
}
// Sám so sebou sa neobchoduje (#112): keď sa dopyt a ponuka toho istého hráča prekrývajú, prekrývajúca sa časť sa
// v oboch zruší (ako „decrement and cancel“ na burze) – nijaký obchod, nijaký záznam v histórii cien ani v správach.
// Dopytu sa vráti záloha za zrušené kusy (mince hneď), ponuke tovar: z čakajúcej ponuky na vyzdvihnutie na trhu,
// z okamžitého príkazu späť do batohu (z neho práve odišiel). Postavy sa v knihe len obchádzajú.
function selfCancel(mk: Mk, item: ItemId, b: Order, a: Order): boolean {
  const k = Math.min(b.rem, a.rem), sv = mk.save(must(a.pl));
  if (k <= 0 || !sv) return false;
  const back = Math.min(b.coins, k * b.p);
  b.rem -= k; b.coins -= back; sv.coins += back;
  const batches = takeEscrow(item, a, k, mk.tick);
  I.addItems(a.ioc ? I.playerC(sv) : boxC(sv), item, k, mk.tick, batches);
  if (!b.ioc) b.cx = (b.cx || 0) + k;
  if (!a.ioc) a.cx = (a.cx || 0) + k;
  mk.selfx.push({ item, k, buyer: { ...b }, seller: { ...a } });
  if (a.rem <= 0) drop(mk, item, a);
  if (b.rem <= 0) { if (b.coins > 0) { sv.coins += b.coins; b.coins = 0; } drop(mk, item, b); }
  return true;
}
// Čakajúca strana obchodu (jej limit je cena): okamžitý príkaz nikdy nečaká; cenník veľkoobchodníka čaká vždy (jeho ďalší
// stupeň nastúpi až po obchode, ale je to stále ten istý vypísaný cenník); inak skôr zadaná objednávka.
function maker(b: Order, a: Order): Order {
  if (b.ioc || a.ioc) return b.ioc ? a : b;
  if (b.npc === 'vo' || a.npc === 'vo') return b.npc === 'vo' ? b : a;
  return b.n < a.n ? b : a;
}
// Obchod medzi dopytom b a ponukou a za limit čakajúcej z nich (maker). Postavy platia za kvety podľa čerstvosti
// (ako doteraz trh: cena × čerstvosť kusu). Dopytu sa vráti, o čo bol obchod lacnejší než jeho záloha.
function fill(mk: Mk, item: ItemId, b: Order, a: Order): boolean {
  const price = maker(b, a).p, tick = mk.tick, sp = speciesOf(item);
  const k = Math.min(b.rem, a.rem, Math.floor(b.coins / price));
  if (k <= 0) return false;
  const batches = takeEscrow(item, a, k, tick);
  let pay = k * price;
  if (b.npc && isFlower(item) && sp) { pay = 0; for (const x of batches) pay += x.n * B.freshPay(price, D.freshness(sp, x.age)); }
  const buyer = acctOf(mk, item, b), seller = acctOf(mk, item, a);
  b.coins -= pay; b.rem -= k;
  if (!b.ioc) { const extra = b.coins - b.rem * b.p; if (extra > 0) { buyer.coins.coins += extra; b.coins -= extra; } }
  seller.coins.coins += pay;
  // kúpené cez Dopyt čaká na trhu; okamžitý nákup ide rovno do batohu (hráč stojí pri trhu)
  I.addItems(b.pl != null && !b.ioc ? boxC(must(mk.save(b.pl))) : buyer.c, item, k, tick, batches);
  mk.trades.push({ item, k, pay, buyer: { ...b }, seller: { ...a } });
  logTrade(mk.book(item), tick, Math.round(pay / k), k);
  if (b.npc === 'vo' || a.npc === 'vo') mk.requote.add(item);
  if (b.npc) npcBought(mk, b.npc, item, k);
  if (a.rem <= 0) drop(mk, item, a);
  if (b.rem <= 0) { if (b.coins > 0) { buyer.coins.coins += b.coins; b.coins = 0; } drop(mk, item, b); }
  return true;
}
// Záznam obchodu v knihe (graf pri posuvníku ceny): staršie než TRADE_DAYS dní sa zahodia, najviac 200 záznamov
function logTrade(book: Book, tick: number, p: number, k: number): void {
  const from = tick - B.TRADE_DAYS * TPD, tr = (book.tr || []).filter(t => t[0] >= from);
  const last = tr[tr.length - 1];
  if (last && last[0] === tick && last[1] === p) last[2] += k; else tr.push([tick, p, k]);
  book.tr = tr.length > 200 ? tr.slice(-200) : tr;
}
// Rozdelenie cien obchodov za posledné TRADE_DAYS dní pre klienta: [cena, kusy], zoradené podľa ceny
export function tradeHist(m: Market, item: ItemId, tick: number): [number, number][] {
  const by = new Map<number, number>(), from = tick - B.TRADE_DAYS * TPD;
  for (const [t, p, k] of m.books[item]?.tr ?? []) if (t >= from) by.set(p, (by.get(p) ?? 0) + k);
  return [...by.entries()].sort((a, b) => a[0] - b[0]);
}
// Postava kúpila k kusov: Jano kúpené semienka hneď zasadí – o pár dní z nich prinesie dvakrát toľko kvetov (jano_sell).
// Iné postavy si tovar nechávajú (Fero ako zásobu, Zuzka do kytíc, veľkoobchodník na predaj).
function npcBought(mk: Mk, npc: NpcId, item: ItemId, k: number): void {
  const sp = speciesOf(item), ctx = mk.ctx;
  if (npc !== 'jano' || !sp || !item.startsWith('seed_') || !ctx) return;
  I.removeItems(npcC(mk.npc('jano')), item, k, mk.tick);
  const start = P.phase(sp, P.season(mk.tick)) === 'now' ? mk.tick : P.seasonStartTick(mk.tick, 1);
  ctx.schedule(Math.max(mk.tick + 1, start + D.SPECIES[sp].days * TPD + ctx.rng.int(TPD / 2)), 'jano_sell', { sp, n: k * 2 });
}

// Kedy vyprší nová objednávka: o ORDER_DAYS dní
export function expiry(tick: number): number { return tick + B.ORDER_DAYS * TPD; }
// Kvety v ponuke vädnú ako v batohu: udalosť oWilt:<id> príde, keď zvädne najstaršia várka ponuky
type Planner = Pick<MkCtx, 'scheduleUnique' | 'tick'>;
function planWilt(ctx: Planner, item: ItemId, o: Order): void {
  const sp = speciesOf(item);
  if (!sp || !isFlower(item) || !o.fb || !o.fb.length) return;
  const life = D.SPECIES[sp].life * TPD, oldest = Math.max(...o.fb.map(b => D.batchAge(b, ctx.tick, 1)));
  ctx.scheduleUnique('oWilt:' + orderId(item, o.n), Math.max(ctx.tick + 1, Math.ceil(ctx.tick + life - oldest)), 'oWilt', { item, n: o.n });
}
// Objednávka postavy: odoberie zálohu z jej účtu (dopyt: mince, ponuka: tovar; čo nemá, to nezadá) a spáruje knihu.
// Vráti zadanú objednávku (alebo null, ak nebolo čo zadať).
export function npcOrder(mk: Mk, npc: NpcId, item: ItemId, s: OrderSide, p: number, q: number): Order | null {
  const a = npcAcct(mk, item, npc), c = npcC(a);
  if (s === 'buy') q = Math.min(q, Math.floor(a.coins / p));
  else q = Math.min(q, a.inv[item] || 0);
  if (q <= 0 || p <= 0) return null;
  let batches: MovedBatch[] | null = null;
  if (s === 'buy') a.coins -= q * p; else batches = must(I.removeItems(c, item, q, mk.tick) ?? undefined);
  const o = insert(mk, item, { side: s, npc, nm: NPC_NAME[npc], p, q, exp: npc === 'vo' ? null : expiry(mk.tick) }, s === 'buy' ? q * p : 0, batches);
  if (npc !== 'vo') settle(mk, item);
  return o;
}
// Postava stiahne všetky svoje objednávky (pred novým rozhodnutím); items = len tieto tovary
export function npcWithdrawAll(mk: Mk, npc: NpcId, items: readonly ItemId[] = BOOK_ITEMS): void {
  for (const item of items) for (const o of Object.values(mk.book(item).orders)) if (o && o.npc === npc) withdraw(mk, item, o);
}

// ---------- Veľkoobchodník ----------
// Trh s jednou položkou a danou zásobou (pre ceny z prices.ts)
function partAt(item: ItemId, stock: number, fest: number | undefined): MarketPart {
  const sp = speciesOf(item), m: MarketPart = { seeds: {}, flowers: {}, compost: null };
  if (item === 'compost') m.compost = { stock };
  else if (sp && item.startsWith('seed_')) m.seeds[sp] = { stock };
  else if (sp) m.flowers[sp] = fest == null ? { stock } : { stock, fest };
  return m;
}
interface Rung { side: OrderSide; p: number; q: number }
// Cenník veľkoobchodníka pre zásobu stock a mince cash: predaj celej zásoby po kusoch (k-ty predaný kus stojí cenu pri
// zásobe stock − k), výkup bidDepth kusov (k-ty vykúpený kus za výkupnú cenu pri zásobe stock + k). Kvety nepredáva.
// Rovnaké susedné ceny tvoria jeden stupeň. V knihe je z každej strany len prvý stupeň (requote); keď sa vybaví,
// hneď nastúpi ďalší – je to pevné pravidlo dopĺňania, preto ho pohľad pre klienta (levels) ukáže celé.
// Rovnaké susedné ceny sa spoja do jednej objednávky.
// first = len prvý stupeň z každej strany (to, čo je v knihe) – rátanie ďalších kusov sa vtedy skončí pri prvej inej cene
export function ladder(item: ItemId, stock: number, cash: number, fest: number | undefined, tick: number, first = false, asks = true): Rung[] {
  const out: Rung[] = [];
  // pridá kus za cenu p; false = prvý stupeň strany je hotový (len pri first)
  const push = (s: OrderSide, p: number): boolean => {
    const l = out[out.length - 1];
    if (l && l.side === s && l.p === p && !(first && l.q >= WHOLESALE.step)) { l.q++; return true; }
    if (first && l && l.side === s) return false;
    out.push({ side: s, p, q: 1 });
    return true;
  };
  if (asks && !isFlower(item)) for (let k = 0; k < stock; k++) { const q = P.buyQuote(partAt(item, stock - k, fest), tick, item); if (q && !push('sell', q.price)) break; }
  const depth = item === 'compost' ? WHOLESALE.compostBidDepth : WHOLESALE.bidDepth;
  for (let k = 0; k < depth; k++) {
    const p = P.sellQuote(partAt(item, stock + k, fest), tick, item);
    if (p == null || p > cash || !push('buy', p)) break;
    cash -= p;
  }
  return out;
}
// Prepočíta ponuky a dopyty veľkoobchodníka pre tovar podľa jeho aktuálnej zásoby a mincí. Objednávky s cenou, ktorá
// v novom rebríku ostáva, sa len zmenšia či zväčšia (záloha sa dorovná, číslo a poradie ostanú), ostatné sa stiahnu
// a chýbajúce pribudnú – tak sa pri zmene zásoby o kus zmení len málo objednávok (a denník ostane malý).
// Vráti, či sa niečo zmenilo (bez zmeny sa kniha nemusí znova párovať – bola v poriadku).
// Vstupy cenníka veľkoobchodníka pre tovar (zásoba, mince, sviatok, obdobie) a jeho objednávky v knihe: keď sa od
// posledného prepočtu nezmenili, cenník je ten istý (ceny z prices.ts závisia len od zásoby, obdobia a sviatku)
function quoteKey(book: Book, item: ItemId, fest: number | undefined, tick: number): string {
  const vo = book.vo, cur = Object.values(book.orders).filter((o): o is Order => !!o && o.npc === 'vo').sort((a, b) => a.n - b.n);
  const text = `${String(vo.inv[item] || 0)}|${String(vo.coins)}|${String(fest ?? 1)}|${String(P.season(tick))}|${cur.map(o => o.side + String(o.p) + 'x' + String(o.rem)).join()}`;
  let h = 2166136261; // krátky odtlačok (FNV-1a), aby sa do uloženia nepísal celý text
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
export function requote(mk: Mk, item: ItemId): boolean {
  const book = mk.book(item), vo = book.vo, c = npcC(vo), entry = mk.entry(item), tick = mk.tick;
  if (book.q === quoteKey(book, item, entry.fest, tick)) return false;
  const changed = requoteNow(mk, item, book, vo, c, entry, tick);
  book.q = quoteKey(book, item, entry.fest, tick);
  return changed;
}
function requoteNow(mk: Mk, item: ItemId, book: Book, vo: NpcAccount, c: Container, entry: { stock: number; fest?: number }, tick: number): boolean {
  const cur = Object.values(book.orders).filter((o): o is Order => !!o && o.npc === 'vo').sort((a, b) => a.n - b.n);
  const stock = (vo.inv[item] || 0) + cur.reduce((a, o) => a + (o.side === 'sell' ? o.rem : 0), 0);
  const cash = vo.coins + cur.reduce((a, o) => a + (o.side === 'buy' ? o.coins : 0), 0);
  entry.stock = stock;
  const target = ladder(item, stock, cash, entry.fest, tick, true);
  const sig = (l: readonly { side: OrderSide; p: number }[], q: (i: number) => number): string => l.map((x, i) => x.side + String(x.p) + 'x' + String(q(i))).sort().join();
  if (sig(cur, i => must(cur[i]).rem) === sig(target, i => must(target[i]).q)) return false;
  const want = new Map(target.map(r => [r.side + String(r.p), r.q]));
  const keep = new Map<string, Order>();
  // najprv uvoľniť: stiahnuť, čo v rebríku nie je (alebo je tam dvakrát), zmenšiť, čo je priveľké
  for (const o of cur) {
    const k = o.side + String(o.p), q = want.get(k);
    if (q == null || keep.has(k)) { withdraw(mk, item, o); continue; }
    keep.set(k, o);
    if (o.rem > q) {
      const d = o.rem - q;
      if (o.side === 'buy') { o.rem = q; o.coins -= d * o.p; vo.coins += d * o.p; } else I.addItems(c, item, d, tick, takeEscrow(item, o, d, tick));
      o.q = Math.max(o.q, o.rem);
    }
  }
  // potom doplniť: zväčšiť ponechané, pridať nové
  for (const r of target) {
    const o = keep.get(r.side + String(r.p));
    if (!o) { npcOrder(mk, 'vo', item, r.side, r.p, r.q); continue; }
    const d = r.q - o.rem;
    if (d <= 0) continue;
    if (r.side === 'buy') { const k = Math.min(d, Math.floor(vo.coins / o.p)); vo.coins -= k * o.p; o.coins += k * o.p; o.rem += k; }
    else {
      const k = Math.min(d, vo.inv[item] || 0), e = escrowC(item, o);
      if (k > 0) { I.addItems(e, item, k, tick, must(I.removeItems(c, item, k, tick) ?? undefined)); o.rem = e.inv[item] || 0; if (isFlower(item)) o.fb = e.fb[item] || []; }
    }
    o.q = Math.max(o.q, o.rem);
  }
  return true;
}
// Prepočet cien veľkoobchodníka všetkých tovarov (alebo vybraných) a spárovanie kníh, ktoré sa zmenili
export function requoteAll(mk: Mk, items: readonly ItemId[] = BOOK_ITEMS): void {
  for (const item of items) if (requote(mk, item) || mk.requote.has(item)) settle(mk, item);
}

// Zrušenie objednávky v úzkom návrhu (výrez jednej objednávky market:book:<tovar>:<n> a účet vlastníka): záloha
// späť vlastníkovi, objednávka z knihy von. Hráčovi v uložení ubudne zo zoznamu otvorených objednávok.
// Výrez jednej objednávky (kľúč so zloženým tovarom a číslom: typ výrezu podľa šablóny kľúča sa tu neodvodí)
const orderSlice = (s: GameSlices, item: ItemId, n: number): Order | undefined => s[`market:book:${item}:${String(n)}`] as Order | undefined;
// toBox = tovar hráčovi na vyzdvihnutie (vypršanie, keď nie je pri trhu), inak do batohu (zrušenie pri trhu)
function removeNarrow(s: GameSlices, item: ItemId, n: number, ctx: GameCtx, toBox = false): Order | null {
  const key = `market:book:${item}:${String(n)}`, o = orderSlice(s, item, n);
  if (!o) return null;
  const sv = o.pl != null ? sl(s, `save:${o.pl}`) : undefined, a = o.npc ? sl(s, `market:npc:${o.npc}`) : undefined;
  const acct: Acct | null = sv ? { coins: sv, c: toBox ? boxC(sv) : I.playerC(sv) } : a ? { coins: a, c: npcC(a) } : null;
  if (!acct) return null;
  const view: Order = { ...o };
  release(item, o, acct, ctx.tick);
  if (sv && sv.orders) sv.orders = sv.orders.filter(x => x !== orderId(item, n));
  s[key] = undefined;
  ctx.cancel('oExpire:' + orderId(item, n)); ctx.cancel('oWilt:' + orderId(item, n));
  return view;
}
// Hráč key ruší svoju objednávku
export function cancelOrder(s: GameSlices, key: PlayerKey, item: ItemId, n: number, ctx: GameCtx): string | null {
  const o = orderSlice(s, item, n);
  if (!o || o.pl !== key) return 'Táto objednávka už nie je otvorená.';
  removeNarrow(s, item, n, ctx);
  return null;
}
// Objednávka vypršala (udalosť oExpire): záloha späť; hráčovi v hre správa
export function expireOrder(s: GameSlices, item: ItemId, n: number, ctx: GameCtx): void {
  const o = removeNarrow(s, item, n, ctx, true);
  if (!o || o.pl == null || !(ctx.presence || []).some(p => p.key === o.pl)) return;
  const back = o.side === 'buy' ? `${String(o.coins)} 🪙` : `${String(o.rem)}× ${D.itemName(item)} (čaká na trhu v Moje)`;
  ctx.emit({ to: o.pl, t: 'toast', text: `⌛ ${o.side === 'buy' ? 'Tvoj dopyt' : 'Tvoja ponuka'} na ${D.itemName(item)} vypršal(a) – vrátené: ${back}.`, kind: 'info' });
}
// Udalosť oWilt: kvety v ponuke, ktoré dožili, zvädnú – z ponuky von (dead), hráčovi ako zvädnuté kvety na vyzdvihnutie
// (dajú sa skompostovať), postave sa zahodia. Kým v ponuke niečo ostane, naplánuje sa ďalšia várka.
export function wiltOrder(s: GameSlices, item: ItemId, n: number, ctx: GameCtx): void {
  const o = orderSlice(s, item, n), sp = speciesOf(item);
  if (!o || !sp || !o.fb) return;
  const life = D.SPECIES[sp].life * TPD, k = o.fb.filter(b => D.batchAge(b, ctx.tick, 1) >= life).reduce((a, b) => a + b.n, 0);
  if (k > 0) {
    takeEscrow(item, o, k, ctx.tick);
    o.dead = (o.dead || 0) + k;
    const sv = o.pl != null ? sl(s, `save:${o.pl}`) : undefined;
    if (sv) {
      I.addItems(boxC(sv), 'wilted', k, ctx.tick);
      if ((ctx.presence || []).some(p => p.key === o.pl)) ctx.emit({ to: must(o.pl), t: 'toast', text: `🥀 V tvojej ponuke zvädlo ${String(k)}× ${D.itemName(item)} – zvädnuté kvety čakajú na trhu v Moje.`, kind: 'info' });
    }
  }
  if (o.rem <= 0) { removeNarrow(s, item, n, ctx, true); return; }
  planWilt(ctx, item, o);
}

// ---------- Hráč ----------
// Okamžitý (ioc) alebo limitný príkaz hráča key nad tovarom item: n kusov za najviac / aspoň p za kus.
// Vráti chybu (nič sa nestalo) alebo výsledok: vybavené kusy a mince, koľko čaká v knihe.
export function playerOrder(mk: Mk, item: ItemId, key: PlayerKey, name: string, s: OrderSide, n: number, p: number, ioc: boolean): { err: string } | { got: number; coins: number; rest: number; cx: number; o: Order } {
  const sv = must(mk.save(key)), tick = mk.tick, sp = speciesOf(item);
  if (!B.isBookItem(item) || D.isTool(item)) return { err: 'Toto sa na trhu neobchoduje.' };
  const minRep = sp && item.startsWith('seed_') ? D.MIN_SEED_REP[sp] : undefined;
  if (s === 'buy' && sp && minRep && D.repLevel(sv.rep || 0) < minRep) return { err: `Semienka ${D.SPECIES[sp].name} môžu kupovať len záhradníci s reputáciou ${String(minRep)}.` };
  if (!ioc && (sv.orders || []).length >= B.orderLimit(sv.rep || 0)) {
    const lim = B.orderLimit(sv.rep || 0);
    return { err: `Naraz môžeš mať len ${String(lim)} ${plural(lim, 'otvorenú objednávku', 'otvorené objednávky', 'otvorených objednávok')}. Vyššia reputácia ti dovolí viac.` };
  }
  let coins = 0, batches: MovedBatch[] | null = null;
  if (s === 'buy') {
    coins = ioc ? Math.min(sv.coins, n * p) : n * p;
    if (coins > sv.coins || coins <= 0) return { err: 'Nemáš dosť mincí. 🪙' };
    sv.coins -= coins;
  } else {
    if (ioc) n = Math.min(n, sv.inv[item] || 0);
    if (n <= 0 || (sv.inv[item] || 0) < n) return { err: 'Toľko toho nemáš.' };
    batches = must(I.removeItems(I.playerC(sv), item, n, tick) ?? undefined);
  }
  const o = insert(mk, item, { side: s, pl: key, nm: name, p, q: n, exp: ioc ? null : expiry(tick), ioc }, coins, batches);
  settle(mk, item);
  let got = 0, paid = 0;
  for (const t of mk.trades) if ((s === 'buy' ? t.buyer : t.seller).pl === key && (s === 'buy' ? t.buyer : t.seller).n === o.n && t.item === item) { got += t.k; paid += t.pay; }
  // prekryv s vlastnou objednávkou druhej strany sa zrušil (selfCancel)
  let cx = 0;
  for (const x of mk.selfx) if (x.item === item && (s === 'buy' ? x.buyer : x.seller).n === o.n) cx += x.k;
  const live = mk.book(item).orders[String(o.n)];
  if (ioc && live) withdraw(mk, item, live);
  return { got, coins: paid, rest: !ioc && live ? live.rem : 0, cx, o };
}

// Obchody z návrhu oznámi: hráčom v hre správou, ostatným do súhrnu po prihlásení; obchody hráčov (nie s veľkoobchodníkom)
// aj do správ na trhu. Hráč, ktorý návrh spustil, dostane súhrn od akcie.
// Správa hráčovi o zrušenom prekryve s jeho vlastnou objednávkou druhej strany (s = strana novej objednávky)
export function selfCancelText(item: ItemId, s: OrderSide, k: number): string {
  return s === 'buy'
    ? `🏷️ ${String(k)}× ${D.itemName(item)} z tvojej ponuky – sám od seba nekúpiš, prekryv sa zrušil; tovar čaká na vyzdvihnutie v Moje.`
    : `🏷️ ${String(k)}× ${D.itemName(item)} pre tvoj dopyt – sám sebe nepredáš, prekryv sa zrušil; záloha dopytu sa ti vrátila.`;
}
export function announce(mk: Mk): void {
  const online = new Set((mk.ctx?.presence || []).map(p => p.key));
  for (const t of mk.trades) {
    const unit = Math.round(t.pay / t.k), name = D.itemName(t.item);
    for (const [o, verb] of [[t.seller, 'predané'], [t.buyer, 'kúpené']] as const) {
      if (o.pl == null || o.pl === mk.actor) continue;
      const other = o === t.seller ? t.buyer : t.seller, who = other.nm || 'veľkoobchodník';
      const box = o.side === 'buy' ? ' Čaká na trhu v Moje.' : '';
      if (online.has(o.pl) && mk.ctx) mk.ctx.emit({ to: o.pl, t: 'toast', text: `🏷️ ${o.side === 'sell' ? 'Tvoja ponuka' : 'Tvoj dopyt'}: ${verb} ${String(t.k)}× ${name} za ${String(t.pay)} 🪙 (${who}).${box}`, kind: 'gift' });
      else { const sv = mk.save(o.pl); if (sv) { const aw = sv.away = sv.away || {}, k = `${o.side}:${t.item}`, cur = aw[k] || { n: 0, c: 0 }; aw[k] = { n: cur.n + t.k, c: cur.c + t.pay }; } }
    }
    if ((t.seller.pl != null || t.buyer.pl != null) && t.seller.npc !== 'vo' && t.buyer.npc !== 'vo') {
      mk.news(`🏷️ ${t.seller.nm} predal(a) ${String(t.k)}× ${name} za ${String(unit)} 🪙/ks – kúpil(a) ${t.buyer.nm}.`);
    }
  }
  mk.trades.length = 0;
}
// Súhrn obchodov, kým hráč nebol v hre (pri prihlásení); vymaže ho
export function awaySummary(sv: PlayerSave): string | null {
  const aw = sv.away;
  delete sv.away;
  if (!aw) return null;
  const sold: string[] = [], bought: string[] = [];
  for (const [k, v] of entries(aw)) {
    const [s, item = ''] = k.split(':');
    (s === 'sell' ? sold : bought).push(`${String(v.n)}× ${D.itemName(item)} za ${String(v.c)} 🪙`);
  }
  const parts = [sold.length ? 'predal(a) si ' + sold.join(', ') : '', bought.length ? 'kúpil(a) si ' + bought.join(', ') + ' (čaká na trhu v Moje)' : ''].filter(Boolean);
  return parts.length ? `🏷️ Kým si nebol(a) v hre, ${parts.join(' a ')}.` : null;
}

// ---------- Postavy ----------
// Najvyšší dopyt iných vlastníkov po tovare (alebo null)
function bestBid(mk: Mk, item: ItemId, not: NpcId): number | null {
  const b = side(mk.book(item), 'buy', mk.tick).find(o => o.npc !== not);
  return b ? b.p : null;
}
// Veľkoobchodníkova cena predaja (najlacnejšia jeho ponuka), alebo cena podľa vzorca, keď nemá zásobu
function wholesaleAsk(mk: Mk, item: ItemId): number {
  const q = P.buyQuote(partAt(item, mk.entry(item).stock, undefined), mk.tick, item);
  return q ? q.price : 0;
}
const flowerQuote = (mk: Mk, sp: SpeciesId): number => { const e = mk.entry(`fl_${sp}`); return P.flowerPrice({ flowers: { [sp]: e } }, mk.tick, sp); };

// Záhradník Jano: stiahne staré objednávky, kvety, ktoré má, ponúkne za 0,8 výkupnej ceny (ako doteraz – tlačí výkup
// dole), a kúpi semienka s najlepším očakávaným ziskom za deň – dopyt za cenu veľkoobchodníka. Pestuje len to,
// čo naozaj kúpi (npcBought); zvyšok dopytu čaká v knihe do ďalšej návštevy.
// items = knihy, ktoré návšteva deklarovala (visitItems)
export function janoVisit(mk: Mk, g: { int(n: number): number }, items: readonly ItemId[]): void {
  const tick = mk.tick, jano = mk.npc('jano'), has = new Set(items);
  npcWithdrawAll(mk, 'jano', items);
  if (jano.coins > JANO.purse) jano.coins = JANO.purse;
  I.wiltSweep(npcC(jano), tick); delete jano.inv.wilted;
  for (const sp of P.PLANTABLE) if (has.has(`fl_${sp}`)) janoOffer(mk, sp);
  const c = janoPick(item => mk.entry(item).stock, tick);
  if (!c || !has.has(`seed_${c.sp}`)) return;
  const k = Math.min(mk.entry(`seed_${c.sp}`).stock - 1, 2 + g.int(5));
  if (k <= 0) return;
  const before = mk.trades.length, o = npcOrder(mk, 'jano', `seed_${c.sp}`, 'buy', c.p, k);
  const got = mk.trades.slice(before).filter(t => t.buyer.npc === 'jano').reduce((s, t) => s + t.k, 0);
  if (got) mk.news(`🧑‍🌾 Záhradník Jano nakúpil ${String(got)}× semienka ${D.SPECIES[c.sp].name}.`);
  const rest = o ? mk.book(`seed_${c.sp}`).orders[String(o.n)] : undefined;
  if (rest) mk.news(`🧑‍🌾 Jano chce kúpiť ${String(rest.rem)}× semienka ${D.SPECIES[c.sp].name} za ${String(rest.p)} 🪙.`);
}
// Jano ponúkne všetky kvety druhu sp za 0,8 výkupnej ceny (tá klesá s každým predaným kusom – ponuka zoberie len
// dopyty nad touto cenou, zvyšok čaká v knihe)
function janoOffer(mk: Mk, sp: SpeciesId): number {
  const n = mk.npc('jano').inv[`fl_${sp}`] || 0;
  if (!n) return 0;
  npcOrder(mk, 'jano', `fl_${sp}`, 'sell', Math.max(1, Math.round(flowerQuote(mk, sp) * 0.8)), n);
  return n;
}
// Jano prinesie vypestované kvety (n kusov druhu sp) na trh
export function janoSell(mk: Mk, sp: SpeciesId, n: number): void {
  I.addItems(npcC(mk.npc('jano')), `fl_${sp}`, n, mk.tick);
  npcWithdrawAll(mk, 'jano', [`fl_${sp}`]);
  janoOffer(mk, sp);
  mk.news(`🧑‍🌾 Jano priniesol na trh ${String(n)}× ${D.SPECIES[sp].name} – výkupná cena klesla.`);
}

// Špekulant Fero: semienka, ktoré drží, ponúkne lacnejšie než veľkoobchodník, keď sú drahé (≥ 1,5× základnej ceny),
// mimo sezóny ich predá do výkupu; potom skúpi lacné semienka na ďalšie obdobie (dopyt za cenu veľkoobchodníka).
export function feroVisit(mk: Mk, g: { int(n: number): number; pick<T>(l: readonly T[]): T | undefined }, items: readonly ItemId[]): void {
  const tick = mk.tick, se = P.season(tick), fero = mk.npc('fero'), has = new Set(items);
  npcWithdrawAll(mk, 'fero', items);
  for (const sp of P.PLANTABLE) {
    const item = `seed_${sp}` as const, n = fero.inv[item] || 0;
    if (!n || !has.has(item)) continue;
    const base = D.SPECIES[sp].seed, p = wholesaleAsk(mk, item);
    if (P.phase(sp, se) === 'off') {
      const bid = bestBid(mk, item, 'fero');
      if (bid != null) { npcOrder(mk, 'fero', item, 'sell', bid, n); mk.news(`🎩 Špekulant Fero sa zbavuje ${String(n)}× semienka ${D.SPECIES[sp].name} – už nie je ich čas.`); }
    } else if (p >= base * 1.5) {
      npcOrder(mk, 'fero', item, 'sell', Math.max(base, p - 1), n);
      mk.news(`🎩 Špekulant Fero predáva ${String(n)}× semienka ${D.SPECIES[sp].name} za ${String(Math.max(base, p - 1))} 🪙 – lacnejšie než veľkoobchodník.`);
    }
  }
  const held = P.PLANTABLE.reduce((a, sp) => a + (fero.inv[`seed_${sp}`] || 0), 0);
  if (held >= 20) return;
  const sp = g.pick(feroCands(item => mk.entry(item).stock, tick).filter(x => has.has(`seed_${x}`)));
  if (!sp) return;
  const p = wholesaleAsk(mk, `seed_${sp}`), k = Math.min(3 + g.int(4), mk.entry(`seed_${sp}`).stock - 3);
  if (k <= 0) return;
  const before = mk.trades.length;
  npcOrder(mk, 'fero', `seed_${sp}`, 'buy', p, k);
  const got = mk.trades.slice(before).filter(t => t.buyer.npc === 'fero').reduce((s, t) => s + t.k, 0);
  if (got) mk.news(`🎩 Špekulant Fero skúpil ${String(got)}× semienka ${D.SPECIES[sp].name}. Tuší, že budú drahé…`);
}

// Kvetinárka Zuzka: kvety z minulých nákupov predala v kyticiach, od zákazníkov má na nové nákupy ZUZKA.budget mincí;
// dá dopyty o ZUZKA.markup nad výkup veľkoobchodníka na kvety v sezóne, počas sviatku viac na sviatočné druhy.
export function zuzkaVisit(mk: Mk, festMult: Partial<Record<SpeciesId, number>> | null, items: readonly ItemId[]): void {
  const z = mk.npc('zuzka'), has = new Set(items);
  npcWithdrawAll(mk, 'zuzka', items);
  let sold = 0;
  for (const sp of P.PLANTABLE) sold += z.inv[`fl_${sp}`] || 0;
  z.inv = {}; z.fb = {};
  z.coins = Math.max(z.coins, ZUZKA.budget);
  const wanted = zuzkaWanted(mk.tick, festMult).filter(sp => has.has(`fl_${sp}`));
  const asked: string[] = [];
  for (const sp of wanted) {
    const p = Math.ceil(flowerQuote(mk, sp) * ZUZKA.markup), q = ZUZKA.perSpecies + (festMult && festMult[sp] ? ZUZKA.festExtra : 0);
    if (npcOrder(mk, 'zuzka', `fl_${sp}`, 'buy', p, q)) asked.push(D.SPECIES[sp].name);
  }
  if (sold >= 3) mk.news(`💐 Kvetinárka Zuzka predala ${String(sold)} kvetov v kyticiach.`);
  if (asked.length) mk.news(`💐 Kvetinárka Zuzka kúpi kvety lepšie než veľkoobchodník: ${asked.slice(0, 4).join(', ')}${asked.length > 4 ? '…' : ''}.`);
}

// Ráno: veľkoobchodník stiahne svoje objednávky, zákazníci mu cez noc rozkúpili časť kvetov, semienka mimo sezóny
// sa kazia; odberatelia mu doplnia mince; potom znova vypíše ceny (a knihy sa spárujú). Zápis cien do histórie.
export function dawnBook(mk: Mk, m: Market): void {
  const tick = mk.tick, se = P.season(tick);
  for (const sp of P.PLANTABLE) {
    const fl = `fl_${sp}` as const, seed = `seed_${sp}` as const, fc = npcC(mk.book(fl).vo);
    const f = fc.inv[fl] || 0, keep = Math.floor(f * P.PRICING.flowerOvernight); // kvety nepredáva – sú v jeho pokladni
    if (f > keep) I.removeItems(fc, fl, f - keep, tick);
    if (P.phase(sp, se) !== 'off') continue;
    const s = mk.entry(seed).stock, k = Math.floor(s * P.PRICING.seedOffSeasonDecay), sc = npcC(mk.book(seed).vo);
    if (s <= k) continue;
    // pokazené semienka: najprv z voľných, potom z jeho ponúk od najlacnejšej – k-ty kus rebríka stojí cenu pri zásobe
    // stock − k, takže s menšou zásobou ubudnú práve najlacnejšie kusy a zvyšok rebríka ostane, ako bol
    let d = s - k;
    const free = Math.min(d, sc.inv[seed] || 0);
    if (free) { I.removeItems(sc, seed, free, tick); d -= free; }
    for (const o of side(mk.book(seed), 'sell', tick).filter(x => x.npc === 'vo')) {
      if (d <= 0) break;
      const t = Math.min(d, o.rem);
      takeEscrow(seed, o, t, tick); d -= t;
      if (o.rem <= 0) drop(mk, seed, o);
    }
  }
  for (const item of BOOK_ITEMS) fund(mk, item);
  requoteAll(mk);
  P.recordHistory(m, tick);
}
// Pokladňa veľkoobchodníka pre tovar: doplní ju, aby pokryla celý rebrík výkupu pri dnešnej zásobe; nad skim × toľko odvedie
export function fund(mk: Mk, item: ItemId): void {
  const book = mk.book(item), vo = book.vo, e = mk.entry(item);
  // výkupná cena s každým kusom klesá, takže hĺbka × prvá cena pokryje celý rebrík výkupu
  const top = P.sellQuote(partAt(item, e.stock, e.fest), mk.tick, item) ?? 0;
  const need = top * (item === 'compost' ? WHOLESALE.compostBidDepth : WHOLESALE.bidDepth);
  const cash = vo.coins + Object.values(book.orders).reduce((a, o) => a + (o && o.npc === 'vo' ? o.coins : 0), 0);
  if (cash < need) vo.coins += need - cash;
  else if (cash > WHOLESALE.skim * need) vo.coins -= Math.min(vo.coins, cash - WHOLESALE.skim * need);
}

// ---------- Založenie a prevod ----------
const newAcct = (coins: number): NpcAccount => ({ coins, inv: {}, fb: {} });
// Trh bez kníh (nový svet alebo uloženie pred verziou 12): knihy pre všetok tovar, účty postáv; zásoba veľkoobchodníka
// (seeds/flowers/compost.stock) sa stane jeho tovarom, Ferove zásoby (hold) jeho tovarom, mince postáv ostanú.
// Potom veľkoobchodník vypíše ceny. Volá sa nad živým svetom (initEconomy), raz – ďalej trh mení len kniha.
export function initBooks(world: Pick<GameWorld, 'saves' | 'tick'>, m: Market): void {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- uloženia pred verziou 13 knihy nemajú
  if (m.books && Object.keys(m.books).length) {
    // tovar pridaný neskôr (nové druhy): kniha so zásobou veľkoobchodníka, ktorú mu dal trh (seeds/flowers.stock)
    const missing = BOOK_ITEMS.filter(item => !m.books[item]);
    if (!missing.length) return;
    for (const item of missing) {
      const vo = newAcct(0), sp = speciesOf(item), st = !sp ? m.compost.stock : item.startsWith('seed_') ? m.seeds[sp]?.stock ?? 0 : m.flowers[sp]?.stock ?? 0;
      if (st > 0) I.addItems(npcC(vo), item, st, world.tick);
      m.books[item] = { next: 1, orders: {}, vo };
    }
    const mk = mkWorld(world, m, null);
    for (const item of missing) fund(mk, item);
    requoteAll(mk, missing);
    return;
  }
  const old: { jano?: { coins?: number }; fero?: { coins?: number; hold?: Partial<Record<SpeciesId, number>> } } = m.npcs;
  const jano = newAcct(old.jano?.coins ?? 300), fero = newAcct(old.fero?.coins ?? 400), zuzka = newAcct(ZUZKA.budget);
  const add = (a: NpcAccount, item: ItemId, n: number): void => { if (n > 0) I.addItems(npcC(a), item, n, world.tick); };
  m.books = {};
  for (const item of BOOK_ITEMS) {
    const vo = newAcct(0), sp = speciesOf(item);
    add(vo, item, !sp ? m.compost.stock : item.startsWith('seed_') ? m.seeds[sp]?.stock ?? 0 : m.flowers[sp]?.stock ?? 0);
    m.books[item] = { next: 1, orders: {}, vo };
  }
  for (const sp of P.PLANTABLE) add(fero, `seed_${sp}`, old.fero?.hold?.[sp] ?? 0);
  m.npcs = { jano, fero, zuzka };
  const mk = mkWorld(world, m, null);
  for (const item of BOOK_ITEMS) { mk.entry(item).stock = must(m.books[item]).vo.inv[item] || 0; fund(mk, item); }
  requoteAll(mk);
}
// Pri načítaní: zoznam otvorených objednávok v uložení hráča sa prepočíta z kníh (odvodený údaj, ako plotsUsed)
// Pri načítaní: každá čakajúca objednávka má udalosť vypršania a ponuka kvetov udalosť vädnutia. Uloženie zo servera,
// ktorý tieto udalosti nepozná (návrat na staršiu verziu a späť), ich nemá – objednávky by inak nikdy nevypršali
// a ich záloha by ostala zamknutá. Vypršanie, ktoré prešlo počas výpadku, príde hneď v ďalšom kroku.
export function restoreOrderEvents(m: Market, ctx: Pick<GameCtx, 'tick' | 'pending' | 'scheduleUnique'>): number {
  let n = 0;
  for (const item of keys(m.books)) for (const o of Object.values(m.books[item]?.orders ?? {})) {
    if (!o || o.ioc) continue;
    const id = orderId(item, o.n);
    if (o.exp != null && !ctx.pending('oExpire:' + id)) { ctx.scheduleUnique('oExpire:' + id, Math.max(ctx.tick + 1, o.exp), 'oExpire', { item, n: o.n }); n++; }
    if (o.side === 'sell' && isFlower(item) && o.fb && o.fb.length && !ctx.pending('oWilt:' + id)) { planWilt(ctx, item, o); n++; }
  }
  return n;
}
export function syncPlayerOrders(world: Pick<GameWorld, 'saves'>, m: Market): void {
  const by: Partial<Record<PlayerKey, string[]>> = {};
  for (const item of keys(m.books)) for (const o of Object.values(m.books[item]?.orders ?? {})) if (o && o.pl != null) (by[o.pl] = by[o.pl] || []).push(orderId(item, o.n));
  for (const [key, sv] of entries(world.saves)) { const l = by[key]; if (l) sv.orders = l; else delete sv.orders; }
}

// ---------- Pohľad pre klienta ----------
const freshOf = (item: ItemId, o: Order, tick: number): number | undefined => {
  const sp = speciesOf(item);
  if (!sp || !isFlower(item) || !o.fb || !o.fb.length) return undefined;
  return Math.round(D.freshness(sp, Math.max(...o.fb.map(b => D.batchAge(b, tick, 1)))) * 100) / 100;
};
// Úrovne knihy v poradí výberu (bez okamžitých príkazov – tie v knihe nikdy nezostanú). Veľkoobchodník má v knihe len
// prvý stupeň cenníka; ďalšie stupne nastúpia hneď po ňom, preto sa ukážu celé (ako keby boli v knihe – ich poradie je
// ich cena, sú najnovšie).
export function levels(m: Market, item: ItemId, s: OrderSide, tick: number): Level[] {
  const book = m.books[item];
  if (!book) return [];
  const out: { l: Level; k: number; n: number }[] = [];
  for (const o of side(book, s, tick)) {
    if (o.npc === 'vo') continue;
    const l: Level = { p: o.p, n: o.rem, w: o.nm };
    const fr = s === 'sell' ? freshOf(item, o, tick) : undefined;
    if (fr != null) l.fr = fr;
    if (s === 'buy' && o.npc && isFlower(item)) l.f = 1;
    if (o.pl != null) l.id = orderId(item, o.n);
    out.push({ l, k: prio(o, tick), n: o.n });
  }
  const vo = Object.values(book.orders).filter((o): o is Order => !!o && o.npc === 'vo');
  const e = entryOf(m, item), cash = book.vo.coins + vo.reduce((a, o) => a + o.coins, 0);
  for (const r of ladder(item, e.stock, cash, e.fest, tick)) {
    if (r.side !== s) continue;
    const l: Level = { p: r.p, n: r.q, w: '' };
    if (s === 'buy' && isFlower(item)) l.f = 1;
    out.push({ l, k: r.p, n: Infinity });
  }
  out.sort((a, b) => (s === 'buy' ? b.k - a.k : a.k - b.k) || a.n - b.n);
  return out.map(x => x.l);
}
// Otvorené objednávky hráča (záložka Moje)
export function ordersView(m: Market | null, sv: PlayerSave, tick: number): OrderView[] {
  const out: OrderView[] = [];
  for (const id of sv.orders || []) {
    const r = parseOrderId(id), o = r && m ? lookup(m.books[r.item]?.orders ?? {}, String(r.n)) : undefined;
    if (!r || !o) continue;
    const v: OrderView = { id, item: r.item, side: o.side, p: o.p, q: o.q, rem: o.rem, coins: o.coins, exp: o.exp };
    if (o.dead) v.dead = o.dead;
    if (o.cx) v.cx = o.cx;
    const fr = o.side === 'sell' ? freshOf(r.item, o, tick) : undefined;
    if (fr != null) v.fr = fr;
    out.push(v);
  }
  return out;
}
