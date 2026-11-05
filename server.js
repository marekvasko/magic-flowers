// Čarovná záhrada – herný server (HTTP + WebSocket)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const D = require('./shared/data.js');
const E = require('./engine.js');
const Econ = require('./economy.js');
const I = require('./items.js');
const Scav = require('./scavenge.js');
const Ice = require('./ice.js');
const Areas = require('./areas.js');
const P = require('./presence.js');
const Debug = require('./debug.js');

const PORT = +process.env.PORT || 3000;
// Dĺžka herného dňa je napevno D.BASE_DAY_SECONDS (20 min); DAY_SECONDS v prostredí slúži len na testovanie.
const DAY_SECONDS = +process.env.DAY_SECONDS || D.BASE_DAY_SECONDS;
const MAX_PLAYERS = 4;
const START = Econ.startCapital(process.env); // mince a reputácia nového hráča (v testovacích prostrediach viac)
const RECONNECT_GRACE_MS = 10000; // návrat do 10 s je rýchle znovupripojenie – bez hlásení o odchode a príchode
const HEARTBEAT_MS = 30000; // ping klientom; kto neodpovie do ďalšieho kola, toho odpojíme
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SHARED_DIR = path.join(__dirname, 'shared');

// ---------- Statické súbory ----------
const zlib = require('zlib');
const THREE_DIR = path.join(__dirname, 'node_modules', 'three', 'build');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json'
};
const gzCache = new Map(); // súbor → { mtime, gz } – Three.js má ~2 MB, gzip ho zmenší asi na štvrtinu
const server = http.createServer((req, res) => {
  if (debugHandle(req, res)) return; // /debug a /api/debug/* (len na čítanie)
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  // hra je len v 3D na '/'; staré odkazy na /3d presmerujeme (aj s ?room=…)
  if (url === '/3d' || url === '/3d/') { const q = (req.url || '').indexOf('?'); res.writeHead(301, { Location: '/' + (q >= 0 ? req.url.slice(q) : '') }); return res.end(); }
  if (url === '/') url = '/index.html';
  let base = PUBLIC_DIR, rel = url.slice(1);
  if (url.startsWith('/shared/')) { base = SHARED_DIR; rel = url.slice(8); }
  else if (url.startsWith('/vendor/three/')) { base = THREE_DIR; rel = url.slice(14); }
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': base === THREE_DIR ? 'public, max-age=86400' : 'no-cache' };
    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /text|json|svg/.test(type);
    fs.readFile(file, (err2, buf) => {
      if (err2) { res.writeHead(500); return res.end(); }
      if (!gzip) { res.writeHead(200, headers); return res.end(buf); }
      let c = gzCache.get(file);
      if (!c || c.mtime !== st.mtimeMs) { c = { mtime: st.mtimeMs, gz: zlib.gzipSync(buf) }; gzCache.set(file, c); }
      res.writeHead(200, Object.assign(headers, { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }));
      res.end(c.gz);
    });
  });
});

// ---------- Svety (miestnosti) ----------
// Čas je diskrétny: svet má celé počítadlo `tick` (D.TICKS_PER_DAY krokov na deň), deň a minúta sa z neho
// len odvodzujú. Všetko, čo sa má stať v budúcnosti, je udalosť v plánovači (room.events) a ukladá sa so svetom.
const SAVE_VERSION = 5; // 3: hory, ľad a ľadovňa; 4: Les na pomedzí; 5: kľúče udalostí (unikátne a periodické)
const TPD = D.TICKS_PER_DAY, MPT = D.MIN_PER_TICK;
const DEFAULT_MODE = process.env.DEFAULT_MODE === 'paused' ? 'paused' : 'running';
const MAX_CATCHUP_DAYS = +process.env.MAX_CATCHUP_DAYS || 30; // koľko herných dní najviac dobehneme po výpadku servera
const rooms = new Map();

function roomFile(id) { return path.join(DATA_DIR, 'room-' + id + '.json'); }

function newWorldState() {
  return {
    v: SAVE_VERSION, tick: D.DAWN_TICK + 6, wall: Date.now(), mode: DEFAULT_MODE, daySeconds: DAY_SECONDS,
    rng: crypto.randomBytes(4).readUInt32LE(0), seq: 0, events: [],
    weather: 'sun', saves: {}, storage: {}, market: null, contracts: null, fairyNight: -1, eternal: false, scav: {},
    icehouse: { built: false, ice: 0 }, hory: null, pomedzieSeed: Areas.newSeed()
  };
}

// Prevod uloženia zo starších formátov, po krokoch podľa verzie.
function migrate(saved) {
  const out = Object.assign(newWorldState(), saved);
  const from = saved.v || 1;
  if (from === SAVE_VERSION) return out;
  if (from < 2) { // spojitý čas day/min → diskrétne kroky
    const day = saved.day || 1, min = saved.min || 390;
    out.tick = (day - 1) * TPD + Math.min(TPD - 1, Math.round(min / MPT));
    out.mode = 'paused'; // staré svety sa správali ako pozastavené – zachováme to, prepnúť sa dá v menu
    out.wall = Date.now();
    for (const sv of Object.values(out.saves || {})) if (sv.vily) sv.vily = Math.max(0, Math.round((sv.vily - 1440) / MPT));
    delete out.day; delete out.min;
  }
  if (from < 3) { // hory a ľadovňa: nová plocha s plným ľadovcom, ľadovňa ešte nepostavená
    out.icehouse = { built: false, ice: 0 }; out.hory = null;
  }
  if (from < 4) { // Les na pomedzí: nová plocha, rozloženie zo semienka sveta (záhrada ani polohy hráčov sa nemenia)
    out.pomedzieSeed = Areas.newSeed();
  }
  if (from < 5) { // udalosti dostanú kľúče – reconcile potom nič nezdvojí a nič nestratí
    for (const e of out.events || []) {
      const d = e.data || {};
      if (['dawn', 'hourly', 'delivery', 'npc_jano', 'npc_fero', 'npc_zuzka'].includes(e.type)) { e.key = e.type; e.periodic = true; }
      else if (['festAnnounce', 'festStart', 'festEnd'].includes(e.type)) { e.key = e.type + ':' + d.id; e.periodic = true; e.data = { id: d.id }; }
      else if (e.type === 'cDue' || e.type === 'cExpire') e.key = e.type + ':' + d.id;
      else if (e.type === 'vilyEnd' || e.type === 'scavDone') e.key = e.type + ':' + d.key;
    }
  }
  out.v = SAVE_VERSION; out.migratedFrom = saved.migratedFrom || from;
  return out;
}

