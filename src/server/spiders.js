// Pavúky a pavučiny (#57) na engine v2 (docs/engine.md): Les divov (vlčiaky, stará pradlena a ich pavučiny s hodvábom)
// a kútové pavučiny krížiaka v záhrade a v horách. Nič tu nemení svet priamo – všetko sú návrhy nad výrezmi.
//
// Stav sveta (obyčajný JSON):
//   world.webs    = { list: [{ id, x, y, ax, n, silk, o }], nid, pend: { [o]: [krok, …] } }   (ukladá sa)
//                   pavučina zaberá n políčok od (x, y): ax 0 = vodorovne, ax 1 = zvisle; o = majiteľ (index pavúka);
//                   pend = kedy majiteľ znova utká roztrhnutú pavučinu (udalosť weave:<o> na najbližší termín)
//   world.corners = { garden: [kľúč kúta], hory: […] }                                           (ukladá sa)
//   world.sps     = { s0: { … }, … }  pavúky v lese; world.kz = { garden, hory }  krížiak na ceste do kúta
//                   (neukladajú sa – po načítaní sú pavúky doma a spia, Spiders.load)
// Výrezy: 'webs', 'corners' (vlastnosti sveta), 'spider:<id>' / 'spider:*' a 'kz:<plocha>' (Spiders.slice).
//
// Plánovanie: každý pavúk má vlastnú periodickú udalosť 'spider:<id>' a krížiak 'kz:<plocha>'. Plánuje ich len engine
// (reconcile) podľa stavu pavúka: s.next = krok, keď chce znova konať (hýbe sa → ďalší krok; nečinný → svoj termín, najviac
// o WATCH_MS, aby si všimol hráča; nikto v lese → spí, kontrola raz za deň). Kto stav pavúka zmení zvonka (vbehnutie do
// pavučiny, ťahanie hodvábu, príchod hráča do lesa), nastaví mu next a zruší jeho udalosť – reconcile ju hneď naplánuje znova.
// Hráčov (kde stoja, lampáš, kam idú, ťahanie hodvábu) vidia návrhy len cez ctx.presence; náhoda len ctx.rng.
// Rýchlosti sú v políčkach za sekundu reálneho času, časy v D.SPIDERS / D.WEB v ms – na kroky ich prepočíta daySeconds.
const D = require('../shared/data.ts');
const E = require('./engine.ts');
const I = require('./items.ts');
const { areaTiles, clampPos } = require('./areas.ts');
const Webs = require('../shared/webs.js');
const { analyze, cornerSpots, bfs } = Webs;

const SP = D.SPIDERS, WEB = D.WEB, V = SP.vlciak, PR = SP.pradlena, KZ = SP.kriziak;
const LW = D.LES_W, LH = D.LES_H, TPD = D.TICKS_PER_DAY;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NEAR8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const IDS = Array.from({ length: SP.vlciak.n + 1 }, (_, i) => 's' + i); // 6 vlčiakov a pradlena
const IDLE_MS = 3000; // nečinný pavúk bez vlastného termínu sa rozhliadne najneskôr takto (hráča inak ohlási pohyb, posKeys)
const STEP_MS = 200; // hýbuci sa pavúk koná ~5× za sekundu reálneho času (klient polohu plynulo dopočíta)
const KZ_STEP_MS = 100; // krížiak je rýchly – koná ~10× za sekundu
const WAKE_R = Math.max(D.SPIDERS.vlciak.sense, D.SPIDERS.lamp + 0.5) + 0.5; // hráč takto blízko zobudí nečinného pavúka
const ACTIVE_R = 16; // pavúk ďalej od všetkých hráčov (v tme ho nikto nevidí) je doma a spí – žije len les okolo hráčov
const PULL_MOVE = 0.35; // o koľko sa ťahajúci hráč smie pohnúť
const CLIMB = { tree: 1, giant: 1, trunk: 1 };
const toast$ = (to, text, kind) => ({ to, t: 'toast', text, kind: kind || 'info' });
const season = tick => D.seasonOf(D.dayOfTick(tick));
const tickSec = ds => ds / TPD;
const ticksOf = (ms, ds) => Math.max(1, Math.round(ms / 1000 / tickSec(ds)));
const isObj = v => v !== null && typeof v === 'object';

// ---------- Rozbor lesa (nory, územia, miesta na pavučiny, priechodnosť, miesta na kmeňoch) ----------
// Čistá funkcia rozloženia Lesa divov. Počíta sa pri keys() nad živým svetom (len číta) a pamätá podľa semienka lesa;
// návrh si ho v run vezme cez výrez 'lesSeed' (kópie výrezov by vyrovnávaciu pamäť podľa identity poľa minuli).
const forests = new Map(); // lesSeed → { les (pole políčok), f }
function forestOf(world) {
  const c = forests.get(world.lesSeed);
  if (c && c.les === world.les) return c.f;
  const f = Object.assign(analyze(world.les, world.lesSeed >>> 0), { pass: world.les.map(t => (D.BLOCK[t.g] ? 0 : 1)), les: world.les, spots: {} });
  forests.set(world.lesSeed, { les: world.les, f });
  return f;
}
function forestBy(seed) {
  const c = forests.get(seed);
  if (!c) throw new Error('rozbor lesa chýba (keys ho nepripravil)');
  return c.f;
}
function webTiles(wb) { const out = []; for (let k = 0; k < wb.n; k++) out.push((wb.y + (wb.ax ? k : 0)) * LW + wb.x + (wb.ax ? 0 : k)); return out; }
function webAt(webs, i) { for (const wb of (webs && webs.list) || []) if (webTiles(wb).includes(i)) return wb; return null; }
const kindOf = (f, o) => (f.homes[o] ? f.homes[o].k : null);
const target = (f, o, tick) => { const k = kindOf(f, o); return k ? WEB.count[k === 'p' ? 'pradlena' : 'vlciak'][season(tick)] : 0; };
const nameOf = (f, o) => (kindOf(f, o) === 'p' ? 'Stará pradlena' : 'Vlčiak');

// ---------- Výrezy ----------
// 'spider:<id>' jeden pavúk, 'spider:*' všetky (príchod hráča do lesa ich budí), 'kz:<plocha>' krížiak na ceste.
// Ostatné kľúče rieši predvolené E.sliceOf (webs, corners sú obyčajné vlastnosti sveta).
function at(parent, prop) { return isObj(parent) ? { get: () => parent[prop], set: (v, ch) => E.sync(parent, prop, v, [], ch) } : null; }
function slice(world, key) {
  if (key === 'spider:*') return at(world, 'sps');
  if (key.startsWith('spider:')) return at(world.sps, key.slice(7));
  if (key.startsWith('kz:')) return at(world.kz, key.slice(3));
  return undefined;
}

