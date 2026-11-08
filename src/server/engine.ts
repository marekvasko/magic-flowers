// Jadro simulácie: diskrétny čas, fronta udalostí, návrhy nad zmrazeným svetom a ich atomické vykonanie.
//
// Modul nemá vlastný stav. Všetko, čo sa mení, je vo svete (world) ako obyčajný JSON a ukladá sa s ním:
//   world.tick    – herný čas v krokoch (D.TICKS_PER_DAY krokov na deň)
//   world.wall    – reálny čas (ms), ktorému zodpovedá world.tick
//   world.seed    – tajné semienko sveta (hex); klient ho nikdy nedostane
//   world.step    – počítadlo vykonaných kôl (z neho a zo semienka sa odvodzuje náhoda každého návrhu)
//   world.seq     – počítadlo naplánovaných udalostí (stabilné poradie v rámci jedného kroku)
//   world.events  – fronta udalostí zoradená podľa (at, seq)
// Správanie dodáva volajúci v „špecifikácii“ (spec), ktorá sa neukladá:
//   spec.proposers – { typ: { keys(data, world, presence) → { reads, writes }, run(slices, data, ctx) } }   návrhy (pozri nižšie)
//   spec.periodic  – [{ key, type, data?, next(from, rng) }]   periodické udalosti (pozri reconcile)
//   spec.slice     – (world, key) => { get(), set(value, changes?) } | null   mapovanie kľúča na výrez (predvolené sliceOf)
//   spec.presence  – (world) => snímka toho, čo nie je stav (pripojení hráči: [{ key, … }]); návrh dostane vlastnú kópiu
//                    ako ctx.presence a záznam dávky ju nesie (prehranie ju dostane z denníka)
//   spec.onBatch   – (world, out) => void   po každej dávke: správy pre hráčov (out.outbox) a záznam do denníka (out.entry)
//   spec.onError   – (err, ev, world) => void   voliteľné, inak console.error
//
// Udalosť vo fronte: { at, seq, type, data, key?, periodic? }
//   bežná      – bez kľúča; plánuje ju návrh alebo akcia hráča (schedule / scheduleIn)
//   unikátna   – s kľúčom; s rovnakým kľúčom je vo fronte najviac jedna (scheduleUnique, zrušenie cez cancel)
//   periodická – s kľúčom a periodic: true; plánuje ju len reconcile podľa spec.periodic
//
// Čas sa neposúva po krokoch, ale skokom na najbližšiu udalosť (advanceTo). Podrobný popis: docs/engine.md.
//
// ---- Návrhy, výrezy, kolá a vykonanie (commitBatch) ----
// Dávka = všetko, čo má v jednom kroku nastať: udalosti fronty, alebo akcie hráčov (vstupy { type, data, id, actor }).
// Udalosti a akcie nikdy nie sú v jednej dávke (akcie prídu až po udalostiach svojho kroku). Nikto nemení svet priamo:
//   1. návrh najprv deklaruje kľúče (keys): čo číta a čo mení – 'tile:garden:12', 'save:ana', 'market:*', 'contracts'…
//      Kľúč končiaci '*' je celá kolekcia ('save:*' = všetky uloženia) a stretáva sa s každým kľúčom s tým istým začiatkom.
//   2. engine mu dá obyčajné kópie práve týchto výrezov (slices[kľúč]) a vlastný generátor náhody; run ich mení
//      bežným kódom; nedeklarovaný výrez v slices nie je (undefined), takže siahnutie naň zlyhá nahlas,
//   3. návrhy sa vykonajú v poradí dávky: deklarované výrezy sa zapíšu späť do sveta na mieste (objekty, ktoré
//      server drží – uloženie hráča, políčko – si zachovajú identitu). Návrh, ktorého kľúče sa stretávajú so zápismi
//      už vykonaného návrhu, sa odloží (hold) a vyhodnotí znova v ďalšom kole toho istého kroku nad zmeneným svetom,
//   4. návrh sa vykoná celý alebo vôbec (chyba v run nezanechá nič); zmena výrezu deklarovaného len na čítanie je chyba;
//      ctx.reject(msg) návrh odmietne – nič sa nevykoná a hráč (input.actor) dostane msg ako správu (null = potichu).
// Vyhodnotenia v jednom kole na sebe nezávisia (mohli by bežať paralelne); poradie určuje len vykonanie.
// Plánovanie udalostí ide cez ctx (schedule, scheduleUnique, cancel, pending) ako operácie vykonané pri commite;
// unikátna udalosť je zároveň kľúč 'event:<kľúč>', ktorý engine k návrhu pridá sám.
//
// Typy (#122, fáza 3): engine je všeobecný – svet (W), záznam prítomnosti (P) a správu z návrhu (M) dodá hra (src/server/game.ts).
// Výrezy sú obyčajný JSON; hlboká kópia, zápis na mieste a porovnanie (clone, sync, same) pracujú s ľubovoľným JSON,
// preto tu (a len tu) je všeobecný objekt JsonObject.
import crypto from 'node:crypto';
import { TICKS_PER_DAY } from '../shared/data.ts';
import type { Rng } from './world.ts';
export { TICKS_PER_DAY, MIN_PER_TICK, DAWN_TICK, dayOfTick, minOfTick } from '../shared/data.ts';