function getRoom(id) {
  if (rooms.has(id)) return rooms.get(id);
  const base = D.buildMap();
  let st = newWorldState();
  try { st = migrate(JSON.parse(fs.readFileSync(roomFile(id), 'utf8'))); } catch (e) { /* nový svet */ }
  const savedTiles = st.tiles;
  const room = Object.assign(st, { id, players: new Map(), dirty: true });
  // Základ mapy berieme z aktuálneho generátora, z uloženia len pôdu a rastliny.
  room.tiles = base.map((g, i) => {
    const sv = savedTiles && savedTiles.length === base.length && savedTiles[i];
    const t = { g, s: (sv && sv.s) || null };
    if (g === 'water' && sv && sv.cut) t.cut = 1; // otvor v zamrznutom jazierku
    return t;
  });
  room.hory = Ice.loadHory(st.hory);
  if (!Number.isInteger(room.pomedzieSeed)) room.pomedzieSeed = Areas.newSeed();
  room.pomedzie = Areas.loadPomedzie(room.pomedzieSeed);
  Ice.applyIcehouse(room);
  Object.defineProperty(room, 'day', { get() { return D.dayOfTick(this.tick); } });
  Object.defineProperty(room, 'min', { get() { return D.minOfTick(this.tick); } });
  room.daySeconds = DAY_SECONDS;
  room.storage = room.storage || {};
  I.syncAll(I.storageC(room), room.tick);
  for (const sv of Object.values(room.saves)) if (sv.inv) I.syncAll(I.playerC(sv), room.tick);
  Econ.initEconomy(room);
  E.reconcile(room, SIM); // doplní chýbajúce periodické udalosti, zahodí udalosti obsahu, ktorý už v hre nie je
  if (room.mode === 'running') {
    // Svet beží aj bez hráčov – dobehneme čas, kým bol server vypnutý (najviac MAX_CATCHUP_DAYS dní).
    const cap = MAX_CATCHUP_DAYS * TPD * E.tickMs(room);
    room.wall = Math.max(room.wall, Date.now() - cap);
    const n = E.advance(room, Date.now(), SIM);
    if (n) console.log(`[${id}] dobehnutých ${n} krokov (${(n / TPD).toFixed(1)} dňa)`);
  } else room.wall = Date.now();
  rooms.set(id, room);
  return room;
}

function serialize(room) {
  return JSON.stringify({
    v: SAVE_VERSION, tick: room.tick, wall: room.wall, mode: room.mode, daySeconds: room.daySeconds,
    rng: room.rng, seq: room.seq, events: room.events,
    weather: room.weather, saves: room.saves, storage: room.storage, storageFb: room.storageFb, market: room.market, contracts: room.contracts,
    fairyNight: room.fairyNight, eternal: room.eternal, migratedFrom: room.migratedFrom, scav: room.scav, scavSalt: room.scavSalt, icehouse: room.icehouse, pomedzieSeed: room.pomedzieSeed,
    tiles: room.tiles.map(t => t.cut ? { s: t.s, cut: 1 } : { s: t.s }), hory: Ice.saveHory(room)
  });
}
// Ladiaca stránka /debug: svety len číta (z pamäte alebo zo súboru), nič nenačíta ani neuloží
const debugHandle = Debug.create({ dataDir: DATA_DIR, debugDir: path.join(__dirname, 'debug'), rooms, serialize, migrate, sim: () => SIM });
let saveSeq = 0;
// Atómový zápis: najprv dočasný súbor, potom premenovanie – pri páde nezostane rozbitý JSON.
function saveRoom(room, sync) {
  if (!room.dirty && !sync) return;
  room.dirty = false;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = roomFile(room.id), tmp = `${file}.${process.pid}.${++saveSeq}.tmp`, data = serialize(room);
  if (sync) { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); return; }
  fs.writeFile(tmp, data, err => { if (err) return console.error('save', err); fs.rename(tmp, file, () => {}); });
}

function season(room) { return D.seasonOf(room.day); }
function hour(room) { return room.min / 60; }

// Nový hráč začína chudobne: pár semienok sezónneho kvetu, malá krhla a povolenie na pár políčok.
function newSave(room) {
  const se = season(room);
  const sp = Econ.PLANTABLE.filter(k => !D.SPECIES[k].strict && D.SPECIES[k].seasons.includes(se))
    .sort((a, b) => D.SPECIES[a].seed - D.SPECIES[b].seed)[0];
  return {
    coins: START.coins, water: 5, inv: { hoe: 1, can: 1, ['seed_' + sp]: 4 },
    recipes: [], seen: [sp], vily: 0, look: null, talked: false, rep: START.rep, up: { can: 0, plots: 0, composter: 0 }
  };
}
// Hráči zo starších verzií hry: nezoberieme im to, čo mali (krhla na 20 a neobmedzené pole).
function migrateSave(sv, room) {
  if (!sv.up) sv.up = { can: 2, plots: 2, composter: 0 };
  if (sv.rep == null) sv.rep = 0;
  sv.water = Math.min(sv.water || 0, Econ.canCap(sv));
  I.syncAll(I.playerC(sv), room.tick); // kvety bez várok dostanú vek 0 (čerstvo odrezané)
}

// ---------- Komunikácia ----------
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { const s = JSON.stringify(msg); for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s); }
function toast(pl, text, kind) { send(pl.ws, { t: 'toast', text, kind: kind || 'info' }); }
function toastAll(room, text, kind) { broadcast(room, { t: 'toast', text, kind: kind || 'info' }); }
// Hráči sú vždy na jednej ploche (záhrada / hory / Les na pomedzí) – políčka a efekty dostanú len tí, ktorí sú na nej.
function broadcastArea(room, area, msg) { const s = JSON.stringify(msg); for (const p of room.players.values()) if (p.area === area && p.ws.readyState === 1) p.ws.send(s); }
function fx(room, k, x, y, extra, area) { broadcastArea(room, area || 'garden', Object.assign({ t: 'fx', k, x, y }, extra || {})); }
// Políčka záhrady posielame cez Scav.tileView – druh divej rastliny ostane skrytý, kým nevyklíči (hory rastliny nemajú).
function tileView(area, t) { return area === 'garden' ? Scav.tileView(t) : t; }
function tilesView(room, area) { area = area || 'garden'; return Areas.areaTiles(room, area).map(t => tileView(area, t)); }
function tilesMsg(room, area) { area = area || 'garden'; broadcastArea(room, area, { t: 'tiles', tiles: tilesView(room, area) }); }
function tileMsg(room, i, area) { area = area || 'garden'; room.dirty = true; broadcastArea(room, area, { t: 'tile', i, v: tileView(area, Areas.areaTiles(room, area)[i]) }); }
function plotsUsed(room, key) { let n = 0; for (const t of room.tiles) if (t.s && t.s.o === key) n++; return n; }
function sendMe(pl) {
  const sv = pl.save;
  send(pl.ws, {
    t: 'me', coins: sv.coins, water: sv.water, inv: sv.inv, recipes: sv.recipes, seen: sv.seen, vily: sv.vily > pl.room.tick,
    rep: sv.rep, up: sv.up, canCap: Econ.canCap(sv), plotLimit: Econ.plotLimit(sv), plotsUsed: plotsUsed(pl.room, pl.key), maxActive: Econ.maxActive(sv),
    fb: I.batchesView(I.playerC(sv), pl.room.tick), tick: pl.room.tick
  });
  pl.room.dirty = true;
}
function roomInfo(room) {
  return {
    t: 'room', eternal: room.eternal, mode: room.mode, daySeconds: room.daySeconds, storage: room.storage, storageFb: I.batchesView(I.storageC(room), room.tick),
    storageRate: I.storageRate(room), icehouse: room.icehouse, tick: room.tick, names: [...room.players.values()].map(p => p.name)
  };
}

// Všetky zmeny inventára idú cez items.js (kvety majú várky s vekom). take vráti odobraté várky alebo null.
function give(pl, id, n, batches) { I.addItems(I.playerC(pl.save), id, n, pl.room.tick, batches); }
function take(pl, id, n) { return I.removeItems(I.playerC(pl.save), id, n, pl.room.tick); }

