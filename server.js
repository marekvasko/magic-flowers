// Čarovná záhrada – herný server (HTTP + WebSocket)
const http = require('http');
const fs = require('fs');
const path = require('path');
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
const Events = require('./events.js');
const Actions = require('./actions.js');
const Spiders = require('./spiders.js');

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
const SAVE_VERSION = 10; // 3: hory, ľad a ľadovňa; 4: Les na pomedzí; 5: kľúče udalostí (unikátne a periodické); 6: spoločné povolenie na pole; 7: Les divov; 8: semienko sveta a počítadlo kôl namiesto rng; 9: 11 520 krokov za deň (×40); 10: pavúky a pavučiny
const OLD_TPD = 288, OLD_MPT = 5, TICK_SCALE = D.TICKS_PER_DAY / OLD_TPD; // mriežka času do verzie 8
const TPD = D.TICKS_PER_DAY, MPT = D.MIN_PER_TICK;
const DEFAULT_MODE = process.env.DEFAULT_MODE === 'paused' ? 'paused' : 'running';
const MAX_CATCHUP_DAYS = +process.env.MAX_CATCHUP_DAYS || 30; // koľko herných dní najviac dobehneme po výpadku servera
const JOURNAL_MAX = (+process.env.JOURNAL_MAX_MB || 20) * 1024 * 1024; // denník dávok: po prekročení sa otočí (jeden starší súbor sa drží)
// ladiaca stránka, záložka Engine (#106): koľko posledných dávok (a rámcov filtra) drží každý svet v pamäti; 0 = nič
const TRACE_MAX = process.env.DEBUG_TRACE == null || process.env.DEBUG_TRACE === '' ? 600 : Math.max(0, process.env.DEBUG_TRACE | 0);
const clock = () => performance.now(); // čas častí dávky pre ladiacu stránku (nie herný čas)
const rooms = new Map();

function roomFile(id) { return path.join(DATA_DIR, 'room-' + id + '.json'); }
function journalFile(id) { return path.join(DATA_DIR, 'journal-' + id + '.jsonl'); }

function newWorldState() {
  return {
    v: SAVE_VERSION, tick: D.DAWN_TICK + 6, wall: Date.now(), mode: DEFAULT_MODE, daySeconds: DAY_SECONDS,
    seed: E.newSeed(), step: 0, seq: 0, events: [],
    weather: 'sun', saves: {}, storage: {}, storageFb: {}, market: null, contracts: null, fairyNight: -1, eternal: false, scav: {}, scavSalt: Areas.newSeed(),
    icehouse: { built: false, ice: 0 }, hory: null, pomedzieSeed: Areas.newSeed(), up: { plots: 0 }, lesSeed: Areas.newSeed(), les: null,
    glacierFed: -1, // deň, v ktorom ľadovec naposledy dorástol zo zrážok (najviac raz za deň)
    plotsUsed: 0, maxRep: 0 // odvodené počítadlá (pozri economy.js); pri načítaní sa prepočítajú
  };
}

