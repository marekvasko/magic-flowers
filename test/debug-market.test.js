// Ladiaca stránka (#76): API trhu – rozklad cien na kópii sveta, svet sa nezmení.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const D = require('../src/shared/data.ts');
const E = require('../src/server/engine.js');
const Econ = require('../src/server/economy.js');
const Debug = require('../src/server/debug.js');
const market = require('../debug/api/market.js');
const TPD = D.TICKS_PER_DAY;

const KEY = 'tajny-kluc-hraca';

// Svet s trhom, ktorý pár dní žil (história, správy, NPC, zákazky)
function makeState(days) {
  const room = { tick: D.DAWN_TICK + 6, wall: 0, daySeconds: 1200, seed: 'debug-trh', step: 0, seq: 0, events: [], saves: { [KEY]: { coins: 50, rep: 200, inv: {} } }, market: null, contracts: null, maxRep: 200 };
  const spec = { proposers: Object.assign({ dawn: Econ.DAWN }, Econ.PROPOSERS), periodic: [{ key: 'dawn', type: 'dawn', next: E.daily(D.DAWN_TICK) }, ...Econ.PERIODIC], onError(err) { throw err; } };
  Econ.initEconomy(room);
  E.advanceTo(room, room.tick + days * TPD, spec);
  const c = room.contracts.list[0];
  if (c) c.takenBy = KEY;
  return JSON.parse(JSON.stringify(room));
}
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k in o) deepFreeze(o[k]); } return o; }
const q = id => new URLSearchParams({ id });

test('debug trh: štruktúra a ceny zhodné s hrou, stav sa nezmení', () => {
  const state = makeState(12), text = JSON.stringify(state);
  deepFreeze(state);
  const r = market(q('x'), { load: id => id === 'x' ? { id, source: 'file', file: null, online: [], state } : null });
  assert.strictEqual(JSON.stringify(state), text, 'svet sa nezmenil');
  assert.strictEqual(market(q('nie'), { load: () => null }), null, 'neexistujúci svet → 404');

  assert.strictEqual(r.market, true);
  assert.strictEqual(r.tick, state.tick);
  assert.strictEqual(r.seeds.length, Econ.PLANTABLE.length);
  for (const s of r.seeds) {
    assert.strictEqual(s.price, Econ.seedPrice(state.market, state.tick, s.sp), s.sp);
    assert.strictEqual(s.sellBack, Econ.sellQuote(state.market, state.tick, 'seed_' + s.sp));
    assert.strictEqual(s.stock, state.market.seeds[s.sp].stock);
    assert.deepStrictEqual(s.hist, state.market.hist['seed_' + s.sp]);
    assert.strictEqual(s.minRep, D.MIN_SEED_REP[s.sp] || 0);
    assert.strictEqual(s.name, D.SPECIES[s.sp].name);
  }
  for (const f of r.flowers) {
    assert.strictEqual(f.price, Econ.flowerPrice(state.market, state.tick, f.sp));
    assert.ok(['base', 'rare', 'fest', 'sat', 'satRaw', 'raw'].every(k => typeof f.parts[k] === 'number'));
  }
  assert.strictEqual(r.compost.price, Econ.compostPrice(state.market));
  assert.strictEqual(r.compost.sellBack, Econ.sellQuote(state.market, state.tick, 'compost'));
  assert.strictEqual(r.npcs.jano.coins, state.market.npcs.jano.coins);
  assert.strictEqual(r.npcs.fero.coins, state.market.npcs.fero.coins);
  assert.ok(r.nextDelivery > r.tick);
  assert.ok(r.upcoming && r.upcoming.start > r.tick && r.upcoming.end > r.upcoming.start);
  assert.ok(r.news.length > 0);
  assert.ok(r.events.length > 0 && r.events.every(e => e.text && e.at >= r.tick));
  assert.ok(r.events.some(e => e.type === 'delivery'));
  assert.strictEqual(r.contracts.length, state.contracts.list.length);
  assert.strictEqual(r.constants.SEED_TARGET, 10);
  assert.strictEqual(r.constants.seedDemand.now, 1.35);
});

test('debug trh: sviatok počas sviatku a najbližší sviatok', () => {
  const state = makeState(1);
  const f = D.FESTIVALS[1];
  state.tick = Econ.festStartTick(f) + 3;
  state.market.festival = { id: f.id, name: f.name, icon: f.icon, mult: f.mult, until: state.tick + TPD };
  Econ.setFestival(state.market, f); // ako festStart: násobky aj do položiek kvetov
  state.events = []; // staré uloženie bez udalostí: najbližší sviatok sa dopočíta
  const r = market(q('x'), { load: () => ({ id: 'x', source: 'file', file: null, online: [], state }) });
  assert.strictEqual(r.festival.id, f.id);
  assert.strictEqual(r.upcoming.id, D.FESTIVALS[2].id);
  assert.strictEqual(r.upcoming.start, Econ.festStartTick(D.FESTIVALS[2]));
  const ruza = r.flowers.find(x => x.sp === 'ruza');
  assert.strictEqual(ruza.parts.fest, f.mult.ruza);
  assert.strictEqual(ruza.parts.festival, f.id);
});

test('debug trh: svet bez trhu (staré uloženie) nespadne', () => {
  const r = market(q('x'), { load: () => ({ id: 'x', source: 'file', file: null, online: [], state: { tick: 5, events: [] } }) });
  assert.strictEqual(r.market, false);
  assert.strictEqual(r.seeds, undefined);
});

test('debug trh: /api/debug/market pre svet zo súboru aj v pamäti, bez kľúčov a bez zmien', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-market-'));
  const state = makeState(5), saved = JSON.stringify(state), file = path.join(dir, 'room-subor.json');
  fs.writeFileSync(file, saved);
  const live = Object.assign(makeState(3), { players: new Map() });
  const liveText = JSON.stringify(live);
  const rooms = new Map([['zivy', live]]);
  const handle = Debug.create({ dataDir: dir, debugDir: path.join(__dirname, '..', 'debug'), rooms, serialize: r => JSON.stringify(r), migrate: s => s });
  const srv = http.createServer((req, res) => { if (!handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const get = p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: srv.address().port, path: p }, res => {
    let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject));
  try {
    for (const id of ['subor', 'zivy']) {
      const r = await get('/api/debug/market?id=' + id);
      assert.strictEqual(r.status, 200, r.body);
      assert.ok(!r.body.includes(KEY), 'kľúč hráča nesmie byť vo výstupe');
      const j = JSON.parse(r.body);
      assert.strictEqual(j.source, id === 'subor' ? 'file' : 'memory');
      assert.ok(j.contracts.some(c => c.takenBy === Debug.keyId(KEY)));
    }
    assert.strictEqual((await get('/api/debug/market?id=nikto')).status, 404);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), saved);
    assert.deepStrictEqual(fs.readdirSync(dir), ['room-subor.json']);
    assert.strictEqual(JSON.stringify(live), liveText, 'živý svet ostal nedotknutý');
  } finally { srv.close(); }
});
