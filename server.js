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

const PORT = +process.env.PORT || 3000;
// Dĺžka herného dňa je napevno D.BASE_DAY_SECONDS (20 min); DAY_SECONDS v prostredí slúži len na testovanie.
const DAY_SECONDS = +process.env.DAY_SECONDS || D.BASE_DAY_SECONDS;
const MAX_PLAYERS = 4;
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
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/' || url === '/3d' || url === '/3d/') url = '/index.html';
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
const SAVE_VERSION = 2;
const TPD = D.TICKS_PER_DAY, MPT = D.MIN_PER_TICK;
const DEFAULT_MODE = process.env.DEFAULT_MODE === 'paused' ? 'paused' : 'running';
const MAX_CATCHUP_DAYS = +process.env.MAX_CATCHUP_DAYS || 30; // koľko herných dní najviac dobehneme po výpadku servera
const rooms = new Map();

function roomFile(id) { return path.join(DATA_DIR, 'room-' + id + '.json'); }

function newWorldState() {
  return {
    v: SAVE_VERSION, tick: D.DAWN_TICK + 6, wall: Date.now(), mode: DEFAULT_MODE, daySeconds: DAY_SECONDS,
    rng: crypto.randomBytes(4).readUInt32LE(0), seq: 0, events: [],
    weather: 'sun', saves: {}, storage: {}, market: null, contracts: null, fairyNight: -1, eternal: false
  };
}

// Prevod uloženia zo starého formátu (spojitý čas day/min) na diskrétne kroky.
function migrate(saved) {
  if (saved.v === SAVE_VERSION) return Object.assign(newWorldState(), saved);
  const out = Object.assign(newWorldState(), saved);
  const day = saved.day || 1, min = saved.min || 390;
  out.tick = (day - 1) * TPD + Math.min(TPD - 1, Math.round(min / MPT));
  out.mode = 'paused'; // staré svety sa správali ako pozastavené – zachováme to, prepnúť sa dá v menu
  out.wall = Date.now();
  for (const sv of Object.values(out.saves || {})) if (sv.vily) sv.vily = Math.max(0, Math.round((sv.vily - 1440) / MPT));
  delete out.day; delete out.min;
  out.v = SAVE_VERSION; out.migratedFrom = saved.v || 1;
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
  room.tiles = base.map((g, i) => ({ g, s: (savedTiles && savedTiles.length === base.length && savedTiles[i].s) || null }));
  Object.defineProperty(room, 'day', { get() { return D.dayOfTick(this.tick); } });
  Object.defineProperty(room, 'min', { get() { return D.minOfTick(this.tick); } });
  room.daySeconds = DAY_SECONDS;
  if (!E.nextOf(room, 'dawn')) E.schedule(room, E.nextDailyTick(room.tick + 1, D.DAWN_TICK), 'dawn');
  if (!E.nextOf(room, 'hourly')) E.schedule(room, room.tick + 12, 'hourly');
  room.storage = room.storage || {};
  I.syncAll(I.storageC(room), room.tick);
  for (const sv of Object.values(room.saves)) if (sv.inv) I.syncAll(I.playerC(sv), room.tick);
  Econ.initEconomy(room);
  if (room.mode === 'running') {
    // Svet beží aj bez hráčov – dobehneme čas, kým bol server vypnutý (najviac MAX_CATCHUP_DAYS dní).
    const cap = MAX_CATCHUP_DAYS * TPD * E.tickMs(room);
    room.wall = Math.max(room.wall, Date.now() - cap);
    const n = E.advance(room, Date.now(), HANDLERS);
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
    fairyNight: room.fairyNight, eternal: room.eternal, migratedFrom: room.migratedFrom,
    tiles: room.tiles.map(t => ({ s: t.s }))
  });
}
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
    coins: 30, water: 5, inv: { hoe: 1, can: 1, ['seed_' + sp]: 4 },
    recipes: [], seen: [sp], vily: 0, look: null, talked: false, rep: 0, up: { can: 0, plots: 0, composter: 0 }
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
function fx(room, k, x, y, extra) { broadcast(room, Object.assign({ t: 'fx', k, x, y }, extra || {})); }
function tileMsg(room, i) { room.dirty = true; broadcast(room, { t: 'tile', i, v: room.tiles[i] }); }
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
  return { t: 'room', eternal: room.eternal, mode: room.mode, daySeconds: room.daySeconds, storage: room.storage, storageFb: I.batchesView(I.storageC(room), room.tick), tick: room.tick, names: [...room.players.values()].map(p => p.name) };
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