// Prevod uloženia zo starších formátov, po krokoch podľa verzie.
function migrate(saved) {
  const out = Object.assign(newWorldState(), saved);
  const from = saved.v || 1;
  if (from === SAVE_VERSION) return out;
  if (from < 2) { // spojitý čas day/min → diskrétne kroky (v mriežke verzie 2–8, krok 9 ich potom preškáluje)
    const day = saved.day || 1, min = saved.min || 390;
    out.tick = (day - 1) * OLD_TPD + Math.min(OLD_TPD - 1, Math.round(min / OLD_MPT));
    out.mode = 'paused'; // staré svety sa správali ako pozastavené – zachováme to, prepnúť sa dá v menu
    out.wall = Date.now();
    for (const sv of Object.values(out.saves || {})) if (sv.vily) sv.vily = Math.max(0, Math.round((sv.vily - 1440) / OLD_MPT));
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
  if (from < 6) { // spoločné povolenie na pole: záhrada dostane najvyššiu úroveň, akú mal niektorý hráč
    let lvl = 0;
    for (const sv of Object.values(out.saves || {})) {
      lvl = Math.max(lvl, sv.up ? sv.up.plots || 0 : 2); // hráči zo starších verzií bez vylepšení dostávali úroveň 2
      if (sv.up) delete sv.up.plots;
    }
    out.up = { plots: Math.min(lvl, D.UPGRADES.plots.levels.length - 1) };
  }
  if (from < 7) { // Les divov: nová plocha severne od Lesa na pomedzí, rozloženie zo semienka sveta (pri prvom načítaní sa uloží)
    out.lesSeed = Areas.newSeed(); out.les = null;
  }
  if (from < 8) { // návrhy nad zmrazeným svetom: náhodu odvodzuje engine zo semienka sveta a čísla kola, spoločný rng zaniká
    out.seed = E.newSeed(); out.step = 0; delete out.rng;
    if (out.scavSalt == null) out.scavSalt = Areas.newSeed(); // doteraz sa odvodzoval lenivo zo spoločného rng
  }
  if (from < 9) scaleTicks(out, TICK_SCALE); // jemnejší čas: každý uložený krok ×40 (deň a hodina ostávajú tie isté)
  if (from < 10) { out.webs = null; out.corners = null; } // pavúky (#57): pavučiny sa utkajú pri prvom načítaní, v každej ploche jeden kút
  out.v = SAVE_VERSION; out.migratedFrom = saved.migratedFrom || from;
  return out;
}
// Preškálovanie všetkých uložených krokov (čas sveta, udalosti, uloženia hráčov, várky, rastliny, zákazky, sviatok, správy).
// Prehľadané políčka trávy (scav) sa zahodia – okná hodín sa číslujú inak.
function scaleTicks(out, k) {
  const sc = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * k) : v);
  out.tick = sc(out.tick);
  for (const e of out.events || []) e.at = sc(e.at);
  const batches = fb => { for (const id in fb || {}) for (const b of fb[id]) { b.a = sc(b.a); b.at = sc(b.at); } };
  for (const sv of Object.values(out.saves || {})) {
    if (sv.vily) sv.vily = sc(sv.vily);
    if (sv.lastTick != null) sv.lastTick = sc(sv.lastTick);
    batches(sv.fb);
  }
  batches(out.storageFb);
  for (const t of out.tiles || []) { const p = t && t.s && t.s.p; if (p && p.bt != null) p.bt = sc(p.bt); }
  for (const c of (out.contracts && out.contracts.list) || []) { c.posted = sc(c.posted); c.openUntil = sc(c.openUntil); c.due = sc(c.due); }
  const m = out.market;
  if (m) {
    if (m.festival && m.festival.until != null) m.festival.until = sc(m.festival.until);
    for (const n of m.news || []) n.tick = sc(n.tick);
  }
  out.scav = {};
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
  if (!Number.isInteger(room.lesSeed)) room.lesSeed = Areas.newSeed();
  room.les = Areas.loadLes(st.les, room.lesSeed);
  room.icehouse = room.icehouse || { built: false, ice: 0 };
  Ice.applyIcehouse(room.icehouse, room.tiles);
  room.up = room.up || { plots: 0 };
  Object.defineProperty(room, 'day', { get() { return D.dayOfTick(this.tick); } });
  Object.defineProperty(room, 'min', { get() { return D.minOfTick(this.tick); } });
  room.daySeconds = DAY_SECONDS;
  room.storage = room.storage || {}; room.storageFb = room.storageFb || {};
  I.syncAll(I.storageC(storageOf(room), room.icehouse), room.tick);
  for (const sv of Object.values(room.saves)) if (sv.inv) I.syncAll(I.playerC(sv), room.tick);
  // odvodené počítadlá sa pri načítaní vždy prepočítajú (staré uloženia ich nemajú; chyba by sa sama opravila)
  room.plotsUsed = Econ.plotsUsedOf(room.tiles);
  room.maxRep = Econ.maxRepOf(room.saves);
  const live = E.liveCtx(room, 'ekonomika'); // jediná akcia nad živým svetom: založenie trhu, nástenky a pavučín
  Econ.initEconomy(room, live);
  Econ.syncFestival(room.market); // sviatočné násobky v položkách kvetov (staršie uloženia ich nemajú)
  Spiders.load(room, live); // pavučiny a kúty (nový svet ich utká); pavúky sú doma a spia
  room.inbox = []; room.inSeq = 0; // schránka správ hráčov; rámec (frame) ich spracuje raz za 100 ms
  room.trace = TRACE_MAX ? Debug.traceRing(TRACE_MAX) : null; // posledné dávky pre ladiacu stránku (neukladá sa), aj z dobiehania
  E.reconcile(room, SIM); // doplní chýbajúce periodické udalosti, zahodí udalosti obsahu, ktorý už v hre nie je
  // značka načítania v denníku: odkiaľ (krok, kolo) beh pokračuje – po páde servera sa dobehnuté kroky zapíšu znova
  appendJournal(room, { load: true, tick: room.tick, step: room.step, seq: room.seq, migratedFrom: room.migratedFrom || null });
  if (room.mode === 'running') {
    // Svet beží aj bez hráčov – dobehneme čas, kým bol server vypnutý (najviac MAX_CATCHUP_DAYS dní).
    const cap = MAX_CATCHUP_DAYS * TPD * E.tickMs(room);
    room.wall = Math.max(room.wall, Date.now() - cap);
    const n = traced(room, 'catchup', () => E.advance(room, Date.now(), SIM));
    if (n) console.log(`[${id}] dobehnutých ${n} krokov (${(n / TPD).toFixed(1)} dňa)`);
  } else room.wall = Date.now();
  rooms.set(id, room);
  return room;
}

function serialize(room) {
  return JSON.stringify({
    v: SAVE_VERSION, tick: room.tick, wall: room.wall, mode: room.mode, daySeconds: room.daySeconds,
    seed: room.seed, step: room.step, seq: room.seq, events: room.events,
    weather: room.weather, saves: room.saves, storage: room.storage, storageFb: room.storageFb, market: room.market, contracts: room.contracts,
    fairyNight: room.fairyNight, eternal: room.eternal, migratedFrom: room.migratedFrom, scav: room.scav, scavSalt: room.scavSalt, icehouse: room.icehouse, pomedzieSeed: room.pomedzieSeed, up: room.up, lesSeed: room.lesSeed,
    glacierFed: room.glacierFed, plotsUsed: room.plotsUsed, maxRep: room.maxRep, ...Spiders.save(room),
    tiles: room.tiles.map(t => t.cut ? { s: t.s, cut: 1 } : { s: t.s }), hory: Ice.saveHory(room.hory), les: Areas.saveLes(room)
  });
}
// Sklad ako výrez { inv, fb } pre items.js (vo svete sú to dve vlastnosti: storage a storageFb)
function storageOf(room) { room.storageFb = room.storageFb || {}; return { inv: room.storage, fb: room.storageFb }; }