// Objekt alebo pole JSON s ľubovoľnými kľúčmi – engine nevie, čo výrez obsahuje (výnimka z prísnych typov, pozri hlavičku)
type JsonObject = { [key: string | number]: unknown };
// Udalosť vo fronte. Typ a dáta pozná až hra (save.ts SavedEvent); engine s nimi len narába.
export interface EngineEvent {
  at: number;
  seq: number;
  type: string;
  data: unknown;
  key?: string;
  periodic?: true;
}
// Udalosť naplánovaná návrhom, ktorá ešte nie je vo fronte (seq dostane až pri commite)
export type DraftEvent = Omit<EngineEvent, 'seq'> & { seq?: number };
// Čo engine od sveta potrebuje; zvyšok sveta pozná len hra (sliceOf siaha na vlastnosti podľa mena kľúča)
export interface EngineWorld {
  tick: number;
  wall: number;
  daySeconds: number;
  seed?: string | null;
  step?: number;
  seq?: number;
  events: EngineEvent[];
}
// Deklarované kľúče návrhu
export interface Keys { reads?: readonly string[]; writes?: readonly string[] }
// Výrezy návrhu: kľúč → obyčajná kópia výrezu (hra ich číta cez typovaný prístup, game.ts)
export type Slices = { [key: string]: unknown };
// Zmena listu výrezu pre denník: cesta, pôvodná a nová hodnota
export interface Change { p: (string | number)[]; from?: unknown; to?: unknown }
export type Changes = Record<string, Change[]>;
// Výrez sveta: prečítať a zapísať späť na mieste
export interface Slice { get(): unknown; set(v: unknown, changes: Change[] | null): void }
// Adresát správy z návrhu
export type Recipient = string | { readonly all: true } | { readonly area: string };

// Kontext návrhu: náhoda, správy, fronta, prítomnosť
export interface Ctx<P, M> {
  tick: number;
  id: string;
  rng: Rng;
  presence: P[] | null | undefined;
  actor: P | undefined;
  outbox: M[];
  emit(msg: M): void;
  reject(msg?: string | null): never;
  schedule(at: number, type: string, data?: unknown): DraftEvent;
  scheduleIn(ticks: number, type: string, data?: unknown): DraftEvent;
  scheduleUnique(key: string, at: number, type: string, data?: unknown): DraftEvent;
  cancel(key: string): number;
  pending(key: string): DraftEvent | null;
}
// Návrh pre jeden typ vstupu. Metódy (nie vlastnosti s funkciou) zámerne: parametre metód TypeScript porovnáva
// bivariantne, takže návrh s presnými dátami (napr. { key, i }) sa zmestí do zoznamu návrhov enginu s dátami unknown.
export interface Proposer<D, W, P, M, S = Slices> {
  keys?(data: D, world: W, presence?: P[]): Keys;
  run(slices: S, data: D, ctx: Ctx<P, M>): void;
}
// Periodická udalosť: kľúč, typ, dáta a kedy má nastať (od kroku from)
export interface PeriodicDef<W> {
  key: string;
  type: string;
  data?: unknown;
  next(from: number, rng: Rng, world: W): number;
}
// Vstup dávky: udalosť z fronty (ev) alebo akcia hráča (id, actor)
export interface Input {
  type: string;
  data: unknown;
  ev?: EngineEvent;
  id?: string | number;
  actor?: string;
}
export type Outcome = 'applied' | 'held' | 'rejected' | 'error';
export interface ProposalRecord {
  id: string;
  type: string;
  round: number;
  reads: string[];
  writes: string[];
  outcome: Outcome;
  msg?: string | null;
  changes?: Changes;
}
// Záznam dávky do denníka (journal-*.jsonl); prehranie z neho zopakuje akcie hráčov
export interface JournalEntry<P, M> {
  tick: number;
  step: number;
  inputs: { id: string; type: string; data: unknown; ev?: { at: number; seq: number; key?: string | undefined } | undefined; actor?: string | undefined }[];
  presence?: P[] | undefined;
  proposals: ProposalRecord[];
  outbox: M[];
}
export type Timing = { schedule: number; evaluate: number; resolve: number; commit: number };
export type Op = { op: 'insert'; ev: DraftEvent; seq?: number } | { op: 'cancel'; key: string };
// Výsledok vyhodnotenia návrhu (evaluate)
export interface Result<M> {
  id: string;
  input: Input;
  reads: Set<string>;
  writes: Set<string>;
  slices: Slices;
  ops: Op[];
  outbox: M[];
  reject?: string | null;
  error?: unknown;
}
export interface BatchOut<P, M> {
  tick: number;
  rounds: number;
  applied: Result<M>[];
  rejected: Result<M>[];
  outbox: M[];
  entry: JournalEntry<P, M>;
  step?: number | undefined;
  timing?: Timing;
}
// Špecifikácia hry pre engine (neukladá sa)
export interface Spec<W extends EngineWorld, P extends { key: string }, M> {
  proposers?: Readonly<Record<string, Proposer<unknown, W, P, M> | undefined>>;
  periodic?: readonly PeriodicDef<W>[];
  slice?: (world: W, key: string) => Slice | null;
  presence?: (world: W) => P[] | undefined;
  onBatch?: (world: W, out: BatchOut<P, M>) => void;
  onError?: (err: unknown, ev: EngineEvent | Input, world: W) => void;
  clock?: () => number;
}

// Reálne milisekundy na jeden krok
export function tickMs(world: Pick<EngineWorld, 'daySeconds'>): number { return world.daySeconds * 1000 / TICKS_PER_DAY; }

