// Kniha objednávok (#112): párovanie (cena čakajúcej objednávky, cena a čas, starnutie), záloha, čiastočné obchody,
// zrušenie, vypršanie, limit objednávok, obchody offline, súboje v jednom kroku, postavy a veľkoobchodník, zachovanie
// tovaru a mincí, prevod uloženia v11.
import { test } from 'node:test';
import assert from 'node:assert';
import * as D from '../src/shared/data.ts';
import type { Batch, ItemId } from '../src/shared/data.ts';
import * as B from '../src/shared/book.ts';
import type { Market, Order } from '../src/shared/save.ts';
import * as E from '../src/server/engine.ts';
import * as Econ from '../src/server/economy.ts';
import * as I from '../src/server/items.ts';
import * as Mkt from '../src/server/market.ts';
import * as Actions from '../src/server/actions.ts';
import { TPD, SPEC, act, give, makeWorld, save, textOf } from './game-world.ts';
import type { W } from './game-world.ts';
import { must } from './helpers.ts';

const FL: ItemId = 'fl_ruza';
const orders = (w: W, item: ItemId): Order[] => Object.values(must(w.market.books[item]).orders).filter((o): o is Order => !!o);
const players = (w: W, item: ItemId): Order[] => orders(w, item).filter(o => o.pl != null);
// Najvyšší dopyt postáv po tovare (nad ním hráčske ponuky nikoho iného nezaujímajú)
const topBid = (w: W, item: ItemId): number => Math.max(0, ...orders(w, item).filter(o => o.side === 'buy').map(o => o.p));
// Na vyzdvihnutie na trhu (kúpené cez Dopyt, vrátené, zvädnuté)
const boxed = (w: W, key: string, item: ItemId): number => save(w, key).box?.inv[item] || 0;
// Hráč sa postaví k trhovému stánku (vyzdvihnúť tovar a zrušiť objednávku sa dá len tam)
function atStall(w: W, ...who: string[]): void {
  w.presence = (w.presence || []).map(p => (who.includes(p.key) ? { ...p, x: Actions.STALL.x, y: Actions.STALL.y + 1 } : p));
}
// Veky kvetov tovaru v kontajneri (batoh, na vyzdvihnutie, záloha ponuky): po kusoch, zoradené
const ages = (fb: readonly Batch[] | undefined, tick: number): number[] => (fb || []).flatMap(b => Array<number>(b.n).fill(Math.round(D.batchAge(b, tick, 1)))).sort((a, b) => a - b);
const run = (w: W, ...inputs: E.Input[]): E.BatchOut<never, never> => E.commitBatch(w, inputs, SPEC) as unknown as E.BatchOut<never, never>;
// Všetky mince v záhrade (hráči, postavy, zálohy dopytov) a kusy tovaru (batohy, účty, zálohy ponúk)
function coins(w: W): number {
  let c = 0;
  for (const sv of Object.values(w.saves)) c += must(sv).coins;
  for (const id of Mkt.TRADERS) c += w.market.npcs[id].coins;
  for (const item of Mkt.BOOK_ITEMS) { c += must(w.market.books[item]).vo.coins; for (const o of orders(w, item)) c += o.coins; }
  return c;
}
function units(w: W, item: ItemId): number {
  let n = 0;
  for (const sv of Object.values(w.saves)) n += (must(sv).inv[item] || 0) + (must(sv).box?.inv[item] || 0);
  for (const id of Mkt.TRADERS) n += w.market.npcs[id].inv[item] || 0;
  n += must(w.market.books[item]).vo.inv[item] || 0;
  for (const o of orders(w, item)) if (o.side === 'sell') n += o.rem;
  return n;
}
// Záloha každej objednávky sedí (dopyt: rem × p, ponuka: várky = rem) a zásoba veľkoobchodníka = jeho tovar + ponuky
function invariants(w: W): void {
  const m: Market = w.market;
  for (const item of Mkt.BOOK_ITEMS) {
    for (const o of orders(w, item)) {
      assert.ok(o.rem > 0, `${item}#${String(o.n)} prázdna objednávka v knihe`);
      if (o.side === 'buy') assert.strictEqual(o.coins, o.rem * o.p, `${item}#${String(o.n)} záloha dopytu`);
      if (o.side === 'sell' && o.fb) assert.strictEqual(o.fb.reduce((s, b) => s + b.n, 0), o.rem, `${item}#${String(o.n)} várky`);
    }
    const vo = must(m.books[item]).vo, st = (vo.inv[item] || 0) + orders(w, item).filter(o => o.npc === 'vo' && o.side === 'sell').reduce((s, o) => s + o.rem, 0);
    const sp = D.speciesOfItem(item);
    const e = !sp ? m.compost : item.startsWith('seed_') ? m.seeds[sp] : m.flowers[sp];
    assert.strictEqual(must(e).stock, st, `${item}: zásoba veľkoobchodníka`);
    // v knihe nezostal prekrytý pár rôznych vlastníkov
    const book = must(m.books[item]);
    for (const b of Mkt.side(book, 'buy', w.tick)) for (const a of Mkt.side(book, 'sell', w.tick)) {
      assert.ok(a.p > b.p || (a.pl != null ? a.pl === b.pl : a.npc === b.npc), `${item}: prekrytý dopyt ${String(b.p)} a ponuka ${String(a.p)}`);
    }
  }
  for (const [key, sv] of Object.entries(w.saves)) {
    const mine = Mkt.BOOK_ITEMS.flatMap(item => players(w, item).filter(o => o.pl === key).map(o => Mkt.orderId(item, o.n))).sort();
    assert.deepStrictEqual([...(must(sv).orders || [])].sort(), mine, `${key}: zoznam objednávok`);
  }
}

