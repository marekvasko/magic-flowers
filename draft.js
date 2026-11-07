// Návrh (draft): kópia sveta „pri zápise“ (copy-on-write) nad zmrazeným snímkom.
//
// Návrh (proposal) nikdy nemení svet priamo. Handler dostane namiesto sveta proxy, ktorá:
//   - čítanie púšťa do snímku a zapisuje si, ktoré zdroje (resources) návrh čítal,
//   - pri prvom zápise skopíruje objekt (a cestu k nemu až ku koreňu), takže snímok ostane nedotknutý,
//   - každý zápis zaznamená ako záplatu (patch) { op: 'set' | 'del', path, value } a zdroj, ktorého sa týka.
// Z návrhu potom vzniknú: reads, writes (množiny zdrojov), patches (zoznam záplat) a ops (plánovanie udalostí).
// applyPatches záplaty vykoná na živom svete na mieste – objekty, ktoré server drží (uloženie hráča,
// políčka), si zachovajú identitu.
//
// Zdroje (resources) sú hrubšie než cesty: 'tile:garden:12', 'save:ana', 'pos:ana', 'market:seed_mak', 'contracts'…
// Dva návrhy, ktoré nezdieľajú zdroj, sa nijako neovplyvňujú (pozri engine.js, commitBatch).
// Kľúč končiaci '*' je celá kolekcia ('save:*' = iterovanie všetkých uložení) a stretáva sa s každým kľúčom s tým istým začiatkom.
// Kľúč '*' sa stretáva so všetkým (starý handler, ktorý nedeklaruje, čo mení).
//
// Čo nie je stav (players, dirty, tick, wall…), je „prechodné“ (transient): prechádza priamo na živý objekt sveta,
// bez kópie a bez sledovania. Kľúč 'rng' je lokálny: každý návrh má vlastný generátor a E.rand(world) naň siahne cez návrh.

const DRAFT = Symbol('draft');
const POS_FIELDS = new Set(['x', 'y', 'area', 'lastTick']);
const isIndex = k => typeof k === 'string' ? /^\d+$/.test(k) : Number.isInteger(k);
const isObj = v => v !== null && typeof v === 'object';

// Predvolené mapovanie cesty vo svete na zdroj (herná znalosť: ako je uložený svet, pozri serialize v server.js).
// Cesta kratšia než zdroj (napr. ['saves']) dá kľúč kolekcie ('save:*'). Neznámy kľúč na vrchu je sám sebe zdrojom.
function resourceOf(path) {
  const [k, a, b] = path;
  switch (k) {
    case 'tiles': return isIndex(a) ? `tile:garden:${a}` : 'tile:garden:*';
    case 'hory': return isIndex(a) ? `tile:hory:${a}` : 'tile:hory:*';
    case 'les': return isIndex(a) ? `tile:les:${a}` : 'tile:les:*';
    case 'saves': return a === undefined ? 'save:*' : POS_FIELDS.has(b) ? `pos:${a}` : `save:${a}`;
    case 'market':
      if (a === undefined) return 'market:*';
      if (a === 'seeds' || a === 'flowers') { const p = a === 'seeds' ? 'seed_' : 'fl_'; return b === undefined ? `market:${p}*` : `market:${p}${b}`; }
      if (a === 'npcs') return b === undefined ? 'market:npc:*' : `market:npc:${b}`;
      return `market:${a}`; // compost, festival, hist, news
    case 'storage': case 'storageFb': return 'storage';
    case 'events': case 'seq': return 'events';
    default: return String(k);
  }
}
// Kľúče sveta, ktoré nie sú herným stavom a návrh ich nesleduje (dopĺňa spec.transient).
const TRANSIENT = ['tick', 'wall', 'daySeconds', 'v', 'migratedFrom', 'id', 'day', 'min'];

// Stretávajú sa dva zdroje? ('*' všetko, 'x:*' všetko s tým začiatkom)
function meets(a, b) {
  if (a === '*' || b === '*') return true;
  if (a.endsWith('*')) return b.startsWith(a.slice(0, -1)) || b === a;
  if (b.endsWith('*')) return a.startsWith(b.slice(0, -1));
  return a === b;
}
// Stretáva sa niektorý zdroj z `keys` s niektorým z `written`?
function conflicts(keys, written) {
  for (const k of keys) for (const w of written) if (meets(k, w)) return true;
  return false;
}

// Hlboká kópia hodnoty JSON (záplaty sa pri vykonaní kopírujú, aby svet nezdieľal objekty s návrhom)
function clone(v) {
  if (!isObj(v)) return v;
  if (Array.isArray(v)) return v.map(clone);
  const out = {};
  for (const k in v) out[k] = clone(v[k]);
  return out;
}

