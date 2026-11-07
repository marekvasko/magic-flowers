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
//   spec.proposers – { typ: { keys(data, world) → { reads, writes }, run(slices, data, ctx) } }   návrhy (pozri nižšie)
//   spec.periodic  – [{ key, type, data?, next(from, rng) }]   periodické udalosti (pozri reconcile)
//   spec.slice     – (world, key) => { get(), set(value, changes?) } | null   mapovanie kľúča na výrez (predvolené sliceOf)
//   spec.presence  – (world) => ľubovoľná snímka toho, čo nie je stav (pripojení hráči); návrh ju dostane ako ctx.presence
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
// Dávka = všetko, čo má v jednom kroku nastať (dnes udalosti, neskôr aj akcie hráčov). Nikto nemení svet priamo:
//   1. návrh najprv deklaruje kľúče (keys): čo číta a čo mení – 'tile:garden:12', 'save:ana', 'market:*', 'contracts'…
//      Kľúč končiaci '*' je celá kolekcia ('save:*' = všetky uloženia) a stretáva sa s každým kľúčom s tým istým začiatkom.
//   2. engine mu dá obyčajné kópie práve týchto výrezov (slices[kľúč]) a vlastný generátor náhody; run ich mení
//      bežným kódom; nedeklarovaný výrez v slices nie je (undefined), takže siahnutie naň zlyhá nahlas,
//   3. návrhy sa vykonajú v poradí dávky: deklarované výrezy sa zapíšu späť do sveta na mieste (objekty, ktoré
//      server drží – uloženie hráča, políčko – si zachovajú identitu). Návrh, ktorého kľúče sa stretávajú so zápismi
//      už vykonaného návrhu, sa odloží (hold) a vyhodnotí znova v ďalšom kole toho istého kroku nad zmeneným svetom,
//   4. návrh sa vykoná celý alebo vôbec (chyba v run nezanechá nič); zmena výrezu deklarovaného len na čítanie je chyba.
// Vyhodnotenia v jednom kole na sebe nezávisia (mohli by bežať paralelne); poradie určuje len vykonanie.
// Plánovanie udalostí ide cez ctx (schedule, scheduleUnique, cancel, pending) ako operácie vykonané pri commite;
// unikátna udalosť je zároveň kľúč 'event:<kľúč>', ktorý engine k návrhu pridá sám.
const crypto = require('crypto');
const { TICKS_PER_DAY, MIN_PER_TICK, DAWN_TICK, dayOfTick, minOfTick } = require('./shared/data.js');

// Reálne milisekundy na jeden krok
function tickMs(world) { return world.daySeconds * 1000 / TICKS_PER_DAY; }