// ---------- Rast ----------
function growPlant(room, i) {
  const t = room.tiles[i], s = t.s, p = s && s.p;
  if (!p || p.d) return;
  const sp = D.SPECIES[p.sp];
  const se = season(room);
  const x = i % D.W, y = Math.floor(i / D.W);
  const inSeason = sp.seasons.includes(se) || p.b || room.eternal;
  if (!inSeason) {
    // Mráz zničí všetko nezimné; inak má rastlina 2 dni milosti a kvitnúca vydrží.
    if (se === 3) { p.d = 1; p.why = 'mráz'; return; }
    p.oos = (p.oos || 0) + 1;
    if (p.prog < sp.days && p.oos > 2) { p.d = 1; p.why = 'nesprávne obdobie'; return; }
  }
  const watered = !!s.w || room.eternal;
  p.dry = watered ? 0 : (p.dry || 0) + 1;
  const tol = sp.water === 1 ? 2 : sp.water === 2 ? 1 : 0;
  const deathAt = sp.water === 1 ? 5 : sp.water === 2 ? 3 : 2;
  if (p.dry >= deathAt) { p.d = 1; p.why = 'sucho'; return; }
  if (p.prog >= sp.days) { // už kvitne – po čase odkvitne (trvalka zakvitne znova)
    if (p.bt == null) p.bt = room.tick;
    if (room.tick - p.bt >= sp.life * TPD) {
      if (sp.perennial) { p.prog = sp.days * 0.5; p.bt = null; }
      else { p.d = 1; p.why = 'odkvitla'; }
    }
    return;
  }
  let g = (watered || p.dry < tol) ? 1 : 0;
  let bad = g === 0;
  if (!inSeason) { g *= 0.5; bad = true; }
  const shade = D.isShade(room.tiles, x, y);
  const lightOk = sp.light === 'any' || (sp.light === 'shade') === shade;
  if (!lightOk) { g *= 0.5; bad = true; }
  const soilOk = !sp.soil || sp.soil === s.k || (sp.soil === 'sand' && s.k === 'rock') || (sp.soil === 'rich' && s.r);
  if (!soilOk) { g = sp.strict ? 0 : g * 0.5; bad = true; }
  if (s.r) g *= 1.5;
  p.prog = Math.min(sp.days, p.prog + g);
  if (p.prog >= sp.days) p.bt = room.tick;
  if (bad) p.q = Math.max(1, p.q - 1);
}

// Divá rastlina vyklíčila – hráč sa konečne dozvie, čo z nej bude
function revealWild(room, i) {
  const s = room.tiles[i].s, p = s && s.p;
  if (!p || !p.wild || p.d || !(p.prog > 0)) return;
  delete p.wild;
  const sv = s.o && room.saves[s.o];
  if (sv && sv.seen && !sv.seen.includes(p.sp)) sv.seen.push(p.sp);
  const pl = s.o && playerByKey(room, s.o);
  if (pl) toast(pl, `🌱 Z divého semienka vykukol klíčok: ${D.SPECIES[p.sp].name}!`, 'gift');
}

function dawn(room) {
  const se = season(room);
  for (let i = 0; i < room.tiles.length; i++) { growPlant(room, i); revealWild(room, i); }
  Scav.prune(room);
  const r = E.rand(room);
  room.weather = se === 3 ? (r < 0.4 ? 'snow' : 'sun') : (r < (se === 0 ? 0.35 : 0.25) ? 'rain' : 'sun');
  for (const t of room.tiles) if (t.s) t.s.w = room.weather === 'rain' ? 1 : 0;
  const iceAreas = Ice.dawnIce(room, se, room.weather); // otvory vo vode zamrznú, ľadovec sa topí, v daždi/snehu dorastie
  Econ.onDawn(room);
  room.dirty = true;
  if (!room.players.size) return;
  tilesMsg(room, 'garden');
  if (iceAreas.includes('hory')) tilesMsg(room, 'hory');
  broadcast(room, roomInfo(room));
  if ((room.day - 1) % D.DAYS_PER_SEASON === 0 && room.day > 1) toastAll(room, `Nastáva ${D.SEASONS[se].toLowerCase()} ${D.SEASON_ICONS[se]}`, 'day');
  const wtxt = { rain: 'Prší – záhrada sa poleje sama. 🌧️', snow: 'Sneží. ❄️', sun: 'Slnečno. ☀️' }[room.weather];
  toastAll(room, `Deň ${room.day} · ${D.SEASONS[se]}. ${wtxt}`, 'day');
}

function playerByKey(room, key) { for (const p of room.players.values()) if (p.key === key) return p; return null; }

// Obsluha naplánovaných udalostí (obyčajné callbacky, pozri engine.js a docs/engine.md).
const HANDLERS = {
  dawn,
  // Každú hernú hodinu: kvety staršie než ich životnosť zvädnú (v batohoch aj v sklade, aj u offline hráčov).
  hourly(room) {
    for (const key in room.saves) {
      const w = I.wiltSweep(I.playerC(room.saves[key]), room.tick);
      const names = Object.entries(w);
      if (!names.length) continue;
      const pl = playerByKey(room, key);
      if (pl) { toast(pl, '🥀 Zvädlo: ' + names.map(([n, k]) => `${k}× ${n}`).join(', ') + '. Zvädnuté kvety sa dajú skompostovať v sklade.'); sendMe(pl); }
    }
    // ľad v batohu sa do pol dňa roztopí
    for (const key in room.saves) {
      const k = I.meltSweep(I.playerC(room.saves[key]), room.tick);
      const pl = k && playerByKey(room, key);
      if (pl) { toast(pl, `💧 V batohu sa ti roztopil ľad (${k}×). Ľad treba rýchlo odniesť do ľadovne.`); sendMe(pl); }
    }
    let info = Object.keys(I.wiltSweep(I.storageC(room), room.tick)).length > 0;
    const had = room.icehouse.ice;
    if (Ice.meltHourly(room, season(room))) toastAll(room, '💧 Ľad v ľadovni sa roztopil. Sklad už nechladí tak dobre – doplň ľad z hôr alebo v zime z jazierka. 🧊');
    if (room.icehouse.ice !== had) { info = true; room.dirty = true; }
    if (info) broadcast(room, roomInfo(room));
  },
  scavDone(room, d) {
    const pl = playerByKey(room, d.key);
    if (pl && pl.scav && pl.scav.n === d.n) finishScavenge(pl);
  },
  vilyEnd(room, d) {
    const pl = playerByKey(room, d.key);
    if (pl) { toast(pl, 'Trblietky okolo teba vyprchali. Víly ťa už nevidia. 🧚'); sendMe(pl); }
  }
};

Object.assign(HANDLERS, Econ.HANDLERS);
// Periodické udalosti plánuje engine sám (E.reconcile): ráno o 6:00 a každú celú hodinu, plus ekonomika.
const PERIODIC = [
  { key: 'dawn', type: 'dawn', next: E.daily(D.DAWN_TICK) },
  { key: 'hourly', type: 'hourly', next: E.every(TPD / 24) },
  ...Econ.PERIODIC
];
const SIM = { handlers: HANDLERS, periodic: PERIODIC };
Econ.setHooks({
  market(room) { room.marketDirty = true; room.dirty = true; },
  board(room) { room.boardDirty = true; room.dirty = true; },
  toastAll(room, text, kind) { toastAll(room, text, kind); },
  toastKey(room, key, text, kind) { const p = playerByKey(room, key); if (p) toast(p, text, kind); },
  me(room, key) { const p = playerByKey(room, key); if (p) sendMe(p); }
});
// Zmeny trhu a nástenky posielame hráčom dávkovo (najviac raz za 100 ms).
function flushEconomy(room) {
  if (!room.players.size) return;
  if (room.marketDirty) { room.marketDirty = false; broadcast(room, Econ.marketView(room)); }
  if (room.boardDirty) { room.boardDirty = false; broadcast(room, Econ.boardView(room)); }
}

