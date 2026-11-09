// Ladiaca stránka (#76): API trhu – rozklad cien na kópii sveta, svet sa nezmení.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as D from '../src/shared/data.ts';
import type { Contracts, Market, PlayerSave } from '../src/shared/save.ts';
import { isRecord } from '../src/shared/util.ts';
import * as E from '../src/server/engine.ts';
import * as Econ from '../src/server/economy.ts';
import * as Debug from '../src/server/debug.ts';
import type { DebugState, Loaded } from '../src/server/debug.ts';
import market from '../src/server/debug-api/market.ts';
import type { MarketView } from '../src/server/debug-api/market.ts';
import type { GameSpec, GameWorld } from '../src/server/game.ts';
import { must, parseJson, partial, portOf, rethrow, testWorld } from './helpers.ts';
const TPD = D.TICKS_PER_DAY;

const KEY = 'tajny-kluc-hraca';

// Svet s trhom, ktorý pár dní žil (história, správy, NPC, zákazky) – ako JSON (kópia, ako ju dá tools.load)
type State = DebugState & { market: Market; contracts: Contracts; events: E.EngineEvent[] };
function makeState(days: number): State {
  const room = testWorld<Partial<GameWorld>>({ tick: D.DAWN_TICK + 6, wall: 0, daySeconds: 1200, seed: 'debug-trh', step: 0, seq: 0, events: [], saves: { [KEY]: partial<PlayerSave>({ coins: 50, rep: 200, inv: {} }) }, market: null, contracts: null, maxRep: 200 });
  const spec: GameSpec = { proposers: { dawn: Econ.DAWN, ...Econ.PROPOSERS }, periodic: [{ key: 'dawn', type: 'dawn', next: E.daily(D.DAWN_TICK) }, ...Econ.PERIODIC], onError: rethrow };
  Econ.initEconomy(room);
  E.advanceTo(room, room.tick + days * TPD, spec);
  const c = must(room.contracts ?? undefined).list[0];
  if (c) c.takenBy = KEY;
  return parseJson<State>(JSON.stringify(room));
}
function deepFreeze<T>(o: T): T { if (isRecord(o) && !Object.isFrozen(o)) { Object.freeze(o); for (const k in o) deepFreeze(o[k]); } return o; }
const q = (id: string): URLSearchParams => new URLSearchParams({ id });
// Svet pre tools.load (súbor, bez hráčov online)
const loaded = (id: string, state: DebugState): Loaded => ({ id, source: 'file', file: null, online: [], state });
// pohľad na trh v teste: polia trhu ako voliteľné (svet bez trhu ich nemá)
type Loose = MarketView & Omit<Partial<Extract<MarketView, { market: true }>>, 'market'>;
const view = (r: MarketView | null): Loose => must(r ?? undefined);
const field = (v: unknown, k: string): unknown => (isRecord(v) ? v[k] : undefined);

test('debug trh: štruktúra a ceny zhodné s hrou, stav sa nezmení', () => {
  const state = makeState(12), text = JSON.stringify(state);
  deepFreeze(state);
  const r = view(market(q('x'), { load: id => id === 'x' ? loaded('x', state) : null }));
  assert.strictEqual(JSON.stringify(state), text, 'svet sa nezmenil');
  assert.strictEqual(market(q('nie'), { load: () => null }), null, 'neexistujúci svet → 404');

  assert.strictEqual(r.market, true);
  assert.strictEqual(r.tick, state.tick);
  assert.strictEqual(must(r.seeds).length, Econ.PLANTABLE.length);
  for (const s of must(r.seeds)) {
    assert.strictEqual(s.price, Econ.seedPrice(state.market, state.tick, s.sp), s.sp);
    assert.strictEqual(s.sellBack, Econ.sellQuote(state.market, state.tick, `seed_${s.sp}`));
    assert.strictEqual(s.stock, must(state.market.seeds[s.sp]).stock);
    assert.deepStrictEqual(s.hist, state.market.hist[`seed_${s.sp}`]);
    assert.strictEqual(s.minRep, D.MIN_SEED_REP[s.sp] || 0);
    assert.strictEqual(s.name, D.SPECIES[s.sp].name);
  }
  for (const f of must(r.flowers)) {
    assert.strictEqual(f.price, Econ.flowerPrice(state.market, state.tick, f.sp));
    assert.ok(['base', 'rare', 'fest', 'sat', 'satRaw', 'raw'].every(k => typeof field(f.parts, k) === 'number'));
  }
  assert.strictEqual(must(r.compost).price, Econ.compostPrice(state.market));
  assert.strictEqual(must(r.compost).sellBack, Econ.sellQuote(state.market, state.tick, 'compost'));
  assert.strictEqual(must(r.npcs).jano.coins, state.market.npcs.jano.coins);
  assert.strictEqual(must(r.npcs).fero.coins, state.market.npcs.fero.coins);
  assert.ok((r.nextDelivery ?? -1) > r.tick);
  const up = r.upcoming;
  assert.ok(up && up.start > r.tick && up.end > up.start);
  assert.ok(must(r.news).length > 0);
  assert.ok(must(r.events).length > 0 && must(r.events).every(e => e.text && e.at >= r.tick));
  assert.ok(must(r.events).some(e => e.type === 'delivery'));
  assert.strictEqual(must(r.contracts).length, state.contracts.list.length);
  assert.strictEqual(r.constants['SEED_TARGET'], 10);
  assert.strictEqual(field(r.constants['seedDemand'], 'now'), 1.35);
});