// ---------- Denník dávok ----------
// Každá vykonaná dávka (krok s udalosťami, alebo akcie hráčov jedného rámca) sa zapíše ako jeden riadok JSON do
// data/journal-<svet>.jsonl: vstupy, kľúče a osud každého návrhu, zmeny podľa kľúča, správy. Prehrá ho E.replay,
// ukazuje ladiaca stránka (#106). Po prekročení JOURNAL_MAX sa súbor otočí na .1 (starší sa zahodí). JOURNAL=0 vypne.
const journals = new Map(); // id → { fd, size }
function openJournal(id) {
  const fd = fs.openSync(journalFile(id), 'a');
  return { fd, size: fs.fstatSync(fd).size };
}
// Zápis je synchrónny (pár mikrosekúnd na riadok): riadky sú v poradí a nestratia sa ani pri okamžitom ukončení servera.
function appendJournal(room, entry) {
  if (process.env.JOURNAL === '0') return;
  const line = JSON.stringify(Object.assign({ wall: Date.now() }, entry)) + '\n';
  try {
    let j = journals.get(room.id);
    if (!j) { fs.mkdirSync(DATA_DIR, { recursive: true }); j = openJournal(room.id); journals.set(room.id, j); }
    if (j.size + Buffer.byteLength(line) > JOURNAL_MAX) {
      journals.delete(room.id); // keby premenovanie zlyhalo, ďalší zápis denník otvorí znova namiesto písania do zavretého popisovača
      fs.closeSync(j.fd);
      fs.renameSync(journalFile(room.id), journalFile(room.id) + '.1');
      j = openJournal(room.id); journals.set(room.id, j);
    }
    j.size += fs.writeSync(j.fd, line);
  } catch (err) { console.error('journal', err); journals.delete(room.id); }
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

// ---------- Komunikácia ----------
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { const s = JSON.stringify(msg); for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s); }
function toast(pl, text, kind) { send(pl.ws, { t: 'toast', text, kind: kind || 'info' }); }
function toastAll(room, text, kind) { broadcast(room, { t: 'toast', text, kind: kind || 'info' }); }
// Hráči sú vždy na jednej ploche (záhrada / hory / Les na pomedzí / Les divov) – políčka a efekty dostanú len tí, ktorí sú na nej.
function broadcastArea(room, area, msg) { const s = JSON.stringify(msg); for (const p of room.players.values()) if (p.area === area && p.ws.readyState === 1) p.ws.send(s); }
function fx(room, k, x, y, extra, area) { broadcastArea(room, area || 'garden', Object.assign({ t: 'fx', k, x, y }, extra || {})); }
// Políčka záhrady posielame cez Scav.tileView – druh divej rastliny ostane skrytý, kým nevyklíči (hory rastliny nemajú).
function tileView(area, t) { return area === 'garden' ? Scav.tileView(t) : t; }
function tilesView(room, area) { area = area || 'garden'; return Areas.areaTiles(room, area).map(t => tileView(area, t)); }
function tilesMsg(room, area) { area = area || 'garden'; broadcastArea(room, area, { t: 'tiles', tiles: tilesView(room, area) }); }
function tileMsg(room, i, area) { area = area || 'garden'; room.dirty = true; broadcastArea(room, area, { t: 'tile', i, v: tileView(area, Areas.areaTiles(room, area)[i]) }); }
// Spoločné povolenie na pole: koľko políčok je v záhrade obrobených a koľko ich povolenie dovoľuje
function plotsMsg(room) { return { t: 'plots', used: room.plotsUsed, limit: Econ.plotLimit(room.up) }; }
// Úrovne vylepšení pre klienta: vlastné hráča a spoločné záhrady
function upView(room, sv) { return Object.assign({}, sv.up, room.up); }
function sendMe(pl) {
  const room = pl.room, sv = pl.save;
  send(pl.ws, {
    t: 'me', coins: sv.coins, water: sv.water, inv: sv.inv, recipes: sv.recipes, seen: sv.seen, vily: sv.vily > room.tick,
    rep: sv.rep, up: upView(room, sv), canCap: Econ.canCap(sv), plotLimit: Econ.plotLimit(room.up), plotsUsed: room.plotsUsed, maxActive: Econ.maxActive(sv),
    fb: I.batchesView(I.playerC(sv), room.tick), tick: room.tick
  });
  room.dirty = true;
}
function roomInfo(room) {
  return {
    t: 'room', eternal: room.eternal, mode: room.mode, daySeconds: room.daySeconds, storage: room.storage, storageFb: I.batchesView(I.storageC(storageOf(room), room.icehouse), room.tick),
    storageRate: I.storageRate(room.icehouse), icehouse: room.icehouse, tick: room.tick, names: [...room.players.values()].map(p => p.name)
  };
}
// Snímka toho, čo nie je stav sveta, ale návrhy to potrebujú: kto je pripojený, kde stojí, či hľadá v tráve (a odkiaľ), emócia (tanec),
// lampáš v ruke, rýchlosť pohybu a ťahanie hodvábu (pavúky, spiders.js)
function presenceOf(room) {
  return [...room.players.values()].map(p => ({ key: p.key, name: p.name, area: p.area, x: p.x, y: p.y, scav: p.scav ? { i: p.scav.i, n: p.scav.n, px: p.scav.px, py: p.scav.py } : null, emote: p.emote, emoteAt: p.emoteAt,
    lp: !!p.lp, ...velocity(p), pull: p.pull ? { id: p.pull.id, n: p.pull.n, px: p.pull.px, py: p.pull.py } : null })); // lampáš, rýchlosť (kam pavúk beží) a ťahanie hodvábu – pre pavúky
}

// Pavučina na hráčovi (pavúk ho zabalil): 1 hneď po zabalení, postupne do 0 (zoderie sa)
function webLeft(p, now) {
  if (!p.web) return 0;
  const k = 1 - (now - p.web.at) / p.web.ms;
  if (k <= 0) { p.web = null; return 0; }
  return Math.round(k * 100) / 100;
}
// Rýchlosť hráča z posledných pohybov (políčka/s); kto 250 ms neposlal pohyb, stojí. Zaokrúhlená (ide do každého záznamu denníka).
function velocity(p) {
  if (!p.movedAt || Date.now() - p.movedAt > 250) return { vx: 0, vy: 0 };
  return { vx: Math.round((p.vx || 0) * 100) / 100, vy: Math.round((p.vy || 0) * 100) / 100 };
}
function playerByKey(room, key) { for (const p of room.players.values()) if (p.key === key) return p; return null; }