test('nový trh: veľkoobchodník má zásobu v ponukách po kusoch, okamžitý nákup ide po rebríku a zdražuje', () => {
  const w = makeWorld(1), sp = Econ.PLANTABLE.find(x => must(w.market.seeds[x]).stock >= 6) ?? 'mak', id: ItemId = `seed_${sp}`;
  invariants(w);
  const before = coins(w), u = units(w, id), p0 = Econ.seedPrice(w.market, w.tick, sp);
  const asks = Mkt.levels(w.market, id, 'sell', w.tick);
  assert.strictEqual(asks[0]?.p, p0, 'najlacnejšia ponuka = cena veľkoobchodníka');
  const r = run(w, act('buy', 'ana', { id, n: 5 }));
  assert.strictEqual(r.applied.length, 1);
  assert.strictEqual(save(w, 'ana').inv[id], 5);
  const walk = B.walk(asks, 5);
  assert.strictEqual(500 - save(w, 'ana').coins, walk.total, 'zaplatil presne súčet rebríka z pohľadu klienta');
  assert.ok(Econ.seedPrice(w.market, w.tick, sp) >= p0, 'cena po nákupe neklesla');
  assert.strictEqual(coins(w), before, 'mince sa nestratili ani nepribudli');
  assert.strictEqual(units(w, id), u, 'tovar sa nestratil');
  invariants(w);
});

test('cena obchodu je limit čakajúcej objednávky: dopyt 100 + ponuka 90 → 100, ponuka 90 + dopyt 100 → 90', () => {
  for (const bidFirst of [true, false]) {
    const w = makeWorld(2), T = topBid(w, FL), hi = T + 20, lo = T + 10;
    give(save(w, 'bob'), FL, 3, w.tick);
    const bid = act('order', 'ana', { id: FL, side: 'buy', n: 2, p: hi }), ask = act('order', 'bob', { id: FL, side: 'sell', n: 2, p: lo });
    if (bidFirst) { run(w, bid); run(w, ask); } else { run(w, ask); run(w, bid); }
    const price = bidFirst ? hi : lo;
    assert.strictEqual(boxed(w, 'ana', FL), 2, 'kúpené cez Dopyt čaká na trhu');
    assert.strictEqual(save(w, 'ana').inv[FL], undefined, 'do batohu sa neteleportuje');
    assert.strictEqual(save(w, 'ana').coins, 500 - 2 * price, 'kupujúci zaplatil cenu čakajúcej objednávky (rozdiel zálohy vrátený)');
    assert.strictEqual(save(w, 'bob').coins, 500 + 2 * price);
    assert.strictEqual(players(w, FL).length, 0, 'obe objednávky sú vybavené');
    invariants(w);
  }
});

