// Ceny riadku trhu (#112, src/shared/quote.ts): mierka posuvníka a prechod knihou, ktorý klient ukáže na tlačidle.
// Hlavne: čo klient predpovie z knihy, ktorú mu server pošle (Mkt.levels), musí server naozaj vybaviť – rovnaký počet
// kusov a rovnaká suma mincí pri okamžitom nákupe aj predaji, aj s vlastnými objednávkami v knihe a s kvetmi pre postavy.
import { test } from 'node:test';
import assert from 'node:assert';
import * as D from '../src/shared/data.ts';
import type { ItemId } from '../src/shared/data.ts';
import * as Qt from '../src/shared/quote.ts';
import * as E from '../src/server/engine.ts';
import * as I from '../src/server/items.ts';
import * as Mkt from '../src/server/market.ts';
import * as Actions from '../src/server/actions.ts';
import { SPEC, TPD, act, give, makeWorld, save } from './game-world.ts';
import type { W } from './game-world.ts';
import { must } from './helpers.ts';

// deterministická náhoda (mulberry32)
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
}
const run = (w: W, ...inputs: E.Input[]): void => { E.commitBatch(w, inputs, SPEC); };
const boxN = (w: W, key: string, item: ItemId): number => save(w, key).box?.inv[item] || 0;

test('mierka posuvníka: trh v strede, toX a toP sú navzájom inverzné a rastú, povinné ceny sú na posuvníku', () => {
  const tr: [number, number][] = [[30, 1], [36, 2], [40, 6], [41, 8], [42, 9], [43, 7], [45, 6], [48, 2], [57, 1]];
  const sc = Qt.scaleOf(42, tr, [70, 20]);
  assert.strictEqual(sc.toX(42), 0.5, 'trhová cena v strede');
  assert.ok(sc.lo <= 20 && sc.hi >= 70, 'povinné ceny (kniha, zvolená cena) sú na posuvníku');
  let prev = -1;
  for (let p = sc.lo; p <= sc.hi; p++) {
    const x = sc.toX(p);
    assert.ok(x > prev, `toX rastie (${String(p)})`);
    assert.ok(Math.abs(sc.toP(x) - p) < 1e-6, `toP(toX(${String(p)})) = ${String(p)}`);
    prev = x;
  }
  // každá minca má skoro rovnakú dĺžku: najdlhšia najviac asi 2× najkratšia
  const steps: number[] = [];
  for (let p = sc.lo; p < sc.hi; p++) steps.push(sc.toX(p + 1) - sc.toX(p));
  assert.ok(Math.max(...steps) / Math.min(...steps) < 2.2, 'kroky mincí sú vyrovnané');
});

test('prázdna kniha a tovar bez knihy: predvolená cena je náhradná, pevná cena sa násobí počtom', () => {
  const empty = Qt.quoter([], 'buy', new Set(), { fixed: 0, fallback: 33 });
  assert.deepStrictEqual([empty.defPrice(3), empty.market(), empty.quote(3, 33)], [33, 33, { now: false, total: 99 }]);
  const fixed = Qt.quoter(null, 'sell', new Set(), { fixed: 7, fallback: 7 });
  assert.deepStrictEqual([fixed.quote(4, 7), fixed.limit(0, 5)], [{ now: true, total: 28 }, 5]);
});

// Klient vidí knihu tak, ako ju pošle server (Mkt.levels) a svoje objednávky (Mkt.ordersView); pri predaji kvetov
// pozná čerstvosť svojich kusov (batchesView, najstaršie prvé) – rovnako ako sellFresh v game.ts
function clientQuoter(w: W, key: string, item: ItemId, side: Qt.Side): Qt.Quoter {
  const sv = save(w, key), m = w.market, tick = w.tick;
  const book = Mkt.levels(m, item, side === 'buy' ? 'sell' : 'buy', tick);
  const mine = new Set(Mkt.ordersView(m, sv, tick).map(o => o.id));
  const sp = D.speciesOfItem(item), list = I.batchesView(I.playerC(sv), tick)[item] ?? [];
  const fresh = side === 'sell' && item.startsWith('fl_') && sp ? (i: number): number => {
    for (const b of list) { if (i < b.n) return D.freshness(sp, b.age); i -= b.n; }
    return 1;
  } : undefined;
  return Qt.quoter(book, side, mine, { fixed: 0, fallback: book[0]?.p ?? 1, fresh });
}

