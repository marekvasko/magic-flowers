import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import WebSocket from 'ws';
import * as D from '../src/shared/data.ts';
import type { SaveFile } from '../src/shared/save.ts';
import * as Econ from '../src/server/economy.ts';
import { must, parseMsg, readJson } from './helpers.ts';

type Server = ChildProcessByStdio<null, Readable, Readable>;
function startServer(dataDir: string, port: number): Promise<Server> {
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DEFAULT_MODE: 'paused' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error('server sa nespustil')); }, 8000);
    proc.stdout.on('data', (d: Buffer) => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + String(c))); });
  });
}
function stopServer(proc: Server): Promise<void> { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', () => { r(); }); proc.kill('SIGTERM'); }); }

test('server: udalosti zo svetu verzie 4 dostanú kľúče, duplicity a odstránené typy zmiznú, chýbajúce sa doplnia', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-events-'));
  const port = 41000 + Math.floor(Math.random() * 2000);
  const f = must(D.FESTIVALS[0]);
  const ev = (at: number, seq: number, type: string, data?: unknown): { at: number; seq: number; type: string; data: unknown } => ({ at, seq, type, data: data === undefined ? null : data });
  const save = {
    v: 4, tick: 1000, wall: Date.now(), mode: 'paused', daySeconds: 1200, rng: 1, seq: 9, weather: 'sun',
    saves: { eva: { coins: 77, water: 3, inv: { hoe: 1, can: 1 }, recipes: [], seen: [], vily: 1200, rep: 0, up: { can: 0, plots: 0, composter: 0 } } },
    storage: {}, icehouse: { built: false, ice: 0 }, hory: null, pomedzieSeed: 1, market: null, contracts: null,
    events: [
      ev(1012, 1, 'hourly'), ev(1050, 2, 'npc_fero'), ev(1060, 3, 'npc_fero'), ev(1100, 4, 'dawn'),
      ev(1150, 5, 'zrusena_udalost'), ev(1200, 6, 'vilyEnd', { key: 'eva' }),
      ev(5000, 7, 'festAnnounce', { id: f.id, start: 5576 })
    ]
  };
  fs.writeFileSync(path.join(dir, 'room-stary.json'), JSON.stringify(save));
  const proc = await startServer(dir, port);
  try {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'join', room: 'stary', name: 'Eva' }));
    await new Promise<void>(r => ws.on('message', raw => { if (parseMsg(raw).t === 'welcome') r(); }));
    ws.close();
  } finally { await stopServer(proc); }
  const saved = readJson<SaveFile & { rng?: unknown }>(path.join(dir, 'room-stary.json'));
  assert.strictEqual(saved.v, 14);
  // v8: semienko sveta a počítadlo kôl namiesto spoločného rng
  assert.ok(/^[0-9a-f]{32}$/.test(saved.seed), 'seed: ' + saved.seed);
  assert.strictEqual(typeof saved.step, 'number');
  assert.strictEqual(saved.rng, undefined);
  assert.ok(Number.isInteger(saved.scavSalt));
  // #109: odvodené počítadlá a deň kŕmenia ľadovca sa doplnia (staré uloženie ich nemá)
  assert.deepStrictEqual([saved.plotsUsed, saved.maxRep, saved.glacierFed], [0, 0, -1]);
  assert.deepStrictEqual(saved.storageFb, {});
  const byKey = (k: string): SaveFile['events'] => saved.events.filter(e => e.key === k);
  // pôvodné udalosti ostali tam, kde boli – v jemnejšej mriežke času (v9: každý krok ×40; aj čas sveta a elixír víl)
  const K = D.TICKS_PER_DAY / 288;
  assert.strictEqual(K, 40);
  assert.strictEqual(saved.tick, 1000 * K);
  assert.strictEqual(must(saved.saves['eva']).vily, 1200 * K);
  assert.deepStrictEqual(byKey('hourly').map(e => e.at), [1012 * K]);
  assert.deepStrictEqual(byKey('dawn').map(e => e.at), [1100 * K]);
  assert.deepStrictEqual(byKey('npc_fero').map(e => e.at), [1050 * K], 'duplicita zmizla');
  assert.deepStrictEqual(byKey('festAnnounce:' + f.id).map(e => [e.at, e.data]), [[5000 * K, { id: f.id }]]);
  assert.deepStrictEqual(byKey('vilyEnd:eva').map(e => [e.at, !!e.periodic]), [[1200 * K, false]]);
  const types: string[] = saved.events.map(e => e.type);
  assert.ok(!types.includes('zrusena_udalost'), 'odstránený typ zmizol');
  // chýbajúce periodické udalosti (dodávky, ostatné NPC, sviatky) sa doplnili, každá práve raz
  for (const def of Econ.PERIODIC) assert.strictEqual(byKey(def.key).length, 1, def.key);
  // zákazky z novej nástenky majú unikátne udalosti
  for (const c of saved.contracts.list) assert.strictEqual(byKey('cDue:' + c.id).length, 1, 'cDue:' + c.id);
});