test('čiastočný obchod: dopyt na 5, ponuka 3 → 3 kúpené, 2 čakajú so zálohou; zvyšok vybaví ďalšia ponuka', () => {
  const w = makeWorld(3), p = topBid(w, FL) + 10;
  give(save(w, 'bob'), FL, 5, w.tick); save(w, 'ana').coins = 5000;
  run(w, act('order', 'bob', { id: FL, side: 'sell', n: 3, p }));
  run(w, act('order', 'ana', { id: FL, side: 'buy', n: 5, p }));
  const [o] = players(w, FL);
  assert.ok(o && o.pl === 'ana' && o.rem === 2 && o.q === 5 && o.coins === 2 * p);
  assert.strictEqual(save(w, 'ana').coins, 5000 - 5 * p, '3 zaplatené + 2 v zálohe');
  run(w, act('sell', 'bob', { id: FL, n: 2, lim: p }));
  assert.strictEqual(boxed(w, 'ana', FL), 5);
  assert.match(run(w, act('collect', 'ana', { id: FL })).rejected[0]?.reject ?? '', /pri trhovom stánku/, 'od domčeka sa nevyzdvihne');
  atStall(w, 'ana');
  run(w, act('collect', 'ana', { id: FL }));
  assert.deepStrictEqual([save(w, 'ana').inv[FL], save(w, 'ana').box], [5, undefined], 'vyzdvihnuté do batohu');
  assert.strictEqual(run(w, act('collect', 'ana', { id: FL })).rejected[0]?.reject, 'Tu nič nečaká.');
  assert.strictEqual(players(w, FL).length, 0);
  invariants(w);
});

test('kvety v ponuke si nesú vek a vädnú v nej: zvädnuté idú predávajúcemu na vyzdvihnutie, ponuka ukáže, koľko zvädlo', () => {
  const w = makeWorld(4), p = topBid(w, FL) + 10, life = D.SPECIES.ruza.life * TPD, half = Math.floor(life / 2);
  give(save(w, 'bob'), FL, 2, w.tick - half);   // dva staré kvety
  give(save(w, 'bob'), FL, 3, w.tick);          // tri čerstvé
  run(w, act('order', 'bob', { id: FL, side: 'sell', n: 5, p }));
  run(w, act('buy', 'ana', { id: FL, n: 1, lim: p }));
  const age = D.batchAge(must(save(w, 'ana').fb?.[FL]?.[0]), w.tick, 1);
  assert.ok(Math.abs(age - half) < 2, 'okamžitý nákup: najstarší kvet s vekom rovno do batohu');
  w.presence = [];
  E.advanceTo(w, w.tick + life - half + 2, SPEC); // starý kvet dožil, čerstvé ešte nie
  const o = must(players(w, FL)[0]);
  assert.deepStrictEqual([o.rem, o.dead, boxed(w, 'bob', 'wilted')], [3, 1, 1], 'zvädol len zvyšný starý kvet');
  assert.ok(E.pending(w, 'oWilt:' + Mkt.orderId(FL, o.n)), 'ďalšie vädnutie je naplánované');
  invariants(w);
});

test('kvet je vždy konkrétny kus so svojím vekom: ponuka → dopyt → na vyzdvihnutie → batoh; zrušenie a vypršanie vrátia tie isté kvety', () => {
  const w = makeWorld(41), p = topBid(w, FL) + 10, life = D.SPECIES.ruza.life * TPD, t0 = w.tick;
  const a1 = Math.floor(life * 0.6), a2 = Math.floor(life * 0.3);
  give(save(w, 'bob'), FL, 1, t0 - a1); give(save(w, 'bob'), FL, 2, t0 - a2); give(save(w, 'bob'), FL, 3, t0);
  const before = ages(save(w, 'bob').fb?.[FL], t0);
  run(w, act('order', 'bob', { id: FL, side: 'sell', n: 6, p }));
  assert.deepStrictEqual(ages(players(w, FL)[0]?.fb, t0), before, 'v ponuke tie isté kvety s vekom');
  w.presence = [];
  E.advanceTo(w, t0 + TPD / 4, SPEC);
  const t1 = w.tick, aged = before.map(a => a + (t1 - t0));
  w.presence = [{ key: 'ana', name: 'Ana', area: 'garden', x: 1, y: 1, scav: null }, { key: 'bob', name: 'Bob', area: 'garden', x: 1, y: 1, scav: null }];
  save(w, 'ana').coins = 5000;
  run(w, act('order', 'ana', { id: FL, side: 'buy', n: 2, p }));
  assert.deepStrictEqual(ages(save(w, 'ana').box?.fb[FL], t1), aged.slice(-2), 'kúpené cez Dopyt: dva najstaršie kvety, starnú ďalej (aj v ponuke)');
  run(w, act('buy', 'ana', { id: FL, n: 1, lim: p }));
  assert.deepStrictEqual(ages(save(w, 'ana').fb?.[FL], t1), aged.slice(-3, -2), 'okamžitý nákup: ďalší najstarší kvet rovno do batohu');
  atStall(w, 'ana', 'bob');
  run(w, act('collect', 'ana', { id: FL }));
  assert.deepStrictEqual(ages(save(w, 'ana').fb?.[FL], t1), aged.slice(-3), 'vyzdvihnuté: tie isté kvety, žiadny nový');
  const id = Mkt.orderId(FL, must(players(w, FL)[0]).n);
  run(w, act('cancelOrder', 'bob', { id }));
  assert.deepStrictEqual(ages(save(w, 'bob').fb?.[FL], t1), aged.slice(0, 3), 'zrušenie: zvyšné (najčerstvejšie) kvety späť s vekom');
  // vypršanie: kvety čakajú na vyzdvihnutie, stále s vekom
  run(w, act('order', 'bob', { id: FL, side: 'sell', n: 3, p: 999 }));
  w.presence = [];
  E.advanceTo(w, t1 + B.ORDER_DAYS * TPD + 1, SPEC);
  const left = aged.slice(0, 3).map(a => a + (w.tick - t1)).filter(a => a < life);
  assert.deepStrictEqual(ages(save(w, 'bob').box?.fb[FL], w.tick), left, 'vrátené po vypršaní: tie isté kvety, čo ešte nezvädli');
  invariants(w);
});

