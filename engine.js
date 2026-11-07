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
//   spec.handlers  – { typ: (world, data, ev) => void }   staré handlery: píšu do sveta ako doteraz (pozri „Starý handler“)
//   spec.proposers – { typ: (world, data, ctx) => void }  čisté návrhy: čítajú a píšu návrh, náhodu a správy berú z ctx
//   spec.periodic  – [{ key, type, data?, next(world, from) }]   periodické udalosti (pozri reconcile)
//   spec.transient – [kľúče sveta, ktoré nie sú herným stavom (players, dirty…)]
//   spec.resource  – (path) => zdroj | null   mapovanie cesty na zdroj (predvolené Draft.resourceOf)
//   spec.onError   – (err, ev, world) => void   voliteľné, inak console.error
//
// Udalosť vo fronte: { at, seq, type, data, key?, periodic? }
//   bežná      – bez kľúča; plánuje ju handler alebo akcia hráča (schedule / scheduleIn)
//   unikátna   – s kľúčom; s rovnakým kľúčom je vo fronte najviac jedna (scheduleUnique, zrušenie cez cancel)
//   periodická – s kľúčom a periodic: true; plánuje ju len reconcile podľa spec.periodic
//
// Čas sa neposúva po krokoch, ale skokom na najbližšiu udalosť (advanceTo). Podrobný popis: docs/engine.md.
//
// ---- Návrhy, kolá a vykonanie (commitBatch) ----
// Dávka = všetko, čo má v jednom kroku nastať (dnes udalosti, neskôr aj akcie hráčov). Nikto nemení svet priamo:
//   1. každý vstup dávky sa vyhodnotí nad tým istým zmrazeným svetom na vlastnom návrhu (draft.js) s vlastným
//      generátorom náhody; výsledok je návrh { reads, writes, patches, ops, outbox } alebo odmietnutie,
//   2. návrhy sa vykonajú v poradí dávky; návrh, ktorého reads ∪ writes sa stretáva s writes už vykonaného návrhu,
//      sa odloží (hold) a vyhodnotí znova v ďalšom kole toho istého kroku nad už zmeneným svetom,
//   3. návrh sa vykoná celý alebo vôbec (chyba v handleri nezanechá nič).
// Vyhodnotenia v jednom kole na sebe nezávisia (mohli by bežať paralelne); poradie určuje len vykonanie.
// Starý handler (spec.handlers) sa správa ako návrh so writes: '*' – v kole sa vykoná len ako prvý a ostatné odloží,
// takže beží presne raz a smie mať vedľajšie účinky (posielať správy hráčom) ako doteraz.
const crypto = require('crypto');
const { TICKS_PER_DAY, MIN_PER_TICK, DAWN_TICK, dayOfTick, minOfTick } = require('./shared/data.js');
const Draft = require('./draft.js');

// Reálne milisekundy na jeden krok
function tickMs(world) { return world.daySeconds * 1000 / TICKS_PER_DAY; }

// ---- Náhoda (mulberry32, stav je jedno uint32 číslo v world.rng) ----
// Vo svete už rng nie je: každý návrh dostane vlastný stav (draft.locals.rng) odvodený zo semienka sveta, čísla kola
// a identity vstupu, takže rand(world) funguje v handleroch ako doteraz, ale poradie vyhodnotenia nič nezmení.
function rand(world) {
  let a = (world.rng = (world.rng + 0x6D2B79F5) >>> 0);
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function randInt(world, n) { return Math.floor(rand(world) * n); }
function pick(world, list) { return list[randInt(world, list.length)]; }
// Počiatočný stav generátora z tajného semienka a ľubovoľných častí (číslo kola, kľúč, krok…)
function seedOf(seed, ...parts) {
  return crypto.createHash('sha256').update([seed == null ? '' : seed, ...parts].join('\u0000')).digest().readUInt32LE(0);
}
// Generátor s vlastným stavom (pre čisté návrhy cez ctx.rng)
function generator(state) {
  const g = { rng: state >>> 0 };
  return { rand: () => rand(g), int: n => randInt(g, n), pick: list => pick(g, list) };
}
function newSeed() { return crypto.randomBytes(16).toString('hex'); }

// ---- Fronta udalostí ----

// Vloží udalosť na správne miesto (binárne hľadanie podľa (at, seq)).
// Udalosť nikdy nepadne do minulosti ani do práve spracúvaného kroku: najskôr world.tick + 1.
// Z návrhu (handler beží nad draftom) sa nevkladá, len zaznamená ako operácia; vykoná sa pri commite.
function insert(world, at, type, data, key, periodic) {
  const d = world[Draft.DRAFT];
  if (d) {
    const ev = { at: Math.max(at, world.tick + 1), type, data: data === undefined ? null : data };
    if (key != null) { ev.key = key; d.writes.add('event:' + key); }
    if (periodic) ev.periodic = true;
    d.ops.push({ op: 'insert', ev });
    return ev;
  }
  world.seq = (world.seq || 0) + 1;
  const ev = { at: Math.max(at, world.tick + 1), seq: world.seq, type, data: data === undefined ? null : data };
  if (key != null) ev.key = key;
  if (periodic) ev.periodic = true;
  const q = world.events;
  let lo = 0, hi = q.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const m = q[mid];
    if (m.at < ev.at || (m.at === ev.at && m.seq < ev.seq)) lo = mid + 1; else hi = mid;
  }
  q.splice(lo, 0, ev);
  return ev;
}
// Fronta tak, ako ju vidí návrh: snímok plus to, čo návrh sám zrušil a naplánoval
function queueView(d) {
  let q = d.snapshot.events;
  for (const o of d.ops) {
    if (o.op === 'cancel') q = q.filter(e => e.key !== o.key);
    else q = q.concat([o.ev]);
  }
  return q;
}

