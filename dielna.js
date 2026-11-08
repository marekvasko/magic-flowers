// Pavúčí hodváb (#23): majster hodvábu, Dielňa s krosnami a hodvábne prikrývky (izolácia ľadovne je v ice.js).
// Čisté funkcie nad výrezmi sveta: dielna = { built, loom, job: { key, at } | null, ready: { kľúč: počet } } (world.dielna),
// tiles = políčka záhrady, sv = uloženie hráča. Prikrývka je zo 6 hodvábu: u majstra hneď za mince, na krosnách
// zadarmo, ale krosná tká 2–4 herné hodiny a naraz len jednu prikrývku. Hotová počká v Dielni, kým si ju tkáč vezme.
const D = require('./shared/data.js');
const I = require('./items.js');

const newDielna = () => ({ built: false, loom: false, job: null, ready: {} });
// Uloženie zo staršej verzie alebo poškodené → doplní chýbajúce časti
function loadDielna(saved) {
  const d = Object.assign(newDielna(), saved && typeof saved === 'object' ? saved : {});
  d.built = !!d.built; d.loom = !!(d.built && d.loom);
  if (!(d.job && typeof d.job.key === 'string' && Number.isFinite(d.job.at))) d.job = null;
  if (!d.ready || typeof d.ready !== 'object') d.ready = {};
  return d;
}

// Pozemok Dielne v záhrade: kým nie je postavená 'lot', potom 'dielna'
function lotIdx() {
  const L = D.DIELNA.lot, out = [];
  for (let y = L.y0; y <= L.y1; y++) for (let x = L.x0; x <= L.x1; x++) out.push(y * D.W + x);
  return out;
}
function applyDielna(dielna, tiles) {
  for (const i of lotIdx()) tiles[i].g = dielna && dielna.built ? 'dielna' : 'lot';
}
// Hráč stojí pri Dielni / pri majstrovi (p = záznam prítomnosti)
function near(p, x, y, r) { return !!p && p.area === 'garden' && Math.hypot(p.x - x, p.y - y) <= r; }
function nearDielna(p) { const L = D.DIELNA.lot; return near(p, (L.x0 + L.x1 + 1) / 2, (L.y0 + L.y1 + 1) / 2, 3); }
// Majster hodvábu v kroku tick (D.masterAt): '' = hráč p u neho môže tkať, inak dôvod odmietnutia; dielna = world.dielna (krosná)
const MASTER_GONE = 'Odkedy sú v Dielni krosná, majster hodvábu do dedinky nechodí. Prikrývky ti utkajú krosná. 🧶';
function masterCheck(p, tick, dielna) {
  if (dielna && dielna.loom) return MASTER_GONE;
  const m = D.masterAt(D.dayOfTick(tick), D.minOfTick(tick));
  if (!m) return 'Majster hodvábu je preč – do dedinky chodí len na jar a na jeseň. 🧵';
  if (!m.still) return D.masterRoadText(m);
  if (!near(p, m.x, m.y, 2.5)) return m.where === 'hut' ? 'Majster hodvábu je na noc u babky v chalúpke – podíď k nemu.' : 'Podíď bližšie k majstrovi hodvábu.';
  return '';
}

const take = (sv, id, n) => I.removeItems(I.playerC(sv), id, n, 0);
const give = (sv, id, n) => I.addItems(I.playerC(sv), id, n, 0);
const lacksSilk = sv => (sv.inv.silk || 0) < D.BLANKET_SILK;
const SILK_MSG = `Na prikrývku treba ${D.BLANKET_SILK}× pavúčí hodváb. Nájdeš ho v pavučinách v Lese divov. 🕸️`;

// Kúpa Dielne (spoločná stavba, platí ju hráč): pozemok v tiles dostane budovu. Vráti chybu alebo null.
function buildDielna(dielna, tiles, sv) {
  const B = D.DIELNA;
  if (dielna.built) return 'Dielňa už v záhrade stojí.';
  if (D.repLevel(sv.rep || 0) < B.rep) return `Potrebuješ reputáciu úrovne ${B.rep}.`;
  if (sv.coins < B.price) return 'Nemáš dosť mincí. 🪙';
  if (lotIdx().some(i => tiles[i].s)) return 'Na pozemku vedľa trhu je prekopaná zem. Najprv ju zarovnaj motykou.';
  sv.coins -= B.price;
  dielna.built = true;
  applyDielna(dielna, tiles);
  return null;
}
// Kúpa krosien do Dielne (spoločné ako Dielňa)
function buyLoom(dielna, sv) {
  const L = D.DIELNA.loom;
  if (!dielna.built) return 'Najprv treba postaviť Dielňu. Kúpiš ju na trhu (záložka Vylepšiť). 🪚';
  if (dielna.loom) return 'Krosná už v Dielni sú.';
  if (D.repLevel(sv.rep || 0) < L.rep) return `Potrebuješ reputáciu úrovne ${L.rep}.`;
  if (sv.coins < L.price) return 'Nemáš dosť mincí. 🪙';
  sv.coins -= L.price;
  dielna.loom = true;
  return null;
}

