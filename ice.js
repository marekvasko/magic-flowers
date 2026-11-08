// Ľad: hory (druhá hracia plocha), ľadovec, zamrznutá voda, krompáč a ľadovňa.
// Čisté funkcie nad výrezmi sveta – server (alebo návrh udalosti) im dá len to, s čím pracujú:
//   hory = políčka hôr [{ g, ice?, cut? }] (world.hory), tiles = políčka záhrady, icehouse = { built, ice } (world.icehouse),
//   st = sklad { inv, fb } (výrez 'storage'), occupied = množina políčok hôr, na ktorých stojí hráč (z prítomnosti).
// Na políčku ľadovca je ice = koľko vrstiev ľadu (po 1/4 bloku) na ňom ešte stojí; cut = 1 → do vody sa dnes už vysekal otvor.
const D = require('./shared/data.js');
const I = require('./items.js');

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
function saveHory(hory) { return hory.map(t => t.ice != null || t.cut ? { ice: t.ice, cut: t.cut } : 0); }

// Pozemok ľadovne v záhrade: kým nie je postavená 'lot', potom 'icehouse'.
function lotIdx() {
  const L = D.ICEHOUSE.lot, out = [];
  for (let y = L.y0; y <= L.y1; y++) for (let x = L.x0; x <= L.x1; x++) out.push(y * D.W + x);
  return out;
}
function applyIcehouse(icehouse, tiles) {
  for (const i of lotIdx()) tiles[i].g = icehouse && icehouse.built ? 'icehouse' : 'lot';
}

// Vysekanie ľadu krompáčom na políčku i plochy tiles. Vráti { ok, msg } – pri ok sa hráčovi pridá 1 ľad.
function digIce(tiles, i, season) {
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
function meltGlacier(hory, n) {
  const list = hory.map((t, i) => i).filter(i => hory[i].ice > 0).sort((a, b) => LEVELS[a] - LEVELS[b] || a - b);
  let k = 0;
  for (const i of list) {
    const t = hory[i];
    while (t.ice > 0 && k < n) { t.ice--; k++; }
    if (k >= n) break;
  }
  return k;
}
// Políčka hôr, na ktorých stojí hráč – pod nohami ľad nedorastá. presence: [{ area, x, y }] (snímka pripojených hráčov)
function occupied(presence) {
  const s = new Set();
  for (const p of presence || []) if (p.area === 'hory') s.add(Math.floor(p.y) * D.W + Math.floor(p.x));
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
    if (D.passable(t)) m = Math.min(m, D.level(t));
  }
  return m;
}
// Dorastanie: n vrstiev, rovnomerne od najvyšších políčok pod skalami nadol, najviac do pôvodnej výšky.
// Nedorastá pod hráčom (occ = occupied(prítomnosť)) a nikdy nie viac ako pol bloku nad najnižšieho suseda – nikoho nezamuruje.
function growGlacier(hory, n, occ) {
  const list = hory.map((t, i) => i).filter(i => LEVELS[i] > 0).sort((a, b) => LEVELS[b] - LEVELS[a] || a - b);
  occ = occ || new Set();
  let k = 0, any = true;
  while (k < n && any) {
    any = false;
    for (const i of list) {
      if (k >= n) break;
      const t = hory[i];
      if (t.ice < LEVELS[i] && !occ.has(i) && D.level(t) + 1 <= lowestNeighbour(hory, i) + D.GLACIER_STEP) { t.ice++; k++; any = true; }
    }
  }
  return k;
}
// Zrážky (dážď, sneh) – ľadovec dorastie. Vráti počet pribudnutých vrstiev. Najviac raz za deň: volajúci si pamätá
// deň posledného kŕmenia (world.glacierFed) a keď sa zhoduje s dnešným, nevolá.
function feedGlacier(hory, weather, occ) {
  const n = D.GLACIER_GROW[weather];
  return n ? growGlacier(hory, n, occ) : 0;
}