// ---- Náhoda (mulberry32, stav je jedno uint32 číslo) ----
// Vo svete rng nie je: každý návrh dostane vlastný generátor odvodený zo semienka sveta, čísla kola a identity vstupu,
// takže poradie vyhodnotenia nič nezmení.
function mulberry(g: { state: number }): number {
  const a = (g.state = (g.state + 0x6D2B79F5) >>> 0);
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
// Počiatočný stav generátora z tajného semienka a ľubovoľných častí (číslo kola, kľúč, krok…)
export function seedOf(seed: string | null | undefined, ...parts: (string | number)[]): number {
  return crypto.createHash('sha256').update([seed == null ? '' : seed, ...parts].join('\u0000')).digest().readUInt32LE(0);
}
// Generátor s vlastným stavom: rand() ∈ [0,1), int(n) ∈ 0..n-1, pick(list)
export function generator(state: number): Rng {
  const g = { state: state >>> 0 };
  const rand = (): number => mulberry(g), int = (n: number): number => Math.floor(rand() * n);
  return { rand, int, pick: list => list[int(list.length)] };
}
export function newSeed(): string { return crypto.randomBytes(16).toString('hex'); }

// ---- Fronta udalostí ----

// Vloží udalosť na správne miesto (binárne hľadanie podľa (at, seq)).
// Udalosť nikdy nepadne do minulosti ani do práve spracúvaného kroku: najskôr world.tick + 1.
function insert(world: EngineWorld, at: number, type: string, data: unknown, key?: string | null, periodic?: boolean): EngineEvent {
  world.seq = (world.seq || 0) + 1;
  const ev: EngineEvent = { at: Math.max(at, world.tick + 1), seq: world.seq, type, data: data === undefined ? null : data };
  if (key != null) ev.key = key;
  if (periodic) ev.periodic = true;
  const q = world.events;
  let lo = 0, hi = q.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const m = q[mid];
    if (m && (m.at < ev.at || (m.at === ev.at && m.seq < ev.seq))) lo = mid + 1; else hi = mid;
  }
  q.splice(lo, 0, ev);
  return ev;
}
// Bežná udalosť v kroku `at`.
export function schedule(world: EngineWorld, at: number, type: string, data?: unknown): EngineEvent { return insert(world, at, type, data); }
// Bežná udalosť o `ticks` krokov (najmenej o 1).
export function scheduleIn(world: EngineWorld, ticks: number, type: string, data?: unknown): EngineEvent { return insert(world, world.tick + Math.max(1, ticks), type, data); }
// Unikátna udalosť: zruší čakajúcu udalosť s rovnakým kľúčom a naplánuje novú.
export function scheduleUnique(world: EngineWorld, key: string, at: number, type: string, data?: unknown): EngineEvent {
  cancel(world, key);
  return insert(world, at, type, data, key);
}
// Zruší všetky čakajúce udalosti s daným kľúčom. Vráti, koľko ich zrušil.
export function cancel(world: EngineWorld, key: string): number {
  const before = world.events.length;
  world.events = world.events.filter(e => e.key !== key);
  return before - world.events.length;
}
// Najskoršia čakajúca udalosť s daným kľúčom alebo null.
export function pending(world: EngineWorld, key: string): EngineEvent | null { return world.events.find(e => e.key === key) || null; }
// Krok najbližšej udalosti alebo null, keď je fronta prázdna.
export function nextAt(world: EngineWorld): number | null { const e = world.events[0]; return e ? e.at : null; }

// ---- Periodické udalosti: reconciler ----
// Periodické udalosti nikto neplánuje ručne. spec.periodic ich len deklaruje a reconcile zaručí,
// že každý deklarovaný kľúč má vo fronte práve jednu udalosť:
//   1. zahodí udalosti, ktorých typ už nemá návrh (obsah odstránený z hry),
//   2. zahodí periodické udalosti, ktorých kľúč už nie je deklarovaný,
//   3. pri duplicitách nechá len najskoršiu,
//   4. chýbajúce naplánuje na def.next(world.tick + 1, rng).
// Keď sa periodická udalosť vykoná, z fronty zmizne a najbližší reconcile naplánuje ďalšiu.
// Tak isto sa nové periodické udalosti dostanú aj do starých uložených svetov.
// Plán reconcile bez zmeny sveta (reconcile ho len vykoná; ladiaca stránka ho ukazuje):
//   drop    – [{ ev, why }] udalosti, ktoré zahodí
//   missing – deklarácie, ktoré vo fronte chýbajú a naplánuje ich
//   ok      – deklarácie s práve jednou udalosťou vo fronte: [{ def, ev }]
export interface ReconcilePlan<W> {
  drop: { ev: EngineEvent; why: string }[];
  missing: PeriodicDef<W>[];
  ok: { def: PeriodicDef<W>; ev: EngineEvent }[];
}
function knows<W extends EngineWorld, P extends { key: string }, M>(spec: Spec<W, P, M>, type: string): boolean { return !!(spec.proposers && spec.proposers[type]); }
export function reconcilePlan<W extends EngineWorld, P extends { key: string }, M>(world: W, spec: Spec<W, P, M>): ReconcilePlan<W> {
  const defs = spec.periodic || [];
  const declared = new Set(defs.map(d => d.key));
  const seen = new Map<string, EngineEvent>(), drop: { ev: EngineEvent; why: string }[] = [];
  for (const e of world.events) {
    let why: string | null = null;
    if (!knows(spec, e.type)) why = 'neznámy typ';
    else if (e.periodic && !declared.has(e.key ?? '')) why = 'nedeklarovaná periodická';
    else if (e.periodic && seen.has(e.key ?? '')) why = 'duplicita';
    if (why) drop.push({ ev: e, why });
    else if (e.periodic) seen.set(e.key ?? '', e);
  }
  const ok: { def: PeriodicDef<W>; ev: EngineEvent }[] = [];
  for (const def of defs) { const ev = seen.get(def.key); if (ev) ok.push({ def, ev }); }
  return { drop, missing: defs.filter(d => !seen.has(d.key)), ok };
}
// Kedy má periodická udalosť nastať: def.next dostane generátor odvodený z (semienko, kľúč, from),
// takže náhodný čas (návšteva NPC) nezávisí od ničoho iného a je rovnaký pri skoku aj pri kroku.
export function planAt<W extends EngineWorld>(world: W, def: PeriodicDef<W>, from: number): number { return def.next(from, generator(seedOf(world.seed, 'plan', def.key, from)), world); }
export function reconcile<W extends EngineWorld, P extends { key: string }, M>(world: W, spec: Spec<W, P, M>): void {
  const { drop, missing } = reconcilePlan(world, spec);
  if (drop.length) {
    const gone = new Set(drop.map(d => d.ev));
    for (const d of drop) console.warn(`[engine] zahodená udalosť ${d.ev.key || d.ev.type} (${d.why})`);
    world.events = world.events.filter(e => !gone.has(e));
  }
  for (const def of missing) insert(world, planAt(world, def, world.tick + 1), def.type, def.data, def.key, true);
}