// ---------- Spánok ----------
// Keď spia všetci pripojení hráči, svet pretočí noc zrýchlene (FF_STEPS krokov za 100 ms) až do 6:00.
const FF_STEPS = 5;
const HOUSE = { x: 3.5, y: 28.5 };
function nearHouse(pl) { return pl.area === 'garden' && Math.hypot(pl.x - HOUSE.x, pl.y - HOUSE.y) <= 3.5; }
function sleepMsg(room) {
  const ps = [...room.players.values()];
  return { t: 'sleep', ids: ps.filter(p => p.sleep).map(p => p.id), total: ps.length, ff: !!room.ff };
}
function checkSleep(room) {
  if (room.ff || !room.players.size) return;
  for (const p of room.players.values()) if (!p.sleep) return;
  room.ff = { until: E.nextDailyTick(room.tick + 1, D.DAWN_TICK) };
  broadcast(room, sleepMsg(room));
}
function fastForward(room, now) {
  E.advanceTo(room, Math.min(room.ff.until, room.tick + FF_STEPS), SIM);
  room.wall = now; // pretočený čas sa nedobieha – po prebudení beží svet zase normálnym tempom
  room.dirty = true;
  if (room.tick >= room.ff.until) {
    room.ff = null;
    for (const p of room.players.values()) p.sleep = false;
    broadcast(room, sleepMsg(room));
  }
  broadcast(room, timeMsg(room));
}

function timeMsg(room) {
  return { t: 'time', tick: room.tick, tickMs: room.ff ? 100 / FF_STEPS : E.tickMs(room), weather: room.weather, mode: room.mode, daySeconds: room.daySeconds };
}

// ---------- Akcie ----------
function inRing(p) { if (p.area !== 'garden') return false; const x = Math.floor(p.x), y = Math.floor(p.y); return x >= D.RING.x0 && x <= D.RING.x1 && y >= D.RING.y0 && y <= D.RING.y1; }

function playerAt(room, pl, x, y) {
  for (const o of room.players.values()) if (o !== pl && o.area === pl.area && Math.hypot(o.x - (x + 0.5), o.y - (y + 0.5)) < 0.8) return o;
  return null;
}

function eachAround(room, x, y, r, fn) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= D.W || ny >= D.H) continue;
    fn(ny * D.W + nx, room.tiles[ny * D.W + nx]);
  }
}

function act(pl, m) {
  const room = pl.room, sv = pl.save;
  const x = m.x | 0, y = m.y | 0, item = String(m.item || '');
  const area = pl.area, tiles = Areas.areaTiles(room, area);
  if (!Areas.inside(area, x, y)) return;
  if (Math.hypot(pl.x - (x + 0.5), pl.y - (y + 0.5)) > 2.4) return toast(pl, 'Si príliš ďaleko.');
  if (item && !sv.inv[item]) return;
  const i = y * D.areaSize(area).w + x, t = tiles[i];
  if (pl.scav) {
    if (searchesWith(item) && pl.scav.i === i) return toast(pl, 'Ešte stále hľadáš… 🔍');
    stopScavenge(pl, 'Prestal(a) si hľadať.');
  }

  // Iný hráč – darovanie
  const other = playerAt(room, pl, x, y);
  if (other) {
    if (item === 'po_laska') {
      take(pl, item, 1);
      give(pl, 'seed_duhova', 2); give(other, 'seed_duhova', 2);
      sv.coins += 50; other.save.coins += 50;
      fx(room, 'hearts', (pl.x + other.x) / 2, (pl.y + other.y) / 2, null, area);
      toastAll(room, `💕 ${pl.name} daroval(a) ${other.name} Elixír lásky! Obaja dostávajú dúhové semienka.`, 'magic');
      sendMe(pl); sendMe(other); return;
    }
    if (D.isTool(item) || !item) { fx(room, 'wave', other.x, other.y, null, area); return; }
    if (item === 'ice' && (other.save.inv.ice || 0) >= D.ICE_CARRY) return toast(pl, `${other.name} už viac ľadu neunesie (najviac ${D.ICE_CARRY}).`);
    give(other, item, 1, take(pl, item, 1));
    toast(pl, `Daroval(a) si ${other.name}: ${D.itemName(item)} 🎁`);
    toast(other, `${pl.name} ti daroval(a): ${D.itemName(item)} 🎁`, 'gift');
    fx(room, 'gift', other.x, other.y, null, area);
    sendMe(pl); sendMe(other); return;
  }

  // Ľad: krompáčom na ľadovci alebo (v zime) na zamrznutej vode
  if (item === 'pick' && (t.g === 'glacier' || t.g === 'water')) {
    if ((sv.inv.ice || 0) >= D.ICE_CARRY) return toast(pl, `Viac ľadu neunesieš (najviac ${D.ICE_CARRY}). Odnes ho do ľadovne – kým sa neroztopí. 🧊`);
    const r = Ice.digIce(room, tiles, i, season(room));
    if (r.ok) { give(pl, 'ice', 1); tileMsg(room, i, area); sendMe(pl); fx(room, 'ice', x + 0.5, y + 0.5, null, area); }
    return toast(pl, r.msg);
  }
  if (t.g === 'icehouse') { if (item === 'ice') fillIcehouse(pl, sv.inv.ice); return; }
  if (area !== 'garden') {
    if (t.g === 'water' && item === 'can') { sv.water = Econ.canCap(sv); sendMe(pl); fx(room, 'splash', x + 0.5, y + 0.5, null, area); return; }
    if (t.g === 'glacier') return toast(pl, 'Na ľad potrebuješ krompáč – kúpiš ho na trhu (záložka Vylepšiť). ⛏️');
    if (item === 'hoe' || item.startsWith('seed_') || D.isWild(item) || item === 'compost') return toast(pl, area === 'hory'
      ? 'V horách je pôda kamenistá a studená. Pestuj radšej v záhrade. 🏔️'
      : 'Les na pomedzí je divý – tu sa nepestuje. Pestuj v záhrade. 🌳');
    if (item.startsWith('po_')) {
      if (['rast', 'jar', 'hojnost'].includes(item.slice(3))) return toast(pl, 'Tento elixír pôsobí na záhony – použi ho v záhrade. 🌱');
      return usePotion(pl, item.slice(3), x, y);
    }
    return;
  }

  // Studňa prianí
  if (t.g === 'well' && item !== 'can') return wishingWell(pl);
  if ((t.g === 'water' || t.g === 'well') && item === 'can') {
    sv.water = Econ.canCap(sv); sendMe(pl); fx(room, 'splash', x + 0.5, y + 0.5); return;
  }

  // Zber
  const p = t.s && t.s.p;
  if (p && !p.d && p.prog >= D.SPECIES[p.sp].days) {
    const sp = D.SPECIES[p.sp];
    if (p.sp === 'papradie' && !D.isNight(room.min)) return toast(pl, 'Papraď drží púčik pevne zatvorený… vraj sa otvára len v noci. 🌙');
    const n = Math.min(4, p.q + (t.s.r ? 1 : 0));
    give(pl, 'fl_' + p.sp, n);
    t.s.r = 0;
    if (sp.perennial) { p.prog = sp.days * 0.5; p.q = 3; p.bt = null; } else t.s.p = null;
    toast(pl, `+${n}× ${sp.name}` + (n >= 3 ? ' ⭐ výborná kvalita!' : ''));
    if (p.sp === 'papradie') toastAll(room, `✨ ${pl.name} našiel(a) papraďový kvet! Môže si niečo priať…`, 'magic');
    fx(room, p.sp === 'papradie' ? 'sparkle' : 'pop', x + 0.5, y + 0.5, { c: sp.color });
    tileMsg(room, i); sendMe(pl); return;
  }

  // Neprekopaná tráva a v ruke nič, čo by tu niečo robilo (semienka, kvety, krhla…) → hľadanie divých semienok
  if (Scav.canSearch(t) && searchesWith(item)) {
    if (Math.hypot(pl.x - (x + 0.5), pl.y - (y + 0.5)) > 0.45) return toast(pl, 'Postav sa priamo na to políčko trávy. 🔍');
    return startScavenge(pl, i, item);
  }

  if (item === 'hoe') {
    if (p && p.d) { t.s.p = null; tileMsg(room, i); return; }
    if (!t.s && D.TILLABLE[t.g]) {
      if (t.g === 'ring') return;
      const lim = Econ.plotLimit(sv);
      if (plotsUsed(room, pl.key) >= lim) return toast(pl, `Máš povolenie len na ${lim} políčok. Väčšie pole kúpiš na trhu (záložka Vylepšiť), alebo zarovnaj prázdne políčko motykou.`);
      t.s = { k: D.TILLABLE[t.g], w: room.weather === 'rain' ? 1 : 0, r: 0, p: null, o: pl.key };
      tileMsg(room, i); sendMe(pl); fx(room, 'dirt', x + 0.5, y + 0.5); return;
    }
    if (t.s && !t.s.p && (!t.s.o || t.s.o === pl.key)) { // zarovnať prázdne políčko – uvoľní miesto v povolení
      t.s = null; Scav.empty(room, i); tileMsg(room, i); sendMe(pl); return; // čerstvo zarovnaná zem semienka nemá
    }
    if (t.g === 'ring' || t.g === 'shroom') return toast(pl, 'Kruh z húb radšej nechaj tak… niekto tu v noci tancuje. 🍄');
    return;
  }
  if (item === 'can') {
    if (!t.s) return;
    if (sv.water <= 0) return toast(pl, 'Krhla je prázdna – načri vodu v jazierku alebo v studni. 💧');
    sv.water--; t.s.w = 1; tileMsg(room, i); sendMe(pl); fx(room, 'drops', x + 0.5, y + 0.5); return;
  }
  if (item === 'compost') {
    if (!t.s || t.s.r) return;
    take(pl, item, 1); t.s.r = 1; tileMsg(room, i); sendMe(pl); return;
  }
  if (item.startsWith('seed_')) {
    if (!t.s) return toast(pl, 'Najprv zem prekopaj motykou.');
    if (t.s.p) return;
    const key = item.slice(5), sp = D.SPECIES[key];
    if (!sp.seasons.includes(season(room)) && !room.eternal) {
      return toast(pl, `${sp.name} sa sadí v období: ${sp.seasons.map(s => D.SEASONS[s]).join(', ')}.`);
    }
    take(pl, item, 1);
    t.s.p = { sp: key, prog: 0, q: 3, dry: 0 };
    if (sp.strict && t.s.k !== sp.soil) toast(pl, `Hmm, ${sp.name} tu asi nebude rásť…`);
    tileMsg(room, i); sendMe(pl); return;
  }
  if (D.isWild(item)) {
    if (!t.s) return toast(pl, 'Najprv zem prekopaj motykou.');
    if (t.s.p) return;
    const ws = +item.slice(5);
    if (ws !== season(room) && !room.eternal) return toast(pl, `Toto divé semienko je z obdobia ${D.SEASONS[ws].toLowerCase()} – vtedy ho aj zasaď.`);
    take(pl, item, 1);
    // druh sa určí teraz a už sa nezmení; hráč ho uvidí, až keď vyklíči
    t.s.p = { sp: Scav.pickWild(room, ws, sp => Econ.flowerPrice(room, sp)), prog: 0, q: 3, dry: 0, wild: 1 };
    toast(pl, 'Zasadil(a) si divé semienko. Čo z neho vyrastie? 🤔');
    tileMsg(room, i); sendMe(pl); return;
  }
  if (item.startsWith('po_')) return usePotion(pl, item.slice(3), x, y);
}

