// Ľad: hory (druhá hracia plocha), ľadovec, zamrznutá voda, krompáč a ľadovňa.
// Čisté funkcie nad stavom sveta (room) – server ich len volá a posiela zmeny hráčom.
// room.hory = políčka hôr [{ g, ice?, cut? }], room.icehouse = { built, ice }
// Na políčku ľadovca je ice = koľko vrstiev ľadu (po 1/4 bloku) na ňom ešte stojí; cut = 1 → do vody sa dnes už vysekal otvor.
const D = require('./shared/data.js');
const I = require('./items.js');

function areaTiles(room, area) { return area === 'hory' ? room.hory : room.tiles; }
// pôvodná (najvyššia) výška ľadu na každom políčku hôr
const LEVELS = D.glacierLevels(D.buildMountains());

// Políčka hôr: typy zeme z generátora, z uloženia len zásoba ľadu a otvory vo vode.
function loadHory(saved) {
  const base = D.buildMountains();
  const ok = Array.isArray(saved) && saved.length === base.length;
  return base.map((g, i) => {
    const t = { g }, s = ok && saved[i] || {};
    if (g === 'glacier') t.ice = s.ice == null ? LEVELS[i] : Math.max(0, Math.min(LEVELS[i], s.ice | 0));
    if (g === 'water' && s.cut) t.cut = 1;
    return t;
  });
}
function saveHory(room) { return room.hory.map(t => t.ice != null || t.cut ? { ice: t.ice, cut: t.cut } : 0); }

// Pozemok ľadovne v záhrade: kým nie je postavená 'lot', potom 'icehouse'.
function lotIdx() {
  const L = D.ICEHOUSE.lot, out = [];
  for (let y = L.y0; y <= L.y1; y++) for (let x = L.x0; x <= L.x1; x++) out.push(y * D.W + x);
  return out;
}
function applyIcehouse(room) {
  room.icehouse = room.icehouse || { built: false, ice: 0 };
  for (const i of lotIdx()) room.tiles[i].g = room.icehouse.built ? 'icehouse' : 'lot';
}

// Vysekanie ľadu krompáčom. Vráti { ok, msg } – pri ok sa hráčovi pridá 1 ľad.
function digIce(room, tiles, i, season) {
  const t = tiles[i];
  if (t.g === 'glacier') {
    if (!t.ice) return { ok: false, msg: 'Tu je ľad vysekaný až po dno. Ľadovec každé ráno trochu dorastie. 🧊' };
    t.ice--;
    return { ok: true, msg: `+1 🧊 Ľad (tu ešte ${t.ice} ${t.ice === 1 ? 'vrstva' : t.ice >= 2 && t.ice <= 4 ? 'vrstvy' : 'vrstiev'}).` };
  }
  if (t.g === 'water') {
    if (season !== 3) return { ok: false, msg: 'Voda nie je zamrznutá. Ľad tu vysekáš až v zime. ❄️' };
    if (t.cut) return { ok: false, msg: 'Tu už je otvor v ľade. Cez noc zamrzne – skús iné miesto. 🧊' };
    t.cut = 1;
    return { ok: true, msg: '+1 🧊 Ľad zo zamrznutej vody.' };
  }
  return { ok: false, msg: null };
}

// Topenie: n vrstiev od okrajov (najnižšie políčka ľadovca) dnu – ľadovec viditeľne ustupuje k skalám.
function meltGlacier(room, n) {
  const list = room.hory.map((t, i) => i).filter(i => room.hory[i].ice > 0).sort((a, b) => LEVELS[a] - LEVELS[b] || a - b);
  let k = 0;
  for (const i of list) {
    const t = room.hory[i];
    while (t.ice > 0 && k < n) { t.ice--; k++; }
    if (k >= n) break;
  }
  return k;
}
// Políčka hôr, na ktorých stojí hráč – pod nohami ľad nedorastá.
function occupied(room) {
  const s = new Set();
  if (room.players) for (const p of room.players.values()) if (p.area === 'hory') s.add(Math.floor(p.y) * D.W + Math.floor(p.x));
  return s;
}
// Najnižšie priechodné susedné políčko (vo vrstvách ľadu) – ľadovec dorastá len tak, aby sa naň dalo vyliezť.
function lowestNeighbour(tiles, i) {
  const x = i % D.W, y = (i / D.W) | 0;
  let m = Infinity;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= D.W || ny >= D.H) continue;
    const t = tiles[ny * D.W + nx];
    if (D.passable(t)) m = Math.min(m, D.iceLevel(t));
  }
  return m;
}
// Dorastanie: n vrstiev, rovnomerne od najvyšších políčok pod skalami nadol, najviac do pôvodnej výšky.
// Nedorastá pod hráčom a nikdy nie viac ako pol bloku nad najnižšieho suseda – nikoho nezamuruje.
function growGlacier(room, n) {
  const list = room.hory.map((t, i) => i).filter(i => LEVELS[i] > 0).sort((a, b) => LEVELS[b] - LEVELS[a] || a - b);
  const occ = occupied(room);
  let k = 0, any = true;
  while (k < n && any) {
    any = false;
    for (const i of list) {
      if (k >= n) break;
      const t = room.hory[i];
      if (t.ice < LEVELS[i] && !occ.has(i) && t.ice + 1 <= lowestNeighbour(room.hory, i) + D.GLACIER_STEP) { t.ice++; k++; any = true; }
    }
  }
  return k;
}
// Zrážky (dážď, sneh) – ľadovec dorastie najviac raz za deň. Vráti počet pribudnutých vrstiev.
function feedGlacier(room, weather) {
  const day = D.dayOfTick(room.tick), n = D.GLACIER_GROW[weather];
  if (!n || room.glacierFed === day) return 0;
  room.glacierFed = day;
  return growGlacier(room, n);
}