test('kvety na vyzdvihnutie vädnú ako v batohu: zvädnuté ostanú na trhu, vyzdvihnú sa pri stánku', () => {
  const w = makeWorld(42), p = topBid(w, FL) + 10, life = D.SPECIES.ruza.life * TPD;
  give(save(w, 'bob'), FL, 2, w.tick - Math.floor(life / 2));
  run(w, act('order', 'bob', { id: FL, side: 'sell', n: 2, p }));
  save(w, 'ana').coins = 5000;
  run(w, act('order', 'ana', { id: FL, side: 'buy', n: 2, p }));
  assert.strictEqual(boxed(w, 'ana', FL), 2);
  w.presence = [];
  E.advanceTo(w, w.tick + Math.ceil(life / 2) + TPD / 12, SPEC);
  assert.deepStrictEqual([boxed(w, 'ana', FL), boxed(w, 'ana', 'wilted')], [0, 2], 'na trhu zvädli, nečakajú čerstvé');
  w.presence = [{ key: 'ana', name: 'Ana', area: 'garden', x: Actions.STALL.x, y: Actions.STALL.y + 1, scav: null }];
  run(w, act('collect', 'ana', { id: 'wilted' }));
  assert.deepStrictEqual([save(w, 'ana').inv.wilted, save(w, 'ana').box], [2, undefined], 'zvädnuté vyzdvihnuté do batohu');
  invariants(w);
});

test('vlastný dopyt a ponuka sa neobchodujú: prekryv sa v oboch zruší (zrušené kusy), bez obchodu a záznamu v histórii', () => {
  const w = makeWorld(43), p = topBid(w, FL) + 10, life = D.SPECIES.ruza.life * TPD;
  give(save(w, 'bob'), FL, 3, w.tick - Math.floor(life / 3));
  const ages0 = ages(save(w, 'bob').fb?.[FL], w.tick);
  run(w, act('order', 'bob', { id: FL, side: 'sell', n: 3, p }));
  const coins0 = save(w, 'bob').coins = 5000, tr0 = (must(w.market.books[FL]).tr || []).length, news0 = w.market.news.length;
  const r = E.commitBatch(w, [act('order', 'bob', { id: FL, side: 'buy', n: 5, p: p + 2 })], SPEC);
  assert.ok(r.outbox.some(m => m.to === 'bob' && /sám od seba nekúpiš, prekryv sa zrušil/.test(textOf(m))));
  const mine = players(w, FL);
  assert.strictEqual(mine.length, 1, 'ponuka celá zrušená, v knihe ostal len dopyt');
  const o = must(mine[0]);
  assert.deepStrictEqual([o.side, o.q, o.rem, o.cx, o.coins], ['buy', 5, 2, 3, 2 * (p + 2)], 'dopyt: 3 zrušené, 2 čakajú so zálohou');
  assert.strictEqual(save(w, 'bob').coins, coins0 - 2 * (p + 2), 'za zrušené kusy záloha späť');
  assert.deepStrictEqual(ages(save(w, 'bob').box?.fb[FL], w.tick), ages0, 'kvety z ponuky čakajú na vyzdvihnutie, tie isté s vekom');
  assert.deepStrictEqual([(must(w.market.books[FL]).tr || []).length, w.market.news.length], [tr0, news0], 'nijaký obchod v histórii ani v správach');
  invariants(w);
});