const SIM = {
  proposers: Object.assign({}, Events.PROPOSERS, Actions.PROPOSERS, Spiders.PROPOSERS), periodic: Events.PERIODIC.concat(Spiders.PERIODIC), presence: presenceOf, clock,
  slice: (world, key) => { const s = Spiders.slice(world, key); return s === undefined ? E.sliceOf(world, key) : s; }, // pavúky: spider:<id>, kz:<plocha>
  // denník najprv (nech záznam nechýba), potom správy hráčom; chyba pri posielaní nesmie zhodiť simuláciu ani server;
  // nakoniec záznam pre ladiacu stránku (kto dávku spustil, rozhodnutia filtra, časy častí)
  onBatch(room, out) {
    const t0 = clock();
    appendJournal(room, out.entry);
    const t1 = clock();
    try { notify(room, out); } catch (err) { console.error(`[${room.id}] notify`, err); }
    if (!room.trace) return;
    const f = room.traceFrame;
    room.traceFrame = null;
    const timing = Object.assign(f ? { filter: f.ms } : {}, out.timing, { journal: t1 - t0, notify: clock() - t1 });
    Debug.traceBatch(room.trace, out, { source: f ? 'frame' : room.traceSource || 'live', filter: f && f.filter, timing });
  }
};
// Kto posúva čas (pre ladiacu stránku): live (bežiaci čas), catchup (dobiehanie po načítaní), ff (pretočenie noci)
function traced(room, source, fn) {
  const prev = room.traceSource;
  room.traceSource = source;
  try { return fn(); } finally { room.traceSource = prev; }
}

// Po vykonaní dávky: odmietnutia akcií ako správa ich hráčovi, správy z návrhov (adresát to: E.ALL všetkým,
// E.area(plocha) hráčom na ploche, inak kľúč hráča) a obnova toho, čo sa podľa zapísaných kľúčov zmenilo –
// políčka (zmena typu zeme, napr. stavba, pošle celú plochu – klient vtedy prestavia 3D svet), batohy (me), trh,
// nástenka, sklad a ľadovňa (room), povolenie na pole (plots), počasie (time).
// Správy scavStart / scavDone / travel / joined sú pokyny pre prítomnosť (hráč začal / prestal hľadať, prešiel do inej
// plochy, pripojil sa), nie správy klientovi. Odmietnutý pohyb vráti prítomnosť na potvrdené miesto a pošle hráčovi opravu.
function notify(room, out) {
  if (!room.players.size) { if (out.applied.length) room.dirty = true; return; }
  for (const r of out.rejected) {
    const pl = r.input.actor != null ? playerByKey(room, r.input.actor) : null;
    if (!pl) continue;
    if (r.reject) toast(pl, r.reject);
    if (r.input.type === 'pos') { pl.x = pl.save.x; pl.y = pl.save.y; send(pl.ws, { t: 'pos', x: pl.x, y: pl.y }); }
  }
  for (const p of out.entry.proposals) { // pripojenie, ktoré zlyhalo chybou: klient by čakal na svet donekonečna
    if (p.outcome !== 'error' || p.type !== 'join') continue;
    const inp = out.entry.inputs.find(i => i.id === p.id), pl = inp && playerByKey(room, inp.actor);
    if (pl) { send(pl.ws, { t: 'error', text: 'Pripojenie zlyhalo. Skús to znova.' }); pl.ws.close(); }
  }
  if (!out.applied.length) return;
  room.dirty = true;
  const tiles = {}, me = new Set(), whole = new Set();
  for (const a of D.AREAS) tiles[a] = new Set();
  let info = false, time = false, plots = false, everyone = false, webs = false, corners = false;
  for (const p of out.entry.proposals) {
    if (p.outcome !== 'applied') continue;
    for (const key in p.changes) {
      const [a, b, c] = key.split(':'), paths = p.changes[key];
      if (a === 'tile') {
        for (const ch of paths) { if (c === '*') tiles[b].add(+ch.p[0]); if (ch.p[c === '*' ? 1 : 0] === 'g') whole.add(b); }
        if (c !== '*') tiles[b].add(+c);
      }
      else if (a === 'save') { if (b === '*') for (const ch of paths) me.add(ch.p[0]); else me.add(key.slice(5)); }
      else if (a === 'market') room.marketDirty = true;
      else if (key === 'contracts') room.boardDirty = true;
      else if (key === 'storage' || key === 'icehouse' || key === 'eternal') info = true;
      else if (key === 'weather') { time = true; info = true; } // nový deň: aj sklad (vek várok) a čas v room
      else if (key === 'plotsUsed') plots = true;
      else if (key === 'webs') webs = true;
      else if (key === 'corners') corners = true;
      else if (key === 'up') { plots = true; everyone = true; } // spoločné vylepšenie: každému nové limity v me
    }
  }
  for (const area in tiles) {
    if (tiles[area].size > 20 || whole.has(area)) tilesMsg(room, area);
    else for (const i of tiles[area]) tileMsg(room, i, area);
  }
  for (const msg of out.outbox) {
    const to = msg.to, body = Object.assign({}, msg); delete body.to;
    if (to && to.all) { broadcast(room, body); continue; }
    if (to && to.area) { broadcastArea(room, to.area, body); continue; }
    const pl = typeof to === 'string' ? playerByKey(room, to) : null;
    if (!pl) continue;
    if (body.t === 'me') me.add(to);
    else if (body.t === 'scavDone') pl.scav = null;
    else if (body.t === 'scavStart') pl.scav = { i: body.i, n: body.n, px: pl.x, py: pl.y, seeds: body.seeds };
    else if (body.t === 'pullStart') pl.pull = { id: body.id, n: body.n, px: pl.x, py: pl.y };
    else if (body.t === 'pullDone') pl.pull = null;
    else if (body.t === 'webbed') { pl.web = { at: Date.now(), ms: body.ms }; pl.pull = null; send(pl.ws, body); } // zabalený do pavučiny – vidia to aj ostatní (pl)
    else if (body.t === 'travel') arrived(pl, body.from, body.area);
    else if (body.t === 'joined') { joined(pl); me.add(to); }
    else send(pl.ws, body);
  }
  if (everyone) for (const p of room.players.values()) sendMe(p);
  else for (const key of me) { const pl = playerByKey(room, key); if (pl) sendMe(pl); }
  if (plots) broadcast(room, plotsMsg(room));
  if (webs) broadcastArea(room, 'les', Spiders.websView(room));
  if (corners) for (const a of D.CORNER_AREAS) broadcastArea(room, a, Spiders.cornerView(room, a));
  if (info) broadcast(room, roomInfo(room));
  if (time) broadcast(room, timeMsg(room));
}
// Zmeny trhu a nástenky posielame hráčom dávkovo (najviac raz za 100 ms).
function flushEconomy(room) {
  if (!room.players.size) return;
  if (room.marketDirty) { room.marketDirty = false; broadcast(room, Econ.marketView(room.market, room.tick, room.events)); }
  if (room.boardDirty) { room.boardDirty = false; broadcast(room, Econ.boardView(room.contracts)); }
}