// ---------- Pavučiny ----------
// Utká novú pavučinu na náhodnom voľnom mieste v území majiteľa (nie cez inú pavučinu ani cez hráča).
function weave(webs, f, o, ctx) {
  const used = new Set(), occ = new Set();
  for (const wb of webs.list) for (const i of webTiles(wb)) used.add(i);
  for (const p of ctx.presence || []) if (p.area === 'les') occ.add(Math.floor(p.y) * LW + Math.floor(p.x));
  const free = (f.cands[o] || []).filter(c => c.tiles.every(i => !used.has(i) && !occ.has(i)));
  if (!free.length) return null;
  const c = free[ctx.rng.int(free.length)];
  const wb = { id: ++webs.nid, x: c.x, y: c.y, ax: c.ax, n: c.n, silk: WEB.silk, o };
  webs.list.push(wb);
  return wb;
}
// Termíny tkania sa zmenili: zruší periodickú udalosť weave:<o>, engine (reconcile) ju naplánuje znova na najbližší
// termín z webs.pend[o] (PERIODIC) – návrh nikdy nič neplánuje sám
function planWeave(webs, o, ctx) { ctx.cancel('weave:' + o); }
// Pavučina zmizla (roztrhnutá, vyťahaná) – majiteľ ju o deň utká inde.
function tear(webs, wb, ctx) {
  webs.list = webs.list.filter(x => x.id !== wb.id);
  (webs.pend[wb.o] = webs.pend[wb.o] || []).push(ctx.tick + WEB.reweave);
  planWeave(webs, wb.o, ctx);
}
// Počet pavučín podľa obdobia: chýbajúce hneď dotkáme, nadbytočné (príchod zimy) pavúky zjedia, zbytočné tkanie sa zruší.
function balance(webs, f, ctx) {
  webs.list = webs.list.filter(wb => f.homes[wb.o]);
  f.homes.forEach((h, o) => {
    const want = target(f, o, ctx.tick), have = webs.list.filter(wb => wb.o === o);
    for (let k = have.length; k > want; k--) webs.list = webs.list.filter(wb => wb.id !== have[k - 1].id);
    const n = Math.min(have.length, want), pend = (webs.pend[o] || []).sort((a, b) => a - b);
    pend.length = Math.max(0, Math.min(pend.length, want - n));
    for (let k = n + pend.length; k < want; k++) weave(webs, f, o, ctx);
    if (pend.length) webs.pend[o] = pend; else delete webs.pend[o];
    planWeave(webs, o, ctx);
  });
}

// ---------- Kúty pre krížiaka (záhrada, hory) ----------
// Kľúč kúta 'i:d:e' (alebo 'i:d:e:3') začína indexom políčka, takže odstránenie pavučiny nepotrebuje políčka.
const spotCache = new WeakMap();
function spotsOf(tiles, area) {
  let c = spotCache.get(tiles);
  if (!c) { c = cornerSpots(tiles, D.areaSize(area).w, D.areaSize(area).h); spotCache.set(tiles, c); }
  return c;
}
const tileOfKey = k => parseInt(k, 10);
function cornerList(world, area) {
  const byKey = new Map(spotsOf(areaTiles(world, area), area).map(s => [s.k, s]));
  return ((world.corners && world.corners[area]) || []).map(k => byKey.get(k)).filter(Boolean);
}
// kúty, ktoré už neexistujú (napr. na pozemku postavili ľadovňu), zahodíme
function pruneCorners(corners, tiles, area) {
  const ok = new Set(spotsOf(tiles, area).map(s => s.k));
  corners[area] = (corners[area] || []).filter(k => ok.has(k));
}
function addCorner(corners, area, key) {
  const list = corners[area] || (corners[area] = []);
  if (list.length >= KZ.max || list.includes(key)) return false;
  list.push(key);
  return true;
}
// Stromy v okolí cesty krížiaka (kam vybehne, keď sa zľakne): stred kmeňa a polomer pre každý strom v dosahu
function treesNear(tiles, area, pts) {
  const { w, h } = D.areaSize(area), out = [], seen = new Set();
  for (const [px, py] of pts) {
    for (let y = Math.max(0, Math.floor(py - KZ.tree)); y <= Math.min(h - 1, Math.floor(py + KZ.tree)); y++) {
      for (let x = Math.max(0, Math.floor(px - KZ.tree)); x <= Math.min(w - 1, Math.floor(px + KZ.tree)); x++) {
        const a = Webs.anchorAt(tiles, w, h, x, y);
        if (!a || !CLIMB[a.g] || seen.has(a.cx + ',' + a.cz)) continue;
        seen.add(a.cx + ',' + a.cz);
        out.push([a.cx, a.cz, a.r]);
      }
    }
  }
  return out;
}
// Krížiak vybehne z miesta 8–14 krokov od kúta (spoza budovy, kríka…) a beží k nemu po priechodných políčkach.
function startKriziak(tiles, area, spot, ctx) {
  const { w, h } = D.areaSize(area);
  const { dist } = bfs(w, h, [spot.i], n => D.passable(tiles[n]) && tiles[n].g !== 'gate', 14);
  const far = [];
  for (let i = 0; i < dist.length; i++) if (dist[i] >= 8) far.push(i);
  if (!far.length) return null;
  const start = far[ctx.rng.int(far.length)], path = [];
  for (let i = start; i !== spot.i;) { // po klesajúcej vzdialenosti až ku kútu
    const x = i % w, y = (i / w) | 0;
    let nxt = -1;
    for (const [dx, dy] of DIRS) { const n = (y + dy) * w + x + dx; if (x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h && dist[n] === dist[i] - 1) { nxt = n; break; } }
    if (nxt < 0) return null;
    path.push(nxt); i = nxt;
  }
  const pts = [start, ...path].map(i => [i % w + 0.5, ((i / w) | 0) + 0.5]);
  return { id: 'k' + area, k: 'k', x: pts[0][0], y: pts[0][1], a: 0, path, w, spot: spot.k, trees: treesNear(tiles, area, pts),
    st: 'go', until: 0, left: 2, moving: false, next: ctx.tick + 1 };
}
// Strom, na ktorý krížiak vybehne: z vopred zistených stromov okolo cesty, radšej ďalej od toho, kto ho vyľakal
function treeFor(z, from) {
  let best = null, bs = Infinity;
  for (const [cx, cz, r] of z.trees || []) {
    const d = Math.hypot(cx - z.x, cz - z.y);
    if (d > KZ.tree) continue;
    const sc = d - 0.6 * (Math.hypot(cx - from.x, cz - from.y) - Math.hypot(z.x - from.x, z.y - from.y));
    if (sc < bs) { bs = sc; best = [cx, cz, r]; }
  }
  if (!best) return null;
  let nx = z.x - best[0], ny = z.y - best[1];
  const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
  return { x: best[0] + nx * (best[2] + 0.03), y: best[1] + ny * (best[2] + 0.03), nx, ny };
}

