// Predmety v batohu a v sklade. Odrezané kvety (fl_*) majú várky s vekom, aby mohli postupne vädnúť.
// Kontajner: { inv: {id: počet}, fb: {id: [várka]}, rate, sv? }   várka: { n, a: vek v krokoch k času at, at }
// Pravidlo: inv[id] je vždy súčet várok fb[id]. Odoberá sa najstaršie (FIFO).
const D = require('./shared/data.js');

const isFlower = id => id.startsWith('fl_');
// várky s vekom majú odrezané kvety (vädnú) a ľad (topí sa)
const batched = id => isFlower(id) || id === 'ice';

function playerC(sv) { sv.fb = sv.fb || {}; return { inv: sv.inv, fb: sv.fb, rate: 1, sv }; }
// V sklade kvety starnú pomalšie; kým je v ľadovni ľad, ešte pomalšie.
function storageRate(room) { return room.icehouse && room.icehouse.ice > 0 ? D.ICEHOUSE.rate : D.STORAGE_AGE_RATE; }
function storageC(room) { room.storageFb = room.storageFb || {}; return { inv: room.storage, fb: room.storageFb, rate: storageRate(room) }; }

// Pred zmenou rýchlosti starnutia kontajnera zapíšeme každej várke jej doterajší vek k času tick,
// aby nová rýchlosť platila až odteraz (vek sa nesmie skokovo zmeniť).
function rebase(c, tick) {
  for (const id in c.fb) for (const b of c.fb[id]) { b.a = D.batchAge(b, tick, c.rate); b.at = tick; }
}

// batches: várky z iného kontajnera ({n, age}) – pri presune si kvety nesú svoj vek
function addItems(c, id, n, tick, batches) {
  if (n <= 0) return;
  c.inv[id] = (c.inv[id] || 0) + n;
  if (c.sv && c.sv.seen) {
    const sp = id.startsWith('seed_') ? id.slice(5) : isFlower(id) ? id.slice(3) : null;
    if (sp && !c.sv.seen.includes(sp)) c.sv.seen.push(sp);
  }
  if (!batched(id)) return;
  const list = c.fb[id] || (c.fb[id] = []);
  for (const b of batches || [{ n, age: 0 }]) {
    // rovnako staré kvety spojíme do jednej várky
    const same = list.find(x => Math.abs(D.batchAge(x, tick, c.rate) - b.age) < 1);
    if (same) same.n += b.n;
    else list.push({ n: b.n, a: b.age, at: tick });
  }
  list.sort((x, y) => D.batchAge(y, tick, c.rate) - D.batchAge(x, tick, c.rate)); // najstaršie prvé
}

// Vráti odobraté várky [{n, age}] (pre nekvety jednu várku s vekom 0) alebo null, ak toho nie je dosť.
function removeItems(c, id, n, tick) {
  const have = c.inv[id] || 0;
  if (n <= 0 || have < n) return null;
  if (have === n) delete c.inv[id]; else c.inv[id] = have - n;
  if (!batched(id)) return [{ n, age: 0 }];
  syncBatches(c, id, tick, have);
  const list = c.fb[id], out = [];
  let left = n;
  while (left > 0 && list.length) {
    const b = list[0], k = Math.min(left, b.n);
    out.push({ n: k, age: D.batchAge(b, tick, c.rate) });
    b.n -= k; left -= k;
    if (!b.n) list.shift();
  }
  if (!list.length) delete c.fb[id];
  return out;
}

// Ak by várky nesedeli s počtom (staré uloženia, ručné úpravy), dorovnáme ich.
function syncBatches(c, id, tick, count) {
  const list = c.fb[id] || (c.fb[id] = []);
  let sum = list.reduce((s, b) => s + b.n, 0);
  if (sum < count) list.push({ n: count - sum, a: 0, at: tick });
  while (sum > count && list.length) { const b = list[0], k = Math.min(b.n, sum - count); b.n -= k; sum -= k; if (!b.n) list.shift(); }
}
function syncAll(c, tick) {
  for (const id of Object.keys(c.inv)) if (batched(id)) syncBatches(c, id, tick, c.inv[id]);
  for (const id of Object.keys(c.fb)) if (!c.inv[id]) delete c.fb[id];
}

// Kvety staršie než ich životnosť zvädnú – zmenia sa na „zvädnuté kvety“. Vráti {meno druhu: počet}.
function wiltSweep(c, tick) {
  const wilted = {};
  for (const id of Object.keys(c.fb)) {
    if (!isFlower(id)) continue;
    const sp = id.slice(3), life = D.SPECIES[sp].life * D.TICKS_PER_DAY;
    let k = 0;
    c.fb[id] = c.fb[id].filter(b => { if (D.batchAge(b, tick, c.rate) >= life) { k += b.n; return false; } return true; });
    if (!c.fb[id].length) delete c.fb[id];
    if (k) {
      c.inv[id] -= k; if (c.inv[id] <= 0) delete c.inv[id];
      c.inv.wilted = (c.inv.wilted || 0) + k;
      wilted[D.SPECIES[sp].name] = k;
    }
  }
  return wilted;
}

// Ľad starší než D.ICE_LIFE sa roztopí (zmizne). Vráti, koľko kusov sa roztopilo.
function meltSweep(c, tick) {
  const list = c.fb.ice;
  if (!list) return 0;
  let k = 0;
  c.fb.ice = list.filter(b => { if (D.batchAge(b, tick, c.rate) >= D.ICE_LIFE) { k += b.n; return false; } return true; });
  if (!c.fb.ice.length) delete c.fb.ice;
  if (k) { c.inv.ice -= k; if (c.inv.ice <= 0) delete c.inv.ice; }
  return k;
}

// Pre klienta: várky s aktuálnym vekom
function batchesView(c, tick) {
  const out = {};
  for (const id in c.fb) out[id] = c.fb[id].map(b => ({ n: b.n, age: Math.round(D.batchAge(b, tick, c.rate)) }));
  return out;
}

module.exports = { isFlower, playerC, storageC, storageRate, rebase, addItems, removeItems, syncAll, wiltSweep, meltSweep, batchesView };