// ---------- Hľadanie divých semienok ----------
// Motyka v tráve kope a elixíry sa dajú použiť kdekoľvek; s čímkoľvek iným (alebo s prázdnou rukou) sa hľadá.
function searchesWith(item) { return item !== 'hoe' && !item.startsWith('po_'); }
// Hráč sa prikrčí a hrabe v tráve D.SCAVENGE.ticks krokov; pohnúť sa alebo urobiť niečo iné hľadanie preruší.
// Kde sú semienka, vie len server – klient dostane až výsledok.
function startScavenge(pl, i, item) {
  const room = pl.room;
  pl.scavN = (pl.scavN | 0) + 1;
  pl.scav = { i, n: pl.scavN, px: pl.x, py: pl.y, seeds: !!item && (item.startsWith('seed_') || D.isWild(item)) };
  E.scheduleUnique(room, 'scavDone:' + pl.key, room.tick + D.SCAVENGE.ticks, 'scavDone', { key: pl.key, n: pl.scav.n });
}
function stopScavenge(pl, msg) {
  pl.scav = null;
  E.cancel(pl.room, 'scavDone:' + pl.key);
  if (msg) toast(pl, msg);
}
function finishScavenge(pl) {
  const room = pl.room, i = pl.scav.i, t = room.tiles[i], seeds = pl.scav.seeds;
  pl.scav = null;
  if (!Scav.canSearch(t)) return toast(pl, 'Kým si hľadal(a), niekto tu trávu prekopal.');
  const x = i % D.W + 0.5, y = Math.floor(i / D.W) + 0.5;
  room.dirty = true;
  if (!Scav.roll(room, i)) return toast(pl, 'Nič tu nie je… skús vedľa. 🌾' + (seeds ? ' (Na sadenie najprv prekopaj zem motykou.)' : ''));
  const id = 'wild_' + season(room);
  give(pl, id, 1);
  toast(pl, `🌾 Našiel(a) si ${D.itemName(id).toLowerCase()}!`, 'gift');
  fx(room, 'pop', x, y, { c: '#9ccc65' });
  sendMe(pl);
}

function usePotion(pl, k, x, y) {
  const room = pl.room, sv = pl.save;
  if (k === 'laska') return toast(pl, 'Tento elixír treba darovať niekomu milému – postav sa k inému hráčovi. 💕');
  take(pl, 'po_' + k, 1);
  if (k === 'rast') {
    eachAround(room, x, y, 1, (i, t) => {
      if (t.s && t.s.p && !t.s.p.d) { const sp = D.SPECIES[t.s.p.sp]; t.s.p.prog = Math.min(sp.days, t.s.p.prog + 1); t.s.w = 1; revealWild(room, i); tileMsg(room, i); }
    });
    fx(room, 'sparkle', x + 0.5, y + 0.5, { c: '#7ed957' });
  } else if (k === 'dazd') {
    room.weather = 'rain';
    for (let i = 0; i < room.tiles.length; i++) if (room.tiles[i].s) room.tiles[i].s.w = 1;
    tilesMsg(room, 'garden');
    if (Ice.feedGlacier(room, 'rain')) tilesMsg(room, 'hory'); // dážď živí aj ľadovec
    toastAll(room, `🌧️ ${pl.name} privolal(a) dážď!`, 'magic');
  } else if (k === 'jar') {
    eachAround(room, x, y, 1, (i, t) => { if (t.s && t.s.p && !t.s.p.d) { t.s.p.b = 1; tileMsg(room, i); } });
    fx(room, 'sparkle', x + 0.5, y + 0.5, { c: '#f48fb1' });
    toast(pl, 'Tieto kvety teraz rastú v každom ročnom období. 🌸');
  } else if (k === 'hojnost') {
    eachAround(room, x, y, 2, (i, t) => { if (t.s) { t.s.r = 1; if (t.s.p && !t.s.p.d) t.s.p.q = 3; tileMsg(room, i); } });
    fx(room, 'sparkle', x + 0.5, y + 0.5, { c: '#ffd54f' });
  } else if (k === 'vily') {
    sv.vily = room.tick + TPD;
    E.scheduleUnique(room, 'vilyEnd:' + pl.key, sv.vily, 'vilyEnd', { key: pl.key });
    toast(pl, 'Svet sa zatrblietal… Teraz vidíš víly. Možno by si v noci mal(a) zájsť do lesa ku kruhu z húb. 🧚', 'magic');
  } else if (k === 'duha') {
    for (const o of room.players.values()) o.save.coins += 300;
    for (let i = 0; i < room.tiles.length; i++) { const t = room.tiles[i]; if (t.s && t.s.p && !t.s.p.d) t.s.p.q = 3; }
    tilesMsg(room, 'garden');
    broadcast(room, { t: 'fx', k: 'rainbow' });
    toastAll(room, `🌈 ${pl.name} uvaril(a) Dúhový elixír! Nad záhradou sa klenie dúha. Všetci dostávajú 300 🪙 a kvety najvyššiu kvalitu!`, 'magic');
    for (const o of room.players.values()) sendMe(o);
  } else if (k === 'sliz') {
    toast(pl, 'Vypil(a) si čudný sliz. Chvíľu si videl(a) farby, ktoré neexistujú. 🫠');
    fx(room, 'burp', pl.x, pl.y, null, pl.area);
  }
  sendMe(pl);
}