// ---------- Pavúky v lese ----------
function homeState(h, o) {
  return { id: 's' + o, k: h.k, o, hx: h.x + 0.5, hy: h.y + 0.5, x: h.x + 0.5, y: h.y + 0.5, a: Math.PI / 2, st: 'home', until: 0,
    cool: 0, scared: 0, path: null, tgt: null, z: 0, tr: null, web: null, moving: false, up: false, next: null };
}
const tileOf = (x, y) => Math.floor(y) * LW + Math.floor(x);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// Cesta po políčkach vlastného územia k prvému políčku, ktoré spĺňa goal (bez štartu). null = nedá sa.
function pathTo(f, s, goal) {
  const start = tileOf(s.x, s.y);
  const prev = new Map([[start, -1]]), q = [start];
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    if (goal(i)) { const out = []; for (let k = i; k !== start; k = prev.get(k)) out.unshift(k); return out; }
    const x = i % LW, y = (i / LW) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy, n = ny * LW + nx;
      if (nx < 0 || ny < 0 || nx >= LW || ny >= LH || prev.has(n) || f.owner[n] !== s.o) continue;
      prev.set(n, i); q.push(n);
    }
  }
  return null;
}
function stepTo(s, x, y, sp, dt) {
  const dx = x - s.x, dy = y - s.y, d = Math.hypot(dx, dy);
  if (d < 1e-6) return true;
  const k = Math.min(1, sp * dt / d);
  s.x += dx * k; s.y += dy * k; s.a = Math.atan2(dy, dx); s.moving = true;
  return k >= 1;
}
// cesta sa neskracuje (v denníku by bola každý krok celá znova) – pi = koľko políčok už prešiel
function setPath(s, p) { s.path = p || []; s.pi = 0; }
const pathLeft = s => (s.path ? s.path.length - (s.pi || 0) : 0);
function walkPath(s, sp, dt) {
  if (!pathLeft(s)) return true;
  const i = s.path[s.pi || 0];
  if (stepTo(s, i % LW + 0.5, ((i / LW) | 0) + 0.5, sp, dt)) s.pi = (s.pi || 0) + 1;
  return !pathLeft(s);
}
function goHome(f, s, now) { s.z = 0; s.tr = null; s.st = 'return'; s.tgt = null; setPath(s, pathTo(f, s, i => i === tileOf(s.hx, s.hy))); s.until = now; }
const inTerr = (f, s, x, y) => f.owner[tileOf(x, y)] === s.o;
// Krok preč od bodu (x, y) po vlastnom území (na susedné políčko najďalej od neho).
function away(f, s, x, y, sp, dt) {
  const cx = Math.floor(s.x), cy = Math.floor(s.y);
  let best = null, bd = Math.hypot(s.x - x, s.y - y);
  for (const [dx, dy] of NEAR8) {
    const nx = cx + dx, ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= LW || ny >= LH || f.owner[ny * LW + nx] !== s.o) continue;
    if (dx && dy && (f.owner[cy * LW + nx] !== s.o || f.owner[ny * LW + cx] !== s.o)) continue;
    const d = Math.hypot(nx + 0.5 - x, ny + 0.5 - y);
    if (d > bd) { bd = d; best = [nx + 0.5, ny + 0.5]; }
  }
  if (best) stepTo(s, best[0], best[1], sp, dt);
}
// Kde bude hráč o krok: z jeho posledného pohybu (prítomnosť vx, vy v políčkach/s)
const ahead = (p, dt) => ({ x: p.x + (p.vx || 0) * dt, y: p.y + (p.vy || 0) * dt });
function nearest(s, list) { let b = null; for (const l of list) if (!b || dist(s, l) < dist(s, b)) b = l; return b; }

// ---------- Na strome ----------
// Pavúk čaká na kmeni, ktorý drží jednu z jeho pavučín (strana kmeňa k pavučine, nx, ny = smer od kmeňa k nej),
// hlavou dole. Ker ani spadnutý kmeň nie sú strom – vtedy pavúk počká na chodníku.
function trunkSpot(les, wb) {
  const out = [];
  const ends = wb.ax ? [[wb.x, wb.y - 1, wb.x, wb.y], [wb.x, wb.y + wb.n, wb.x, wb.y + wb.n - 1]]
    : [[wb.x - 1, wb.y, wb.x, wb.y], [wb.x + wb.n, wb.y, wb.x + wb.n - 1, wb.y]];
  for (const [x, y, wx, wy] of ends) {
    const a = Webs.anchorAt(les, LW, LH, x, y);
    if (!a || !CLIMB[a.g]) continue;
    let nx = wx + 0.5 - a.cx, ny = wy + 0.5 - a.cz;
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    out.push({ x: a.cx + nx * (a.r + 0.04), y: a.cz + ny * (a.r + 0.04), nx, ny });
  }
  return out.length ? out[wb.id % out.length] : null;
}
// miesto na kmeni pri pavučine (rozloženie lesa sa nemení – pamätá sa v rozbore)
function spotOf(f, wb) { const k = [wb.x, wb.y, wb.ax, wb.n, wb.id].join(':'); if (!(k in f.spots)) f.spots[k] = trunkSpot(f.les, wb); return f.spots[k]; }
const between = (rng, [a, b]) => a + rng.rand() * (b - a);
const r3 = v => Math.round(v * 1000) / 1000; // poloha a výška na tisíciny políčka (kratší denník)
function startGuard(s, P, now, rng, T) { s.st = 'guard'; s.gz = r3(between(rng, P.guard)); s.until = now + T(between(rng, P.guardMs)); }
// Čaká na kmeni: vylezie do svojej výšky (pri zdvihnutom lampáši až na P.high a pavučinu nechá tak), po čase zlezie a ide domov.
function guard(f, s, P, lamps, now, dt, T) {
  if (lamps.some(l => dist(s, l) < SP.lamp + 0.5)) s.scared = now + T(P.backMs || 2000);
  const want = now < s.scared ? P.high : now < s.until ? s.gz : 0, dz = want - s.z, step = P.climb * dt;
  if (Math.abs(dz) > 5e-4) { s.z = Math.abs(dz) <= step ? want : s.z + Math.sign(dz) * step; s.moving = true; s.up = dz > 0; } // výšky sú na tisíciny
  else if (!want) goHome(f, s, now);
}
const hiding = (s, wb, now) => s.st === 'guard' && s.web === wb.id && now < s.scared;
function chase(s, key, now) { s.z = 0; s.tr = null; s.st = 'chase'; s.tgt = key; setPath(s, null); s.repath = 0; s.seen = now; s.border = 0; }
// Pavučinu niekto potiahol alebo do nej vbehol – majiteľ sa rozbehne k nej (pradlena rovno k hráčovi). Mení výrez pavúka
// (spider:<id>) z iného návrhu; ten mu potom zruší udalosť, aby ho engine naplánoval hneď. false = nechá to tak.
function alert(f, s, wb, key, now) {
  if (!s || hiding(s, wb, now)) return false;
  s.z = 0; s.tr = null; // z kmeňa zoskočí
  if (s.k === 'p') { if (s.st !== 'chase') chase(s, key, now); }
  else if (s.st === 'guard' && s.web === wb.id) chase(s, key, now); // čakal priamo pri nej
  else if (s.st !== 'chase') { const t = webTiles(wb), mid = t[Math.floor(t.length / 2)]; s.st = 'alert'; s.tgt = key; setPath(s, pathTo(f, s, i => i === mid)); s.until = now; }
  s.next = now + 1;
  return true;
}