// ---------- Spánok ----------
// Keď spia všetci pripojení hráči, svet pretočí noc zrýchlene (FF_STEPS krokov za 100 ms) až do 6:00.
const FF_STEPS = 5 * TICK_SCALE; // noc (12 h) prebehne za ~3 s
const TIME_MS = 1000; // čas sa klientom posiela najviac raz za sekundu (krokov je ~10 za sekundu); klient si ho medzitým dopočíta
const nearHouse = Actions.nearHouse;
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
  traced(room, 'ff', () => E.advanceTo(room, Math.min(room.ff.until, room.tick + FF_STEPS), SIM));
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

// ---------- Akcie hráčov ----------
// Správy hráčov nič nemenia hneď: handler socketu ich len overí a vloží do schránky miestnosti (room.inbox, poradie seq,
// krok príchodu tick). Rámec (frame, raz za 100 ms) ich vyhodnotí v rozhodovacom kole: pohyb sa zlúči (platí posledný),
// hneď sa premietne do prítomnosti a ako vstup pos ho engine overí a zapíše do stavu (poloha je stav sveta),
// správy len o prítomnosti (spánok, skok, nastavenia, chat) sa vybavia priamo a všetko ostatné (akcie, pripojenie,
// odchod, tanec) sa stane vstupom enginu a jednou dávkou v aktuálnom kroku (actions.js).
// Z jedného hráča prejde v rámci najviac jedna akcia na políčku (act); ďalšie počkajú na ďalší rámec.
// Udalosti a akcie nie sú nikdy v jednej dávke: dávka akcií sa vykoná v kroku, v ktorom správy prišli (svet sa medzi
// rámcami nehýbe, takže to je práve aktuálny krok), až potom rámec posunie čas.
const INBOX_MAX = 2000, PLAYER_INBOX_MAX = 100, DEFER_MAX = 3; // ochrana pred zaplavením: čo sa nezmestí (na svet, na hráča, odložené akcie), sa zahodí
const MESSAGES = new Set(['move', 'act', 'jump', 'sleep', 'emote', 'buy', 'sell', 'upgrade', 'ctake', 'cdeliver', 'brew', 'wish', 'settings', 'store', 'unstore', 'compostWilted', 'buyTool', 'build', 'icehouse', 'chat']);
// Správa servera samému sebe do schránky (odchod, „naposledy videný“) – nie od klienta
function enqueue(room, pl, m) { room.inbox.push({ pl, m, seq: ++room.inSeq, tick: room.tick, internal: true }); }

// Vstup enginu z akcie hráča: id podľa poradia v schránke, actor = kľúč hráča (aj v data, lebo kľúče návrhu ho potrebujú)
function actionInput(room, pl, seq, type, data) {
  return { type, data: Object.assign({ key: pl.key }, data), id: 'a#' + seq, actor: pl.key };
}

// Hľadanie divých semienok: prítomnosť (pl.scav) nastaví server podľa správy scavStart z návrhu; koniec je udalosť scavDone.
// Prestať hľadať (pohyb, iná akcia, spánok, prechod) zruší udalosť – cez vstup scavStop v tom istom rámci.
function stopScavenge(pl, msg, inputs) {
  pl.scav = null;
  inputs.push(actionInput(pl.room, pl, ++pl.room.inSeq, 'scavStop', {}));
  if (msg) toast(pl, msg);
}

// Prechod do inej plochy (pokyn travel z návrhu pos): poloha je už v uložení; hráč dostane políčka novej plochy
// (aj jej veľkosť) a príchodové miesto. seq rozlíši staré správy o pohybe, ktoré klient poslal ešte z predchádzajúcej plochy.
function areaMsg(pl) {
  const { w, h } = D.areaSize(pl.area);
  return { t: 'area', area: pl.area, seq: pl.areaSeq, w, h, tiles: tilesView(pl.room, pl.area), x: pl.x, y: pl.y };
}
function arrived(pl, from, to) {
  pl.area = to; pl.x = pl.save.x; pl.y = pl.save.y;
  pl.areaSeq++;
  pl.emote = null; pl.scav = null;
  send(pl.ws, areaMsg(pl));
  for (const v of Spiders.areaViews(pl.room, to)) send(pl.ws, v);
  toast(pl, to === 'hory'
    ? '🏔️ Vystúpil(a) si do hôr. Na ľadovci pod skalami vysekáš krompáčom ľad. Chodníkom dole sa vrátiš do záhrady.'
    : to === 'les'
      ? (pl.save.inv.lamp
        ? '🌲 Vstúpil(a) si do Lesa divov. Je tu tma aj cez deň – vezmi do ruky lampáš. 🏮 Na juhu sa vrátiš do Lesa na pomedzí.'
        : '🌲 Vstúpil(a) si do Lesa divov. Je tu taká tma, že vidíš len pár krokov… Lampáš kúpiš na trhu. Na juhu sa vrátiš do Lesa na pomedzí.')
      : to === 'pomedzie'
        ? (from === 'les' ? '🌳 Vrátil(a) si sa z Lesa divov do Lesa na pomedzí. Konečne svetlo!'
          : '🌳 Prišiel(a) si do Lesa na pomedzí. Na juhu je lúka, na sever les hustne a stmieva sa… Na západe sa vrátiš do záhrady, na severe vedie chodník do Lesa divov.')
        : from === 'pomedzie' ? '🏡 Vrátil(a) si sa z lesa do záhrady.' : '🏡 Vrátil(a) si sa do záhrady.', 'day');
}
// Pripojenie vykonané (pokyn joined z návrhu join): hráč dostane svet, čas, trh, nástenku, batoh a stav záhrady
function joined(pl) {
  const room = pl.room;
  pl.joining = false;
  pl.look = pl.save.look; // vzhľad ako v uložení (návrh join ho doplnil o predvolené farby)
  send(pl.ws, { t: 'welcome', id: pl.id, room: room.id, w: D.areaSize(pl.area).w, h: D.areaSize(pl.area).h, tiles: tilesView(room, pl.area), area: pl.area, seq: pl.areaSeq, x: pl.x, y: pl.y });
  for (const v of Spiders.areaViews(room, pl.area)) send(pl.ws, v);
  send(pl.ws, timeMsg(room));
  send(pl.ws, Econ.marketView(room.market, room.tick, room.events));
  send(pl.ws, Econ.boardView(room.contracts));
  broadcast(room, roomInfo(room));
  broadcast(room, sleepMsg(room));
}

