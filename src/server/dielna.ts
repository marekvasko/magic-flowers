// Pavúčí hodváb (#23): majster hodvábu, Dielňa s krosnami a hodvábne prikrývky (izolácia ľadovne je v ice.js).
// Čisté funkcie nad výrezmi sveta: dielna = { built, loom, job: { key, at } | null, ready: { kľúč: počet } } (world.dielna),
// tiles = políčka záhrady, sv = uloženie hráča. Prikrývka je zo 6 hodvábu: u majstra hneď za mince, na krosnách
// zadarmo, ale krosná tká 2–4 herné hodiny a naraz len jednu prikrývku. Hotová počká v Dielni, kým si ju tkáč vezme.
import * as D from '../shared/data.ts';
import type { ItemId } from '../shared/data.ts';
import type { Dielna, Inventory, Objects, PlayerKey, PlayerSave, Soil } from '../shared/save.ts';
import * as Obj from '../shared/objects.ts';
import { isArray, isRecord, keys, lookup, must } from '../shared/util.ts';
import * as I from './items.ts';
import type { Presence, Tile } from './world.ts';

export const newDielna = (): Dielna => ({ built: false, loom: false, job: null, ready: {} });
// Uloženie zo staršej verzie alebo poškodené → doplní chýbajúce časti (ostatné polia uloženia ostanú, ako boli)
export function loadDielna(saved: unknown): Dielna {
  const src = isRecord(saved) ? saved : {}, job = src['job'], ready = src['ready'];
  const built = !!src['built'];
  const jobKey = isRecord(job) ? job['key'] : undefined, jobAt = isRecord(job) ? job['at'] : undefined;
  return {
    ...newDielna(), ...src, built, loom: !!(built && src['loom']),
    job: typeof jobKey === 'string' && typeof jobAt === 'number' && Number.isFinite(jobAt) ? { key: jobKey, at: jobAt } : null,
    ready: isRecord(ready) ? readyOf(ready) : {}
  };
}
// Hotové prikrývky z uloženia: kľúč hráča → počet (hodnoty sa berú, ako sú – v uložení sú vždy čísla)
function readyOf(r: { [key: string]: unknown }): Dielna['ready'] {
  const out: Dielna['ready'] = {};
  for (const k of Object.keys(r)) { const n = r[k]; if (typeof n === 'number') out[k] = n; }
  return out;
}

// Pozemok Dielne v záhrade (objekt, #178): kým nie je postavená 'lot', potom 'dielna'. Bez pozemku žiadne políčka.
export function lotIdx(objects: Objects | null | undefined): number[] { return Obj.rectIdx(Obj.lotRect(objects, 'dielna')); }
export function applyDielna(dielna: Pick<Dielna, 'built'> | null | undefined, tiles: readonly Tile[], objects: Objects | null | undefined): void {
  Obj.applyLot(tiles, objects, 'dielna', !!dielna && dielna.built);
}
// Hráč stojí pri Dielni / pri majstrovi (p = záznam prítomnosti)
type Where = Pick<Presence, 'area' | 'x' | 'y'> | null | undefined;
function near(p: Where, x: number, y: number, r: number): boolean { return !!p && p.area === 'garden' && Math.hypot(p.x - x, p.y - y) <= r; }
export function nearDielna(p: Where, objects: Objects | null | undefined): boolean { const L = Obj.lotRect(objects, 'dielna'), c = L && Obj.center(L); return !!c && near(p, c.x, c.y, 3); }
// Majster hodvábu v kroku tick (D.masterAt): '' = hráč p u neho môže tkať, inak dôvod odmietnutia; dielna = world.dielna (krosná)
const MASTER_GONE = 'Odkedy sú v Dielni krosná, majster hodvábu do dedinky nechodí. Prikrývky ti utkajú krosná. 🧶';
export function masterCheck(p: Where, tick: number, dielna: Pick<Dielna, 'loom'> | null | undefined): string {
  if (dielna && dielna.loom) return MASTER_GONE;
  const m = D.masterAt(D.dayOfTick(tick), D.minOfTick(tick));
  if (!m) return 'Majster hodvábu je preč – do dedinky chodí len na jar a na jeseň. 🧵';
  if (!m.still) return D.masterRoadText(m);
  if (!near(p, m.x, m.y, 2.5)) return m.where === 'hut' ? 'Majster hodvábu je na noc u babky v chalúpke – podíď k nemu.' : 'Podíď bližšie k majstrovi hodvábu.';
  return '';
}