test('okamžitý nákup cez vlastnú ponuku: jej prekryv sa zruší (tovar na vyzdvihnutie), zvyšok sa kúpi od iných', () => {
  const w = makeWorld(44), p = topBid(w, FL) + 10;
  give(save(w, 'bob'), FL, 2, w.tick); give(save(w, 'ana'), FL, 3, w.tick);
  run(w, act('order', 'bob', { id: FL, side: 'sell', n: 2, p }));
  run(w, act('order', 'ana', { id: FL, side: 'sell', n: 3, p: p + 5 }));
  save(w, 'bob').coins = 5000;
  run(w, act('buy', 'bob', { id: FL, n: 4, lim: p + 5 }));
  assert.deepStrictEqual([boxed(w, 'bob', FL), save(w, 'bob').inv[FL]], [2, 2], 'vlastné 2 na vyzdvihnutie, 2 kúpené od Any do batohu');
  assert.strictEqual(save(w, 'bob').coins, 5000 - 2 * (p + 5));
  assert.strictEqual(players(w, FL).filter(o => o.pl === 'bob').length, 0, 'bobova ponuka je preč');
  assert.strictEqual(must(players(w, FL).find(o => o.pl === 'ana')).rem, 1);
  invariants(w);
});

test('zrušenie vráti zálohu; limit otvorených objednávok podľa reputácie; cudziu objednávku zrušiť nejde', () => {
  const w = makeWorld(5), p = Math.max(1, Math.floor(topBid(w, FL) / 2));
  for (let i = 0; i < B.orderLimit(0); i++) assert.strictEqual(run(w, act('order', 'ana', { id: FL, side: 'buy', n: 2, p })).applied.length, 1);
  const r = run(w, act('order', 'ana', { id: FL, side: 'buy', n: 1, p }));
  assert.match(r.rejected[0]?.reject ?? '', /Naraz môžeš mať len 2/);
  assert.strictEqual(save(w, 'ana').coins, 500 - 4 * p);
  const id = must(save(w, 'ana').orders?.[0]);
  assert.match(run(w, act('cancelOrder', 'ana', { id })).rejected[0]?.reject ?? '', /pri trhovom stánku/, 'od domčeka sa nezruší');
  atStall(w, 'ana', 'bob');
  assert.strictEqual(run(w, act('cancelOrder', 'bob', { id })).rejected[0]?.reject, 'Táto objednávka už nie je otvorená.', 'bob nezruší anin dopyt');
  run(w, act('cancelOrder', 'ana', { id }));
  assert.strictEqual(save(w, 'ana').coins, 500 - 2 * p);
  assert.strictEqual(save(w, 'ana').orders?.length, 1);
  assert.strictEqual(E.pending(w, 'oExpire:' + id), null, 'udalosť vypršania je zrušená');
  invariants(w);
});

test('vypršanie: po 3 dňoch sa ponuka vráti predávajúcemu (aj keď nie je v hre)', () => {
  const w = makeWorld(6), id: ItemId = 'seed_ruza';
  give(save(w, 'bob'), id, 4, w.tick);
  run(w, act('order', 'bob', { id, side: 'sell', n: 4, p: 999 }));
  assert.strictEqual(save(w, 'bob').inv[id] || 0, 0);
  w.presence = [];
  E.advanceTo(w, w.tick + B.ORDER_DAYS * TPD + 1, SPEC);
  assert.strictEqual(boxed(w, 'bob', id), 4, 'vrátené semienka čakajú na trhu');
  assert.strictEqual(players(w, id).length, 0);
  invariants(w);
});

test('obchod, kým hráč nie je v hre: súhrn pri prihlásení; hráč v hre dostane správu hneď', () => {
  const w = makeWorld(7), p = topBid(w, FL) + 10;
  give(save(w, 'bob'), FL, 3, w.tick); save(w, 'ana').coins = 5000;
  run(w, act('order', 'bob', { id: FL, side: 'sell', n: 3, p }));
  w.presence = (w.presence || []).filter(x => x.key !== 'bob');
  run(w, act('buy', 'ana', { id: FL, n: 3, lim: p }));
  assert.deepStrictEqual(save(w, 'bob').away, { [`sell:${FL}`]: { n: 3, c: 3 * p } });
  const out = E.commitBatch(w, [act('join', 'bob', { name: 'Bob', look: null, start: { coins: 30, rep: 0 }, quick: false })], SPEC);
  assert.ok(out.outbox.some(m => m.to === 'bob' && /Kým si nebol\(a\) v hre, predal\(a\) si 3× .* za \d+ 🪙/.test(textOf(m))));
  assert.strictEqual(save(w, 'bob').away, undefined);
  // v hre: správa hneď a obchod hráčov v správach trhu
  give(save(w, 'bob'), FL, 1, w.tick);
  run(w, act('order', 'bob', { id: FL, side: 'sell', n: 1, p }));
  w.presence = [...w.presence, { key: 'bob', name: 'Bob', area: 'garden', x: 1, y: 1, scav: null }];
  const r = E.commitBatch(w, [act('buy', 'ana', { id: FL, n: 1, lim: p })], SPEC);
  assert.ok(r.outbox.some(m => m.to === 'bob' && /Tvoja ponuka: predané 1×/.test(textOf(m))));
  assert.match(must(w.market.news[0]).text, /predal\(a\) 1× .* kúpil\(a\) Ana/);
});