// Ľadovňa: hráč do nej vloží ľad z batohu (najviac toľko, koľko sa zmestí).
function nearIcehouse(pl) {
  const L = D.ICEHOUSE.lot;
  return pl.area === 'garden' && Math.hypot(pl.x - (L.x0 + L.x1 + 1) / 2, pl.y - (L.y0 + L.y1 + 1) / 2) <= 3;
}
function fillIcehouse(pl, n) {
  const room = pl.room;
  if (!room.icehouse.built) return toast(pl, 'Ľadovňa ešte nie je postavená. Kúpiš ju na trhu (záložka Vylepšiť). 🧊');
  if (!nearIcehouse(pl)) return toast(pl, 'Podíď bližšie k ľadovni.');
  n = Math.min(n | 0, pl.save.inv.ice || 0);
  if (n <= 0) return toast(pl, 'Nemáš ľad. Vysekáš ho krompáčom na ľadovci v horách, v zime aj na jazierku. ⛏️');
  const k = Ice.fillIcehouse(room, n);
  if (!k) return toast(pl, 'Ľadovňa je plná. 🧊');
  take(pl, 'ice', k);
  toast(pl, `🧊 Vložil(a) si ${k}× ľad. V ľadovni je ${Math.ceil(room.icehouse.ice)}/${D.ICEHOUSE.cap}.`);
  fx(room, 'ice', D.ICEHOUSE.lot.x0 + 1, D.ICEHOUSE.lot.y0 + 1);
  room.dirty = true; sendMe(pl); broadcast(room, roomInfo(room));
}

// Prechod do inej plochy: hráč dostane políčka novej plochy (aj jej veľkosť) a príchodové miesto.
// seq rozlíši staré správy o pohybe, ktoré klient poslal ešte z predchádzajúcej plochy.
function areaMsg(pl) {
  const { w, h } = D.areaSize(pl.area);
  return { t: 'area', area: pl.area, seq: pl.areaSeq, w, h, tiles: tilesView(pl.room, pl.area), x: pl.x, y: pl.y };
}
function travel(pl, to) {
  const a = D.arrival(pl.area, to);
  if (!a) return;
  if (pl.scav) stopScavenge(pl);
  const from = pl.area;
  pl.area = pl.save.area = to;
  pl.x = pl.save.x = a.x; pl.y = pl.save.y = a.y;
  pl.areaSeq++;
  pl.emote = null;
  send(pl.ws, areaMsg(pl));
  toast(pl, to === 'hory'
    ? '🏔️ Vystúpil(a) si do hôr. Na ľadovci pod skalami vysekáš krompáčom ľad. Chodníkom dole sa vrátiš do záhrady.'
    : to === 'pomedzie'
      ? '🌳 Prišiel(a) si do Lesa na pomedzí. Na juhu je lúka, na sever les hustne a stmieva sa… Na západe sa vrátiš do záhrady.'
      : from === 'pomedzie' ? '🏡 Vrátil(a) si sa z lesa do záhrady.' : '🏡 Vrátil(a) si sa do záhrady.', 'day');
}

function wishingWell(pl) {
  const sv = pl.save, room = pl.room;
  if (sv.coins < 5) return toast(pl, 'Na prianie potrebuješ hodiť do studne 5 🪙.');
  sv.coins -= 5;
  const r = E.rand(room);
  if (r < 0.45) toast(pl, '🪙 Žbluňk… Zo studne zašepkal hlas: „' + E.pick(room, D.TIPS) + '“', 'magic');
  else if (r < 0.65) {
    const pool = Object.keys(D.SPECIES).filter(k => !D.SPECIES[k].magic);
    const sp = E.pick(room, pool);
    give(pl, 'seed_' + sp, 2);
    toast(pl, `🪙 Žbluňk… Z hĺbky vyletelo vrecúško: 2× semienka ${D.SPECIES[sp].name}!`, 'gift');
  } else if (r < 0.75 && room.weather !== 'rain' && season(room) !== 3) {
    room.weather = 'rain';
    for (const t of room.tiles) if (t.s) t.s.w = 1;
    tilesMsg(room, 'garden');
    if (Ice.feedGlacier(room, 'rain')) tilesMsg(room, 'hory');
    toastAll(room, '🪙 Studňa zahučala a z neba sa spustil dážď!', 'magic');
  } else if (r < 0.77) {
    give(pl, 'seed_papradie', 1);
    toast(pl, '🪙 Na dne studne sa niečo zalesklo… Papraďové semienko!', 'magic');
  } else toast(pl, '🪙 Žbluňk. Nič sa nestalo. Možno nabudúce.');
  fx(room, 'splash', 7.5, 28.5);
  sendMe(pl);
}

function checkFairies(room, pl) {
  if (!inRing(pl)) return;
  if (!D.isNight(room.min)) return toast(pl, 'Huby pokojne spia. Možno v noci… 🌙');
  const nightId = hour(room) >= 12 ? room.day : room.day - 1;
  if (room.fairyNight === nightId) return toast(pl, 'Víly už dnes v noci odleteli. Príď zajtra. 🧚');
  const now = Date.now();
  const dancers = [...room.players.values()].filter(p => inRing(p) && p.emote === 'dance' && now - p.emoteAt < 6500);
  const seeFairies = dancers.some(p => p.save.vily > room.tick);
  if (dancers.length >= 2 || (dancers.length >= 1 && seeFairies)) {
    room.fairyNight = nightId;
    for (const d of dancers) { give(d, 'seed_papradie', 1); give(d, 'seed_duhova', 1); sendMe(d); }
    fx(room, 'fairies', 3.5, 3.5);
    toastAll(room, '🧚✨ Z húb sa vzniesli víly a roztancovali sa s ' + dancers.map(d => d.name).join(' a ') +
      '! Každému darovali papraďové semienko a dúhové semienko.', 'magic');
    room.dirty = true;
  } else {
    fx(room, 'glimmer', 3.5, 3.5);
    toast(pl, 'Huby sa jemne rozžiarili… akoby čakali, kým sa k tancu pridá ešte niekto. ✨', 'magic');
  }
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });
let nextId = 1;
const leaving = P.createLeaving(RECONNECT_GRACE_MS);