// Bežná udalosť v kroku `at`.
function schedule(world, at, type, data) { return insert(world, at, type, data); }
// Bežná udalosť o `ticks` krokov (najmenej o 1).
function scheduleIn(world, ticks, type, data) { return insert(world, world.tick + Math.max(1, ticks), type, data); }
// Unikátna udalosť: zruší čakajúcu udalosť s rovnakým kľúčom a naplánuje novú.
function scheduleUnique(world, key, at, type, data) {
  cancel(world, key);
  return insert(world, at, type, data, key);
}
// Zruší všetky čakajúce udalosti s daným kľúčom. Vráti, koľko ich zrušil.
function cancel(world, key) {
  const d = world[Draft.DRAFT];
  if (d) {
    const n = queueView(d).filter(e => e.key === key).length;
    d.writes.add('event:' + key);
    d.ops.push({ op: 'cancel', key });
    return n;
  }
  const before = world.events.length;
  world.events = world.events.filter(e => e.key !== key);
  return before - world.events.length;
}
// Najskoršia čakajúca udalosť s daným kľúčom alebo null.
function pending(world, key) {
  const d = world[Draft.DRAFT];
  if (d) { d.reads.add('event:' + key); return queueView(d).find(e => e.key === key) || null; }
  return world.events.find(e => e.key === key) || null;
}
// Krok najbližšej udalosti alebo null, keď je fronta prázdna.
function nextAt(world) { return world.events.length ? world.events[0].at : null; }

// ---- Periodické udalosti: reconciler ----
// Periodické udalosti nikto neplánuje ručne. spec.periodic ich len deklaruje a reconcile zaručí,
// že každý deklarovaný kľúč má vo fronte práve jednu udalosť:
//   1. zahodí udalosti, ktorých typ už nemá handler ani proposer (obsah odstránený z hry),
//   2. zahodí periodické udalosti, ktorých kľúč už nie je deklarovaný,
//   3. pri duplicitách nechá len najskoršiu,
//   4. chýbajúce naplánuje na def.next(world, world.tick + 1).
// Keď sa periodická udalosť vykoná, z fronty zmizne a najbližší reconcile naplánuje ďalšiu.
// Tak isto sa nové periodické udalosti dostanú aj do starých uložených svetov.
// Plán reconcile bez zmeny sveta (reconcile ho len vykoná; ladiaca stránka ho ukazuje):
//   drop    – [{ ev, why }] udalosti, ktoré zahodí
//   missing – deklarácie, ktoré vo fronte chýbajú a naplánuje ich
//   ok      – deklarácie s práve jednou udalosťou vo fronte: [{ def, ev }]
function knows(spec, type) { return !!((spec.handlers && spec.handlers[type]) || (spec.proposers && spec.proposers[type])); }
function reconcilePlan(world, spec) {
  const defs = spec.periodic || [];
  const declared = new Set(defs.map(d => d.key));
  const seen = new Map(), drop = [];
  for (const e of world.events) {
    let why = null;
    if (!knows(spec, e.type)) why = 'neznámy typ';
    else if (e.periodic && !declared.has(e.key)) why = 'nedeklarovaná periodická';
    else if (e.periodic && seen.has(e.key)) why = 'duplicita';
    if (why) drop.push({ ev: e, why });
    else if (e.periodic) seen.set(e.key, e);
  }
  return { drop, missing: defs.filter(d => !seen.has(d.key)), ok: defs.filter(d => seen.has(d.key)).map(def => ({ def, ev: seen.get(def.key) })) };
}
// Kedy má periodická udalosť nastať: def.next dostane svet s vlastným generátorom odvodeným z (semienko, kľúč, from),
// takže náhodný čas (návšteva NPC) nezávisí od ničoho iného a je rovnaký pri skoku aj pri kroku.
function planAt(world, def, from) {
  const w = Object.create(world);
  Object.defineProperty(w, 'rng', { value: seedOf(world.seed, 'plan', def.key, from), writable: true, enumerable: false });
  return def.next(w, from);
}
function reconcile(world, spec) {
  const { drop, missing } = reconcilePlan(world, spec);
  if (drop.length) {
    const gone = new Set(drop.map(d => d.ev));
    for (const d of drop) console.warn(`[engine] zahodená udalosť ${d.ev.key || d.ev.type} (${d.why})`);
    world.events = world.events.filter(e => !gone.has(e));
  }
  for (const def of missing) insert(world, planAt(world, def, world.tick + 1), def.type, def.data, def.key, true);
}