test('jeden krok: dva dopyty na tú istú poslednú ponuku – vybaví sa práve jeden, druhý čaká v knihe', () => {
  const w = makeWorld(8), p = topBid(w, FL) + 10;
  give(save(w, 'bob'), FL, 1, w.tick);
  w.saves['cyril'] = { ...save(w, 'ana'), inv: {}, fb: {}, coins: 500 };
  run(w, act('order', 'bob', { id: FL, side: 'sell', n: 1, p }));
  const r = run(w, act('order', 'ana', { id: FL, side: 'buy', n: 1, p }), act('order', 'cyril', { id: FL, side: 'buy', n: 1, p }));
  assert.strictEqual(r.applied.length, 2);
  assert.strictEqual(boxed(w, 'ana', FL) + boxed(w, 'cyril', FL), 1, 'kvet nepredaný dvakrát');
  assert.strictEqual(boxed(w, 'ana', FL), 1, 'prvý v poradí vyhral');
  assert.strictEqual(players(w, FL).length, 1);
  invariants(w);
});

test('starnutie priority: staršia ponuka o mincu drahšia predbehne novšiu, cena obchodu je jej limit', () => {
  const w = makeWorld(9), p = topBid(w, FL) + 20;
  give(save(w, 'bob'), FL, 1, w.tick); give(save(w, 'ana'), FL, 1, w.tick);
  w.saves['cyril'] = { ...save(w, 'ana'), inv: {}, fb: {}, coins: 500 };
  run(w, act('order', 'bob', { id: FL, side: 'sell', n: 1, p: p + 1 }));
  w.tick += 3 * TPD - 10; // bob čaká takmer 3 dni (starnutie 1,5 > 1)
  run(w, act('order', 'ana', { id: FL, side: 'sell', n: 1, p }));
  run(w, act('buy', 'cyril', { id: FL, n: 1, lim: p + 1 }));
  assert.strictEqual(save(w, 'bob').coins, 500 + p + 1, 'starší bob predal za svoj limit');
  assert.strictEqual(players(w, FL)[0]?.pl, 'ana');
});

test('rep brána: plesnivec od hráča kúpi len reputácia 2; okamžitý predaj bez kupca sa odmietne', () => {
  const w = makeWorld(10);
  give(save(w, 'bob'), 'seed_plesnivec', 2, w.tick);
  run(w, act('order', 'bob', { id: 'seed_plesnivec', side: 'sell', n: 2, p: 50 }));
  assert.match(run(w, act('buy', 'ana', { id: 'seed_plesnivec', n: 1, lim: 50 })).rejected[0]?.reject ?? '', /reputáciou 2/);
  save(w, 'ana').rep = D.REP_LEVELS[2] ?? 60;
  run(w, act('buy', 'ana', { id: 'seed_plesnivec', n: 1, lim: 50 }));
  assert.strictEqual(save(w, 'ana').inv.seed_plesnivec, 1);
  assert.strictEqual(run(w, act('sell', 'ana', { id: 'po_sliz', n: 1 })).rejected.length, 1, 'nemá elixír');
});