function vlciak(f, s, ps, sv, ctx, dt, T) {
  const now = ctx.tick, lamps = ps.filter(p => p.lp), byKey = k => ps.find(p => p.key === k);
  const lamp = nearest(s, lamps);
  if (lamp && dist(s, lamp) < SP.lamp + 0.3) s.scared = now + T(V.backMs);
  // kým nikoho nenaháňa, všimne si hráča, ktorý príde blízko (bez lampáša)
  if (['home', 'walk', 'pause', 'return', 'search', 'totree', 'guard'].includes(s.st) && now >= s.cool && now >= s.scared) {
    const p = ps.find(p => !p.lp && dist(s, p) <= V.sense && inTerr(f, s, p.x, p.y));
    if (p) chase(s, p.key, now);
  }
  switch (s.st) {
    case 'home':
      if (now >= s.until) {
        const own = ctx.webs.list.filter(wb => wb.o === s.o);
        const wb = own.length && ctx.rng.rand() < 0.6 ? own[ctx.rng.int(own.length)] : null;
        s.web = wb ? wb.id : null;
        let g;
        if (wb) g = webTiles(wb)[0];
        else { const all = []; for (let i = 0; i < f.owner.length; i++) if (f.owner[i] === s.o) all.push(i); g = all[ctx.rng.int(all.length)]; }
        setPath(s, pathTo(f, s, i => i === g));
        s.st = 'walk';
      }
      break;
    case 'walk':
      if (walkPath(s, V.walk, dt)) {
        const wb = s.web != null && ctx.webs.list.find(w => w.id === s.web), spot = wb && spotOf(f, wb);
        if (spot) { s.st = 'totree'; s.tr = spot; s.z = 0; }
        else { s.st = 'pause'; s.until = now + T(2000 + ctx.rng.rand() * 2000); }
      }
      break;
    case 'totree': if (stepTo(s, s.tr.x, s.tr.y, V.walk, dt)) startGuard(s, V, now, ctx.rng, T); break;
    case 'guard': guard(f, s, V, lamps, now, dt, T); break;
    case 'pause': if (now >= s.until) goHome(f, s, now); break;
    case 'return': { // po zabalení hráča uteká (fast)
      const sp = s.fast ? V.run : V.walk * 1.5;
      if (walkPath(s, sp, dt) && stepTo(s, s.hx, s.hy, sp, dt)) { s.st = 'home'; s.fast = false; s.until = now + T(3000 + ctx.rng.rand() * 5000); }
      break;
    }
    case 'alert': {
      const p = byKey(s.tgt);
      if (p && dist(s, p) <= WEB.alert && inTerr(f, s, p.x, p.y)) { chase(s, p.key, now); break; }
      if (walkPath(s, V.run, dt)) {
        const q = ps.filter(o => dist(s, o) <= WEB.alert && inTerr(f, s, o.x, o.y)).sort((a, b) => dist(s, a) - dist(s, b))[0];
        if (q) chase(s, q.key, now); else { s.st = 'search'; s.until = now + T(V.lostMs); }
      }
      break;
    }
    case 'search': if (now >= s.until) goHome(f, s, now); break;
    case 'chase': {
      let p = byKey(s.tgt);
      if (p && dist(s, p) <= V.lose) s.seen = now;
      if (!p || now - s.seen > T(V.lostMs)) {
        // stratil ho – skúsi najbližšieho iného hráča vo svojom území, inak to vzdá
        const q = ps.filter(o => o !== p && dist(s, o) <= V.lose && inTerr(f, s, o.x, o.y)).sort((a, b) => dist(s, a) - dist(s, b))[0];
        if (q) { chase(s, q.key, now); p = q; } else { goHome(f, s, now); break; }
      }
      if (!inTerr(f, s, p.x, p.y)) { // za hranicou územia ďalej nejde
        if (!s.border) s.border = now;
        if (now - s.border > T(V.borderMs)) goHome(f, s, now);
        break;
      }
      s.border = 0;
      if (p.lp && dist(s, p) < SP.lamp + 0.5) s.scared = now + T(V.backMs);
      if (now < s.scared) { // lampáš: drží sa na kraji svetla, kým ho hráč nesklopí
        const l = nearest(s, lamps);
        if (l && dist(s, l) < SP.lamp) away(f, s, l.x, l.y, V.run, dt);
        break;
      }
      const d = dist(s, p);
      if (d < 0.55) { // dobehol ho: zabalí ho do pavučiny, vezme hodváb a uteká (uloženie obete návrh deklaroval, kým ho naháňal)
        if (!sv) break;
        const k = wrap(f, s, p, sv, V, ctx, T);
        ctx.emit(toast$(p.key, k ? `🕸️ Vlčiak ťa zabalil do pavučiny, vzal ti ${k}× hodváb a ušiel! Počkaj, kým sa pavučina zoderie.` : '🕸️ Vlčiak ťa zabalil do pavučiny a ušiel. Počkaj, kým sa pavučina zoderie.'));
        break;
      }
      const t = ahead(p, dt); // kam hráč o krok dobehne (cieľ cesty z diaľky)
      if (d < 1.2) stepTo(s, p.x, p.y, V.run, dt); // na blízko rovno na hráča (stojaci hráč nemá kam „dobehnúť“)
      else {
        const pi = inTerr(f, s, t.x, t.y) ? tileOf(t.x, t.y) : tileOf(p.x, p.y);
        if (!pathLeft(s) || now >= s.repath || s.goal !== pi) { setPath(s, pathTo(f, s, i => i === pi)); s.goal = pi; s.repath = now + T(400); }
        walkPath(s, V.run, dt);
      }
      break;
    }
  }
}