// Pohyb: smer, plazenie a lampáš sú len prítomnosť (ozdoba); poloha sa premietne do prítomnosti hneď (vysielanie polôh
// 10× za sekundu) a zároveň ide ako vstup pos do enginu, ktorý ju overí a zapíše do uloženia (poloha je stav sveta).
function moveInput(room, pl, e, inputs) {
  const m = e.m, sv = pl.save, no = why => { e.why = why; return null; }; // why: dôvod pre ladiacu stránku
  if (pl.sleep || pl.joining) return no(pl.sleep ? 'player is asleep' : 'player is still joining'); // spiaci hráč leží v posteli
  if ((m.ar | 0) !== pl.areaSeq) return no('sent from the previous area'); // pohyb ešte z predchádzajúcej plochy
  if (!(typeof m.x === 'number' && typeof m.y === 'number' && isFinite(m.x) && isFinite(m.y))) return no('invalid position');
  const pos = Areas.clampPos(pl.area, m.x, m.y); // z plochy sa vyjsť nedá – len cez prechod
  // rýchlosť (políčka/s) – kam hráč beží (pavúk mieri, kde hráč o krok bude); po prechode či skoku sa zahodí
  const now = Date.now(), dts = (now - (pl.movedAt || 0)) / 1000;
  if (dts > 0 && dts < 1 && Math.hypot(pos.x - pl.x, pos.y - pl.y) < 2) { pl.vx = (pos.x - pl.x) / dts; pl.vy = (pos.y - pl.y) / dts; } else { pl.vx = 0; pl.vy = 0; }
  pl.movedAt = now;
  pl.x = pos.x; pl.y = pos.y;
  pl.dir = m.dir | 0;
  if (typeof m.a === 'number' && isFinite(m.a)) pl.a = +m.a.toFixed(3); // presný smer pohľadu (3D: 8 smerov)
  pl.cr = !!m.cr; // plazí sa
  pl.lp = !!m.lp && !!sv.inv.lamp; // drží lampáš (svieti)
  if (pl.lp && pl.pull) { pl.pull = null; inputs.push(actionInput(room, pl, ++room.inSeq, 'pullStop', {})); toast(pl, 'Prestal(a) si ťahať hodváb.'); } // s lampášom sa hodváb neťahá
  return actionInput(room, pl, e.seq, 'pos', { x: pos.x, y: pos.y });
}

// Správa, ktorá mení herný stav → vstup enginu (alebo null). Prítomnosť presence je snímka po pohyboch tohto rámca.
function toInput(room, pl, e, presence, inputs) {
  const m = e.m, sv = pl.save, key = pl.key;
  const mk = (type, data) => actionInput(room, pl, e.seq, type, data);
  const no = why => { e.why = why; return null; }; // dôvod pre ladiacu stránku
  switch (m.t) {
    case 'seen': case 'leave': return e.internal ? mk(m.t, {}) : no('only the server sends this');
    case 'join': return e.internal ? mk('join', { name: m.name, look: m.look, start: START, quick: !!m.quick }) : no('only the server sends this');
    case 'act': {
      if (pl.sleep) return no('player is asleep');
      const me = presence.find(p => p.key === key);
      if (!me) return no('player not in presence');
      const r = Actions.resolveAct(room, presence, me, m);
      if (!r) return no('nothing to do on that tile');
      if (r.toast) { toast(pl, r.toast); return no('refused before the engine: ' + r.toast); }
      if (pl.scav) { // kým hľadá: to isté políčko znova = stále hľadá; čokoľvek iné (čo by sa naozaj stalo) hľadanie preruší
        if (r.type === 'scavStart' && pl.scav.i === r.data.i) { toast(pl, 'Ešte stále hľadáš… 🔍'); return no('refused before the engine: still searching this tile'); }
        stopScavenge(pl, 'Prestal(a) si hľadať.', inputs);
        me.scav = null;
      }
      return mk(r.type, r.data);
    }
    case 'buy': return mk('buy', { id: String(m.id), n: Math.max(1, Math.min(20, m.n | 0)) });
    case 'sell': return mk('sell', { id: String(m.id), n: Math.max(1, Math.min(999, m.n | 0)) });
    case 'upgrade': return mk('upgrade', { kind: String(m.kind) });
    case 'ctake': return mk('ctake', { id: m.id | 0 });
    case 'cdeliver': return mk('cdeliver', { id: m.id | 0 });
    case 'brew': {
      const items = Array.isArray(m.items) ? m.items.map(String).slice(0, 3) : [];
      return items.length === 3 && items.every(id => id.startsWith('fl_')) ? mk('brew', { items }) : null;
    }
    case 'wish': return sv.inv.fl_papradie ? mk('wish', { kind: ['zlato', 'jar', 'poklad'].includes(m.kind) ? m.kind : 'poklad' }) : no('no fern flower to wish with');
    case 'store': case 'unstore': return mk(m.t, { id: String(m.id), n: Math.max(1, Math.min(999, m.n | 0)) });
    case 'compostWilted': return mk('compostWilted', {});
    case 'buyTool': return mk('buyTool', { id: String(m.id) });
    case 'build': return m.id === 'icehouse' ? mk('build', {}) : null;
    case 'icehouse': return mk('fillIce', { n: m.n | 0 });
  }
  return no('invalid message');
}