test('postavy: 40 dní – Jano, Fero, Zuzka a veľkoobchodník obchodujú cez knihu; nič sa nestratí, kniha je vždy v poriadku', () => {
  const w = makeWorld(11);
  w.presence = [];
  give(save(w, 'bob'), FL, 6, w.tick);
  run(w, act('order', 'bob', { id: FL, side: 'sell', n: 6, p: topBid(w, FL) + 2 }));
  const jano0 = w.market.npcs.jano.coins;
  for (let d = 0; d < 40; d++) { E.advanceTo(w, w.tick + TPD, SPEC); invariants(w); }
  const news = w.market.news.map(n => n.text).join('\n');
  assert.ok(w.market.npcs.jano.coins !== jano0 || /Jano/.test(news), 'Jano obchodoval');
  assert.ok(Mkt.BOOK_ITEMS.every(item => orders(w, item).every(o => o.npc !== 'vo' || o.exp === null)));
  for (const id of Mkt.TRADERS) assert.ok(w.market.npcs[id].coins >= 0, id + ' nemá dlh');
  for (const item of Mkt.BOOK_ITEMS) assert.ok(must(w.market.books[item]).vo.coins >= 0, item);
});

test('veľkoobchodník vykupuje kvety za cenu × čerstvosť a po predaji zníži výkupnú cenu', () => {
  const w = makeWorld(12), sp = 'ruza';
  give(save(w, 'ana'), FL, 3, w.tick);
  const b = Mkt.levels(w.market, FL, 'buy', w.tick), p0 = Econ.flowerPrice(w.market, w.tick, sp);
  const exp = B.walk(b, 3, () => 1).total;
  run(w, act('sell', 'ana', { id: FL, n: 3 }));
  assert.strictEqual(save(w, 'ana').coins, 500 + exp);
  assert.ok(Econ.flowerPrice(w.market, w.tick, sp) <= p0);
  assert.strictEqual(must(w.market.books[FL]).vo.inv[FL], 3);
  invariants(w);
});

test('prevod v11: zásoby veľkoobchodníka sa stanú jeho tovarom v ponukách, Ferove zásoby jeho tovarom', () => {
  const w = makeWorld(13), m = w.market;
  const old = { seeds: m.seeds, flowers: m.flowers, compost: { stock: 9 }, hist: {}, news: [], festival: null, npcs: { jano: { coins: 111 }, fero: { coins: 222, hold: { mak: 4 } } } };
  w.market = old as unknown as Market; // uloženie spred verzie 12 (iný tvar trhu – presne to prevádza initBooks)
  const stock = must(old.seeds.ruza).stock;
  Econ.initEconomy(w);
  assert.strictEqual(w.market.npcs.jano.coins, 111);
  assert.strictEqual(w.market.npcs.fero.inv.seed_mak, 4);
  assert.strictEqual(units(w, 'seed_ruza'), stock);
  assert.strictEqual(units(w, 'compost'), 9 + Object.values(w.saves).reduce((s, sv) => s + (must(sv).inv.compost || 0), 0));
  invariants(w);
});

// ---- Postavy v knihe: obchody medzi návštevami, s hráčmi aj medzi sebou ----
const live = (w: W): Mkt.Mk => Mkt.mkWorld(w, w.market, E.liveCtx(w, 'test'));
const npcBid = (w: W, item: ItemId): number => Math.max(0, ...orders(w, item).filter(o => o.side === 'buy').map(o => o.p));

test('Jano: dopyt po semienkach vybaví hráč medzi návštevami – Jano pestuje len kúpené (jano_sell s 2 × kúpené)', () => {
  const w = makeWorld(20), id: ItemId = 'seed_mak', p = npcBid(w, id) + 3;
  const mk = live(w);
  w.market.npcs.jano.coins = 100;
  Mkt.npcOrder(mk, 'jano', id, 'buy', p, 5);
  const before = w.events.filter(e => e.type === 'jano_sell').length;
  give(save(w, 'bob'), id, 2, w.tick);
  run(w, act('sell', 'bob', { id, n: 2, lim: p }));
  assert.strictEqual(save(w, 'bob').coins, 500 + 2 * p, 'bob predal Janovi za jeho limit');
  const ev = w.events.filter(e => e.type === 'jano_sell');
  assert.strictEqual(ev.length, before + 1);
  assert.deepStrictEqual(must(ev[ev.length - 1]).data, { sp: 'mak', n: 4 });
  assert.strictEqual(w.market.npcs.jano.inv[id] || 0, 0, 'kúpené semienka hneď zasadil');
  assert.strictEqual(orders(w, id).find(o => o.npc === 'jano')?.rem, 3, 'zvyšok dopytu čaká');
  invariants(w);
});