test('debug trh: sviatok počas sviatku a najbližší sviatok', () => {
  const state = makeState(1);
  const f = must(D.FESTIVALS[1]);
  state.tick = Econ.festStartTick(f) + 3;
  state.market.festival = { id: f.id, name: f.name, icon: f.icon, mult: f.mult, until: state.tick + TPD };
  Econ.setFestival(state.market, f); // ako festStart: násobky aj do položiek kvetov
  state.events = []; // staré uloženie bez udalostí: najbližší sviatok sa dopočíta
  const r = view(market(q('x'), { load: () => loaded('x', state) }));
  assert.strictEqual(r.festival?.id, f.id);
  const next = must(D.FESTIVALS[2]);
  assert.strictEqual(r.upcoming?.id, next.id);
  assert.strictEqual(r.upcoming.start, Econ.festStartTick(next));
  const ruza = must(must(r.flowers).find(x => x.sp === 'ruza'));
  assert.strictEqual(ruza.parts.fest, f.mult.ruza);
  assert.strictEqual(ruza.parts.festival, f.id);
});

test('debug trh: svet bez trhu (staré uloženie) nespadne', () => {
  const r = view(market(q('x'), { load: () => loaded('x', { tick: 5, events: [] }) }));
  assert.strictEqual(r.market, false);
  assert.strictEqual(r.seeds, undefined);
});

test('debug trh: /api/debug/market pre svet zo súboru aj v pamäti, bez kľúčov a bez zmien', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-market-'));
  const state = makeState(5), saved = JSON.stringify(state), file = path.join(dir, 'room-subor.json');
  fs.writeFileSync(file, saved);
  const live = Object.assign(makeState(3), { players: new Map<number, { name: string; area: D.AreaId; key: string }>() });
  const liveText = JSON.stringify(live);
  const rooms = new Map([['zivy', live]]);
  const handle = Debug.create({ dataDir: dir, debugDir: path.join(import.meta.dirname, '..', 'debug'), rooms, serialize: r => JSON.stringify(r), migrate: s => s, apis: { market } });
  const srv = http.createServer((req, res) => { if (!handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const get = (p: string): Promise<{ status: number | undefined; body: string }> => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: portOf(srv), path: p }, res => {
    let body = ''; res.on('data', (c: Buffer) => { body += c.toString(); }); res.on('end', () => { resolve({ status: res.statusCode, body }); });
  }).on('error', reject));
  try {
    for (const id of ['subor', 'zivy']) {
      const r = await get('/api/debug/market?id=' + id);
      assert.strictEqual(r.status, 200, r.body);
      assert.ok(!r.body.includes(KEY), 'kľúč hráča nesmie byť vo výstupe');
      const j = parseJson<Loose>(r.body);
      assert.strictEqual(j.source, id === 'subor' ? 'file' : 'memory');
      assert.ok(must(j.contracts).some(c => c.takenBy === Debug.keyId(KEY)));
    }
    assert.strictEqual((await get('/api/debug/market?id=nikto')).status, 404);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), saved);
    assert.deepStrictEqual(fs.readdirSync(dir), ['room-subor.json']);
    assert.strictEqual(JSON.stringify(live), liveText, 'živý svet ostal nedotknutý');
  } finally { srv.close(); }
});
