const test = require('node:test');
const assert = require('node:assert');
const D = require('../shared/data.js');
const E = require('../engine.js');
const Econ = require('../economy.js');
const TPD = D.TICKS_PER_DAY;

function makeWorld(seed) {
  const room = { tick: D.DAWN_TICK + 6, wall: 0, daySeconds: 1200, rng: seed, seq: 0, events: [], saves: {}, market: null, contracts: null };
  const handlers = Object.assign({ dawn(r) { Econ.onDawn(r); E.schedule(r, r.tick + TPD, 'dawn'); } }, Econ.HANDLERS);
  E.schedule(room, E.nextDailyTick(room.tick + 1, D.DAWN_TICK), 'dawn');
  Econ.initEconomy(room);
  return { room, run(days) { for (let i = 0; i < days * TPD; i++) E.step(room, handlers); } };
}

test('64 dní simulácie bez hráčov: zásoby, ceny a fronta udalostí zostávajú v medziach', () => {
  const { room, run } = makeWorld(42);
  let maxEvents = 0;
  for (let d = 0; d < 64; d++) {
    run(1);
    maxEvents = Math.max(maxEvents, room.events.length);
    for (const sp of Econ.PLANTABLE) {
      const s = room.market.seeds[sp].stock, f = room.market.flowers[sp].stock;
      assert.ok(Number.isInteger(s) && s >= 0 && s <= 40, `semienka ${sp}: ${s}`);
      assert.ok(Number.isInteger(f) && f >= 0, `kvety ${sp}: ${f}`);
      const p = Econ.seedPrice(room, sp), q = Econ.flowerPrice(room, sp);
      assert.ok(p >= 2 && p < 1000 && q >= 1 && q < 2000, `ceny ${sp}: ${p}/${q}`);
    }
  }
  assert.ok(maxEvents < 60, 'fronta udalostí: ' + maxEvents);
  assert.ok(room.contracts.list.filter(c => !c.takenBy).length >= 1, 'nástenka nie je prázdna');
  assert.ok(room.market.news.length > 0);
});

test('semienka sú v sezóne v priemere drahšie ako tesne pred sezónou (treba plánovať)', () => {
  let pre = 0, during = 0, n = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const { room, run } = makeWorld(seed);
    for (let d = 0; d < 48; d++) {
      run(1);
      const se = D.seasonOf(D.dayOfTick(room.tick)), dis = (D.dayOfTick(room.tick) - 1) % D.DAYS_PER_SEASON + 1;
      for (const sp of Econ.PLANTABLE) {
        if (D.SPECIES[sp].strict) continue;
        const rel = Econ.seedPrice(room, sp) / D.SPECIES[sp].seed;
        const ph = Econ.phase(sp, se);
        if (ph === 'next' && dis >= 3) { pre += rel; n++; }
        if (ph === 'now' && dis >= 3) during += rel;
      }
    }
  }
  pre /= n; during /= n;
  console.log(`  priemerná cena / základ: pred sezónou ${pre.toFixed(2)}, koniec sezóny ${during.toFixed(2)}`);
  assert.ok(during > pre * 1.2);
});

test('nákup zvyšuje cenu, predaj kvetov ju znižuje; vypredané sa kúpiť nedá', () => {
  const { room } = makeWorld(7);
  const sv = { coins: 10000, inv: {}, rep: 0 };
  const sp = Econ.PLANTABLE.find(s => Econ.phase(s, 0) === 'now' && !D.SPECIES[s].strict);
  const p0 = Econ.seedPrice(room, sp);
  const r = Econ.buy(room, sv, 'seed_' + sp, 5);
  assert.strictEqual(r.n, 5);
  assert.ok(Econ.seedPrice(room, sp) > p0);
  Econ.buy(room, sv, 'seed_' + sp, 999);
  assert.strictEqual(room.market.seeds[sp].stock, 0);
  assert.strictEqual(Econ.buy(room, sv, 'seed_' + sp, 1).n, 0);
  sv.inv['fl_' + sp] = 10;
  const f0 = Econ.flowerPrice(room, sp);
  const s = Econ.sell(room, sv, 'fl_' + sp, 10);
  assert.ok(s.earned < f0 * 10 && Econ.flowerPrice(room, sp) < f0);
  assert.strictEqual(Econ.buy(room, { coins: 9999, inv: {}, rep: 0 }, 'seed_plesnivec', 1).n, 0, 'plesnivec len od reputácie 2');
});