test('klient = server: okamžitý nákup a predaj vybaví toľko kusov a za toľko mincí, koľko ukáže tlačidlo (aj s vlastnými objednávkami a kvetmi pre postavy)', () => {
  const items: ItemId[] = ['fl_ruza', 'seed_ruza', 'compost', 'fl_slnecnica'];
  let checked = 0, withOwn = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const w = makeWorld(900 + seed), r = rng(seed);
    w.presence = (w.presence || []).map(p => ({ ...p, x: Actions.STALL.x, y: Actions.STALL.y + 1 }));
    for (const key of ['ana', 'bob']) {
      save(w, key).coins = 20000;
      for (const item of items) give(save(w, key), item, 30, w.tick - Math.floor(r() * TPD * 2));
    }
    for (let step = 0; step < 25; step++) {
      const item = must(items[Math.floor(r() * items.length)]), key = r() < 0.5 ? 'ana' : 'bob';
      const bid = Mkt.levels(w.market, item, 'buy', w.tick)[0]?.p ?? 5, ask = Mkt.levels(w.market, item, 'sell', w.tick)[0]?.p ?? bid + 10;
      // náhodné čakajúce objednávky okolo trhu (aj vlastné, ktoré sa potom prekrývajú)
      if (r() < 0.6) {
        const s = r() < 0.5 ? 'buy' : 'sell', p = Math.max(1, Math.round((s === 'buy' ? bid : ask) * (0.85 + r() * 0.3)));
        run(w, act('order', key, { id: item, side: s, n: 1 + Math.floor(r() * 4), p }));
        continue;
      }
      const side: Qt.Side = r() < 0.5 ? 'buy' : 'sell', Q = clientQuoter(w, key, item, side);
      if (!Q.all.length) continue;
      const n = 1 + Math.floor(r() * Math.min(12, Q.bookAvail + 3));
      // limit: niekedy cena, za ktorú sa vybaví všetko (predvolená), inak náhodná úroveň knihy
      const lim = r() < 0.5 ? Q.defPrice(n) : must(Q.all[Math.floor(r() * Q.all.length)]).p;
      const want = Q.walk(n, lim);
      if (!want.n) continue;
      if (Q.all.slice(0, 50).some(l => Q.isMine(l))) withOwn++;
      const sv = save(w, key), coins0 = sv.coins, inv0 = sv.inv[item] || 0, box0 = boxN(w, key, item);
      run(w, act(side, key, { id: item, n, lim }));
      const dCoins = sv.coins - coins0, dInv = (sv.inv[item] || 0) - inv0, dBox = boxN(w, key, item) - box0;
      const what = `${item} ${side} ${String(n)} ks po ${String(lim)} (svet ${String(seed)}, krok ${String(step)})`;
      // vlastné kusy v knihe, na ktoré okamžitý príkaz narazí (prekryv sa zruší): koľko a za akú zálohu
      let left = n, ownK = 0, ownVal = 0;
      for (const l of Q.all) {
        if (left <= 0 || (side === 'buy' ? l.p > lim : l.p < lim)) break;
        const k = Math.min(l.n, left); left -= k;
        if (Q.isMine(l)) { ownK += k; ownVal += k * l.p; }
      }
      if (side === 'buy') {
        assert.strictEqual(coins0 - sv.coins, want.total, `${what}: zaplatené (vlastné kusy za 0)`);
        assert.strictEqual(dInv, want.n - ownK, `${what}: kúpené kusy do batohu`);
        assert.strictEqual(dBox, ownK, `${what}: z vlastnej ponuky na vyzdvihnutie`);
      } else {
        assert.strictEqual(dCoins, want.total + ownVal, `${what}: utŕžené + záloha zrušenej časti vlastného dopytu`);
        assert.strictEqual(inv0 - (sv.inv[item] || 0), want.n - ownK, `${what}: predané kusy; pre vlastný dopyt ostali v batohu`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 60, `porovnaných obchodov: ${String(checked)}`);
  assert.ok(withOwn >= 5, `z toho s vlastnou objednávkou v knihe: ${String(withOwn)}`);
});