function dawn(room) {
  const se = season(room);
  for (let i = 0; i < room.tiles.length; i++) growPlant(room, i);
  const r = E.rand(room);
  room.weather = se === 3 ? (r < 0.4 ? 'snow' : 'sun') : (r < (se === 0 ? 0.35 : 0.25) ? 'rain' : 'sun');
  for (const t of room.tiles) if (t.s) t.s.w = room.weather === 'rain' ? 1 : 0;
  Econ.onDawn(room);
  room.dirty = true;
  if (!room.players.size) return;
  broadcast(room, { t: 'tiles', tiles: room.tiles });
  broadcast(room, roomInfo(room));
  if ((room.day - 1) % D.DAYS_PER_SEASON === 0 && room.day > 1) toastAll(room, `Nastáva ${D.SEASONS[se].toLowerCase()} ${D.SEASON_ICONS[se]}`, 'day');
  const wtxt = { rain: 'Prší – záhrada sa poleje sama. 🌧️', snow: 'Sneží. ❄️', sun: 'Slnečno. ☀️' }[room.weather];
  toastAll(room, `Deň ${room.day} · ${D.SEASONS[se]}. ${wtxt}`, 'day');
}

function playerByKey(room, key) { for (const p of room.players.values()) if (p.key === key) return p; return null; }

// Obsluha naplánovaných udalostí. Každá udalosť je {at, seq, type, data} v room.events.
const HANDLERS = {
  dawn(room) {
    dawn(room);
    E.schedule(room, room.tick + TPD, 'dawn');
  },
  // Každú hernú hodinu: kvety staršie než ich životnosť zvädnú (v batohoch aj v sklade, aj u offline hráčov).
  hourly(room) {
    for (const key in room.saves) {
      const w = I.wiltSweep(I.playerC(room.saves[key]), room.tick);
      const names = Object.entries(w);
      if (!names.length) continue;
      const pl = playerByKey(room, key);
      if (pl) { toast(pl, '🥀 Zvädlo: ' + names.map(([n, k]) => `${k}× ${n}`).join(', ') + '. Zvädnuté kvety sa dajú skompostovať v sklade.'); sendMe(pl); }
    }
    if (Object.keys(I.wiltSweep(I.storageC(room), room.tick)).length) broadcast(room, roomInfo(room));
    E.schedule(room, room.tick + 12, 'hourly');
  },
  vilyEnd(room, d) {
    const pl = playerByKey(room, d.key);
    if (pl) { toast(pl, 'Trblietky okolo teba vyprchali. Víly ťa už nevidia. 🧚'); sendMe(pl); }
  }
};

Object.assign(HANDLERS, Econ.HANDLERS);
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
function nearHouse(pl) { return Math.hypot(pl.x - HOUSE.x, pl.y - HOUSE.y) <= 3.5; }
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
  for (let k = 0; k < FF_STEPS && room.tick < room.ff.until; k++) E.step(room, HANDLERS);
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
function inRing(p) { const x = Math.floor(p.x), y = Math.floor(p.y); return x >= D.RING.x0 && x <= D.RING.x1 && y >= D.RING.y0 && y <= D.RING.y1; }