test('Zuzka: hráčov kvet kúpi za svoj limit (podľa čerstvosti), kvet ide do jej účtu', () => {
  const w = makeWorld(21);
  Mkt.zuzkaVisit(live(w), null, Mkt.BOOK_ITEMS);
  const z = must(Mkt.BOOK_ITEMS.map(item => orders(w, item).find(o => o.npc === 'zuzka')).find(o => o));
  const item = must(Mkt.BOOK_ITEMS.find(i => orders(w, i).includes(z)));
  assert.ok(z.p > npcBid(w, item) - 1 && z.p >= Math.max(...orders(w, item).filter(o => o.npc === 'vo').map(o => o.p)), 'Zuzka platí viac než veľkoobchodník');
  const coins = w.market.npcs.zuzka.coins + z.coins;
  give(save(w, 'ana'), item, 1, w.tick);
  run(w, act('sell', 'ana', { id: item, n: 1 }));
  assert.strictEqual(save(w, 'ana').coins, 500 + z.p, 'čerstvý kvet za plný limit');
  assert.strictEqual(w.market.npcs.zuzka.inv[item], 1);
  const left = orders(w, item).find(o => o.npc === 'zuzka');
  assert.strictEqual(w.market.npcs.zuzka.coins + (left ? left.coins : 0), coins - z.p);
  invariants(w);
});

test('Fero: jeho ponuka o mincu lacnejšia než veľkoobchodník ide pri okamžitom nákupe prvá', () => {
  const w = makeWorld(22), id: ItemId = 'seed_ruza';
  const ask = Math.min(...orders(w, id).filter(o => o.npc === 'vo' && o.side === 'sell').map(o => o.p));
  I.addItems(Mkt.npcC(w.market.npcs.fero), id, 3, w.tick);
  Mkt.npcOrder(live(w), 'fero', id, 'sell', ask - 1, 3);
  const fero = w.market.npcs.fero.coins;
  run(w, act('buy', 'ana', { id, n: 2 }));
  assert.strictEqual(save(w, 'ana').coins, 500 - 2 * (ask - 1));
  assert.strictEqual(w.market.npcs.fero.coins, fero + 2 * (ask - 1));
  invariants(w);
});

test('postava s postavou: Jano prinesie kvety, Zuzkin čakajúci dopyt ich kúpi za jej limit, zvyšok ide veľkoobchodníkovi', () => {
  const w = makeWorld(23), mk = live(w);
  Mkt.zuzkaVisit(mk, null, Mkt.BOOK_ITEMS);
  const z = must(Mkt.BOOK_ITEMS.map(item => orders(w, item).find(o => o.npc === 'zuzka')).find(o => o));
  const item = must(Mkt.BOOK_ITEMS.find(i => orders(w, i).includes(z))), sp = must(D.speciesOfItem(item) ?? undefined), q = z.rem, p = z.p;
  const jano = w.market.npcs.jano.coins;
  Mkt.janoSell(mk, sp, q + 2);
  assert.strictEqual(w.market.npcs.zuzka.inv[item], q, 'Zuzka kúpila všetko, čo chcela');
  assert.ok(w.market.npcs.jano.coins >= jano + q * p, 'Jano dostal aspoň Zuzkin limit za každý jej kus');
  invariants(w);
});

test('graf pri posuvníku: kniha si pamätá obchody (cena, kusy) za posledné dni, staršie zabudne; trh ich posiela ako rozdelenie', () => {
  const w = makeWorld(24), p = topBid(w, FL) + 10;
  give(save(w, 'bob'), FL, 3, w.tick); save(w, 'ana').coins = 5000;
  run(w, act('order', 'bob', { id: FL, side: 'sell', n: 3, p }));
  run(w, act('buy', 'ana', { id: FL, n: 2, lim: p }));
  give(save(w, 'ana'), FL, 1, w.tick);
  run(w, act('sell', 'ana', { id: FL, n: 1 })); // predá veľkoobchodníkovi (alebo Zuzke) za jeho cenu
  const hist = Mkt.tradeHist(w.market, FL, w.tick);
  assert.deepStrictEqual(hist.find(([q]) => q === p), [p, 2], 'dva kusy za cenu Bobovej ponuky');
  assert.strictEqual(hist.reduce((a, [, k]) => a + k, 0), 3);
  const view = Econ.marketView(w.market, w.tick, w.events);
  assert.deepStrictEqual(must(view.flowers.ruza).t, hist);
  // po TRADE_DAYS dňoch sa staré obchody v grafe neukážu a pri ďalšom obchode z knihy zmiznú
  w.tick += B.TRADE_DAYS * TPD + 1;
  assert.deepStrictEqual(Mkt.tradeHist(w.market, FL, w.tick), []);
  run(w, act('buy', 'ana', { id: FL, n: 1, lim: p }));
  assert.deepStrictEqual(must(w.market.books[FL]).tr, [[w.tick, p, 1]]);
});