// ---- Výrezy (slices) ----
// Kľúč deklarovaný návrhom → kde vo svete výrez leží (herná znalosť: ako je uložený svet, pozri serialize v server.js).
//   tile:<plocha>:<i> | tile:<plocha>:*   políčko / všetky políčka plochy (garden → world.tiles, hory → world.hory, les…)
//   save:<kľúč> | save:*                  uloženie hráča / všetky uloženia – bez polohy (pozri pos)
//   pos:<kľúč>                            poloha hráča v jeho uložení { x, y, area, lastTick }: píše ju každý pohyb,
//                                         preto je to vlastný výrez a uloženie (save:) ju nikdy neprepíše
//   market:seed_<sp> | market:fl_<sp> | market:compost | market:festival | market:hist | market:news | market:npc:<meno>
//   market:seed_* | market:fl_* | market:npc:* | market:*     kolekcie trhu / celý trh
//   storage                               sklad ako { inv, fb } (world.storage + world.storageFb)
//   čokoľvek iné                          vlastnosť sveta s tým menom (weather, contracts, icehouse, scav, up, plotsUsed…)
// Výrez vráti { get() → hodnota, set(value, changes?) } alebo null, ak kľúč nikam nevedie (napr. neexistujúce uloženie).
const isObj = (v: unknown): v is JsonObject => v !== null && typeof v === 'object';
// Svet ako JSON pre výrezy podľa mena kľúča (jediný prevod typu sveta na všeobecný objekt)
const jsonOf = (world: EngineWorld): JsonObject => world as unknown as JsonObject;
function at(parent: unknown, prop: string | number): Slice | null {
  if (!isObj(parent)) return null;
  return { get: () => parent[prop], set: (v, changes) => { sync(parent, prop, v, [], changes); } };
}
// Vlastnosti sveta, ktoré nie sú výrezom samy osebe (kolekcie majú vlastné kľúče, fronta ide cez ctx) – kľúč s týmto menom nevedie nikam.
const NOT_A_SLICE = new Set(['saves', 'tiles', 'hory', 'les', 'pomedzie', 'market', 'storage', 'storageFb', 'events', 'seq', 'step', 'seed', 'tick', 'wall']);
// Polia uloženia, ktoré patria výrezu pos:<kľúč>, nie save:<kľúč>
export const POS_FIELDS: readonly string[] = ['x', 'y', 'area', 'lastTick'];
const POS = new Set(POS_FIELDS);
const pick = (o: JsonObject, fields: readonly string[]): JsonObject => { const out: JsonObject = {}; for (const f of fields) if (f in o) out[f] = o[f]; return out; };
const omit = (o: JsonObject, skip: Set<string>): JsonObject => { const out: JsonObject = {}; for (const k in o) if (!skip.has(k)) out[k] = o[k]; return out; };
// Zapíše polia src do cur na mieste, polia v skip nechá tak; stack = cesta pre záznam zmien
function syncFields(cur: JsonObject, src: JsonObject, skip: Set<string>, stack: (string | number)[], changes: Change[] | null): void {
  for (const k in cur) if (!(k in src) && !skip.has(k)) { if (changes) changes.push({ p: stack.concat(k), from: clone(cur[k]) }); delete cur[k]; }
  for (const k in src) if (!skip.has(k)) { stack.push(k); sync(cur, k, src[k], stack, changes); stack.pop(); }
}
// Uloženie hráča bez polohy; nové uloženie (ešte neexistuje) sa zapíše celé
function saveSlice(saves: unknown, k: string): Slice | null {
  if (!isObj(saves)) return null;
  return {
    get: () => { const sv = saves[k]; return isObj(sv) ? omit(sv, POS) : sv; },
    set: (v, changes) => { const sv = saves[k]; if (isObj(sv) && isObj(v)) syncFields(sv, v, POS, [], changes); else sync(saves, k, v, [], changes); }
  };
}
function savesSlice(world: JsonObject): Slice {
  const saves = world['saves'];
  return {
    get: () => { const out: JsonObject = {}; if (isObj(saves)) for (const k in saves) { const sv = saves[k]; out[k] = isObj(sv) ? omit(sv, POS) : sv; } return out; },
    set: (v, changes) => {
      if (!isObj(saves) || !isObj(v)) return;
      for (const k in saves) if (!(k in v)) { if (changes) changes.push({ p: [k], from: clone(saves[k]) }); delete saves[k]; }
      for (const k in v) { const sv = saves[k], nv = v[k]; if (isObj(sv) && isObj(nv)) syncFields(sv, nv, POS, [k], changes); else sync(saves, k, nv, [k], changes); }
    }
  };
}
function posSlice(saves: unknown, k: string): Slice | null {
  const sv = isObj(saves) ? saves[k] : null;
  if (!isObj(sv)) return null;
  return { get: () => pick(sv, POS_FIELDS), set: (v, changes) => { if (isObj(v)) for (const f of POS_FIELDS) if (f in v || f in sv) sync(sv, f, v[f], [f], changes); } };
}
export function sliceOf(world: EngineWorld, key: string): Slice | null {
  const w = jsonOf(world);
  const [a, b = '', c = ''] = key.split(':');
  switch (a) {
    case 'tile': { const coll = b === 'garden' ? 'tiles' : b; return c === '*' ? at(w, coll) : at(w[coll], +c); }
    case 'save': { const k = key.slice(5); return k === '*' ? savesSlice(w) : saveSlice(w['saves'], k); } // kľúč hráča smie obsahovať ':'
    case 'pos': return posSlice(w['saves'], key.slice(4));
    case 'market': {
      const m = w['market'];
      if (b === '*') return at(w, 'market');
      if (!isObj(m)) return null;
      if (b === 'seed_*') return at(m, 'seeds');
      if (b === 'fl_*') return at(m, 'flowers');
      if (b.startsWith('seed_')) return at(m['seeds'], b.slice(5));
      if (b.startsWith('fl_')) return at(m['flowers'], b.slice(3));
      if (b === 'npc') return c === '*' ? at(m, 'npcs') : at(m['npcs'], c);
      return at(m, b);
    }
    case 'storage': return {
      get: () => ({ inv: w['storage'], fb: w['storageFb'] || {} }),
      set: (v, changes) => { if (!isObj(v)) return; sync(w, 'storage', v['inv'], ['inv'], changes); sync(w, 'storageFb', v['fb'], ['fb'], changes); }
    };
    default: return NOT_A_SLICE.has(key) ? null : at(w, key);
  }
}
// Stretávajú sa dva kľúče? ('x:*' = všetko s tým začiatkom)
export function meets(a: string, b: string): boolean {
  if (a.endsWith('*')) return b.startsWith(a.slice(0, -1)) || b === a;
  if (b.endsWith('*')) return a.startsWith(b.slice(0, -1));
  return a === b;
}
// Stretáva sa niektorý kľúč z `keys` s niektorým z `written`?
export function conflicts(keys: Iterable<string>, written: readonly string[]): boolean {
  for (const k of keys) for (const w of written) if (meets(k, w)) return true;
  return false;
}
// Hlboká kópia hodnoty JSON
function cloneJson(v: unknown): unknown {
  if (!isObj(v)) return v;
  if (Array.isArray(v)) return v.map(cloneJson);
  const out: JsonObject = {};
  for (const k in v) out[k] = cloneJson(v[k]);
  return out;
}
export function clone<T>(v: T): T { return cloneJson(v) as T; }
// Zapíše hodnotu `src` do parent[prop] na mieste: existujúce objekty sa menia zvnútra (zachovajú identitu – uloženie
// hráča, políčko), polia tiež, kým majú rovnakú dĺžku; pole inej dĺžky sa nahradí celé (prvok odstránený zo zoznamu
// ostane tým, čím bol, nezmení sa na svojho suseda). Čo pribudlo, sa priradí, čo zmizlo, sa zmaže.
// Ak dostane `changes`, zaznamená každú zmenu listu { p: cesta vo výreze, from, to } (hodnoty skopírované, nie živé).
export function sync(parent: JsonObject, prop: string | number, src: unknown, stack: (string | number)[], changes: Change[] | null): void {
  const cur = parent[prop];
  if (isObj(src) && isObj(cur) && Array.isArray(src) === Array.isArray(cur) && (!Array.isArray(src) || (Array.isArray(cur) && src.length === cur.length))) {
    if (Array.isArray(src)) {
      for (let i = 0; i < src.length; i++) { stack.push(i); sync(cur, i, src[i], stack, changes); stack.pop(); }
    } else {
      for (const k in cur) if (!(k in src)) { if (changes) changes.push({ p: stack.concat(k), from: clone(cur[k]) }); delete cur[k]; }
      for (const k in src) { stack.push(k); sync(cur, k, src[k], stack, changes); stack.pop(); }
    }
    return;
  }
  if (cur === src) return;
  if (src === undefined) { if (changes) changes.push({ p: stack.slice(), from: clone(cur) }); delete parent[prop]; return; }
  if (changes) changes.push({ p: stack.slice(), from: clone(cur), to: clone(src) });
  parent[prop] = src;
}
// Rovnajú sa dve hodnoty JSON do hĺbky?
export function same(a: unknown, b: unknown): boolean {
  if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return true;
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false; return true; }
  for (const k in a) if (!(k in b) || !same(a[k], b[k])) return false;
  for (const k in b) if (!(k in a)) return false;
  return true;
}
// Zlúči deklarácie kľúčov viacerých častí návrhu
export function mergeKeys(...list: Keys[]): { reads: string[]; writes: string[] } {
  const reads = new Set<string>(), writes = new Set<string>();
  for (const k of list) { for (const r of k.reads || []) reads.add(r); for (const w of k.writes || []) writes.add(w); }
  for (const w of writes) reads.delete(w);
  return { reads: [...reads], writes: [...writes] };
}