function playerAt(room, pl, x, y) {
  for (const o of room.players.values()) if (o !== pl && Math.hypot(o.x - (x + 0.5), o.y - (y + 0.5)) < 0.8) return o;
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
  if (x < 0 || y < 0 || x >= D.W || y >= D.H) return;
  if (Math.hypot(pl.x - (x + 0.5), pl.y - (y + 0.5)) > 2.4) return toast(pl, 'Si príliš ďaleko.');
  if (item && !sv.inv[item]) return;
  const i = y * D.W + x, t = room.tiles[i];

  // Iný hráč – darovanie
  const other = playerAt(room, pl, x, y);
  if (other) {
    if (item === 'po_laska') {
      take(pl, item, 1);
      give(pl, 'seed_duhova', 2); give(other, 'seed_duhova', 2);
      sv.coins += 50; other.save.coins += 50;
      fx(room, 'hearts', (pl.x + other.x) / 2, (pl.y + other.y) / 2);
      toastAll(room, `💕 ${pl.name} daroval(a) ${other.name} Elixír lásky! Obaja dostávajú dúhové semienka.`, 'magic');
      sendMe(pl); sendMe(other); return;
    }
    if (item === 'hoe' || item === 'can' || !item) { fx(room, 'wave', other.x, other.y); return; }
    give(other, item, 1, take(pl, item, 1));
    toast(pl, `Daroval(a) si ${other.name}: ${D.itemName(item)} 🎁`);
    toast(other, `${pl.name} ti daroval(a): ${D.itemName(item)} 🎁`, 'gift');
    fx(room, 'gift', other.x, other.y);
    sendMe(pl); sendMe(other); return;
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

  if (item === 'hoe') {
    if (p && p.d) { t.s.p = null; tileMsg(room, i); return; }
    if (!t.s && D.TILLABLE[t.g]) {
      if (t.g === 'ring') return;
      const lim = Econ.plotLimit(sv);
      if (plotsUsed(room, pl.key) >= lim) return toast(pl, `Máš povolenie len na ${lim} políčok. Väčšie pole kúpiš na trhu (Vylepšenia), alebo zarovnaj prázdne políčko motykou.`);
      t.s = { k: D.TILLABLE[t.g], w: room.weather === 'rain' ? 1 : 0, r: 0, p: null, o: pl.key };
      tileMsg(room, i); sendMe(pl); fx(room, 'dirt', x + 0.5, y + 0.5); return;
    }
    if (t.s && !t.s.p && (!t.s.o || t.s.o === pl.key)) { // zarovnať prázdne políčko – uvoľní miesto v povolení
      t.s = null; tileMsg(room, i); sendMe(pl); return;
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
  if (item.startsWith('po_')) return usePotion(pl, item.slice(3), x, y);
}

function usePotion(pl, k, x, y) {
  const room = pl.room, sv = pl.save;
  if (k === 'laska') return toast(pl, 'Tento elixír treba darovať niekomu milému – postav sa k inému hráčovi. 💕');
  take(pl, 'po_' + k, 1);
  if (k === 'rast') {
    eachAround(room, x, y, 1, (i, t) => {
      if (t.s && t.s.p && !t.s.p.d) { const sp = D.SPECIES[t.s.p.sp]; t.s.p.prog = Math.min(sp.days, t.s.p.prog + 1); t.s.w = 1; tileMsg(room, i); }
    });
    fx(room, 'sparkle', x + 0.5, y + 0.5, { c: '#7ed957' });
  } else if (k === 'dazd') {
    room.weather = 'rain';
    for (let i = 0; i < room.tiles.length; i++) if (room.tiles[i].s) room.tiles[i].s.w = 1;
    broadcast(room, { t: 'tiles', tiles: room.tiles });
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
    E.cancel(room, e => e.type === 'vilyEnd' && e.data.key === pl.key);
    E.schedule(room, sv.vily, 'vilyEnd', { key: pl.key });
    toast(pl, 'Svet sa zatrblietal… Teraz vidíš víly. Možno by si v noci mal(a) zájsť do lesa ku kruhu z húb. 🧚', 'magic');
  } else if (k === 'duha') {
    for (const o of room.players.values()) o.save.coins += 300;
    for (let i = 0; i < room.tiles.length; i++) { const t = room.tiles[i]; if (t.s && t.s.p && !t.s.p.d) t.s.p.q = 3; }
    broadcast(room, { t: 'tiles', tiles: room.tiles });
    broadcast(room, { t: 'fx', k: 'rainbow' });
    toastAll(room, `🌈 ${pl.name} uvaril(a) Dúhový elixír! Nad záhradou sa klenie dúha. Všetci dostávajú 300 🪙 a kvety najvyššiu kvalitu!`, 'magic');
    for (const o of room.players.values()) sendMe(o);
  } else if (k === 'sliz') {
    toast(pl, 'Vypil(a) si čudný sliz. Chvíľu si videl(a) farby, ktoré neexistujú. 🫠');
    fx(room, 'burp', pl.x, pl.y);
  }
  sendMe(pl);
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
    broadcast(room, { t: 'tiles', tiles: room.tiles });
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

wss.on('connection', ws => {
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
      for (const o of room.players.values()) if (o.key === key) { o.ws.close(); room.players.delete(o.id); }
      if (room.players.size >= MAX_PLAYERS) { send(ws, { t: 'error', text: 'Záhrada je plná (max ' + MAX_PLAYERS + ' hráči).' }); return ws.close(); }
      if (!room.saves[key]) room.saves[key] = newSave(room);
      const sv = room.saves[key];
      migrateSave(sv, room);
      const look = m.look && typeof m.look === 'object' ? { shirt: String(m.look.shirt || '#4a90d9').slice(0, 9), hair: String(m.look.hair || '#5b3a1a').slice(0, 9), hat: !!m.look.hat } : sv.look;
      sv.look = look;
      pl = { id: nextId++, key, name, ws, room, save: sv, x: sv.x || D.SPAWN.x, y: sv.y || D.SPAWN.y, dir: 0, emote: null, emoteAt: 0, look };
      room.players.set(pl.id, pl);
      send(ws, {
        t: 'welcome', id: pl.id, room: roomId, W: D.W, H: D.H, tiles: room.tiles, x: pl.x, y: pl.y
      });
      send(ws, timeMsg(room));
      send(ws, Econ.marketView(room));
      send(ws, Econ.boardView(room));
      sendMe(pl);
      broadcast(room, roomInfo(room));
      broadcast(room, sleepMsg(room));
      toastAll(room, `${name} prišiel(a) do záhrady 🌼`);
      if (sv.lastTick != null && room.tick - sv.lastTick >= TPD) {
        const days = Math.floor((room.tick - sv.lastTick) / TPD);
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
        if (typeof m.x === 'number' && typeof m.y === 'number' && isFinite(m.x) && isFinite(m.y)) {
          pl.x = Math.max(0.2, Math.min(D.W - 0.2, m.x));
          pl.y = Math.max(0.2, Math.min(D.H - 0.2, m.y));
          pl.dir = m.dir | 0;
          if (typeof m.a === 'number' && isFinite(m.a)) pl.a = +m.a.toFixed(3); // presný smer pohľadu (3D: 8 smerov)
          pl.cr = !!m.cr; // plazí sa
          sv.x = pl.x; sv.y = pl.y;
        }
        break;
      case 'act': if (!pl.sleep) act(pl, m); break;
      case 'jump': if (!pl.sleep) pl.jn = ((pl.jn | 0) + 1) % 1000; break; // skok je len pre parádu – ostatní ho uvidia podľa zmeny počítadla
      case 'sleep': {
        if (m.on) {
          if (pl.sleep || room.ff) return;
          if (!D.canSleep(room.min)) return toast(pl, 'Ešte je skoro. Spať sa dá od 18:00. 🌇');
          if (!nearHouse(pl)) return toast(pl, 'Posteľ je v domčeku – podíď bližšie. 🏠');
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
          broadcast(room, { t: 'tiles', tiles: room.tiles });
          broadcast(room, roomInfo(room));
          broadcast(room, { t: 'fx', k: 'rainbow' });
          toastAll(room, `✨ ${pl.name} si prial(a) večnú jar! Záhrada sa odteraz polieva sama a kvetom nevadí ročné obdobie.`, 'magic');
        } else {
          give(pl, 'seed_duhova', 3); give(pl, 'seed_plesnivec', 3); give(pl, 'seed_papradie', 1);
          toastAll(room, `✨ ${pl.name} si prial(a) poklad! Zo zeme vyrástla truhlica plná vzácnych semienok.`, 'magic');
          fx(room, 'sparkle', pl.x, pl.y, { c: '#ffd700' });
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
        if (id === 'hoe' || id === 'can') return;
        if (Math.hypot(pl.x - 3.5, pl.y - 28.5) > 3.5) return toast(pl, 'Sklad je v domčeku – podíď bližšie.');
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
      case 'chat': {
        const text = String(m.text || '').replace(/[<>]/g, '').trim().slice(0, 120);
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
      toastAll(room, `${pl.name} odišiel(a) zo záhrady.`);
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
    const n = E.advance(room, now, HANDLERS, 50000);
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
      id: p.id, name: p.name, x: +p.x.toFixed(3), y: +p.y.toFixed(3), dir: p.dir, a: p.a, look: p.look, cr: p.cr ? 1 : 0, j: p.jn | 0,
      e: p.sleep ? 'sleep' : p.emote && now - p.emoteAt < 6000 ? p.emote : null
    }));
    broadcast(room, { t: 'pl', list });
  }
}, 100);
setInterval(() => { for (const room of rooms.values()) saveRoom(room); }, 15000);

function shutdown() {
  for (const room of rooms.values()) { for (const p of room.players.values()) p.save.lastTick = room.tick; saveRoom(room, true); }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`🌼 Čarovná záhrada beží na http://localhost:${PORT}  (nový svet: deň = ${DAY_SECONDS}s, režim ${DEFAULT_MODE}, ${TPD} krokov/deň)`);
});