// Majster hodvábu: 6 hodvábu + mince → prikrývka hneď
function masterWeave(sv) {
  if (lacksSilk(sv)) return SILK_MSG;
  if (sv.coins < D.MASTER.price) return `Majster si za prácu pýta ${D.MASTER.price} 🪙.`;
  take(sv, 'silk', D.BLANKET_SILK);
  sv.coins -= D.MASTER.price;
  give(sv, 'blanket', 1);
  return null;
}

// Krosná: hráč (key) založí 6 hodvábu; prikrývka bude hotová v kroku at (2–4 herné hodiny, rnd = náhoda 0–1).
// Vráti { err } alebo { at } – volajúci si naplánuje udalosť loomDone.
function loomStart(dielna, sv, key, tick, rnd) {
  const L = D.DIELNA.loom;
  if (!dielna.built) return { err: 'Najprv treba postaviť Dielňu. Kúpiš ju na trhu (záložka Vylepšiť). 🪚' };
  if (!dielna.loom) return { err: `V Dielni ešte nie sú krosná. Kúpiš ich v Dielni za ${L.price} 🪙.` };
  if (dielna.job) return { err: dielna.job.key === key ? 'Krosná ti už tkajú prikrývku. 🧶' : 'Krosná práve tkajú prikrývku pre niekoho iného. Skús to neskôr. 🧶' };
  if (lacksSilk(sv)) return { err: SILK_MSG };
  take(sv, 'silk', D.BLANKET_SILK);
  const at = tick + L.min + Math.floor(rnd * (L.max - L.min + 1));
  dielna.job = { key, at };
  return { at };
}
// Udalosť loomDone: prikrývka je utkaná a čaká v Dielni na tkáča. Vráti true, ak sa naozaj dokončila.
function loomDone(dielna, key) {
  if (!dielna.job || dielna.job.key !== key) return false;
  dielna.job = null;
  dielna.ready[key] = (dielna.ready[key] || 0) + 1;
  return true;
}
// Tkáč si vezme hotové prikrývky. Vráti počet (0 = nič tam nie je).
function loomTake(dielna, sv, key) {
  const n = dielna.ready[key] | 0;
  if (!n) return 0;
  delete dielna.ready[key];
  give(sv, 'blanket', n);
  return n;
}

// Migrácia (#23): čo v starej záhrade stálo na novom pozemku Dielne a na mieste majstra, sa zo zeme odstráni
// a schová pre prvého hráča, ktorý príde. s = pôda políčka { r, p } → zoznam [id, počet]:
// kvitnúca rastlina → kvety (ako pri zbere), rastúca → 1 semienko, pohnojená pôda → 1 kompost, uhynutá ani holá zem nič.
function redeemOf(s) {
  const out = [], p = s && s.p, sp = p && D.SPECIES[p.sp];
  if (sp && !p.d) {
    if (p.prog >= sp.days) out.push(['fl_' + p.sp, Math.min(4, (p.q | 0) + (s.r ? 1 : 0))]);
    else out.push(['seed_' + p.sp, 1]);
  }
  if (s && s.r && !(sp && !p.d && p.prog >= sp.days)) out.push(['compost', 1]);
  return out.filter(([, n]) => n > 0);
}
// Políčka, ktoré migrácia uvoľní: pozemok Dielne a miesto majstra
function clearedIdx() { return lotIdx().concat([D.MASTER.y * D.W + D.MASTER.x]); }
// Zo starých uložených políčok (saved = pole { s } v poradí záhrady) vyberie, čo treba vrátiť, a pôdu tam zmaže.
// Vráti { id: počet } (prázdny objekt, ak tam nič nebolo).
function clearForDielna(saved) {
  const redeem = {};
  if (!Array.isArray(saved) || saved.length !== D.W * D.H) return redeem;
  for (const i of clearedIdx()) {
    const t = saved[i];
    if (!t || !t.s) continue;
    for (const [id, n] of redeemOf(t.s)) redeem[id] = (redeem[id] || 0) + n;
    t.s = null;
  }
  return redeem;
}
// Prvý hráč, ktorý príde: dostane všetko schované (redeem = { id: počet }, po odovzdaní prázdny). Vráti zoznam odovzdaného.
function handRedeem(redeem, sv, tick) {
  const out = [];
  for (const id of Object.keys(redeem || {})) {
    const n = redeem[id] | 0;
    if (n > 0) { I.addItems(I.playerC(sv), id, n, tick); out.push([id, n]); }
    delete redeem[id];
  }
  return out;
}

module.exports = { newDielna, loadDielna, lotIdx, applyDielna, nearDielna, masterCheck, buildDielna, buyLoom, masterWeave, loomStart, loomDone, loomTake, redeemOf, clearedIdx, clearForDielna, handRedeem };