test('zákazka: rezervácia, odovzdanie po častiach, odmena; prepadnutá stojí reputáciu', () => {
  const { room, run } = makeWorld(9);
  room.saves.anka = { coins: 0, inv: {}, rep: 0 };
  const c = room.contracts.list[0];
  assert.strictEqual(Econ.takeContract(room, 'anka', c.id), null);
  assert.ok(Econ.takeContract(room, 'anka', room.contracts.list[1].id), 'na úrovni 0 len 1 zákazka');
  room.saves.anka.inv['fl_' + c.sp] = c.n - 1;
  Econ.deliverContract(room, 'anka', c.id);
  assert.strictEqual(c.got, c.n - 1);
  room.saves.anka.inv['fl_' + c.sp] = 1;
  const r = Econ.deliverContract(room, 'anka', c.id);
  assert.ok(r.done && room.saves.anka.coins === c.reward && room.saves.anka.rep === c.rep);
  const c2 = room.contracts.list.find(x => !x.takenBy);
  Econ.takeContract(room, 'anka', c2.id);
  const repBefore = room.saves.anka.rep;
  run(Math.ceil((c2.due - room.tick) / TPD) + 1);
  assert.ok(!room.contracts.list.includes(c2));
  assert.strictEqual(room.saves.anka.rep, Math.max(0, repBefore - 5));
});

test('krátke zákazky sú len na kvety, ktoré sa dajú vypestovať v aktuálnom období', () => {
  const { room, run } = makeWorld(11);
  for (let d = 0; d < 32; d++) {
    run(1);
    const se = D.seasonOf(D.dayOfTick(room.tick));
    for (const c of room.contracts.list) {
      if (c.kind !== 'short' || c.posted < room.tick - 10) continue;
      assert.ok(D.SPECIES[c.sp].seasons.includes(se), `deň ${D.dayOfTick(room.tick)}: krátka zákazka na ${c.sp} mimo sezóny`);
    }
  }
});

test('predaj starších kvetov vynesie menej než čerstvých', () => {
  const { room } = makeWorld(5);
  const I = require('../items.js');
  const fresh = { coins: 0, inv: {} }, old = { coins: 0, inv: {} };
  I.addItems(I.playerC(fresh), 'fl_tulipan', 3, room.tick);
  I.addItems(I.playerC(old), 'fl_tulipan', 3, room.tick - 3 * TPD);
  const stock = room.market.flowers.tulipan.stock;
  Econ.sell(room, fresh, 'fl_tulipan', 3);
  room.market.flowers.tulipan.stock = stock;
  const r = Econ.sell(room, old, 'fl_tulipan', 3);
  assert.ok(old.coins < fresh.coins * 0.8, `${old.coins} vs ${fresh.coins}`);
  assert.match(r.msg, /čerstvosť/);
});

test('štartovný kapitál: chudobný začiatok, v testovacích prostrediach viac', () => {
  assert.deepStrictEqual(Econ.startCapital({}), { coins: 30, rep: 0 });
  assert.deepStrictEqual(Econ.startCapital({ START_COINS: '', START_REP: '' }), { coins: 30, rep: 0 });
  const t = Econ.startCapital({ START_COINS: '5000', START_REP: '3' });
  assert.strictEqual(t.coins, 5000);
  assert.strictEqual(D.repLevel(t.rep), 3);
  assert.strictEqual(D.repLevel(Econ.startCapital({ START_REP: '99' }).rep), D.REP_LEVELS.length - 1);
});