// Správy o prítomnosti (nemenia herný stav; fáza 4): spánok, emócie, skok, nastavenia sveta, chat
function presenceMessage(room, pl, m, inputs) {
  switch (m.t) {
    case 'jump': if (!pl.sleep) pl.jn = ((pl.jn | 0) + 1) % 1000; break; // skok je len pre parádu – ostatní ho uvidia podľa zmeny počítadla
    case 'sleep': {
      if (m.on) {
        if (pl.sleep || room.ff) return;
        if (!D.canSleep(room.min)) return toast(pl, 'Ešte je skoro. Spať sa dá od 18:00. 🌇');
        if (!nearHouse(pl)) return toast(pl, 'Posteľ je v domčeku – podíď bližšie. 🏠');
        if (pl.scav) stopScavenge(pl, null, inputs);
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
    case 'emote': { // emócia je prítomnosť; tanec v kruhu z húb je navyše vstup enginu (víly) s časom správy
      const e = ['dance', 'wave', 'heart', 'laugh', 'flower'].includes(m.e) ? m.e : 'wave';
      pl.emote = e; pl.emoteAt = Date.now();
      if (e === 'dance' && Actions.inRing(pl)) inputs.push(actionInput(room, pl, ++room.inSeq, 'dance', { now: pl.emoteAt }));
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
    case 'chat': {
      const text = D.chatText(m.text); // limit D.CHAT_MAX platí aj pre upravených klientov
      if (text) broadcast(room, { t: 'chat', name: pl.name, text, id: pl.id });
      break;
    }
  }
}

// Rozhodovacie kolo rámca: schránka → pohyb (zlúčený), správy o prítomnosti, dávka akcií enginu v aktuálnom kroku.
// Správy hráčov, ktorí sa medzitým odpojili, sa zahodia. Druhá a ďalšia akcia na políčku od toho istého hráča počká
// na ďalší rámec (ostane v schránke na začiatku, s pôvodným poradím; najviac DEFER_MAX, ďalšie sa zahodia –
// jeden klient tak nezaplní schránku celého sveta).
// Každé rozhodnutie (zlúčené, odložené, zahodené, len prítomnosť, odmietnuté pred enginom, vstup) a jeho pravidlo
// ide s dávkou do kruhovej pamäte ladiacej stránky (#106); rámec bez dávky sa zapíše samostatne.
function frame(room) {
  const list = room.inbox, overflow = room.inboxDropped | 0;
  if (!list.length && !overflow) return;
  const t0 = clock();
  room.inbox = []; room.inboxDropped = 0;
  const alive = e => room.players.get(e.pl.id) === e.pl;
  const inputs = [], moves = new Map(), acted = new Map(), later = [], dec = [];
  const note = (e, what, rule, extra) => { if (room.trace) dec.push(Object.assign({ seq: e.seq, actor: e.pl.key, t: e.m.t, what, rule }, extra)); };
  if (overflow && room.trace) dec.push({ seq: null, actor: null, t: '*', what: 'dropped', rule: `inbox full: ${overflow} message(s) over the limit (${INBOX_MAX} per room, ${PLAYER_INBOX_MAX} per player)` });
  for (const e of list) { // platí posledný pohyb
    e.pl.inboxN = 0;
    if (!alive(e) || e.m.t !== 'move') continue;
    const prev = moves.get(e.pl);
    if (prev) note(prev, 'coalesced', 'latest move of the player wins', { into: e.seq });
    moves.set(e.pl, e);
  }
  for (const [pl, e] of moves) { const inp = moveInput(room, pl, e, inputs); if (inp) { inputs.push(inp); note(e, 'input', 'move → pos', { id: inp.id }); } else note(e, 'dropped', e.why || 'invalid move'); }
  const presence = presenceOf(room);
  for (const e of list) {
    if (!alive(e) && e.m.t !== 'leave') { note(e, 'dropped', 'player disconnected'); continue; }
    if (e.m.t === 'move') continue;
    const pl = e.pl, m = e.m;
    if (pl.joining && !e.internal) { later.push(e); pl.inboxN++; note(e, 'deferred', 'player is still joining: waits for the next frame'); continue; } // kým nie je pripojený, správy počkajú
    if (m.t === 'act') {
      const n = acted.get(pl) || 0;
      acted.set(pl, n + 1);
      if (n) {
        if (n <= DEFER_MAX) { later.push(e); pl.inboxN++; note(e, 'deferred', `one tile action per player per frame: waits for the next frame (${n}/${DEFER_MAX})`); }
        else note(e, 'dropped', `more than ${DEFER_MAX} tile actions waiting`);
        continue;
      }
    }
    if (['jump', 'sleep', 'emote', 'settings', 'chat'].includes(m.t)) { presenceMessage(room, pl, m, inputs); note(e, 'presence', 'presence only, handled outside the engine'); continue; }
    let inp = null;
    e.why = null;
    try { inp = toInput(room, pl, e, presence, inputs); } catch (err) { console.error(`[${room.id}] správa ${m.t} od ${pl.key}:`, err); e.why = 'error: ' + err.message; }
    if (inp) { inputs.push(inp); note(e, 'input', m.t === 'act' ? `tap resolved to ${inp.type}` : `${m.t} → ${inp.type}`, { id: inp.id }); }
    else note(e, /^refused/.test(e.why || '') ? 'refused' : 'ignored', e.why || 'not a game action');
  }
  room.inbox = later.concat(room.inbox);
  const ms = clock() - t0;
  if (inputs.length) {
    room.traceFrame = room.trace ? { filter: dec, ms } : null; // onBatch ho pripojí k dávke
    try { E.commitBatch(room, inputs, SIM); } finally { room.traceFrame = null; }
    E.reconcile(room, SIM); // udalosti, ktoré akcia zrušila (krok pavúka), sa naplánujú hneď – ako pri prehrávaní denníka (E.replay)
  }
  else if (room.trace && dec.length) Debug.traceFilter(room.trace, room.tick, dec, { filter: ms });
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
      const name = String(m.name || '').replace(/[<>*]/g, '').trim().slice(0, 14) || 'Záhradník'; // '*' je zástupný znak kľúčov enginu
      const room = getRoom(roomId);
      const key = name.toLowerCase();
      // Rýchle znovupripojenie: nahrádza ešte živé (často už mŕtve, len nezistené) spojenie
      // alebo prichádza krátko po odchode. Vtedy nehlásime príchod ani „kým si bol(a) preč“.
      let quick = false;
      for (const o of room.players.values()) if (o.key === key) { o.ws.close(); room.players.delete(o.id); enqueue(room, o, { t: 'leave' }); quick = true; }
      if (room.players.size >= MAX_PLAYERS) { send(ws, { t: 'error', text: 'Záhrada je plná (max ' + MAX_PLAYERS + ' hráči).' }); return ws.close(); }
      if (leaving.back(roomId + ':' + key)) quick = true;
      // prítomnosť hneď (poloha z uloženia alebo štart); uloženie založí či prevedie návrh join a až potom hráč dostane svet
      const sv = room.saves[key];
      const area = sv && D.AREAS.includes(sv.area) ? sv.area : 'garden';
      const pos = Areas.clampPos(area, (sv && sv.x) || D.SPAWN.x, (sv && sv.y) || D.SPAWN.y);
      pl = { id: nextId++, key, name, ws, room, get save() { return room.saves[key]; }, area, areaSeq: 0, x: pos.x, y: pos.y, dir: 0, emote: null, emoteAt: 0, look: null, joining: true };
      room.players.set(pl.id, pl);
      const look = m.look && typeof m.look === 'object' ? { shirt: String(m.look.shirt || ''), hair: String(m.look.hair || ''), hat: !!m.look.hat } : null;
      pl.look = look || (sv && sv.look) || null;
      enqueue(room, pl, { t: 'join', name, look, quick });
      return;
    }
    if (!pl || !MESSAGES.has(m.t)) return;
    const room = pl.room;
    if (room.inbox.length >= INBOX_MAX || (pl.inboxN | 0) >= PLAYER_INBOX_MAX) { room.inboxDropped = (room.inboxDropped | 0) + 1; return; } // ladiaca stránka to ukáže pri ďalšom rámci
    pl.inboxN = (pl.inboxN | 0) + 1;
    room.inbox.push({ pl, m, seq: ++room.inSeq, tick: room.tick }); // rámec (frame) to spracuje do 100 ms
  });
  ws.on('close', () => {
    if (!pl) return;
    const room = pl.room;
    if (room.players.get(pl.id) === pl) {
      room.players.delete(pl.id);
      enqueue(room, pl, { t: 'leave' }); // „naposledy videný“ zapíše návrh leave
      const name = pl.name;
      leaving.leave(room.id + ':' + pl.key, () => toastAll(room, `${name} odišiel(a) zo záhrady.`));
      broadcast(room, roomInfo(room));
      broadcast(room, sleepMsg(room));
      checkSleep(room); // ak odišiel posledný bdejúci, ostatní môžu zaspať
    }
  });
});