wss.on('connection', ws => {
  P.watch(ws);
  let pl = null;
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'join' && !pl) {
      const roomId = String(m.room || 'zahrada').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'zahrada';
      const name = String(m.name || '').replace(/[<>]/g, '').trim().slice(0, 14) || 'Záhradník';
      const room = getRoom(roomId);
      const key = name.toLowerCase();
      // Rýchle znovupripojenie: nahrádza ešte živé (často už mŕtve, len nezistené) spojenie
      // alebo prichádza krátko po odchode. Vtedy nehlásime príchod ani „kým si bol(a) preč“.
      let quick = false;
      for (const o of room.players.values()) if (o.key === key) { o.save.lastTick = room.tick; o.ws.close(); room.players.delete(o.id); quick = true; }
      if (room.players.size >= MAX_PLAYERS) { send(ws, { t: 'error', text: 'Záhrada je plná (max ' + MAX_PLAYERS + ' hráči).' }); return ws.close(); }
      if (leaving.back(roomId + ':' + key)) quick = true;
      if (!room.saves[key]) room.saves[key] = newSave(room);
      const sv = room.saves[key];
      migrateSave(sv, room);
      const look = m.look && typeof m.look === 'object' ? { shirt: String(m.look.shirt || '#4a90d9').slice(0, 9), hair: String(m.look.hair || '#5b3a1a').slice(0, 9), hat: !!m.look.hat } : sv.look;
      sv.look = look;
      const area = D.AREAS.includes(sv.area) ? sv.area : 'garden';
      const pos = Areas.clampPos(area, sv.x || D.SPAWN.x, sv.y || D.SPAWN.y);
      pl = { id: nextId++, key, name, ws, room, save: sv, area, areaSeq: 0, x: pos.x, y: pos.y, dir: 0, emote: null, emoteAt: 0, look };
      room.players.set(pl.id, pl);
      send(ws, {
        t: 'welcome', id: pl.id, room: roomId, w: D.areaSize(area).w, h: D.areaSize(area).h, tiles: tilesView(room, area), area, seq: pl.areaSeq, x: pl.x, y: pl.y
      });
      send(ws, timeMsg(room));
      send(ws, Econ.marketView(room));
      send(ws, Econ.boardView(room));
      sendMe(pl);
      broadcast(room, roomInfo(room));
      broadcast(room, sleepMsg(room));
      if (!quick) toastAll(room, area === 'garden' ? `${name} prišiel(a) do záhrady 🌼` : `${name} prišiel(a) – je ${D.AREA_IN[area]} ${D.AREA_FX[area].icon}`);
      const days = quick ? 0 : P.awayDays(sv.lastTick, room.tick, TPD);
      if (days) {
        toast(pl, `Kým si bol(a) preč, ubehlo ${days} ${days === 1 ? 'deň' : days < 5 ? 'dni' : 'dní'}. Pozri sa, čo sa v záhrade zmenilo. 🌱`, 'day');
      }
      if (!sv.talked) { sv.talked = true; toast(pl, 'Vitaj! Začínaš s pár semienkami a prázdnym vreckom. Pri babke na severe je nástenka so zákazkami. 👵', 'gift'); }
      return;
    }
    if (!pl) return;
    const room = pl.room, sv = pl.save;
    switch (m.t) {
      case 'move':
        if (pl.sleep) break; // spiaci hráč leží v posteli
        if ((m.ar | 0) !== pl.areaSeq) break; // pohyb ešte z predchádzajúcej plochy
        if (typeof m.x === 'number' && typeof m.y === 'number' && isFinite(m.x) && isFinite(m.y)) {
          const pos = Areas.clampPos(pl.area, m.x, m.y); // z plochy sa vyjsť nedá – len cez prechod
          pl.x = pos.x; pl.y = pos.y;
          pl.dir = m.dir | 0;
          if (typeof m.a === 'number' && isFinite(m.a)) pl.a = +m.a.toFixed(3); // presný smer pohľadu (3D: 8 smerov)
          pl.cr = !!m.cr; // plazí sa
          pl.lp = !!m.lp && !!sv.inv.lamp; // drží lampáš (svieti)
          sv.x = pl.x; sv.y = pl.y;
          if (pl.scav && Math.hypot(pl.x - pl.scav.px, pl.y - pl.scav.py) > 0.35) stopScavenge(pl, 'Pohol(a) si sa skôr, než si dohľadal(a).');
          const to = Areas.gateTarget(Areas.areaTiles(room, pl.area), pl.area, pl.x, pl.y);
          if (to) travel(pl, to);
        }
        break;
      case 'act': if (!pl.sleep) act(pl, m); break;
      case 'jump': if (!pl.sleep) pl.jn = ((pl.jn | 0) + 1) % 1000; break; // skok je len pre parádu – ostatní ho uvidia podľa zmeny počítadla
      case 'sleep': {
        if (m.on) {
          if (pl.sleep || room.ff) return;
          if (!D.canSleep(room.min)) return toast(pl, 'Ešte je skoro. Spať sa dá od 18:00. 🌇');
          if (!nearHouse(pl)) return toast(pl, 'Posteľ je v domčeku – podíď bližšie. 🏠');
          if (pl.scav) stopScavenge(pl);
          pl.sleep = true; pl.emote = null;
          const s = sleepMsg(room);
          if (s.ids.length < s.total) toastAll(room, `💤 ${pl.name} ide spať (${s.ids.length}/${s.total}). Keď pôjdu spať všetci, noc prebehne.`, 'day');
          broadcast(room, s);
          checkSleep(room);
        } else if (pl.sleep && !room.ff) {
          pl.sleep = false;
          broadcast(room, sleepMsg(room));
        }
        break;
      }
      case 'emote': {
        const e = ['dance', 'wave', 'heart', 'laugh', 'flower'].includes(m.e) ? m.e : 'wave';
        pl.emote = e; pl.emoteAt = Date.now();
        if (e === 'dance') checkFairies(room, pl);
        break;
      }
      case 'buy': {
        const r = Econ.buy(room, sv, String(m.id), Math.max(1, Math.min(20, m.n | 0)));
        toast(pl, r.msg); if (r.n) sendMe(pl);
        break;
      }
      case 'sell': {
        const r = Econ.sell(room, sv, String(m.id), Math.max(1, Math.min(999, m.n | 0)));
        toast(pl, r.msg); if (r.n) sendMe(pl);
        break;
      }
      case 'upgrade': {
        const err = Econ.upgrade(room, sv, String(m.kind));
        if (err) return toast(pl, err);
        const u = D.UPGRADES[m.kind];
        toast(pl, `${u.icon} ${u.name}: úroveň ${sv.up[m.kind]} (${u.levels[sv.up[m.kind]].v} ${u.unit})`, 'gift');
        room.dirty = true; sendMe(pl);
        break;
      }
      case 'ctake': {
        const err = Econ.takeContract(room, pl.key, m.id | 0);
        toast(pl, err || '📋 Zákazka je tvoja. Termín platí – nezabudni!');
        break;
      }
      case 'cdeliver': {
        const r = Econ.deliverContract(room, pl.key, m.id | 0);
        toast(pl, r.msg, r.done ? 'gift' : 'info');
        if (r.done) fx(room, 'hearts', D.BABKA.x + 0.5, D.BABKA.y + 0.5);
        sendMe(pl);
        break;
      }
      case 'brew': {
        const items = Array.isArray(m.items) ? m.items.map(String).slice(0, 3) : [];
        if (items.length !== 3 || !items.every(id => id.startsWith('fl_'))) return;
        const need = {};
        for (const id of items) need[id] = (need[id] || 0) + 1;
        for (const id in need) if ((sv.inv[id] || 0) < need[id]) return toast(pl, 'Tieto kvety nemáš.');
        for (const id in need) take(pl, id, need[id]);
        const key = items.map(id => id.slice(3)).sort().join('+');
        const k = D.RECIPES[key] || 'sliz';
        give(pl, 'po_' + k, 1);
        if (k !== 'sliz' && !sv.recipes.includes(key)) sv.recipes.push(key);
        fx(room, 'brew', 17.5, 5.5, { c: D.POTIONS[k].color });
        send(pl.ws, { t: 'brewed', k });
        if (k === 'duha') toastAll(room, `🌈 V kotlíku babky sa niečo dúhovo rozžiarilo… ${pl.name} uvaril(a) niečo, čo tu ešte nebolo!`, 'magic');
        sendMe(pl);
        break;
      }
      case 'wish': {
        if (!take(pl, 'fl_papradie', 1)) return;
        const k = m.kind;
        if (k === 'zlato') {
          for (const o of room.players.values()) { o.save.coins += 400; sendMe(o); }
          broadcast(room, { t: 'fx', k: 'gold' });
          toastAll(room, `✨ ${pl.name} si prial(a) zlatý dážď! Každý dostáva 400 🪙.`, 'magic');
        } else if (k === 'jar') {
          room.eternal = true;
          for (const t of room.tiles) if (t.s) t.s.w = 1;
          tilesMsg(room, 'garden');
          broadcast(room, roomInfo(room));
          broadcast(room, { t: 'fx', k: 'rainbow' });
          toastAll(room, `✨ ${pl.name} si prial(a) večnú jar! Záhrada sa odteraz polieva sama a kvetom nevadí ročné obdobie.`, 'magic');
        } else {
          give(pl, 'seed_duhova', 3); give(pl, 'seed_plesnivec', 3); give(pl, 'seed_papradie', 1);
          toastAll(room, `✨ ${pl.name} si prial(a) poklad! Zo zeme vyrástla truhlica plná vzácnych semienok.`, 'magic');
          fx(room, 'sparkle', pl.x, pl.y, { c: '#ffd700' }, pl.area);
        }
        sendMe(pl); room.dirty = true;
        break;
      }
      case 'settings': {
        const mode = m.mode === 'paused' || m.mode === 'running' ? m.mode : room.mode;
        if (mode === room.mode) return;
        room.mode = mode; room.dirty = true;
        broadcast(room, roomInfo(room)); broadcast(room, timeMsg(room));
        toastAll(room, `⚙️ ${pl.name}: svet ${mode === 'running' ? 'beží ďalej aj bez hráčov' : 'sa pozastaví, keď nikto nehrá'}.`, 'day');
        break;
      }
      case 'store': case 'unstore': {
        const id = String(m.id), n = Math.max(1, Math.min(999, m.n | 0));
        if (D.isTool(id)) return;
        if (id === 'ice') return toast(pl, 'Ľad patrí do ľadovne – v sklade by sa roztopil. 🧊');
        if (!nearHouse(pl)) return toast(pl, 'Sklad je v domčeku – podíď bližšie.');
        // kvety si pri presune nesú svoj vek; v sklade starnú pomalšie
        if (m.t === 'store') {
          const b = take(pl, id, n);
          if (!b) return;
          I.addItems(I.storageC(room), id, n, room.tick, b);
        } else {
          const b = I.removeItems(I.storageC(room), id, n, room.tick);
          if (!b) return;
          give(pl, id, n, b);
        }
        room.dirty = true; sendMe(pl); broadcast(room, roomInfo(room));
        break;
      }
      case 'compostWilted': {
        const k = Math.floor((sv.inv.wilted || 0) / D.WILTED_PER_COMPOST);
        if (!k) return toast(pl, `Na 1 kompost treba ${D.WILTED_PER_COMPOST} zvädnuté kvety.`);
        take(pl, 'wilted', k * D.WILTED_PER_COMPOST); give(pl, 'compost', k);
        toast(pl, `♻️ Zo zvädnutých kvetov vznikol ${k}× kompost.`, 'gift'); sendMe(pl);
        break;
      }
      case 'buyTool': {
        const err = Ice.buyTool(sv, String(m.id));
        if (err) return toast(pl, err);
        const T = D.TOOLS[m.id];
        toast(pl, `${T.icon} Kúpil(a) si: ${T.name}. ${T.desc}`, 'gift');
        sendMe(pl);
        break;
      }
      case 'build': {
        if (m.id !== 'icehouse') return;
        const err = Ice.buildIcehouse(room, sv);
        if (err) return toast(pl, err);
        tilesMsg(room, 'garden');
        broadcast(room, roomInfo(room));
        toastAll(room, `🧊 ${pl.name} postavil(a) pri domčeku ľadovňu! Naplň ju ľadom – kým v nej je, kvety v sklade vädnú 4× pomalšie.`, 'gift');
        room.dirty = true; sendMe(pl);
        break;
      }
      case 'icehouse': fillIcehouse(pl, m.n); break;
      case 'chat': {
        const text = D.chatText(m.text); // limit D.CHAT_MAX platí aj pre upravených klientov
        if (text) broadcast(room, { t: 'chat', name: pl.name, text, id: pl.id });
        break;
      }
    }
  });
  ws.on('close', () => {
    if (!pl) return;
    const room = pl.room;
    if (room.players.get(pl.id) === pl) {
      room.players.delete(pl.id);
      pl.save.lastTick = room.tick;
      const name = pl.name;
      leaving.leave(room.id + ':' + pl.key, () => toastAll(room, `${name} odišiel(a) zo záhrady.`));
      broadcast(room, roomInfo(room));
      broadcast(room, sleepMsg(room));
      checkSleep(room); // ak odišiel posledný bdejúci, ostatní môžu zaspať
      room.dirty = true;
      saveRoom(room);
    }
  });
});