function pradlena(f, s, ps, sv, ctx, dt, T) {
  const now = ctx.tick, lamps = ps.filter(p => p.lp);
  switch (s.st) {
    case 'home': { // občas zájde k jednej zo svojich pavučín a počká na jej kmeni
      if (!s.until) s.until = now + T(between(ctx.rng, PR.idleMs));
      if (now < s.until) return;
      const own = ctx.webs.list.filter(wb => wb.o === s.o && spotOf(f, wb)), wb = own.length ? own[ctx.rng.int(own.length)] : null;
      s.until = 0;
      if (!wb) return;
      const t = new Set(webTiles(wb));
      s.web = wb.id; setPath(s, pathTo(f, s, i => t.has(i))); s.st = 'walk';
      return;
    }
    case 'walk': {
      if (!walkPath(s, PR.walk, dt)) return;
      const wb = ctx.webs.list.find(w => w.id === s.web), spot = wb && spotOf(f, wb);
      if (spot) { s.st = 'totree'; s.tr = spot; s.z = 0; } else goHome(f, s, now);
      return;
    }
    case 'totree': if (stepTo(s, s.tr.x, s.tr.y, PR.walk, dt)) startGuard(s, PR, now, ctx.rng, T); return;
    case 'guard': guard(f, s, PR, lamps, now, dt, T); return;
    case 'return': { const sp = s.fast ? PR.walk * 1.6 : PR.walk; if (walkPath(s, sp, dt) && stepTo(s, s.hx, s.hy, sp, dt)) { s.st = 'home'; s.fast = false; s.until = 0; } return; }
  }
  // naháňa toho, kto jej siahol na pavučinu – len po svojej čistine
  const p = ps.find(o => o.key === s.tgt);
  if (!p || !inTerr(f, s, p.x, p.y) || now < s.cool) { goHome(f, s, now); return; }
  const near = lamps.filter(l => dist(s, l) < SP.lamp);
  if (near.length) { const l = nearest(s, near); away(f, s, l.x, l.y, PR.push * near.length, dt); return; } // lampáše ju len pomaly odtláčajú
  const d = dist(s, p);
  if (d < 0.9) { if (sv) bite(f, s, p, sv, ctx, T); return; }
  const t = ahead(p, dt);
  if (d < 1.5) stepTo(s, p.x, p.y, PR.walk, dt);
  else {
    const pi = inTerr(f, s, t.x, t.y) ? tileOf(t.x, t.y) : tileOf(p.x, p.y);
    if (!pathLeft(s) || now >= s.repath || s.goal !== pi) { setPath(s, pathTo(f, s, i => i === pi)); s.goal = pi; s.repath = now + T(400); }
    walkPath(s, PR.walk, dt);
  }
}
// Zabalenie do pavučiny: pavúk vezme hodváb (P.take), hráča zabalí – hráč chvíľu stojí, potom sa pavučina zodiera
// (pokyn webbed: server ho pridá do prítomnosti, aby to videli aj ostatní) – a pavúk hneď uteká domov.
function wrap(f, s, p, sv, P, ctx, T) {
  const n = Math.min(P.take, sv.inv.silk || 0); // vezme, koľko má (removeItems pri nedostatku nevezme nič)
  const k = n > 0 && I.removeItems(I.playerC(sv), 'silk', n, ctx.tick) ? n : 0; // removeItems vráti várky, nie počet
  ctx.emit({ to: p.key, t: 'webbed', stuck: P.webStuckMs, ms: P.webMs, k: P.webSlow, sp: s.k });
  goHome(f, s, ctx.tick); s.fast = true; s.cool = ctx.tick + T(P.coolMs);
  return k;
}
// Pradlena: zabalí, vezme hodváb a odhodí hráča za okraj čistiny (hráč si polohu posúva sám – pokyn shove).
function bite(f, s, p, sv, ctx, T) {
  const start = tileOf(p.x, p.y), webs = new Set(ctx.webs.list.flatMap(webTiles));
  const { dist: dd } = bfs(LW, LH, [start], n => !!f.pass[n], 12);
  let out = -1;
  for (let i = 0; i < dd.length; i++) if (dd[i] > 0 && f.owner[i] !== s.o && !webs.has(i) && (out < 0 || dd[i] < dd[out])) out = i;
  if (out >= 0) ctx.emit({ to: p.key, t: 'shove', x: out % LW + 0.5, y: ((out / LW) | 0) + 0.5 });
  const k = wrap(f, s, p, sv, PR, ctx, T);
  ctx.emit(toast$(p.key, k ? `🕸️ Stará pradlena ťa zabalila do pavučiny, vzala ti ${k}× hodváb a odhodila ťa zo svojej čistiny! Bez lampáša a kamaráta sa k nej nepribližuj.` : '🕸️ Stará pradlena ťa zabalila do pavučiny a odhodila zo svojej čistiny!'));
}
// Kedy chce pavúk znova konať: hýbe sa (alebo naháňa, drží sa) → o STEP krokov; nečinný → svoj termín (najneskôr IDLE_MS).
// Hráča, ktorý sa k nečinnému pavúkovi priblíži (alebo pri ňom zdvihne lampáš), ohlási pohyb – posKeys / onPos ho zobudia.
const busy = s => s.moving || ['chase', 'alert', 'walk', 'return', 'totree'].includes(s.st);
function plan(s, now, T) {
  if (busy(s)) return now + T(STEP_MS);
  const due = [s.until, s.scared, s.cool].filter(t => t > now);
  return Math.min(now + T(IDLE_MS), ...due);
}