// ---- Návrhy ----

// Adresát správy z návrhu (ctx.emit({ to, … })): kľúč hráča ako reťazec, ALL = všetkým, area(plocha) = hráčom na ploche.
// Objekty namiesto reťazcov '*' / 'area:x', aby sa meno hráča nikdy nepomýlilo s adresou.
export const ALL: { readonly all: true } = Object.freeze({ all: true });
export function area<A extends string>(name: A): { area: A } { return { area: name }; }

// Odmietnutie návrhu (ctx.reject) – vyhodí sa a evaluate ho zachytí; msg = správa pre hráča (null = potichu)
class Reject extends Error { msg: string | null; constructor(msg: string | null) { super('reject'); this.msg = msg; } }
// Text chyby pre denník: správa chyby, inak chyba ako reťazec (vyhodiť sa dá čokoľvek)
function errorText(err: unknown): string {
  const m = isObj(err) ? err['message'] : undefined;
  return String(m || err);
}

// Identita vstupu: z nej (a zo semienka a kola) sa odvodzuje náhoda návrhu, takže pridanie či ubratie
// iného vstupu v dávke nezmení jeho výsledok.
function inputId(input: Input): string { return input.id != null ? String(input.id) : input.ev ? 'ev#' + String(input.ev.seq) : input.type; }