// Ráno: otvory vo vode zamrznú, ľadovec sa podľa obdobia topí a v daždi/snehu dorastie.
// Vráti zoznam plôch, ktoré sa zmenili.
function dawnIce(room, season, weather) {
  const changed = new Set();
  for (const area of D.AREAS) for (const t of areaTiles(room, area)) if (t.cut) { delete t.cut; changed.add(area); }
  if (meltGlacier(room, D.GLACIER_MELT[season])) changed.add('hory');
  if (feedGlacier(room, weather)) changed.add('hory');
  return [...changed];
}
function glacierTotal(room) { return room.hory.reduce((s, t) => s + (t.ice || 0), 0); }
function glacierMax() { return LEVELS.reduce((s, v) => s + v, 0); }

// Zmena množstva ľadu v ľadovni – ak sa tým zmení rýchlosť starnutia v sklade, várky sa najprv prepočítajú.
function setIce(room, ice) {
  const before = I.storageC(room);
  const next = Math.max(0, Math.min(D.ICEHOUSE.cap, ice));
  if ((room.icehouse.ice > 0) !== (next > 0)) I.rebase(before, room.tick);
  room.icehouse.ice = next;
}

// Každú hernú hodinu sa časť ľadu roztopí (v zime nič). Vráti true, ak sa ľadovňa práve vyprázdnila.
function meltHourly(room, season) {
  const h = room.icehouse;
  if (!h || !h.built || h.ice <= 0) return false;
  const left = h.ice - D.ICEHOUSE.melt[season];
  setIce(room, left < 1e-6 ? 0 : +left.toFixed(4));
  return h.ice === 0;
}

// Doplnenie ľadovne – vráti, koľko blokov sa zmestilo (hráčovi ich odoberie server).
function fillIcehouse(room, n) {
  const h = room.icehouse;
  if (!h || !h.built) return 0;
  const k = Math.max(0, Math.min(n, Math.floor(D.ICEHOUSE.cap - h.ice + 1e-6)));
  if (k) setIce(room, h.ice + k);
  return k;
}

// Kúpa ľadovne (spoločná stavba, platí ju hráč). Vráti chybu alebo null.
function buildIcehouse(room, sv) {
  const B = D.ICEHOUSE;
  if (room.icehouse && room.icehouse.built) return 'Ľadovňa už v záhrade stojí.';
  if (D.repLevel(sv.rep || 0) < B.rep) return `Potrebuješ reputáciu úrovne ${B.rep}.`;
  if (sv.coins < B.price) return 'Nemáš dosť mincí. 🪙';
  if (lotIdx().some(i => room.tiles[i].s)) return 'Na pozemku vedľa domčeka je prekopaná zem. Najprv ju zarovnaj motykou.';
  sv.coins -= B.price;
  room.icehouse = { built: true, ice: 0 };
  applyIcehouse(room);
  return null;
}

// Kúpa náradia (krompáč) – raz na hráča.
function buyTool(sv, id) {
  const T = D.TOOLS[id];
  if (!T) return 'Toto sa na trhu nepredáva.';
  if (sv.inv[id]) return `${T.name} už máš.`;
  if (D.repLevel(sv.rep || 0) < T.rep) return `Potrebuješ reputáciu úrovne ${T.rep}.`;
  if (sv.coins < T.price) return 'Nemáš dosť mincí. 🪙';
  sv.coins -= T.price;
  sv.inv[id] = 1;
  return null;
}

// Na ktorom prechode stojí hráč: vráti cieľovú plochu, alebo null.
function gateTarget(tiles, area, x, y) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= D.W || ty >= D.H) return null;
  if (tiles[ty * D.W + tx].g !== 'gate') return null;
  return area === 'hory' ? 'garden' : 'hory';
}

module.exports = { LEVELS, areaTiles, loadHory, saveHory, lotIdx, applyIcehouse, digIce, dawnIce, meltGlacier, growGlacier, feedGlacier, glacierTotal, glacierMax, setIce, meltHourly, fillIcehouse, buildIcehouse, buyTool, gateTarget };