// ---------- Návrhy ----------
// Kľúče pavúka: vlastný výrez, pavučiny (čítanie), rozbor lesa cez lesSeed; uloženie obete, keď ju naháňa či sa jej drží.
function spiderKeys(d, w) {
  const s = w.sps && w.sps[d.id];
  if (w.les) forestOf(w);
  const writes = ['spider:' + d.id];
  if (s && s.tgt && s.st === 'chase' && w.saves && w.saves[s.tgt]) writes.push('save:' + s.tgt); // zabalí ho a vezme hodváb
  return { writes, reads: ['webs', 'daySeconds', 'lesSeed'] };
}
const PROPOSERS = {
  // Jeden krok pavúka v lese (d: { id }). Nikto v lese → domov a spí.
  spider: {
    keys: spiderKeys,
    run(s, d, ctx) {
      const sp = s['spider:' + d.id];
      if (!sp) return;
      const ps = (ctx.presence || []).filter(p => p.area === 'les');
      const wasBusy = busy(sp);
      sp.moving = false;
      const near = ps.some(p => Math.hypot(p.x - sp.x, p.y - sp.y) <= ACTIVE_R || Math.hypot(p.x - sp.hx, p.y - sp.hy) <= ACTIVE_R);
      if (!ps.length || (!near && sp.st !== 'chase')) { // nikto nablízku – domov a spí
        Object.assign(sp, { x: sp.hx, y: sp.hy, st: 'home', tgt: null, path: null, pi: 0, fast: false, until: 0, z: 0, tr: null, web: null, next: null });
        return;
      }
      const f = forestBy(s.lesSeed), ds = s.daySeconds, T = ms => ticksOf(ms, ds);
      const dt = (wasBusy ? T(STEP_MS) : 1) * tickSec(ds); // hýbuci sa pavúk koná každých STEP_MS
      ctx.webs = s.webs;
      const sv = sp.tgt ? s['save:' + sp.tgt] : null;
      if (sp.k === 'v') vlciak(f, sp, ps, sv, ctx, dt, T); else pradlena(f, sp, ps, sv, ctx, dt, T);
      sp.x = r3(sp.x); sp.y = r3(sp.y); sp.a = r3(sp.a); sp.z = r3(sp.z || 0);
      sp.next = plan(sp, ctx.tick, T);
    }
  },
  // Krížiak na ceste do kúta (d: { area }): beží trhane, pri hráčovi (alebo lampáši) ujde – radšej na strom; nikto sa nepozerá → utká.
  kriziak: {
    keys: d => ({ writes: ['kz:' + d.area, 'corners'], reads: ['daySeconds'] }),
    run(s, d, ctx) {
      const z = s['kz:' + d.area];
      if (!z) return;
      const now = ctx.tick, T = ms => ticksOf(ms, s.daySeconds), dt = T(KZ_STEP_MS) * tickSec(s.daySeconds);
      const ps = (ctx.presence || []).filter(p => p.area === d.area);
      if (!ps.length) { addCorner(s.corners, d.area, z.spot); s['kz:' + d.area] = null; return; } // nikto sa nepozerá – rovno dobehne
      z.moving = false;
      z.next = now + T(KZ_STEP_MS);
      const scare = ps.find(p => dist(z, p) < KZ.near || (p.lp && dist(z, p) < SP.lamp));
      if (scare && z.st !== 'flee' && z.st !== 'climb') {
        z.st = 'flee'; z.until = now + T(700);
        const a = Math.atan2(z.y - scare.y, z.x - scare.x); z.fx = Math.cos(a); z.fy = Math.sin(a);
        z.tree = treeFor(z, scare);
      }
      if (z.st === 'flee' && z.tree) { if (stepTo(z, z.tree.x, z.tree.y, KZ.flee, dt)) { z.st = 'climb'; z.tr = z.tree; z.z = 0; } return; } // na najbližší strom
      if (z.st === 'climb') { z.z = (z.z || 0) + KZ.climb * dt; z.moving = true; z.up = true; if (z.z >= KZ.gone) s['kz:' + d.area] = null; return; }
      if (z.st === 'flee') {
        z.x += z.fx * KZ.flee * dt; z.y += z.fy * KZ.flee * dt; z.a = Math.atan2(z.fy, z.fx); z.moving = true;
        if (now >= z.until) s['kz:' + d.area] = null; // schoval sa – pavučinu tentoraz neutká
        return;
      }
      if (z.st === 'pause') { if (now >= z.until) { z.st = 'go'; z.left = 1.5 + ctx.rng.rand() * 1.5; } else z.next = z.until; return; }
      if (!z.path.length) { addCorner(s.corners, d.area, z.spot); s['kz:' + d.area] = null; return; }
      const i = z.path[0], before = { x: z.x, y: z.y };
      if (stepTo(z, i % z.w + 0.5, ((i / z.w) | 0) + 0.5, KZ.run, dt)) z.path.shift();
      z.left -= dist(z, before);
      if (z.left <= 0) { z.st = 'pause'; z.until = now + T(400 + ctx.rng.rand() * 600); }
    }
  },
  // Opätovné tkanie (d: { o }): všetky termíny z webs.pend[o], ktoré už nastali (ďalší naplánuje engine podľa pend)
  weave: {
    keys: (d, w) => { if (w.les) forestOf(w); return { writes: ['webs'], reads: ['lesSeed'] }; },
    run(s, d, ctx) {
      const f = forestBy(s.lesSeed), webs = s.webs, pend = webs.pend[d.o] || [];
      const due = pend.filter(t => t <= ctx.tick).length;
      webs.pend[d.o] = pend.filter(t => t > ctx.tick);
      if (!webs.pend[d.o].length) delete webs.pend[d.o];
      for (let k = 0; k < due; k++) if (webs.list.filter(wb => wb.o === d.o).length < target(f, d.o, ctx.tick)) weave(webs, f, d.o, ctx);
    }
  },
  // Ráno: počet pavučín podľa obdobia
  webDawn: {
    keys: (d, w) => { if (w.les) forestOf(w); return { writes: ['webs'], reads: ['lesSeed'] }; },
    run(s, d, ctx) { balance(s.webs, forestBy(s.lesSeed), ctx); }
  },
  // Krížiak sa vydá do voľného kúta (udalosť kriziakTrip v náhodnom čase, v priemere KZ.perDay-krát za deň, v jeseni
  // dvakrát častejšie – pozri PERIODIC). Keď je na ploche hráč, uvidí ho bežať; inak sa pavučina rovno objaví.
  kriziakTrip: {
    keys: () => ({ writes: ['corners', ...D.CORNER_AREAS.map(a => 'kz:' + a)], reads: D.CORNER_AREAS.map(a => 'tile:' + a + ':*') }),
    run(s, d, ctx) {
      for (const area of D.CORNER_AREAS) {
        const list = s.corners[area] || (s.corners[area] = []);
        if (list.length >= KZ.max || s['kz:' + area]) continue;
        const tiles = s['tile:' + area + ':*'], busy = new Set(list.map(tileOfKey));
        const free = spotsOf(tiles, area).filter(p => !list.includes(p.k) && !busy.has(p.i));
        if (!free.length) continue;
        const spot = free[ctx.rng.int(free.length)];
        const z = (ctx.presence || []).some(p => p.area === area) ? startKriziak(tiles, area, spot, ctx) : null;
        if (z) { s['kz:' + area] = z; ctx.cancel('kz:' + area); } else addCorner(s.corners, area, spot.k);
      }
    }
  },
  // --- akcie hráča ---
  // Ťahanie hodvábu (d: { key, id }): hráč ťahá WEB.pullMs, potom udalosť pullDone; prítomnosť (pl.pull) nastaví server podľa pokynu
  pullStart: {
    keys: () => ({ reads: ['webs', 'daySeconds'] }),
    run(s, d, ctx) {
      const me = ctx.actor || ctx.reject(null);
      if (me.lp) return ctx.reject('S lampášom v ruke hodváb neutrhneš. Vyber si v lište niečo iné alebo prázdnu ruku. 🏮');
      if (me.pull) return ctx.reject('Ešte ťaháš… 🕸️');
      if (!s.webs.list.some(wb => wb.id === d.id)) return ctx.reject(null);
      ctx.emit({ to: d.key, t: 'pullStart', id: d.id, n: ctx.id });
      ctx.scheduleUnique('pull:' + d.key, ctx.tick + ticksOf(WEB.pullMs, s.daySeconds), 'pullDone', { key: d.key, id: d.id, n: ctx.id });
    }
  },
  // Hráč prestal ťahať (zdvihol lampáš)
  pullStop: { keys: () => ({}), run(s, d, ctx) { ctx.cancel('pull:' + d.key); } },
  // Koniec ťahania (d: { key, id, n }): +1 hodváb; majiteľ si to všimne s rastúcou šancou, posledné potiahnutie pavučinu roztrhne.
  pullDone: {
    keys(d, w) {
      if (w.les) forestOf(w);
      const wb = w.webs && w.webs.list.find(x => x.id === d.id);
      return { writes: ['webs', 'save:' + d.key, ...(wb && w.sps && w.sps['s' + wb.o] ? ['spider:s' + wb.o] : [])], reads: ['lesSeed'] };
    },
    run(s, d, ctx) {
      const p = (ctx.presence || []).find(x => x.key === d.key);
      if (!p || !p.pull || p.pull.n !== d.n) return; // medzitým prestal ťahať
      ctx.emit({ to: d.key, t: 'pullDone' }); // server: prítomnosť prestane ťahať
      const webs = s.webs, wb = webs.list.find(x => x.id === d.id), sv = s['save:' + d.key];
      if (!wb) return ctx.emit(toast$(d.key, 'Pavučina je preč – niekto ju roztrhol. 🕸️'));
      if (!sv) return;
      const f = forestBy(s.lesSeed), k = WEB.silk - wb.silk; // koľké potiahnutie (0 = prvé)
      wb.silk--;
      I.addItems(I.playerC(sv), 'silk', 1, ctx.tick);
      const torn = wb.silk <= 0;
      if (torn) tear(webs, wb, ctx);
      const noticed = ctx.rng.rand() < WEB.notice[Math.min(k, WEB.notice.length - 1)];
      const who = nameOf(f, wb.o), sp = s['spider:s' + wb.o];
      if (noticed && sp && alert(f, sp, wb, d.key, ctx.tick)) ctx.cancel('spider:s' + wb.o);
      ctx.emit(toast$(d.key, torn
        ? `+1 🕸️ Pavúčí hodváb. Pavučina sa roztrhla${noticed ? ` – ${who} to zacítil(a)! Uteč! 🕷️` : '.'}`
        : `+1 🕸️ Pavúčí hodváb (v pavučine ešte ${wb.silk}).${noticed ? ` Pavučina sa zachvela – ${who.toLowerCase()} to zacítil(a)! 🕷️` : ''}`));
    }
  },
  // Odstránenie kútovej pavučiny (d: { key, area, i }) – nič z nej nie je
  clearWeb: {
    keys: () => ({ writes: ['corners'] }),
    run(s, d, ctx) {
      const list = s.corners[d.area] || [], k = list.find(c => tileOfKey(c) === d.i);
      if (!k) return ctx.reject(null);
      s.corners[d.area] = list.filter(c => c !== k);
      const { w } = D.areaSize(d.area);
      ctx.emit({ to: E.area(d.area), t: 'fx', k: 'cobweb', x: d.i % w + 0.5, y: Math.floor(d.i / w) + 0.5 });
      ctx.emit(toast$(d.key, '🕸️ Odstránil(a) si pavučinu z kúta. Krížiak si nájde iný kút…'));
    }
  }
};