// Fronta, ako ju vidí návrh: vloženie, zrušenie, čakajúca udalosť
interface QueueOps {
  insert(at: number, type: string, data: unknown, key?: string): DraftEvent;
  cancel(key: string): number;
  pending(key: string): DraftEvent | null;
}
// Kontext návrhu (aj „živý“ pre založenie sveta – pozri liveCtx): náhoda, správy, fronta, prítomnosť.
// queue: funkcie nad frontou; events: množina kľúčov 'event:…', ktorých sa návrh dotkol (null = nezaznamenáva);
// presence: kópia snímky prítomnosti pre tento návrh; actor: záznam konajúceho hráča v nej (input.actor), ak tam je
function makeCtx<P, M>(world: EngineWorld, id: string, rng: Rng, queue: QueueOps, events: Set<string> | null, presence: P[] | null | undefined, actor?: P): Ctx<P, M> {
  const touch = (key: string): void => { if (events) events.add('event:' + key); };
  const outbox: M[] = [];
  return {
    tick: world.tick, id, rng, presence, actor, outbox,
    emit: msg => { outbox.push(msg); },
    reject: msg => { throw new Reject(msg === undefined ? null : msg); },
    schedule: (at, type, data) => queue.insert(at, type, data),
    scheduleIn: (ticks, type, data) => queue.insert(world.tick + Math.max(1, ticks), type, data),
    scheduleUnique: (key, at, type, data) => { touch(key); queue.cancel(key); return queue.insert(at, type, data, key); },
    cancel: key => { touch(key); return queue.cancel(key); },
    pending: key => { touch(key); return queue.pending(key); }
  };
}
// Kontext nad živým svetom: len pre založenie sveta (initEconomy pri načítaní). Náhoda z (semienko, kolo, id).
export function liveCtx<P, M>(world: EngineWorld, id: string): Ctx<P, M> {
  const queue: QueueOps = {
    insert: (at, type, data, key) => insert(world, at, type, data, key),
    cancel: key => cancel(world, key), pending: key => pending(world, key)
  };
  return makeCtx<P, M>(world, id, generator(seedOf(world.seed, world.step || 0, id)), queue, null, null);
}
// Fronta tak, ako ju vidí návrh: snímok plus to, čo návrh sám zrušil a naplánoval; zmeny sa len zapisujú ako ops
function draftQueue(world: EngineWorld, ops: Op[]): QueueOps {
  const view = (): DraftEvent[] => {
    let q: DraftEvent[] = world.events;
    for (const o of ops) q = o.op === 'cancel' ? q.filter(e => e.key !== o.key) : q.concat([o.ev]);
    return q;
  };
  return {
    insert(at, type, data, key) {
      const ev: DraftEvent = { at: Math.max(at, world.tick + 1), type, data: data === undefined ? null : data };
      if (key != null) ev.key = key;
      ops.push({ op: 'insert', ev });
      return ev;
    },
    cancel(key) { const n = view().filter(e => e.key === key).length; ops.push({ op: 'cancel', key }); return n; },
    pending(key) { return view().find(e => e.key === key) || null; }
  };
}

// Deklarované kľúče vstupu (bez vyhodnotenia). Vráti { reads: Set, writes: Set } alebo { error }.
type KeysOf = { reads: Set<string>; writes: Set<string>; error?: undefined } | { error: unknown; reads?: undefined; writes?: undefined };
export function keysOf<W extends EngineWorld, P extends { key: string }, M>(world: W, input: Input, spec: Spec<W, P, M>, presence: P[] | undefined): KeysOf {
  const proposer = spec.proposers && spec.proposers[input.type];
  if (!proposer) return { error: new Error(`neznámy typ vstupu ${input.type}`) };
  try {
    const k = proposer.keys ? proposer.keys(input.data, world, presence) : {};
    const writes = new Set(k.writes || []), reads = new Set((k.reads || []).filter(r => !writes.has(r)));
    // dva deklarované kľúče sa nesmú prekrývať ('save:*' a 'save:ana' by boli dve nezávislé kópie toho istého)
    const all = [...reads, ...writes];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i] ?? '', b = all[j] ?? '';
      if (meets(a, b)) throw new Error(`návrh ${input.type} deklaruje prekrývajúce sa kľúče ${a} a ${b}`);
    }
    return { reads, writes };
  } catch (error) { return { error }; }
}