const take = (sv: PlayerSave, id: ItemId, n: number): void => { I.removeItems(I.playerC(sv), id, n, 0); };
const give = (sv: PlayerSave, id: ItemId, n: number): void => { I.addItems(I.playerC(sv), id, n, 0); };
const lacksSilk = (sv: PlayerSave): boolean => (sv.inv.silk || 0) < D.BLANKET_SILK;
const SILK_MSG = `Na prikrývku treba ${String(D.BLANKET_SILK)}× pavúčí hodváb. Nájdeš ho v pavučinách v Lese divov. 🕸️`;

// Kúpa Dielne (spoločná stavba, platí ju hráč): pozemok v tiles dostane budovu. Vráti chybu alebo null.
export function buildDielna(dielna: Dielna, tiles: readonly Tile[], sv: PlayerSave, objects: Objects | null | undefined): string | null {
  const B = D.DIELNA;
  if (dielna.built) return 'Dielňa už v záhrade stojí.';
  if (!Obj.lotOf(objects, 'dielna')) return 'Pre Dielňu zatiaľ nie je vymeraný pozemok.';
  if (D.repLevel(sv.rep || 0) < B.rep) return `Potrebuješ reputáciu úrovne ${String(B.rep)}.`;
  if (sv.coins < B.price) return 'Nemáš dosť mincí. 🪙';
  if (lotIdx(objects).some(i => must(tiles[i]).s)) return 'Na pozemku vedľa trhu je prekopaná zem. Najprv ju zarovnaj motykou.';
  sv.coins -= B.price;
  dielna.built = true;
  applyDielna(dielna, tiles, objects);
  return null;
}
// Kúpa krosien do Dielne (spoločné ako Dielňa)
export function buyLoom(dielna: Dielna, sv: PlayerSave): string | null {
  const L = D.DIELNA.loom;
  if (!dielna.built) return 'Najprv treba postaviť Dielňu. Kúpiš ju na trhu (záložka Vylepšiť). 🪚';
  if (dielna.loom) return 'Krosná už v Dielni sú.';
  if (D.repLevel(sv.rep || 0) < L.rep) return `Potrebuješ reputáciu úrovne ${String(L.rep)}.`;
  if (sv.coins < L.price) return 'Nemáš dosť mincí. 🪙';
  sv.coins -= L.price;
  dielna.loom = true;
  return null;
}

// Majster hodvábu: 6 hodvábu + mince → prikrývka hneď
export function masterWeave(sv: PlayerSave): string | null {
  if (lacksSilk(sv)) return SILK_MSG;
  if (sv.coins < D.MASTER.price) return `Majster si za prácu pýta ${String(D.MASTER.price)} 🪙.`;
  take(sv, 'silk', D.BLANKET_SILK);
  sv.coins -= D.MASTER.price;
  give(sv, 'blanket', 1);
  return null;
}