// Periodické udalosti: každý pavúk a krížiak podľa svojho stavu (next), ranné pavučiny, hodinové kúty
const far = from => from + 7 * TPD; // spiaci pavúk: zobudí ho príchod hráča (kontrola raz za týždeň len pre istotu)
// čas ďalšej výpravy krížiaka: v priemere TPD / perDay (v jeseni polovica), rovnomerne 0,5–1,5× priemeru
const tripAt = (from, rng) => { const mean = TPD / KZ.perDay / (season(from) === 2 ? 2 : 1); return from + Math.round(mean * (0.5 + rng.rand())); };
const PERIODIC = [
  ...IDS.map(id => ({ key: 'spider:' + id, type: 'spider', data: { id }, next: (from, rng, w) => { const s = w && w.sps && w.sps[id]; return s && s.next != null ? Math.max(from, s.next) : far(from); } })),
  ...D.CORNER_AREAS.map(area => ({ key: 'kz:' + area, type: 'kriziak', data: { area }, next: (from, rng, w) => { const z = w && w.kz && w.kz[area]; return z && z.next != null ? Math.max(from, z.next) : far(from); } })),
  ...IDS.map((id, o) => ({ key: 'weave:' + o, type: 'weave', data: { o }, next: (from, rng, w) => { const p = w && w.webs && w.webs.pend && w.webs.pend[o]; return p && p.length ? Math.max(from, Math.min(...p)) : far(from); } })),
  { key: 'webDawn', type: 'webDawn', next: E.daily(D.DAWN_TICK) },
  { key: 'kriziakTrip', type: 'kriziakTrip', next: tripAt }
];

// ---------- Prepojenie s pohybom a pripojením (actions.js) ----------
// Úsek pohybu (x0, y0) → (x1, y1) v lese: pavučiny, cez ktoré prešiel. Bežný pohyb za rámec je pod pol políčka;
// dlhší skok (oprava polohy, presun) sa nepočíta ako beh cez les – rozhoduje len cieľové políčko.
const SWEEP_MAX = 1.5;
function crossed(webs, x0, y0, x1, y1) {
  if (!(Math.hypot(x1 - x0, y1 - y0) <= SWEEP_MAX)) { x0 = x1; y0 = y1; }
  const out = new Map(), n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.2));
  for (let k = 0; k <= n; k++) {
    const x = x0 + (x1 - x0) * k / n, y = y0 + (y1 - y0) * k / n, wb = webAt(webs, tileOf(x, y));
    if (wb && !out.has(wb.id)) out.set(wb.id, wb);
  }
  return [...out.values()];
}
// Prechod cez pavučinu: rovina pavučiny je stred jej radu políčok (ax 0: y = wb.y + 0,5, hráč ide naprieč po y; ax 1 po x).
// d = vzdialenosť od roviny (znamienko podľa strany), u = poloha pozdĺž pavučiny (v rozpätí lo … hi?)
function across(wb, x, y) {
  return wb.ax ? { d: x - (wb.x + 0.5), u: y, lo: wb.y, hi: wb.y + wb.n } : { d: y - (wb.y + 0.5), u: x, lo: wb.x, hi: wb.x + wb.n };
}
// Pavučiny, do ktorých hráč key vošiel alebo v nich je (wb.in[key] = strana, z ktorej prišiel: ±1)
function pushing(webs, key, x0, y0, x1, y1) {
  const out = new Map();
  for (const wb of crossed(webs, x0, y0, x1, y1)) out.set(wb.id, wb);
  for (const wb of (webs && webs.list) || []) if (wb.in && wb.in[key] != null) out.set(wb.id, wb);
  return [...out.values()];
}
const wakeKeys = w => (w.sps ? ['spider:*'] : []);
// Kľúče navyše pre pohyb (d: { key, x, y }): vbehnutie do pavučiny (pavučiny a ich majitelia) alebo príchod do lesa (budí pavúky)
function posKeys(d, w) {
  const sv = w.saves && w.saves[d.key];
  if (!sv || !Number.isFinite(+d.x) || !Number.isFinite(+d.y)) return {};
  const area = D.AREAS.includes(sv.area) ? sv.area : 'garden', p = clampPos(area, +d.x, +d.y);
  if (area !== 'les') {
    const g = D.gateAt(area, Math.floor(p.x), Math.floor(p.y));
    return g && g.to === 'les' ? { writes: wakeKeys(w) } : {};
  }
  const writes = new Set(nearIdle(w, p).map(id => 'spider:' + id));
  if (!w.webs || !Number.isFinite(sv.x) || !Number.isFinite(sv.y)) return { writes: [...writes] };
  // pavučina, v ktorej hráč je alebo do ktorej vchádza: zápis do pavučín (+ majiteľ, keby sa roztrhla)
  const hit = pushing(w.webs, d.key, sv.x, sv.y, p.x, p.y);
  if (!hit.length) return { writes: [...writes] };
  if (w.les) forestOf(w);
  for (const wb of hit) if (w.sps && w.sps['s' + wb.o]) writes.add('spider:s' + wb.o);
  return { writes: ['webs', ...writes], reads: ['lesSeed'] };
}
// Pavúky, ktoré pohyb hráča do bodu p zobudí v ďalšom kroku: nečinné do WAKE_R (všimnú si ho, zľaknú sa lampáša)
// a spiace, ktorých nora je do ACTIVE_R (les okolo hráča ožije)
function nearIdle(w, p) {
  const out = [];
  for (const id in w.sps || {}) {
    const s = w.sps[id];
    if (!s) continue;
    if (s.next == null ? Math.hypot(s.hx - p.x, s.hy - p.y) <= ACTIVE_R : s.next > w.tick + 1 && !busy(s) && Math.hypot(s.x - p.x, s.y - p.y) <= WAKE_R) out.push(id);
  }
  return out;
}
// Po pohybe (from = poloha pred pohybom, pos = po ňom): ťahajúci, ktorý sa pohol, prestane ťahať; vbehnutie do pavučiny;
// príchod do lesa zobudí pavúky.
function onPos(s, d, ctx, from, pos) {
  const me = ctx.actor;
  if (me && me.pull && Math.hypot(pos.x - me.pull.px, pos.y - me.pull.py) > PULL_MOVE) {
    ctx.cancel('pull:' + d.key);
    ctx.emit({ to: d.key, t: 'pullDone' });
    ctx.emit(toast$(d.key, 'Prestal(a) si ťahať hodváb.'));
  }
  if (from.area === 'les' && pos.area === 'les' && s.webs) {
    // Hráč sa do pavučiny zaborí (klient ho v nej spomalí na WEB.drag a pavučina sa za ním naťahuje); roztrhne sa, až keď
    // je políčko (WEB.through) za ňou – hodváb z nej nedostane a majiteľ vie, kde je. Kto cúvne späť, pavučina sa pustí celá.
    for (const wb of pushing(s.webs, d.key, from.x, from.y, pos.x, pos.y)) {
      const a = across(wb, pos.x, pos.y), b = across(wb, from.x, from.y);
      if (!wb.in || wb.in[d.key] == null) { // vošiel
        wb.in = Object.assign({}, wb.in, { [d.key]: (b.d || a.d) < 0 ? -1 : 1 });
        ctx.emit(toast$(d.key, '🕸️ Zaboril(a) si sa do pavučiny… lepí sa a naťahuje.'));
        continue;
      }
      const side = wb.in[d.key], past = -side * a.d; // ako ďaleko je za rovinou (na druhej strane)
      const away = a.u < a.lo - 0.4 || a.u > a.hi + 0.4 || Math.abs(a.d) > WEB.through + 1.5; // vyšiel bokom, skok, starý záznam
      if (past >= WEB.through && !away) {
        const f = forestBy(s.lesSeed);
        tear(s.webs, wb, ctx);
        const sp = s['spider:s' + wb.o];
        if (sp && alert(f, sp, wb, d.key, ctx.tick)) ctx.cancel('spider:s' + wb.o);
        ctx.emit({ to: E.area('les'), t: 'fx', k: 'cobweb', x: pos.x, y: pos.y });
        ctx.emit(toast$(d.key, `🕸️ Prerazil(a) si pavučinu – roztrhla sa a ${nameOf(f, wb.o).toLowerCase()} vie, kde si! 🕷️`));
      } else if (side * a.d >= WEB.through || away) { // cúvol späť alebo vyšiel bokom
        const rest = Object.assign({}, wb.in); delete rest[d.key];
        wb.in = Object.keys(rest).length ? rest : undefined;
      }
    }
  }
  if (pos.area === 'les' && from.area !== 'les') wake(s, ctx);
  for (const k in s) { // nečinné pavúky pri hráčovi (posKeys) – rozhliadnu sa v ďalšom kroku
    if (!k.startsWith('spider:') || k === 'spider:*') continue;
    const sp = s[k];
    if (sp && (sp.next == null || (sp.next > ctx.tick + 1 && !busy(sp)))) { sp.next = ctx.tick + 1; ctx.cancel(k); }
  }
}
// Hráč prišiel do lesa (prechodom alebo pripojením): spiace pavúky sa zobudia
function wake(s, ctx) {
  const all = s['spider:*'];
  if (!all) return;
  for (const id in all) if (all[id] && all[id].next == null) { all[id].next = ctx.tick + 1; ctx.cancel('spider:' + id); }
}
const joinKeys = (d, w) => (w.saves && w.saves[d.key] && w.saves[d.key].area === 'les' ? { writes: wakeKeys(w) } : {});
function onJoin(s, d, ctx, area) { if (area === 'les') wake(s, ctx); }

