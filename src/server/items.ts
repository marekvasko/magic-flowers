// Predmety v batohu a v sklade. Odrezané kvety (fl_*) majú várky s vekom, aby mohli postupne vädnúť.
// Kontajner: { inv: {id: počet}, fb: {id: [várka]}, rate, sv? }   várka: { n, a: vek v krokoch k času at, at }
// Pravidlo: inv[id] je vždy súčet várok fb[id]. Odoberá sa najstaršie (FIFO).
import * as D from '../shared/data.ts';
import type { ItemId } from '../shared/data.ts';
import type { Icehouse, PlayerSave } from '../shared/save.ts';
import type { BatchesView } from '../shared/protocol.ts';
import { keys, must } from '../shared/util.ts';
import type { Container, MovedBatch } from './world.ts';

export const isFlower = (id: string): boolean => id.startsWith('fl_');
// várky s vekom majú odrezané kvety (vädnú) a ľad (topí sa)
const batched = (id: string): boolean => isFlower(id) || id === 'ice';

export function playerC(sv: PlayerSave): Container { sv.fb = sv.fb || {}; return { inv: sv.inv, fb: sv.fb, rate: 1, sv }; }
// V sklade kvety starnú pomalšie; kým je v ľadovni ľad (icehouse = world.icehouse), ešte pomalšie.
export function storageRate(icehouse: Pick<Icehouse, 'ice'> | null | undefined): number { return icehouse && icehouse.ice > 0 ? D.ICEHOUSE.rate : D.STORAGE_AGE_RATE; }
// Sklad ako kontajner: st = výrez 'storage' { inv, fb } (world.storage + world.storageFb), icehouse = výrez 'icehouse'
export function storageC(st: Pick<Container, 'inv'> & Partial<Pick<Container, 'fb'>>, icehouse?: Pick<Icehouse, 'ice'> | null): Container {
  const fb = st.fb = st.fb || {};
  return { inv: st.inv, fb, rate: storageRate(icehouse) };
}

// Pred zmenou rýchlosti starnutia kontajnera zapíšeme každej várke jej doterajší vek k času tick,
// aby nová rýchlosť platila až odteraz (vek sa nesmie skokovo zmeniť).
export function rebase(c: Container, tick: number): void {
  for (const id of keys(c.fb)) for (const b of c.fb[id] || []) { b.a = D.batchAge(b, tick, c.rate); b.at = tick; }
}

// batches: várky z iného kontajnera ({n, age}) – pri presune si kvety nesú svoj vek
export function addItems(c: Container, id: ItemId, n: number, tick: number, batches?: MovedBatch[] | null): void {
  if (n <= 0) return;
  c.inv[id] = (c.inv[id] || 0) + n;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- uloženia spred herbára pole seen nemajú (migrateSave ho nedopĺňa)
  if (c.sv && c.sv.seen) {
    const sp = D.speciesOfItem(id);
    if (sp && !c.sv.seen.includes(sp)) c.sv.seen.push(sp);
  }
  if (!batched(id)) return;
  const list = c.fb[id] || (c.fb[id] = []);
  for (const b of batches || [{ n, age: 0 }]) {
    // rovnako staré kvety spojíme do jednej várky
    const same = list.find(x => Math.abs(D.batchAge(x, tick, c.rate) - b.age) < 5 / D.MIN_PER_TICK); // do 5 herných minút
    if (same) same.n += b.n;
    else list.push({ n: b.n, a: b.age, at: tick });
  }
  list.sort((x, y) => D.batchAge(y, tick, c.rate) - D.batchAge(x, tick, c.rate)); // najstaršie prvé
}

// Vráti odobraté várky [{n, age}] (pre nekvety jednu várku s vekom 0) alebo null, ak toho nie je dosť.
export function removeItems(c: Container, id: ItemId, n: number, tick: number): MovedBatch[] | null {
  const have = c.inv[id] || 0;
  if (n <= 0 || have < n) return null;
  if (have === n) delete c.inv[id]; else c.inv[id] = have - n;
  if (!batched(id)) return [{ n, age: 0 }];
  const list = syncBatches(c, id, tick, have), out: MovedBatch[] = [];
  let left = n;
  while (left > 0 && list.length) {
    const b = must(list[0]), k = Math.min(left, b.n);
    out.push({ n: k, age: D.batchAge(b, tick, c.rate) });
    b.n -= k; left -= k;
    if (!b.n) list.shift();
  }
  if (!list.length) delete c.fb[id];
  return out;
}

// Ak by várky nesedeli s počtom (staré uloženia, ručné úpravy), dorovnáme ich. Vráti zoznam várok predmetu.
function syncBatches(c: Container, id: ItemId, tick: number, count: number): D.Batch[] {
  const list = c.fb[id] || (c.fb[id] = []);
  let sum = list.reduce((s, b) => s + b.n, 0);
  if (sum < count) list.push({ n: count - sum, a: 0, at: tick });
  while (sum > count && list.length) { const b = must(list[0]), k = Math.min(b.n, sum - count); b.n -= k; sum -= k; if (!b.n) list.shift(); }
  return list;
}
export function syncAll(c: Container, tick: number): void {
  for (const id of keys(c.inv)) if (batched(id)) syncBatches(c, id, tick, c.inv[id] || 0);
  for (const id of keys(c.fb)) if (!c.inv[id]) delete c.fb[id];
}

// Kvety staršie než ich životnosť zvädnú – zmenia sa na „zvädnuté kvety“. Vráti {meno druhu: počet}.
export function wiltSweep(c: Container, tick: number): Record<string, number> {
  const wilted: Record<string, number> = {};
  for (const id of keys(c.fb)) {
    const sp = isFlower(id) ? D.speciesOfItem(id) : null;
    if (!sp) continue;
    const life = D.SPECIES[sp].life * D.TICKS_PER_DAY;
    let k = 0;
    const list = (c.fb[id] || []).filter(b => { if (D.batchAge(b, tick, c.rate) >= life) { k += b.n; return false; } return true; });
    c.fb[id] = list;
    if (!list.length) delete c.fb[id];
    if (k) {
      const left = (c.inv[id] || 0) - k;
      c.inv[id] = left; if (left <= 0) delete c.inv[id];
      c.inv.wilted = (c.inv.wilted || 0) + k;
      wilted[D.SPECIES[sp].name] = k;
    }
  }
  return wilted;
}

// Ľad starší než D.ICE_LIFE sa roztopí (zmizne). Vráti, koľko kusov sa roztopilo.
export function meltSweep(c: Container, tick: number): number {
  const list = c.fb.ice;
  if (!list) return 0;
  let k = 0;
  const left = list.filter(b => { if (D.batchAge(b, tick, c.rate) >= D.ICE_LIFE) { k += b.n; return false; } return true; });
  c.fb.ice = left;
  if (!left.length) delete c.fb.ice;
  if (k) { const ice = (c.inv.ice || 0) - k; c.inv.ice = ice; if (ice <= 0) delete c.inv.ice; }
  return k;
}

// Pre klienta: várky s aktuálnym vekom
export function batchesView(c: Container, tick: number): BatchesView {
  const out: BatchesView = {};
  for (const id of keys(c.fb)) out[id] = (c.fb[id] || []).map(b => ({ n: b.n, age: Math.round(D.batchAge(b, tick, c.rate)) }));
  return out;
}