// ---- Návrhy ----

class Reject { constructor(msg) { this.msg = msg; } }

// Identita vstupu: z nej (a zo semienka a kola) sa odvodzuje náhoda návrhu, takže pridanie či ubratie
// iného vstupu v dávke nezmení jeho výsledok.
function inputId(input) { return input.id != null ? String(input.id) : input.ev && input.ev.seq != null ? 'ev#' + input.ev.seq : input.type; }

// Vyhodnotí jeden vstup nad snímkom `world` (bez zmeny sveta). Vráti výsledok návrhu:
//   { id, input, legacy, reads, writes, patches, ops, outbox }           – návrh na vykonanie
//   { …, reject: msg }                                                   – odmietnutie (nič sa nevykoná, hráč dostane správu)
//   { …, error }                                                         – chyba v handleri (nič sa nevykoná, vstup sa spotrebuje)
function evaluate(world, input, spec) {
  const id = inputId(input);
  const proposer = spec.proposers && spec.proposers[input.type];
  const legacy = !proposer && spec.handlers && spec.handlers[input.type];
  const d = Draft.createDraft(world, { resource: spec.resource, transient: spec.transient, rng: seedOf(world.seed, world.step || 0, id) });
  const outbox = [];
  const res = { id, input, legacy: !!legacy, reads: d.reads, writes: d.writes, patches: d.patches, ops: d.ops, outbox };
  try {
    if (proposer) {
      const ctx = {
        tick: world.tick, input, rng: generator(d.locals.rng),
        emit: msg => { outbox.push(msg); },
        reject: msg => { throw new Reject(msg); },
        schedule: (at, type, data) => schedule(d.proxy, at, type, data),
        scheduleIn: (ticks, type, data) => scheduleIn(d.proxy, ticks, type, data),
        scheduleUnique: (key, at, type, data) => scheduleUnique(d.proxy, key, at, type, data),
        cancel: key => cancel(d.proxy, key),
        pending: key => pending(d.proxy, key)
      };
      proposer(d.proxy, input.data, ctx);
    } else if (legacy) {
      legacy(d.proxy, input.data, input.ev || input);
      d.writes.add('*');
    } else throw new Error(`neznámy typ vstupu ${input.type}`);
  } catch (err) {
    if (err instanceof Reject) res.reject = err.msg; else res.error = err;
  }
  return res;
}

// Vykoná jeden návrh na živom svete: záplaty, potom operácie s frontou (v poradí, seq pridelí commit).
function applyResult(world, r) {
  Draft.applyPatches(world, r.patches);
  for (const o of r.ops) {
    if (o.op === 'cancel') cancel(world, o.key);
    else insert(world, o.ev.at, o.ev.type, o.ev.data, o.ev.key, o.ev.periodic);
  }
}

