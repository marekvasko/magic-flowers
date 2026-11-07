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
const SAVE_VERSION = 8; // 3: hory, ľad a ľadovňa; 4: Les na pomedzí; 5: kľúče udalostí (unikátne a periodické); 6: spoločné povolenie na pole; 7: Les divov; 8: semienko sveta a počítadlo kôl namiesto rng
const TPD = D.TICKS_PER_DAY, MPT = D.MIN_PER_TICK;
const DEFAULT_MODE = process.env.DEFAULT_MODE === 'paused' ? 'paused' : 'running';
const MAX_CATCHUP_DAYS = +process.env.MAX_CATCHUP_DAYS || 30; // koľko herných dní najviac dobehneme po výpadku servera
const JOURNAL_MAX = (+process.env.JOURNAL_MAX_MB || 20) * 1024 * 1024; // denník dávok: po prekročení sa otočí (jeden starší súbor sa drží)
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
  Econ.initEconomy(room, E.liveCtx(room, 'ekonomika')); // jediná akcia nad živým svetom: založenie trhu a nástenky
  Econ.syncFestival(room.market); // sviatočné násobky v položkách kvetov (staršie uloženia ich nemajú)
  room.inbox = []; room.inSeq = 0; // schránka správ hráčov; rámec (frame) ich spracuje raz za 100 ms
  E.reconcile(room, SIM); // doplní chýbajúce periodické udalosti, zahodí udalosti obsahu, ktorý už v hre nie je
  // značka načítania v denníku: odkiaľ (krok, kolo) beh pokračuje – po páde servera sa dobehnuté kroky zapíšu znova
  appendJournal(room, { load: true, tick: room.tick, step: room.step, seq: room.seq, migratedFrom: room.migratedFrom || null });
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
    seed: room.seed, step: room.step, seq: room.seq, events: room.events,
    weather: room.weather, saves: room.saves, storage: room.storage, storageFb: room.storageFb, market: room.market, contracts: room.contracts,
    fairyNight: room.fairyNight, eternal: room.eternal, migratedFrom: room.migratedFrom, scav: room.scav, scavSalt: room.scavSalt, icehouse: room.icehouse, pomedzieSeed: room.pomedzieSeed, up: room.up, lesSeed: room.lesSeed,
    glacierFed: room.glacierFed, plotsUsed: room.plotsUsed, maxRep: room.maxRep,
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

function season(room) { return D.seasonOf(room.day); }
function hour(room) { return room.min / 60; }