// Herný čas: pevný krok s dobiehaním – každý deň má presne TPD krokov, aj keď sa časovač oneskorí.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.ff) { fastForward(room, now); flushEconomy(room); continue; }
    if (room.mode === 'paused' && !room.players.size) { room.wall = now; continue; }
    const n = E.advance(room, now, SIM, 50000);
    if (n) { room.dirty = true; if (room.players.size) broadcast(room, timeMsg(room)); }
    flushEconomy(room);
  }
}, 100);
// Pozície hráčov 10× za sekundu
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.players.size) continue;
    const list = [...room.players.values()].map(p => ({
      id: p.id, name: p.name, x: +p.x.toFixed(3), y: +p.y.toFixed(3), dir: p.dir, a: p.a, look: p.look, cr: p.cr ? 1 : 0, lp: p.lp ? 1 : 0, j: p.jn | 0, si: p.scav ? p.scav.i : -1, area: p.area,
      e: p.sleep ? 'sleep' : p.scav ? 'search' : p.emote && now - p.emoteAt < 6000 ? p.emote : null
    }));
    for (const area of D.AREAS) broadcastArea(room, area, { t: 'pl', list: list.filter(p => p.area === area) });
  }
}, 100);
// Priebežne ukladáme aj „naposledy videný“ – po páde servera tak dni neprítomnosti sedia (±15 s).
setInterval(() => {
  for (const room of rooms.values()) { for (const p of room.players.values()) p.save.lastTick = room.tick; saveRoom(room); }
}, 15000);
setInterval(() => P.heartbeat(wss.clients), HEARTBEAT_MS);

function shutdown() {
  for (const room of rooms.values()) { for (const p of room.players.values()) p.save.lastTick = room.tick; saveRoom(room, true); }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`🌼 Čarovná záhrada beží na http://localhost:${PORT}  (nový svet: deň = ${DAY_SECONDS}s, režim ${DEFAULT_MODE}, ${TPD} krokov/deň)`);
});