// ---- Náhoda (mulberry32, stav je jedno uint32 číslo) ----
// Vo svete rng nie je: každý návrh dostane vlastný generátor odvodený zo semienka sveta, čísla kola a identity vstupu,
// takže poradie vyhodnotenia nič nezmení.
function mulberry(g) {
  let a = (g.state = (g.state + 0x6D2B79F5) >>> 0);
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
// Počiatočný stav generátora z tajného semienka a ľubovoľných častí (číslo kola, kľúč, krok…)
function seedOf(seed, ...parts) {
  return crypto.createHash('sha256').update([seed == null ? '' : seed, ...parts].join('\u0000')).digest().readUInt32LE(0);
}
// Generátor s vlastným stavom: rand() ∈ [0,1), int(n) ∈ 0..n-1, pick(list)
function generator(state) {
  const g = { state: state >>> 0 };
  const rand = () => mulberry(g), int = n => Math.floor(rand() * n);
  return { rand, int, pick: list => list[int(list.length)] };
}
function newSeed() { return crypto.randomBytes(16).toString('hex'); }

// ---- Fronta udalostí ----

// Vloží udalosť na správne miesto (binárne hľadanie podľa (at, seq)).
// Udalosť nikdy nepadne do minulosti ani do práve spracúvaného kroku: najskôr world.tick + 1.
function insert(world, at, type, data, key, periodic) {
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
  const before = world.events.length;
  world.events = world.events.filter(e => e.key !== key);
  return before - world.events.length;
}
// Najskoršia čakajúca udalosť s daným kľúčom alebo null.
function pending(world, key) { return world.events.find(e => e.key === key) || null; }
// Krok najbližšej udalosti alebo null, keď je fronta prázdna.
function nextAt(world) { return world.events.length ? world.events[0].at : null; }

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
function knows(spec, type) { return !!(spec.proposers && spec.proposers[type]); }
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
// Kedy má periodická udalosť nastať: def.next dostane generátor odvodený z (semienko, kľúč, from),
// takže náhodný čas (návšteva NPC) nezávisí od ničoho iného a je rovnaký pri skoku aj pri kroku.
function planAt(world, def, from) { return def.next(from, generator(seedOf(world.seed, 'plan', def.key, from)), world); }
function reconcile(world, spec) {
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
//   save:<kľúč> | save:*                  uloženie hráča / všetky uloženia
//   market:seed_<sp> | market:fl_<sp> | market:compost | market:festival | market:hist | market:news | market:npc:<meno>
//   market:seed_* | market:fl_* | market:npc:* | market:*     kolekcie trhu / celý trh
//   storage                               sklad ako { inv, fb } (world.storage + world.storageFb)
//   čokoľvek iné                          vlastnosť sveta s tým menom (weather, contracts, icehouse, scav, up, plotsUsed…)
// Výrez vráti { get() → hodnota, set(value, changes?) } alebo null, ak kľúč nikam nevedie (napr. neexistujúce uloženie).
const isObj = v => v !== null && typeof v === 'object';
function at(parent, prop) {
  if (!isObj(parent)) return null;
  return { get: () => parent[prop], set: (v, changes) => sync(parent, prop, v, [], changes) };
}
function sliceOf(world, key) {
  const [a, b, c] = key.split(':');
  switch (a) {
    case 'tile': { const coll = b === 'garden' ? 'tiles' : b; return c === '*' ? at(world, coll) : at(world[coll], +c); }
    case 'save': return b === '*' ? at(world, 'saves') : at(world.saves, b);
    case 'market': {
      const m = world.market;
      if (b === '*') return at(world, 'market');
      if (!m) return null;
      if (b === 'seed_*') return at(m, 'seeds');
      if (b === 'fl_*') return at(m, 'flowers');
      if (b.startsWith('seed_')) return at(m.seeds, b.slice(5));
      if (b.startsWith('fl_')) return at(m.flowers, b.slice(3));
      if (b === 'npc') return c === '*' ? at(m, 'npcs') : at(m.npcs, c);
      return at(m, b);
    }
    case 'storage': return {
      get: () => ({ inv: world.storage, fb: world.storageFb || {} }),
      set: (v, changes) => { sync(world, 'storage', v.inv, ['inv'], changes); sync(world, 'storageFb', v.fb, ['fb'], changes); }
    };
    default: return at(world, key);
  }
}
// Stretávajú sa dva kľúče? ('x:*' = všetko s tým začiatkom)
function meets(a, b) {
  if (a.endsWith('*')) return b.startsWith(a.slice(0, -1)) || b === a;
  if (b.endsWith('*')) return a.startsWith(b.slice(0, -1));
  return a === b;
}
// Stretáva sa niektorý kľúč z `keys` s niektorým z `written`?
function conflicts(keys, written) {
  for (const k of keys) for (const w of written) if (meets(k, w)) return true;
  return false;
}
// Hlboká kópia hodnoty JSON
function clone(v) {
  if (!isObj(v)) return v;
  if (Array.isArray(v)) return v.map(clone);
  const out = {};
  for (const k in v) out[k] = clone(v[k]);
  return out;
}
// Zapíše hodnotu `src` do parent[prop] na mieste: existujúce objekty sa menia zvnútra (zachovajú identitu – uloženie
// hráča, políčko), polia tiež, kým majú rovnakú dĺžku; pole inej dĺžky sa nahradí celé (prvok odstránený zo zoznamu
// ostane tým, čím bol, nezmení sa na svojho suseda). Čo pribudlo, sa priradí, čo zmizlo, sa zmaže.
// Ak dostane `changes`, zaznamená každú zmenu listu { p: cesta vo výreze, from, to } (hodnoty skopírované, nie živé).
function sync(parent, prop, src, stack, changes) {
  const cur = parent[prop];
  if (isObj(src) && isObj(cur) && Array.isArray(src) === Array.isArray(cur) && (!Array.isArray(src) || src.length === cur.length)) {
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
function same(a, b) {
  if (a === b) return true;
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false; return true; }
  for (const k in a) if (!(k in b) || !same(a[k], b[k])) return false;
  for (const k in b) if (!(k in a)) return false;
  return true;
}
// Zlúči deklarácie kľúčov viacerých častí návrhu
function mergeKeys(...list) {
  const reads = new Set(), writes = new Set();
  for (const k of list) { for (const r of k.reads || []) reads.add(r); for (const w of k.writes || []) writes.add(w); }
  for (const w of writes) reads.delete(w);
  return { reads: [...reads], writes: [...writes] };
}

// ---- Návrhy ----

class Reject { constructor(msg) { this.msg = msg; } }

// Identita vstupu: z nej (a zo semienka a kola) sa odvodzuje náhoda návrhu, takže pridanie či ubratie
// iného vstupu v dávke nezmení jeho výsledok.
function inputId(input) { return input.id != null ? String(input.id) : input.ev && input.ev.seq != null ? 'ev#' + input.ev.seq : input.type; }

// Kontext návrhu (aj „živý“ pre akcie, ktoré ešte nebežia cez engine – pozri liveCtx): náhoda, správy, fronta.
// queue: funkcie nad frontou; events: množina kľúčov 'event:…', ktorých sa návrh dotkol (null = nezaznamenáva)
function makeCtx(world, id, rng, queue, events, presence) {
  const touch = key => { if (events) events.add('event:' + key); };
  const outbox = [];
  return {
    tick: world.tick, id, rng, presence, outbox,
    emit: msg => { outbox.push(msg); },
    reject: msg => { throw new Reject(msg); },
    schedule: (at, type, data) => queue.insert(at, type, data),
    scheduleIn: (ticks, type, data) => queue.insert(world.tick + Math.max(1, ticks), type, data),
    scheduleUnique: (key, at, type, data) => { touch(key); queue.cancel(key); return queue.insert(at, type, data, key); },
    cancel: key => { touch(key); return queue.cancel(key); },
    pending: key => { touch(key); return queue.pending(key); }
  };
}
// Kontext nad živým svetom: pre akcie hráčov, ktoré ešte menia svet priamo (fáza 3 ich prevedie na návrhy),
// a pre založenie sveta. Náhoda z (semienko, kolo, id) – id nech je pre každú akciu iné.
function liveCtx(world, id) {
  const queue = {
    insert: (at, type, data, key) => insert(world, at, type, data, key),
    cancel: key => cancel(world, key), pending: key => pending(world, key)
  };
  return makeCtx(world, id, generator(seedOf(world.seed, world.step || 0, id)), queue, null, null);
}
// Fronta tak, ako ju vidí návrh: snímok plus to, čo návrh sám zrušil a naplánoval; zmeny sa len zapisujú ako ops
function draftQueue(world, ops) {
  const view = () => {
    let q = world.events;
    for (const o of ops) q = o.op === 'cancel' ? q.filter(e => e.key !== o.key) : q.concat([o.ev]);
    return q;
  };
  return {
    insert(at, type, data, key, periodic) {
      const ev = { at: Math.max(at, world.tick + 1), type, data: data === undefined ? null : data };
      if (key != null) ev.key = key;
      if (periodic) ev.periodic = true;
      ops.push({ op: 'insert', ev });
      return ev;
    },
    cancel(key) { const n = view().filter(e => e.key === key).length; ops.push({ op: 'cancel', key }); return n; },
    pending(key) { return view().find(e => e.key === key) || null; }
  };
}

// Deklarované kľúče vstupu (bez vyhodnotenia). Vráti { reads: Set, writes: Set } alebo { error }.
function keysOf(world, input, spec) {
  const proposer = spec.proposers && spec.proposers[input.type];
  if (!proposer) return { error: new Error(`neznámy typ vstupu ${input.type}`) };
  try {
    const k = proposer.keys ? proposer.keys(input.data, world) : {};
    const writes = new Set(k.writes || []), reads = new Set((k.reads || []).filter(r => !writes.has(r)));
    return { reads, writes };
  } catch (error) { return { error }; }
}

// Vyhodnotí jeden vstup nad snímkom `world` (bez zmeny sveta). Vráti výsledok návrhu:
//   { id, input, reads, writes, slices, ops, outbox }    – návrh na vykonanie (slices = zmenené kópie výrezov)
//   { …, reject: msg }                                   – odmietnutie (nič sa nevykoná, hráč dostane správu)
//   { …, error }                                         – chyba (nič sa nevykoná, vstup sa spotrebuje)
function evaluate(world, input, spec, presence) {
  const id = inputId(input);
  const k = keysOf(world, input, spec);
  const res = { id, input, reads: k.reads || new Set(), writes: k.writes || new Set(), slices: {}, ops: [], outbox: [] };
  if (k.error) { res.error = k.error; return res; }
  const sliceOfKey = key => (spec.slice ? spec.slice(world, key) : sliceOf(world, key));
  try {
    for (const key of [...res.reads, ...res.writes]) { const s = sliceOfKey(key); if (s) res.slices[key] = clone(s.get()); }
    const ctx = makeCtx(world, id, generator(seedOf(world.seed, world.step || 0, id)), draftQueue(world, res.ops), res.writes, presence);
    spec.proposers[input.type].run(res.slices, input.data, ctx);
    res.outbox = ctx.outbox;
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
function applyResult(world, r, spec, changes) {
  for (const key of r.writes) {
    if (!(key in r.slices)) continue;
    const s = spec && spec.slice ? spec.slice(world, key) : sliceOf(world, key);
    if (!s) continue;
    const list = changes ? [] : null;
    s.set(r.slices[key], list);
    if (list && list.length) changes[key] = list;
  }
  for (const o of r.ops) {
    if (o.op === 'cancel') cancel(world, o.key);
    else insert(world, o.ev.at, o.ev.type, o.ev.data, o.ev.key, o.ev.periodic);
  }
}

// Vykoná dávku vstupov v kolách (pozri hlavičku). inputs: [{ type, data, ev?, id? }] v poradí dávky.
// Vráti { tick, rounds, applied: [výsledky], rejected: [výsledky], outbox: [správy], entry } a zavolá spec.onBatch.
// entry je záznam dávky do denníka: vstupy, poradie, kľúče a osud každého návrhu v každom kole, zmeny, správy.
function commitBatch(world, inputs, spec) {
  const journal = !!spec.onBatch;
  const entry = { tick: world.tick, step: world.step || 0, inputs: inputs.map(i => ({ id: inputId(i), type: i.type, data: i.data, ev: i.ev ? { at: i.ev.at, seq: i.ev.seq, key: i.ev.key } : undefined })), proposals: [], outbox: [] };
  const out = { tick: world.tick, rounds: 0, applied: [], rejected: [], outbox: entry.outbox, entry };
  const presence = spec.presence ? spec.presence(world) : undefined;
  let todo = inputs;
  while (todo.length) {
    out.rounds++;
    const written = [], held = [];
    const record = (r, outcome, extra) => entry.proposals.push(Object.assign({ id: r.id, type: r.input.type, round: out.rounds, reads: [...r.reads], writes: [...r.writes], outcome }, extra));
    for (const input of todo) {
      // kolízia už z deklarácie: netreba ani vyhodnocovať, návrh počká na ďalšie kolo
      if (written.length) {
        const k = keysOf(world, input, spec);
        if (!k.error && conflicts([...k.reads, ...k.writes], written)) { held.push(input); record({ id: inputId(input), input, reads: k.reads, writes: k.writes }, 'held'); continue; }
      }
      const r = evaluate(world, input, spec, presence);
      if (r.error) { (spec.onError || logError)(r.error, input.ev || input, world); record(r, 'error', { msg: String(r.error && r.error.message || r.error) }); continue; }
      if (written.length && conflicts([...r.reads, ...r.writes], written)) { held.push(input); record(r, 'held'); continue; }
      if (r.reject !== undefined) { out.rejected.push(r); record(r, 'rejected', { msg: r.reject }); continue; }
      const changes = journal ? {} : null;
      applyResult(world, r, spec, changes);
      written.push(...r.writes);
      out.applied.push(r);
      out.outbox.push(...r.outbox);
      record(r, 'applied', journal ? { changes } : undefined);
    }
    world.step = (world.step || 0) + 1;
    todo = held;
  }
  out.step = world.step;
  if (journal) spec.onBatch(world, out);
  return out;
}

// ---- Vykonávanie ----

// Vykoná všetky udalosti, ktoré pripadajú na world.tick, ako jednu dávku.
// Čo dávka naplánuje, padne najskôr na world.tick + 1, takže dávka je vopred uzavretá.
// Chyba v návrhu sa zachytí a zapíše; udalosť sa tým spotrebuje a simulácia beží ďalej.
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

// Prehrá záznamy denníka (entry z commitBatch) nad uloženým svetom: udalosti vzniknú znova z fronty,
// ostatné vstupy (akcie) sa vykonajú ako vlastná dávka v kroku záznamu. Vráti počet prehraných dávok.
function replay(world, entries, spec) {
  let n = 0;
  for (const e of entries) {
    advanceTo(world, e.tick, spec);
    const inputs = e.inputs.filter(i => !i.ev).map(i => ({ type: i.type, data: i.data, id: i.id }));
    if (inputs.length) commitBatch(world, inputs, spec);
    n++;
  }
  return n;
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
function daily(tickOfDay) { return from => nextDailyTick(from, tickOfDay); }
function every(period, offset) { return from => nextEvery(from, period, offset); }

module.exports = {
  TICKS_PER_DAY, MIN_PER_TICK, DAWN_TICK, dayOfTick, minOfTick,
  tickMs, seedOf, generator, newSeed,
  schedule, scheduleIn, scheduleUnique, cancel, pending, nextAt,
  reconcile, reconcilePlan, planAt, keysOf, evaluate, applyResult, commitBatch, runBatch, advanceTo, advance, replay, liveCtx,
  nextEvery, nextDailyTick, daily, every,
  sliceOf, meets, conflicts, clone, same, sync, mergeKeys
};