// Krosná: hráč (key) založí 6 hodvábu; prikrývka bude hotová v kroku at (2–4 herné hodiny, rnd = náhoda 0–1).
// Vráti { err } alebo { at } – volajúci si naplánuje udalosť loomDone.
export function loomStart(dielna: Dielna, sv: PlayerSave, key: PlayerKey, tick: number, rnd: number): { err: string } | { at: number } {
  const L = D.DIELNA.loom;
  if (!dielna.built) return { err: 'Najprv treba postaviť Dielňu. Kúpiš ju na trhu (záložka Vylepšiť). 🪚' };
  if (!dielna.loom) return { err: `V Dielni ešte nie sú krosná. Kúpiš ich v Dielni za ${String(L.price)} 🪙.` };
  if (dielna.job) return { err: dielna.job.key === key ? 'Krosná ti už tkajú prikrývku. 🧶' : 'Krosná práve tkajú prikrývku pre niekoho iného. Skús to neskôr. 🧶' };
  if (lacksSilk(sv)) return { err: SILK_MSG };
  take(sv, 'silk', D.BLANKET_SILK);
  const at = tick + L.min + Math.floor(rnd * (L.max - L.min + 1));
  dielna.job = { key, at };
  return { at };
}
// Udalosť loomDone: prikrývka je utkaná a čaká v Dielni na tkáča. Vráti true, ak sa naozaj dokončila.
export function loomDone(dielna: Dielna, key: PlayerKey): boolean {
  if (!dielna.job || dielna.job.key !== key) return false;
  dielna.job = null;
  dielna.ready[key] = (dielna.ready[key] || 0) + 1;
  return true;
}
// Tkáč si vezme hotové prikrývky. Vráti počet (0 = nič tam nie je).
export function loomTake(dielna: Dielna, sv: PlayerSave, key: PlayerKey): number {
  const n = (dielna.ready[key] ?? 0) | 0;
  if (!n) return 0;
  delete dielna.ready[key];
  give(sv, 'blanket', n);
  return n;
}

// Migrácia (#23): čo v starej záhrade stálo na novom pozemku Dielne a na mieste majstra, sa zo zeme odstráni
// a schová pre prvého hráča, ktorý príde. s = pôda políčka { r, p } → zoznam [id, počet]:
// kvitnúca rastlina → kvety (ako pri zbere), rastúca → 1 semienko, pohnojená pôda → 1 kompost, uhynutá ani holá zem nič.
export function redeemOf(s: Soil | null | undefined): [ItemId, number][] {
  const out: [ItemId, number][] = [], p = s && s.p, sp = p ? lookup(D.SPECIES, p.sp) : undefined;
  if (p && sp && !p.d) {
    if (p.prog >= sp.days) out.push([`fl_${p.sp}`, Math.min(4, (p.q | 0) + (s.r ? 1 : 0))]);
    else out.push([`seed_${p.sp}`, 1]);
  }
  if (s && s.r && !(p && sp && !p.d && p.prog >= sp.days)) out.push(['compost', 1]);
  return out.filter(([, n]) => n > 0);
}
// Políčka, ktoré migrácia uvoľní: pozemok Dielne a miesto majstra
export function clearedIdx(): number[] { return Obj.rectIdx(Obj.defaultRect('dielna')).concat([D.MASTER.y * D.W + D.MASTER.x]); } // migrácia v11: pôvodné miesto pozemku
// Zo starých uložených políčok (saved = pole { s } v poradí záhrady) vyberie, čo treba vrátiť, a pôdu tam zmaže.
// Vráti { id: počet } (prázdny objekt, ak tam nič nebolo).
export function clearForDielna(saved: unknown): Inventory {
  const redeem: Inventory = {};
  if (!isArray(saved) || saved.length !== D.W * D.H) return redeem;
  for (const i of clearedIdx()) {
    const t = saved[i];
    if (!isRecord(t) || !t['s']) continue;
    // pôda zo staršieho uloženia (v11 a skôr) má tvar Soil – zapísal ju server, nie klient
    for (const [id, n] of redeemOf(t['s'] as Soil)) redeem[id] = (redeem[id] || 0) + n;
    t['s'] = null;
  }
  return redeem;
}
// Prvý hráč, ktorý príde: dostane všetko schované (redeem = { id: počet }, po odovzdaní prázdny). Vráti zoznam odovzdaného.
export function handRedeem(redeem: Inventory | null | undefined, sv: PlayerSave, tick: number): [ItemId, number][] {
  const out: [ItemId, number][] = [];
  if (!redeem) return out;
  for (const id of keys(redeem)) {
    const n = (redeem[id] ?? 0) | 0;
    if (n > 0) { I.addItems(I.playerC(sv), id, n, tick); out.push([id, n]); }
    delete redeem[id];
  }
  return out;
}