// Ráno: otvory vo vode (v záhrade aj v horách) zamrznú, ľadovec sa podľa obdobia topí a v daždi/snehu dorastie.
// weather = dnešné počasie, ktorým sa ľadovec kŕmi; null, ak už dnes kŕmený bol (dážď z elixíru či studne pred ránom).
// Vráti zoznam plôch, ktoré sa zmenili.
function dawnIce(tiles, hory, season, weather, occ) {
  const changed = new Set();
  for (const [area, list] of [['garden', tiles], ['hory', hory]]) for (const t of list) if (t.cut) { delete t.cut; changed.add(area); }
  if (meltGlacier(hory, D.GLACIER_MELT[season])) changed.add('hory');
  if (feedGlacier(hory, weather, occ)) changed.add('hory');
  return [...changed];
}
function glacierTotal(hory) { return hory.reduce((s, t) => s + (t.ice || 0), 0); }
function glacierMax() { return LEVELS.reduce((s, v) => s + v, 0); }

// Zmena množstva ľadu v ľadovni – ak sa tým zmení rýchlosť starnutia v sklade st, várky sa najprv prepočítajú (k času tick).
function setIce(icehouse, st, tick, ice) {
  const before = I.storageC(st, icehouse);
  const next = Math.max(0, Math.min(D.ICEHOUSE.cap, ice));
  if ((icehouse.ice > 0) !== (next > 0)) I.rebase(before, tick);
  icehouse.ice = next;
}

// Každú hernú hodinu sa časť ľadu roztopí (v zime nič); izolácia z prikrývok topenie spomalí. Vráti true, ak sa ľadovňa práve vyprázdnila.
function meltHourly(icehouse, st, tick, season) {
  const h = icehouse;
  if (!h || !h.built || h.ice <= 0) return false;
  const left = h.ice - D.ICEHOUSE.melt[season] * D.ICEHOUSE.insul[D.insulLevel(h.bl)];
  setIce(h, st, tick, left < 1e-6 ? 0 : +left.toFixed(4));
  return h.ice === 0;
}

// Doplnenie ľadovne – vráti, koľko blokov sa zmestilo (hráčovi ich odoberie server).
function fillIcehouse(icehouse, st, tick, n) {
  const h = icehouse;
  if (!h || !h.built) return 0;
  const k = Math.max(0, Math.min(n, Math.floor(D.ICEHOUSE.cap - h.ice + 1e-6)));
  if (k) setIce(h, st, tick, h.ice + k);
  return k;
}

// Izolácia (#23): hráč vloží do ľadovne 1 hodvábnu prikrývku (sv = jeho uloženie). Vráti chybu alebo null.
// icehouse.bl = koľko prikrývok v nej už je; úroveň izolácie je D.insulLevel(bl).
function insulate(icehouse, sv) {
  const h = icehouse, B = D.ICEHOUSE, max = B.blankets[B.blankets.length - 1];
  if (!h || !h.built) return 'Ľadovňa ešte nie je postavená. Kúpiš ju na trhu (záložka Vylepšiť). 🧊';
  if ((h.bl | 0) >= max) return 'Ľadovňa je už izolovaná najlepšie, ako sa dá. 🧶';
  if (!(sv.inv.blanket > 0)) return 'Nemáš hodvábnu prikrývku. Utká ti ju majster hodvábu v dedinke alebo krosná v Dielni. 🧶';
  I.removeItems(I.playerC(sv), 'blanket', 1, 0);
  h.bl = (h.bl | 0) + 1;
  return null;
}

// Kúpa ľadovne (spoločná stavba, platí ju hráč): icehouse sa mení na mieste, pozemok v tiles dostane budovu. Vráti chybu alebo null.
function buildIcehouse(icehouse, tiles, sv) {
  const B = D.ICEHOUSE;
  if (icehouse.built) return 'Ľadovňa už v záhrade stojí.';
  if (D.repLevel(sv.rep || 0) < B.rep) return `Potrebuješ reputáciu úrovne ${B.rep}.`;
  if (sv.coins < B.price) return 'Nemáš dosť mincí. 🪙';
  if (lotIdx().some(i => tiles[i].s)) return 'Na pozemku vedľa domčeka je prekopaná zem. Najprv ju zarovnaj motykou.';
  sv.coins -= B.price;
  icehouse.built = true; icehouse.ice = 0; icehouse.bl = 0;
  applyIcehouse(icehouse, tiles);
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

module.exports = { LEVELS, loadHory, saveHory, lotIdx, applyIcehouse, digIce, dawnIce, meltGlacier, growGlacier, feedGlacier, occupied, glacierTotal, glacierMax, setIce, meltHourly, fillIcehouse, insulate, buildIcehouse, buyTool };