// Vyhodnotí jeden vstup nad snímkom `world` (bez zmeny sveta). Vráti výsledok návrhu:
//   { id, input, reads, writes, slices, ops, outbox }    – návrh na vykonanie (slices = zmenené kópie výrezov)
//   { …, reject: msg }                                   – odmietnutie (nič sa nevykoná, hráč dostane správu; null = bez správy)
//   { …, error }                                         – chyba (nič sa nevykoná, vstup sa spotrebuje)
// presence je snímka dávky; návrh dostane vlastnú kópiu a v nej (ak je to zoznam záznamov s key) záznam input.actor ako ctx.actor.
export function evaluate<W extends EngineWorld, P extends { key: string }, M>(world: W, input: Input, spec: Spec<W, P, M>, presence: P[] | undefined): Result<M> {
  const id = inputId(input);
  const k = keysOf(world, input, spec, presence);
  const res: Result<M> = { id, input, reads: k.reads || new Set(), writes: k.writes || new Set(), slices: {}, ops: [], outbox: [] };
  if (k.error !== undefined || !k.reads) { res.error = k.error; return res; }
  const sliceOfKey = (key: string): Slice | null => (spec.slice ? spec.slice(world, key) : sliceOf(world, key));
  try {
    for (const key of [...res.reads, ...res.writes]) { const s = sliceOfKey(key); if (s) res.slices[key] = clone(s.get()); }
    const pr = clone(presence);
    const actor = input.actor != null && Array.isArray(pr) ? pr.find(p => p.key === input.actor) : undefined;
    const ctx = makeCtx<P, M>(world, id, generator(seedOf(world.seed, world.step || 0, id)), draftQueue(world, res.ops), res.writes, pr, actor);
    const proposer = spec.proposers && spec.proposers[input.type];
    if (!proposer) throw new Error(`neznámy typ vstupu ${input.type}`);
    proposer.run(res.slices, input.data, ctx);
    res.outbox = ctx.outbox;
    for (const key in res.slices) if (!res.reads.has(key) && !res.writes.has(key)) throw new Error(`návrh ${id} zapísal do nedeklarovaného výrezu ${key}`);
    for (const key of res.reads) {
      const s = sliceOfKey(key);
      if (s && !same(res.slices[key], s.get())) throw new Error(`návrh ${id} zmenil výrez ${key}, ktorý deklaroval len na čítanie`);
    }
  } catch (err) {
    if (err instanceof Reject) res.reject = err.msg; else res.error = err;
  }
  return res;
}

// Vykoná jeden návrh na živom svete: výrezy späť na mieste, potom operácie s frontou (seq pridelí commit).
// Ak dostane `changes`, zapíše doň zmeny podľa kľúča: { kľúč: [{ p, from, to }] } (len kľúče, kde sa niečo zmenilo).
export function applyResult<W extends EngineWorld, P extends { key: string }, M>(world: W, r: Result<M>, spec: Spec<W, P, M> | null | undefined, changes?: Changes | null): void {
  for (const key of r.writes) {
    if (!(key in r.slices)) continue;
    const s = spec && spec.slice ? spec.slice(world, key) : sliceOf(world, key);
    if (!s) continue;
    const list: Change[] | null = changes ? [] : null;
    s.set(r.slices[key], list);
    if (changes && list && list.length) changes[key] = list;
  }
  for (const o of r.ops) {
    if (o.op === 'cancel') cancel(world, o.key);
    else o.seq = insert(world, o.ev.at, o.ev.type, o.ev.data, o.ev.key, o.ev.periodic).seq; // seq pre ladiacu stránku (kto udalosť naplánoval)
  }
}

// Vykoná dávku vstupov v kolách (pozri hlavičku). inputs: [{ type, data, ev?, id?, actor? }] v poradí dávky
// (ev = udalosť z fronty; actor = kľúč konajúceho hráča pri akcii).
// Vráti { tick, rounds, applied: [výsledky], rejected: [výsledky], outbox: [správy], entry } a zavolá spec.onBatch.
// entry je záznam dávky do denníka: vstupy, snímka prítomnosti, poradie, kľúče a osud každého návrhu v každom kole, zmeny, správy.
// Ak spec.clock (() → ms) existuje, out.timing nesie čas častí dávky v ms: schedule (zostavenie dávky z fronty, ak ho
// dodá volajúci v `scheduleMs`), evaluate (kľúče a beh návrhov), resolve (kolízie), commit (zápis do sveta).
// Čas nie je v entry – denník musí byť pri prehratí rovnaký.
export function commitBatch<W extends EngineWorld, P extends { key: string }, M>(world: W, inputs: Input[], spec: Spec<W, P, M>, scheduleMs?: number): BatchOut<P, M> {
  const journal = !!spec.onBatch;
  const presence = spec.presence ? spec.presence(world) : undefined;
  const entry: JournalEntry<P, M> = {
    tick: world.tick, step: world.step || 0,
    inputs: inputs.map(i => ({ id: inputId(i), type: i.type, data: i.data, ev: i.ev ? { at: i.ev.at, seq: i.ev.seq, key: i.ev.key } : undefined, actor: i.actor != null ? i.actor : undefined })),
    presence: presence === undefined ? undefined : clone(presence), proposals: [], outbox: []
  };
  const out: BatchOut<P, M> = { tick: world.tick, rounds: 0, applied: [], rejected: [], outbox: entry.outbox, entry };
  const clock = spec.clock, timing: Timing | null = clock ? { schedule: scheduleMs || 0, evaluate: 0, resolve: 0, commit: 0 } : null;
  let t0 = clock ? clock() : 0;
  const lap = (part: keyof Timing): void => { if (!clock || !timing) return; const t = clock(); timing[part] += t - t0; t0 = t; };
  let todo = inputs;
  while (todo.length) {
    out.rounds++;
    const written: string[] = [], held: Input[] = [];
    const record = (r: Pick<Result<M>, 'id' | 'input' | 'reads' | 'writes'>, outcome: Outcome, extra?: Partial<ProposalRecord>): void => {
      entry.proposals.push(Object.assign({ id: r.id, type: r.input.type, round: out.rounds, reads: [...r.reads], writes: [...r.writes], outcome }, extra));
    };
    for (const input of todo) {
      // kolízia už z deklarácie: netreba ani vyhodnocovať, návrh počká na ďalšie kolo
      if (written.length) {
        const k = keysOf(world, input, spec, presence);
        const clash = !k.error && k.reads && conflicts([...k.reads, ...k.writes], written);
        if (clock) lap('resolve');
        if (clash) { held.push(input); record({ id: inputId(input), input, reads: k.reads, writes: k.writes }, 'held'); continue; }
      }
      const r = evaluate(world, input, spec, presence);
      if (clock) lap('evaluate');
      if (r.error !== undefined) {
        (spec.onError || logError)(r.error, input.ev || input, world);
        record(r, 'error', { msg: errorText(r.error) });
        continue;
      }
      const clash = written.length && conflicts([...r.reads, ...r.writes], written);
      if (clock) lap('resolve');
      if (clash) { held.push(input); record(r, 'held'); continue; }
      if (r.reject !== undefined) { out.rejected.push(r); record(r, 'rejected', { msg: r.reject }); continue; }
      const changes: Changes | null = journal ? {} : null;
      applyResult(world, r, spec, changes);
      if (clock) lap('commit');
      written.push(...r.writes);
      out.applied.push(r);
      out.outbox.push(...r.outbox);
      record(r, 'applied', changes ? { changes } : undefined);
    }
    world.step = (world.step || 0) + 1;
    todo = held;
  }
  out.step = world.step;
  if (timing) out.timing = timing;
  if (spec.onBatch) spec.onBatch(world, out);
  return out;
}