// Rámec: najprv správy hráčov (dávka akcií v aktuálnom kroku), potom herný čas – pevný krok s dobiehaním,
// každý deň má presne TPD krokov, aj keď sa časovač oneskorí.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    frame(room);
    if (room.ff) { fastForward(room, now); flushEconomy(room); continue; }
    if (room.mode === 'paused' && !room.players.size) { room.wall = now; continue; }
    const n = traced(room, 'live', () => E.advance(room, now, SIM, 50000));
    if (n) { room.dirty = true; if (room.players.size && now - (room.timeAt || 0) >= TIME_MS) { room.timeAt = now; broadcast(room, timeMsg(room)); } }
    flushEconomy(room);
  }
}, 100);
// Pozície hráčov 10× za sekundu
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.players.size) continue;
    // poloha z uloženia (potvrdená enginom), nie z prítomnosti: pohyb, ktorý engine ešte neoveril (alebo odmietne), ostatní neuvidia
    const list = [...room.players.values()].map(p => ({
      id: p.id, name: p.name, x: +(p.save && p.save.x != null ? p.save.x : p.x).toFixed(3), y: +(p.save && p.save.y != null ? p.save.y : p.y).toFixed(3), dir: p.dir, a: p.a, look: p.look, cr: p.cr ? 1 : 0, lp: p.lp ? 1 : 0, j: p.jn | 0, si: p.scav ? p.scav.i : -1, area: p.area,
      e: p.sleep ? 'sleep' : p.scav ? 'search' : p.pull ? 'pull' : p.emote && now - p.emoteAt < 6000 ? p.emote : null,
      wb: webLeft(p, now) // koľko pavučiny ešte na hráčovi zostáva (1 → 0)
    }));
    for (const area of D.AREAS) broadcastArea(room, area, { t: 'pl', list: list.filter(p => p.area === area) });
    // pavúky a krížiak (stav sveta, mení ho len engine): kým nejaké sú, a raz prázdny zoznam, keď zmiznú
    for (const area of D.AREAS) {
      const sp = Spiders.entities(room, area), key = area + 'Sp';
      if (sp.length || room[key]) broadcastArea(room, area, { t: 'sp', list: sp });
      room[key] = sp.length > 0;
    }
  }
}, 100);
// Priebežne ukladáme aj „naposledy videný“ (vstup seen) – po páde servera tak dni neprítomnosti sedia (±15 s).
setInterval(() => {
  for (const room of rooms.values()) { for (const p of room.players.values()) if (!p.joining) enqueue(room, p, { t: 'seen' }); saveRoom(room); }
}, 15000);
setInterval(() => P.heartbeat(wss.clients), HEARTBEAT_MS);

function shutdown() {
  for (const room of rooms.values()) {
    for (const p of room.players.values()) if (!p.joining) enqueue(room, p, { t: 'seen' });
    frame(room); // posledná dávka: čo ešte prišlo a „naposledy videný“ všetkých
    saveRoom(room, true);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`🌼 Čarovná záhrada beží na http://localhost:${PORT}  (nový svet: deň = ${DAY_SECONDS}s, režim ${DEFAULT_MODE}, ${TPD} krokov/deň)`);
});