// Vykoná dávku vstupov v kolách (pozri hlavičku). inputs: [{ type, data, ev?, id? }] v poradí dávky.
// Vráti { rounds, applied: [výsledky], rejected: [výsledky], outbox: [správy] }.
function commitBatch(world, inputs, spec) {
  const out = { rounds: 0, applied: [], rejected: [], outbox: [] };
  let todo = inputs;
  while (todo.length) {
    out.rounds++;
    const written = [], held = [];
    let star = false;
    for (const input of todo) {
      // starý handler beží len ako prvý vykonaný v kole – tak sa vyhodnotí presne raz a smie mať vedľajšie účinky
      if (star || (written.length && spec.handlers && spec.handlers[input.type] && !(spec.proposers && spec.proposers[input.type]))) { held.push(input); continue; }
      const r = evaluate(world, input, spec);
      if (r.error) { (spec.onError || logError)(r.error, input.ev || input, world); continue; }
      if (written.length && Draft.conflicts(new Set([...r.reads, ...r.writes]), written)) { held.push(input); continue; }
      if (r.reject !== undefined) { out.rejected.push(r); continue; }
      applyResult(world, r);
      written.push(...r.writes);
      out.applied.push(r);
      out.outbox.push(...r.outbox);
      if (r.writes.has('*')) star = true;
    }
    world.step = (world.step || 0) + 1;
    todo = held;
  }
  return out;
}

// ---- Vykonávanie ----

// Vykoná všetky udalosti, ktoré pripadajú na world.tick, ako jednu dávku.
// Čo dávka naplánuje, padne najskôr na world.tick + 1, takže dávka je vopred uzavretá.
// Chyba v handleri sa zachytí a zapíše; udalosť sa tým spotrebuje a simulácia beží ďalej.
function runBatch(world, spec) {
  const inputs = [];
  while (world.events.length && world.events[0].at <= world.tick) {
    const ev = world.events.shift();
    inputs.push({ type: ev.type, data: ev.data, ev });
  }
  if (inputs.length) commitBatch(world, inputs, spec);
  return inputs.length;
}
function logError(err, ev, world) {
  console.error(`[engine] chyba v udalosti ${ev.key || ev.type} (krok ${world.tick}, data ${JSON.stringify(ev.data)}):`, err);
}

// Posunie čas na krok `target` skokmi z udalosti na udalosť:
//   reconcile → najbližšia udalosť → ak je až po `target`, koniec → hodiny na ňu → dávka → znova.
// Kroky bez udalostí sa vôbec nesimulujú, takže posun o 1 krok aj o 30 dní je ten istý cyklus.
// Vráti počet vykonaných udalostí.
function advanceTo(world, target, spec) {
  let n = 0;
  for (;;) {
    reconcile(world, spec);
    const at = nextAt(world);
    if (at === null || at > target) break;
    world.tick = Math.max(world.tick, at);
    n += runBatch(world, spec);
  }
  if (target > world.tick) world.tick = target;
  return n;
}

// Dobehne reálny čas: posunie svet o toľko celých krokov, koľko ubehlo od world.wall (najviac maxTicks).
// Vráti, o koľko krokov sa čas posunul.
function advance(world, nowMs, spec, maxTicks) {
  const ms = tickMs(world);
  // tickMs nie je celé číslo – malá tolerancia, aby zaokrúhlenie wall nestratilo celý krok
  const due = Math.min(Math.floor((nowMs - world.wall) / ms + 1e-9), maxTicks || Infinity);
  if (!(due > 0)) return 0;
  advanceTo(world, world.tick + due, spec);
  world.wall += due * ms;
  return due;
}

// ---- Výpočet času periodických udalostí (pre def.next) ----

// Najbližší krok >= from tvaru offset + k * period (každú hodinu, každé 2 dni o 7:00, raz za rok…).
function nextEvery(from, period, offset) {
  const o = ((offset || 0) % period + period) % period;
  return Math.ceil((from - o) / period) * period + o;
}
// Najbližší krok >= from, ktorý padne na danú dennú hodinu (v krokoch od polnoci).
function nextDailyTick(from, tickOfDay) { return nextEvery(from, TICKS_PER_DAY, tickOfDay); }
// Hotové funkcie next pre spec.periodic.
function daily(tickOfDay) { return (world, from) => nextDailyTick(from, tickOfDay); }
function every(period, offset) { return (world, from) => nextEvery(from, period, offset); }

module.exports = {
  TICKS_PER_DAY, MIN_PER_TICK, DAWN_TICK, dayOfTick, minOfTick,
  tickMs, rand, randInt, pick, seedOf, generator, newSeed,
  schedule, scheduleIn, scheduleUnique, cancel, pending, nextAt,
  reconcile, reconcilePlan, planAt, evaluate, applyResult, commitBatch, runBatch, advanceTo, advance,
  nextEvery, nextDailyTick, daily, every,
  DRAFT: Draft.DRAFT, resourceOf: Draft.resourceOf, conflicts: Draft.conflicts, createDraft: Draft.createDraft, applyPatches: Draft.applyPatches
};