// Nový hráč začína chudobne: pár semienok sezónneho kvetu a malá krhla (povolenie na pole je spoločné pre záhradu).
function newSave(room) {
  const se = season(room);
  const sp = Econ.PLANTABLE.filter(k => !D.SPECIES[k].strict && D.SPECIES[k].seasons.includes(se))
    .sort((a, b) => D.SPECIES[a].seed - D.SPECIES[b].seed)[0];
  return {
    coins: START.coins, water: 5, inv: { hoe: 1, can: 1, ['seed_' + sp]: 4 },
    recipes: [], seen: [sp], vily: 0, look: null, talked: false, rep: START.rep, up: { can: 0, composter: 0 }
  };
}
// Hráči zo starších verzií hry: nezoberieme im to, čo mali (krhla na 25; pole prešlo na záhradu v migrate).
function migrateSave(sv, room) {
  if (!sv.up) sv.up = { can: 2, composter: 0 };
  if (sv.rep == null) sv.rep = 0;
  sv.water = Math.min(sv.water || 0, Econ.canCap(sv));
  I.syncAll(I.playerC(sv), room.tick); // kvety bez várok dostanú vek 0 (čerstvo odrezané)
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
// Snímka toho, čo nie je stav sveta, ale návrhy to potrebujú: kto je pripojený, kde stojí a či hľadá v tráve
function presenceOf(room) {
  return [...room.players.values()].map(p => ({ key: p.key, name: p.name, area: p.area, x: p.x, y: p.y, scav: p.scav ? { i: p.scav.i, n: p.scav.n } : null }));
}

// Všetky zmeny inventára idú cez items.js (kvety majú várky s vekom). take vráti odobraté várky alebo null.
function give(pl, id, n, batches) { I.addItems(I.playerC(pl.save), id, n, pl.room.tick, batches); }

function playerByKey(room, key) { for (const p of room.players.values()) if (p.key === key) return p; return null; }

const SIM = {
  proposers: Object.assign({}, Events.PROPOSERS, Actions.PROPOSERS), periodic: Events.PERIODIC, presence: presenceOf,
  // denník najprv (nech záznam nechýba), potom správy hráčom; chyba pri posielaní nesmie zhodiť simuláciu ani server
  onBatch(room, out) { appendJournal(room, out.entry); try { notify(room, out); } catch (err) { console.error(`[${room.id}] notify`, err); } }
};

// Po vykonaní dávky: odmietnutia akcií ako správa ich hráčovi, správy z návrhov (adresát to: E.ALL všetkým,
// E.area(plocha) hráčom na ploche, inak kľúč hráča) a obnova toho, čo sa podľa zapísaných kľúčov zmenilo –
// políčka (zmena typu zeme, napr. stavba, pošle celú plochu – klient vtedy prestavia 3D svet), batohy (me), trh,
// nástenka, sklad a ľadovňa (room), povolenie na pole (plots), počasie (time).
// Správy scavStart / scavDone sú pokyny pre prítomnosť (hráč začal / prestal hľadať), nie správy klientovi.
function notify(room, out) {
  if (!room.players.size) { if (out.applied.length) room.dirty = true; return; }
  for (const r of out.rejected) { const pl = r.input.actor != null ? playerByKey(room, r.input.actor) : null; if (pl && r.reject) toast(pl, r.reject); }
  if (!out.applied.length) return;
  room.dirty = true;
  const tiles = {}, me = new Set(), whole = new Set();
  for (const a of D.AREAS) tiles[a] = new Set();
  let info = false, time = false, plots = false, everyone = false;
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
    else send(pl.ws, body);
  }
  if (everyone) for (const p of room.players.values()) sendMe(p);
  else for (const key of me) { const pl = playerByKey(room, key); if (pl) sendMe(pl); }
  if (plots) broadcast(room, plotsMsg(room));
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
const FF_STEPS = 5;
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

// ---------- Akcie hráčov ----------
// Správy hráčov nič nemenia hneď: handler socketu ich len overí a vloží do schránky miestnosti (room.inbox, poradie seq,
// krok príchodu tick). Rámec (frame, raz za 100 ms) ich vyhodnotí v rozhodovacom kole: pohyb sa zlúči (platí posledný)
// a použije priamo (prítomnosť; fáza 4), správy o prítomnosti (emócie, spánok, nastavenia, chat) sa vybavia priamo
// a všetko, čo mení herný stav, sa stane vstupom enginu a jednou dávkou akcií v aktuálnom kroku (actions.js).
// Z jedného hráča prejde v rámci najviac jedna akcia na políčku (act); ďalšie počkajú na ďalší rámec.
// Udalosti a akcie nie sú nikdy v jednej dávke: dávka akcií sa vykoná v kroku, v ktorom správy prišli (svet sa medzi
// rámcami nehýbe, takže to je práve aktuálny krok), až potom rámec posunie čas.
const INBOX_MAX = 2000, PLAYER_INBOX_MAX = 100, DEFER_MAX = 3; // ochrana pred zaplavením: čo sa nezmestí (na svet, na hráča, odložené akcie), sa zahodí
const MESSAGES = new Set(['move', 'act', 'jump', 'sleep', 'emote', 'buy', 'sell', 'upgrade', 'ctake', 'cdeliver', 'brew', 'wish', 'settings', 'store', 'unstore', 'compostWilted', 'buyTool', 'build', 'icehouse', 'chat']);
function inRing(p) { if (p.area !== 'garden') return false; const x = Math.floor(p.x), y = Math.floor(p.y); return x >= D.RING.x0 && x <= D.RING.x1 && y >= D.RING.y0 && y <= D.RING.y1; }

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

// Prechod do inej plochy: hráč dostane políčka novej plochy (aj jej veľkosť) a príchodové miesto.
// seq rozlíši staré správy o pohybe, ktoré klient poslal ešte z predchádzajúcej plochy.
function areaMsg(pl) {
  const { w, h } = D.areaSize(pl.area);
  return { t: 'area', area: pl.area, seq: pl.areaSeq, w, h, tiles: tilesView(pl.room, pl.area), x: pl.x, y: pl.y };
}
function travel(pl, to, inputs) {
  const a = D.arrival(pl.area, to);
  if (!a) return;
  if (pl.scav) stopScavenge(pl, null, inputs);
  const from = pl.area;
  pl.area = pl.save.area = to;
  pl.x = pl.save.x = a.x; pl.y = pl.save.y = a.y;
  pl.areaSeq++;
  pl.emote = null;
  send(pl.ws, areaMsg(pl));
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

// Pohyb (zatiaľ priamo do prítomnosti; fáza 4 ho urobí stavom): poloha, smer, plazenie, lampáš; prechod cez bránu
function applyMove(pl, m, inputs) {
  const room = pl.room, sv = pl.save;
  if (pl.sleep) return; // spiaci hráč leží v posteli
  if ((m.ar | 0) !== pl.areaSeq) return; // pohyb ešte z predchádzajúcej plochy
  if (!(typeof m.x === 'number' && typeof m.y === 'number' && isFinite(m.x) && isFinite(m.y))) return;
  const pos = Areas.clampPos(pl.area, m.x, m.y); // z plochy sa vyjsť nedá – len cez prechod
  pl.x = pos.x; pl.y = pos.y;
  pl.dir = m.dir | 0;
  if (typeof m.a === 'number' && isFinite(m.a)) pl.a = +m.a.toFixed(3); // presný smer pohľadu (3D: 8 smerov)
  pl.cr = !!m.cr; // plazí sa
  pl.lp = !!m.lp && !!sv.inv.lamp; // drží lampáš (svieti)
  sv.x = pl.x; sv.y = pl.y;
  if (pl.scav && Math.hypot(pl.x - pl.scav.px, pl.y - pl.scav.py) > 0.35) stopScavenge(pl, 'Pohol(a) si sa skôr, než si dohľadal(a).', inputs);
  const to = Areas.gateTarget(Areas.areaTiles(room, pl.area), pl.area, pl.x, pl.y);
  if (to) travel(pl, to, inputs);
}

// Správa, ktorá mení herný stav → vstup enginu (alebo null). Prítomnosť presence je snímka po pohyboch tohto rámca.
function toInput(room, pl, e, presence, inputs) {
  const m = e.m, sv = pl.save, key = pl.key;
  const mk = (type, data) => actionInput(room, pl, e.seq, type, data);
  switch (m.t) {
    case 'act': {
      if (pl.sleep) return null;
      const me = presence.find(p => p.key === key);
      if (!me) return null;
      const r = Actions.resolveAct(room, presence, me, m);
      if (!r) return null;
      if (r.toast) return toast(pl, r.toast);
      if (pl.scav) { // kým hľadá: to isté políčko znova = stále hľadá; čokoľvek iné (čo by sa naozaj stalo) hľadanie preruší
        if (r.type === 'scavStart' && pl.scav.i === r.data.i) return toast(pl, 'Ešte stále hľadáš… 🔍');
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
    case 'wish': return sv.inv.fl_papradie ? mk('wish', { kind: ['zlato', 'jar', 'poklad'].includes(m.kind) ? m.kind : 'poklad' }) : null;
    case 'store': case 'unstore': return mk(m.t, { id: String(m.id), n: Math.max(1, Math.min(999, m.n | 0)) });
    case 'compostWilted': return mk('compostWilted', {});
    case 'buyTool': return mk('buyTool', { id: String(m.id) });
    case 'build': return m.id === 'icehouse' ? mk('build', {}) : null;
    case 'icehouse': return mk('fillIce', { n: m.n | 0 });
  }
  return null;
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
    case 'emote': {
      const e = ['dance', 'wave', 'heart', 'laugh', 'flower'].includes(m.e) ? m.e : 'wave';
      pl.emote = e; pl.emoteAt = Date.now();
      if (e === 'dance') checkFairies(room, pl);
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
function frame(room) {
  const list = room.inbox;
  if (!list.length) return;
  room.inbox = [];
  const alive = e => room.players.get(e.pl.id) === e.pl;
  const inputs = [], moves = new Map(), acted = new Map(), later = [];
  for (const e of list) { e.pl.inboxN = 0; if (alive(e) && e.m.t === 'move') moves.set(e.pl, e.m); } // platí posledný pohyb
  for (const [pl, m] of moves) applyMove(pl, m, inputs);
  const presence = presenceOf(room);
  for (const e of list) {
    if (!alive(e) || e.m.t === 'move') continue;
    const pl = e.pl, m = e.m;
    if (m.t === 'act') { const n = acted.get(pl) || 0; acted.set(pl, n + 1); if (n) { if (n <= DEFER_MAX) { later.push(e); pl.inboxN++; } continue; } }
    if (['jump', 'sleep', 'emote', 'settings', 'chat'].includes(m.t)) { presenceMessage(room, pl, m, inputs); continue; }
    let inp = null;
    try { inp = toInput(room, pl, e, presence, inputs); } catch (err) { console.error(`[${room.id}] správa ${m.t} od ${pl.key}:`, err); }
    if (inp) inputs.push(inp);
  }
  room.inbox = later.concat(room.inbox);
  if (inputs.length) E.commitBatch(room, inputs, SIM);
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
      const name = String(m.name || '').replace(/[<>*]/g, '').trim().slice(0, 14) || 'Záhradník'; // '*' je zástupný znak kľúčov enginu
      const room = getRoom(roomId);
      const key = name.toLowerCase();
      // Rýchle znovupripojenie: nahrádza ešte živé (často už mŕtve, len nezistené) spojenie
      // alebo prichádza krátko po odchode. Vtedy nehlásime príchod ani „kým si bol(a) preč“.
      let quick = false;
      for (const o of room.players.values()) if (o.key === key) { o.save.lastTick = room.tick; o.ws.close(); room.players.delete(o.id); quick = true; }
      if (room.players.size >= MAX_PLAYERS) { send(ws, { t: 'error', text: 'Záhrada je plná (max ' + MAX_PLAYERS + ' hráči).' }); return ws.close(); }
      if (leaving.back(roomId + ':' + key)) quick = true;
      if (!room.saves[key]) { room.saves[key] = newSave(room); room.maxRep = Math.max(room.maxRep || 0, START.rep); }
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
      send(ws, Econ.marketView(room.market, room.tick, room.events));
      send(ws, Econ.boardView(room.contracts));
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
    if (!pl || !MESSAGES.has(m.t)) return;
    const room = pl.room;
    if (room.inbox.length >= INBOX_MAX || (pl.inboxN | 0) >= PLAYER_INBOX_MAX) return;
    pl.inboxN = (pl.inboxN | 0) + 1;
    room.inbox.push({ pl, m, seq: ++room.inSeq, tick: room.tick }); // rámec (frame) to spracuje do 100 ms
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

// Rámec: najprv správy hráčov (dávka akcií v aktuálnom kroku), potom herný čas – pevný krok s dobiehaním,
// každý deň má presne TPD krokov, aj keď sa časovač oneskorí.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    frame(room);
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