// Klik na políčko (Actions.resolveAct): pavučina v lese → ťahať hodváb; kútová pavučina → odstrániť. null = nie je tu pavučina.
function resolveAct(world, me, area, i) {
  if (area === 'les') {
    const wb = webAt(world.webs, i);
    if (!wb) return null;
    if (me.lp) return { toast: 'S lampášom v ruke hodváb neutrhneš. Vyber si v lište niečo iné alebo prázdnu ruku. 🏮' };
    return { type: 'pullStart', data: { key: me.key, id: wb.id } };
  }
  if (D.CORNER_AREAS.includes(area) && world.corners && (world.corners[area] || []).some(k => tileOfKey(k) === i)) return { type: 'clearWeb', data: { key: me.key, area, i } };
  return null;
}

// ---------- Správy pre klientov (server nad živým svetom, mimo enginu) ----------
function websView(world) {
  const f = forestOf(world);
  return { t: 'webs', webs: ((world.webs && world.webs.list) || []).map(wb => Object.assign({ id: wb.id, x: wb.x, y: wb.y, ax: wb.ax, n: wb.n, silk: wb.silk }, wb.in ? { in: wb.in } : {})), homes: f.homes.map(h => ({ k: h.k, x: h.x, y: h.y })) };
}
function cornerView(world, area) { return { t: 'corner', area, list: cornerList(world, area).map(s => ({ x: s.x, y: s.y, dx: s.dx, dy: s.dy, ex: s.ex, ey: s.ey, f: s.faces })) }; }
function areaViews(world, area) {
  if (area === 'les') return [websView(world)];
  if (D.CORNER_AREAS.includes(area)) return [cornerView(world, area)];
  return [];
}
// Pavúky a krížiak na ploche (vysielanie polôh): na kmeni aj výška z, strana kmeňa n a či lezie hore u
function entities(world, area) {
  const out = [], r = v => +(+v).toFixed(2);
  const tree = (o, s) => { if (s.tr && s.st !== 'totree' && s.st !== 'flee') Object.assign(o, { z: r(s.z || 0), n: [r(s.tr.nx), r(s.tr.ny)], u: s.moving && s.up ? 1 : 0 }); return o; };
  if (area === 'les' && world.sps) for (const s of Object.values(world.sps)) out.push(tree({ id: s.id, k: s.k, x: r(s.x), y: r(s.y), a: r(s.a), m: s.moving ? 1 : 0, h: s.st === 'home' ? 1 : 0 }, s));
  const z = world.kz && world.kz[area];
  if (z) out.push(tree({ id: z.id, k: 'k', x: r(z.x), y: r(z.y), a: r(z.a), m: z.moving ? 1 : 0 }, z));
  return out;
}

// ---------- Načítanie a uloženie ----------
// Pri načítaní: pavučiny a kúty z uloženia (neplatné sa zahodia), pavúky doma a spia, krížiaky nikde, ťahanie z minulého
// behu zmizne. Prvé tkanie nového sveta (a jeden kút na plochu) cez živý kontext – ako založenie trhu (E.liveCtx).
function load(world, ctx) {
  const f = forestOf(world);
  const fresh = !(world.webs && Array.isArray(world.webs.list));
  const w = fresh ? { list: [], nid: 0, pend: {} } : world.webs;
  for (const wb of w.list) if (wb) delete wb.in; // kto bol v pavučine, už tam po načítaní nie je
  w.list = w.list.filter(wb => wb && f.cands[wb.o] && f.cands[wb.o].some(c => c.x === wb.x && c.y === wb.y && c.ax === wb.ax && c.n === wb.n) && wb.silk >= 1);
  w.nid = Math.max(w.nid | 0, ...w.list.map(wb => wb.id));
  w.pend = isObj(w.pend) ? w.pend : {};
  world.webs = w;
  const freshCorners = !isObj(world.corners);
  world.corners = freshCorners ? {} : world.corners;
  for (const area of D.CORNER_AREAS) {
    world.corners[area] = Array.isArray(world.corners[area]) ? world.corners[area].map(String) : [];
    pruneCorners(world.corners, areaTiles(world, area), area);
  }
  world.sps = {};
  f.homes.forEach((h, o) => { world.sps['s' + o] = homeState(h, o); });
  world.kz = {};
  for (const area of D.CORNER_AREAS) world.kz[area] = null;
  world.events = world.events.filter(e => e.type !== 'pullDone');
  if (fresh) balance(w, f, ctx);
  if (freshCorners) for (const area of D.CORNER_AREAS) {
    const all = spotsOf(areaTiles(world, area), area);
    if (all.length) addCorner(world.corners, area, all[ctx.rng.int(all.length)].k);
  }
}
// do uloženia len pavučiny a kúty (pavúky a krížiaky sú po načítaní vždy doma)
const save = world => ({ webs: world.webs, corners: world.corners });

module.exports = {
  PROPOSERS, PERIODIC, IDS, STEP_MS, slice, posKeys, onPos, joinKeys, onJoin, resolveAct,
  analyze, cornerSpots, forestOf, webTiles, webAt, across, trunkSpot, spotsOf, cornerList, pruneCorners, alert, crossed, tickSec, ticksOf,
  websView, cornerView, areaViews, entities, load, save
};