// ---- Vykonávanie ----

// Vykoná všetky udalosti, ktoré pripadajú na world.tick, ako jednu dávku.
// Čo dávka naplánuje, padne najskôr na world.tick + 1, takže dávka je vopred uzavretá.
// Chyba v návrhu sa zachytí a zapíše; udalosť sa tým spotrebuje a simulácia beží ďalej.
export function runBatch<W extends EngineWorld, P extends { key: string }, M>(world: W, spec: Spec<W, P, M>, scheduleMs?: number): number {
  const t0 = spec.clock ? spec.clock() : 0;
  const inputs: Input[] = [];
  for (let ev = world.events[0]; ev && ev.at <= world.tick; ev = world.events[0]) {
    world.events.shift();
    inputs.push({ type: ev.type, data: ev.data, ev });
  }
  if (inputs.length) commitBatch(world, inputs, spec, spec.clock ? (scheduleMs || 0) + spec.clock() - t0 : 0);
  return inputs.length;
}
function logError(err: unknown, ev: EngineEvent | Input, world: EngineWorld): void {
  const key = 'key' in ev ? ev.key : undefined;
  console.error(`[engine] chyba v udalosti ${key || ev.type} (krok ${String(world.tick)}, data ${JSON.stringify(ev.data)}):`, err);
}

// Posunie čas na krok `target` skokmi z udalosti na udalosť:
//   reconcile → najbližšia udalosť → ak je až po `target`, koniec → hodiny na ňu → dávka → znova.
// Kroky bez udalostí sa vôbec nesimulujú, takže posun o 1 krok aj o 30 dní je ten istý cyklus.
// Vráti počet vykonaných udalostí.
export function advanceTo<W extends EngineWorld, P extends { key: string }, M>(world: W, target: number, spec: Spec<W, P, M>): number {
  let n = 0;
  for (;;) {
    const t0 = spec.clock ? spec.clock() : 0;
    reconcile(world, spec);
    const at = nextAt(world);
    if (at === null || at > target) break;
    world.tick = Math.max(world.tick, at);
    n += runBatch(world, spec, spec.clock ? spec.clock() - t0 : 0);
  }
  if (target > world.tick) world.tick = target;
  return n;
}

// Dobehne reálny čas: posunie svet o toľko celých krokov, koľko ubehlo od world.wall (najviac maxTicks).
// Vráti, o koľko krokov sa čas posunul.
export function advance<W extends EngineWorld, P extends { key: string }, M>(world: W, nowMs: number, spec: Spec<W, P, M>, maxTicks?: number): number {
  const ms = tickMs(world);
  // tickMs nie je celé číslo – malá tolerancia, aby zaokrúhlenie wall nestratilo celý krok
  const due = Math.min(Math.floor((nowMs - world.wall) / ms + 1e-9), maxTicks || Infinity);
  if (!(due > 0)) return 0;
  advanceTo(world, world.tick + due, spec);
  world.wall += due * ms;
  return due;
}

// Prehrá záznamy denníka (entry z commitBatch) nad uloženým svetom: udalosti vzniknú znova z fronty,
// akcie hráčov sa vykonajú ako vlastná dávka v kroku záznamu (po udalostiach toho kroku, ako na serveri).
// Prítomnosť hráčov dostane každá dávka zo svojho záznamu, nie zo spec.presence. Vráti počet prehraných dávok.
export function replay<W extends EngineWorld, P extends { key: string }, M>(world: W, entries: readonly JournalEntry<P, M>[], spec: Spec<W, P, M>): number {
  let n = 0;
  for (const e of entries) {
    const sp: Spec<W, P, M> = 'presence' in e ? { ...spec, presence: () => e.presence } : spec;
    advanceTo(world, e.tick, sp);
    const inputs: Input[] = e.inputs.filter(i => !i.ev).map(i => ({ type: i.type, data: i.data, id: i.id, ...(i.actor !== undefined ? { actor: i.actor } : {}) }));
    if (inputs.length) commitBatch(world, inputs, sp);
    n++;
  }
  return n;
}

// ---- Výpočet času periodických udalostí (pre def.next) ----

// Najbližší krok >= from tvaru offset + k * period (každú hodinu, každé 2 dni o 7:00, raz za rok…).
export function nextEvery(from: number, period: number, offset?: number): number {
  const o = ((offset || 0) % period + period) % period;
  return Math.ceil((from - o) / period) * period + o;
}
// Najbližší krok >= from, ktorý padne na danú dennú hodinu (v krokoch od polnoci).
export function nextDailyTick(from: number, tickOfDay: number): number { return nextEvery(from, TICKS_PER_DAY, tickOfDay); }
// Hotové funkcie next pre spec.periodic.
export function daily(tickOfDay: number): (from: number) => number { return from => nextDailyTick(from, tickOfDay); }
export function every(period: number, offset?: number): (from: number) => number { return from => nextEvery(from, period, offset); }