// Vytvorí návrh nad snímkom `world`. opts: { resource(path), transient: [kľúče], rng: uint32 }
// Vráti { proxy, reads, writes, patches, ops, rng } – proxy sa dáva handleru, ostatné číta engine po jeho skončení.
function createDraft(world, opts) {
  const o = opts || {};
  const resource = o.resource || resourceOf;
  const transient = new Set([...TRANSIENT, ...(o.transient || [])]);
  const reads = new Set(), writes = new Set(), patches = [], ops = [];
  const locals = { rng: o.rng >>> 0 };
  const proxyNode = new WeakMap(); // proxy → uzol (na rozbalenie hodnôt, ktoré handler vráti späť do sveta)
  const draft = { reads, writes, patches, ops, locals, snapshot: world };

  // Uzol stromu: jeden objekt vo svete (target = objekt zo snímku alebo hodnota, ktorú tam handler vložil).
  // Kópiu má, len ak sa doňho (alebo pod neho) zapisovalo. Uzol je viazaný na svoj objekt, nie na cestu:
  // keď handler nahradí rodiča (list = list.filter(…)), proxy nájdeného prvku ďalej ukazuje na ten prvok.
  // res: zdroj uzla, keď ho už cesta určuje – zdroj závisí najviac od prvých troch prvkov cesty (saves.ana.x je pos:ana,
  // saves.ana.inv.* už save:ana), takže od hĺbky 3 ho potomkovia dedia a nepočítajú znova. Inak null.
  function node(parent, key, target) {
    const path = parent ? parent.path.concat(key) : [];
    let res = null;
    if (path.length >= 3) { res = parent.res || resource(path); if (res && res.endsWith('*')) res = null; }
    return { parent, key, path, res, target, copy: null, children: new Map(), proxy: null };
  }
  // Zdroj vlastnosti uzla: zdedený, alebo z cesty (pod koreňom a v kolekciách)
  function resOf(n, prop) { return n.res || resource(n.path.concat(prop)); }
  const root = node(null, null, world);
  // Vrchné kľúče sveta, ktoré návrh zmenil (koreň sa nekopíruje – svet žije ďalej); DELETED = kľúč zmazaný
  const DELETED = Symbol('deleted');
  const rootCopies = {};
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function current(n) { return n.copy || n.target; }
  // Hodnota vlastnosti uzla tak, ako ju návrh vidí (vrchné kľúče cez rootCopies)
  function valueOf(n, key) {
    if (!n.parent && own(rootCopies, key)) return rootCopies[key] === DELETED ? undefined : rootCopies[key];
    return Reflect.get(current(n), key, current(n));
  }
  // Je uzol stále na svojom mieste vo svete? Proxy prvku, ktorého rodiča handler medzitým nahradil
  // (list = list.filter(…)), ukazuje na odpojený objekt – zápis cez ňu by sa pri commite dostal na nesprávnu cestu,
  // preto je chybou návrhu (čítanie cez ňu je v poriadku).
  function attached(n) {
    for (; n.parent; n = n.parent) if (valueOf(n.parent, n.key) !== current(n)) return false;
    return true;
  }
  // Objekt, do ktorého sa zapisujú vlastnosti uzla n: koreň píše do rootCopies, ostatné do vlastnej kópie.
  function writable(n) {
    if (!n.parent) return rootCopies;
    if (!attached(n)) throw new Error(`zápis cez odpojenú proxy (${n.path.join('.')}): rodič bol medzitým nahradený`);
    return ensureCopy(n);
  }
  // Zabezpečí, že uzol má vlastnú (zapisovateľnú) kópiu, a vráti ju. Kopíruje cestu až k vrchnému kľúču.
  function ensureCopy(n) {
    if (n.copy) return n.copy;
    const cur = n.target;
    n.copy = Array.isArray(cur) ? cur.slice() : Object.assign({}, cur);
    writable(n.parent)[n.key] = n.copy;
    return n.copy;
  }
  // Hodnota, ktorú handler vracia do sveta, nesmie obsahovať proxy (napr. výsledok list.filter(...))
  function unwrap(v) {
    if (!isObj(v)) return v;
    const n = proxyNode.get(v);
    if (n) return current(n);
    if (Array.isArray(v)) { let out = null; for (let i = 0; i < v.length; i++) { const u = unwrap(v[i]); if (u !== v[i]) { out = out || v.slice(); out[i] = u; } } return out || v; }
    let out = null;
    for (const k in v) { const u = unwrap(v[k]); if (u !== v[k]) { out = out || Object.assign({}, v); out[k] = u; } }
    return out || v;
  }
  function child(n, key, value) {
    let c = n.children.get(key);
    if (!c || current(c) !== value) { c = node(n, key, value); n.children.set(key, c); }
    return c;
  }
  function proxyOf(n) {
    if (n.proxy) return n.proxy;
    const cur = current(n);
    n.proxy = new Proxy(Array.isArray(cur) ? [] : {}, handler(n));
    proxyNode.set(n.proxy, n);
    return n.proxy;
  }
  const isRoot = n => !n.parent;

  function handler(n) {
    return {
      get(_, prop) {
        if (isRoot(n)) {
          if (prop === DRAFT) return draft;
          if (prop === 'rng') return locals.rng;
          if (typeof prop === 'symbol' || transient.has(prop)) return world[prop];
        }
        if (typeof prop === 'symbol') return current(n)[prop];
        const v = valueOf(n, prop);
        const r = resOf(n, prop);
        if (!r) return v; // prechodný kľúč – priamo zo živého sveta
        // kolekcia sama (room.tiles, room.saves) nie je čítanie; jej prvky, dĺžka a listy áno
        if (!r.endsWith('*') || !isObj(v)) reads.add(r);
        if (!isObj(v) || typeof v === 'function') return v;
        return proxyOf(child(n, prop, v));
      },
      set(_, prop, value) {
        if (isRoot(n)) {
          if (prop === 'rng') { locals.rng = value; return true; }
          if (typeof prop === 'symbol' || transient.has(prop)) { world[prop] = value; return true; }
        }
        const r = resOf(n, prop);
        if (!r) { current(n)[prop] = value; return true; } // prechodné (len na vrchu sveta)
        const v = unwrap(value);
        if (own(current(n), prop) && valueOf(n, prop) === v) return true; // nič sa nemení
        writable(n)[prop] = v;
        n.children.delete(prop);
        writes.add(r);
        patches.push({ op: 'set', path: n.path.concat(prop), value: v });
        return true;
      },
      deleteProperty(_, prop) {
        if (isRoot(n) && (typeof prop === 'symbol' || transient.has(prop))) { delete world[prop]; return true; }
        const r = resOf(n, prop);
        if (!r) { delete current(n)[prop]; return true; }
        if (valueOf(n, prop) === undefined && !own(current(n), prop)) return true;
        if (isRoot(n)) rootCopies[prop] = DELETED; else delete writable(n)[prop];
        n.children.delete(prop);
        writes.add(r);
        patches.push({ op: 'del', path: n.path.concat(prop) });
        return true;
      },
      has(_, prop) {
        if (typeof prop === 'symbol') return prop in current(n);
        const r = resOf(n, prop);
        if (r) reads.add(r);
        return isRoot(n) && own(rootCopies, prop) ? rootCopies[prop] !== DELETED : prop in current(n);
      },
      ownKeys() {
        if (!isRoot(n)) { reads.add(n.res || resource(n.path)); return Reflect.ownKeys(current(n)); }
        const keys = Reflect.ownKeys(world).filter(k => !(own(rootCopies, k) && rootCopies[k] === DELETED));
        for (const k of Object.keys(rootCopies)) if (rootCopies[k] !== DELETED && !keys.includes(k)) keys.push(k);
        return keys;
      },
      getOwnPropertyDescriptor(_, prop) {
        const cur = current(n);
        const v = valueOf(n, prop);
        const d = isRoot(n) && own(rootCopies, prop) ? (v === undefined ? undefined : { value: v, writable: true, enumerable: true, configurable: true }) : Object.getOwnPropertyDescriptor(cur, prop);
        if (!d) return undefined;
        if (!(Array.isArray(cur) && prop === 'length')) { d.configurable = true; if ('value' in d) d.writable = true; }
        if ('value' in d && isObj(d.value) && typeof prop !== 'symbol' && resOf(n, prop)) d.value = proxyOf(child(n, prop, d.value));
        return d;
      },
      defineProperty(_, prop, desc) {
        if (!('value' in desc)) return false;
        return this.set(_, prop, desc.value);
      },
      getPrototypeOf() { return Object.getPrototypeOf(current(n)); }
    };
  }

  draft.proxy = proxyOf(root);
  return draft;
}

// Vykoná záplaty na živom svete, na mieste (objekty po ceste ostávajú tie isté, chýbajúce sa vytvoria).
function applyPatches(world, patches) {
  for (const p of patches) {
    const path = p.path;
    let cur = world;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (!isObj(cur[k])) cur[k] = isIndex(path[i + 1]) ? [] : {};
      cur = cur[k];
    }
    const last = path[path.length - 1];
    if (p.op === 'del') delete cur[last];
    else cur[last] = clone(p.value);
  }
}

module.exports = { DRAFT, TRANSIENT, resourceOf, meets, conflicts, clone, createDraft, applyPatches };
