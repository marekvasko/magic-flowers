import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.ts';
import type { SaveFile } from '../src/shared/save.ts';
import { SAVE_V11 } from './save-v11.fixture.ts';
import { isMsg, must, parseMsg, portOf, readJson } from './helpers.ts';
import type { MsgOf, MsgType } from './helpers.ts';

async function listenPort(): Promise<number> {
  const server = net.createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = portOf(server); await new Promise<void>(r => server.close(() => { r(); })); return port;
}
async function start(dir: string, port: number): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ['src/server/server.ts'], { cwd: path.join(import.meta.dirname, '..'), env: { ...process.env, DATA_DIR: dir, PORT: String(port), DEFAULT_MODE: 'paused' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('server sa nespustil')); }, 8000);
    proc.stdout.on('data', (data: Buffer) => { if (String(data).includes('beží')) { clearTimeout(timeout); resolve(); } });
    proc.once('error', reject); proc.once('exit', () => { clearTimeout(timeout); reject(new Error('server skončil pred spustením')); });
  });
  return proc;
}
async function stop(proc: ChildProcess): Promise<void> { await new Promise<void>(r => { proc.once('exit', () => { r(); }); proc.kill('SIGTERM'); }); }
async function client(port: number, name: string): Promise<{ ws: WebSocket; messages: ServerMessage[]; send: (m: ClientMessage) => void; wait: <T extends MsgType>(type: T, match?: (m: MsgOf<T>) => boolean) => Promise<MsgOf<T>> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), messages: ServerMessage[] = [];
  ws.on('message', raw => { messages.push(parseMsg(raw)); });
  await new Promise<void>(r => ws.once('open', () => { r(); }));
  const wait = <T extends MsgType>(type: T, match: (m: MsgOf<T>) => boolean = () => true): Promise<MsgOf<T>> => new Promise((resolve, reject) => {
    const timer = setInterval(() => { const m = messages.find((m): m is MsgOf<T> => isMsg(m, type) && match(m)); if (m) { clearInterval(timer); clearTimeout(timeout); resolve(m); } }, 10); // typ správy zúži diskriminátor t
    const timeout = setTimeout(() => { clearInterval(timer); reject(new Error(`nedošlo ${type}`)); }, 4000);
  });
  ws.send(JSON.stringify({ t: 'join', room: 'migracia', name })); await wait('welcome');
  return { ws, messages, send: m => { ws.send(JSON.stringify(m)); }, wait };
}

test('v11 → v12 zachová hráčov a výrobu, presunie Férove zásoby iba raz; rezervácie a offline plnenie prežijú reštart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf112-migration-')), port = await listenPort();
  const old = { ...SAVE_V11, mode: 'paused', market: { ...SAVE_V11.market, npcs: { ...SAVE_V11.market.npcs, fero: { coins: 333, hold: { mak: 3 } } } }, saves: { ...SAVE_V11.saves, bob: { ...SAVE_V11.saves.bob, inv: { ...SAVE_V11.saves.bob.inv, silk: 3 } } }, events: [...SAVE_V11.events, { at: SAVE_V11.tick + 11520, seq: 1000, type: 'jano_sell', data: { sp: 'mak', n: 4 } }] };
  const file = path.join(dir, 'room-migracia.json'); fs.writeFileSync(file, JSON.stringify(old));
  let proc = await start(dir, port); const clients: WebSocket[] = [];
  t.after(async () => { for (const ws of clients) ws.terminate(); if (proc.exitCode === null) await stop(proc); fs.rmSync(dir, { recursive: true, force: true }); });
  const ana = await client(port, 'Ana'); clients.push(ana.ws);
  const before = await ana.wait('me'); assert.equal(before.coins, old.saves.ana.coins); assert.deepEqual(before.inv, old.saves.ana.inv);
  ana.send({ t: 'marketOrder', id: 'silk', side: 'buy', price: 10, n: 3 });
  ana.send({ t: 'marketOrder', id: 'fl_tulipan', side: 'sell', price: 10000, n: 1 });
  const reserved = await ana.wait('me', m => m.orders?.length === 2); assert.equal(reserved.coins, before.coins - 30); assert.equal(reserved.inv.fl_tulipan, 1);
  ana.ws.terminate(); await new Promise(r => setTimeout(r, 50));
  const bob = await client(port, 'Bob'); clients.push(bob.ws); bob.send({ t: 'marketOrder', id: 'silk', side: 'sell', price: 9, n: 2 });
  await bob.wait('toast', m => m.text.startsWith('Predané: 2×'));
  const returned = await client(port, 'Ana'); clients.push(returned.ws);
  await returned.wait('toast', m => m.text.startsWith('Kým si bol(a) preč: kúpené 2 ks za 20'));
  await stop(proc);
  const saved = readJson<SaveFile>(file), book = must(saved.market.book);
  assert.equal(saved.v, 12); assert.equal(saved.migratedFrom, 11);
  assert.equal(book.accounts.fero.coins, 333); assert.equal(book.accounts.fero.inv.seed_mak, 3); assert.deepEqual(saved.market.npcs.fero.hold, {});
  assert.ok(saved.events.some(e => e.type === 'jano_sell' && e.data.n === 4));
  const ids = must(saved.saves['ana']).marketOrders || []; assert.equal(ids.length, 2);
  assert.equal(must(saved.saves['ana']).inv.silk, 9); // pôvodných sedem + dva kúpené
  for (const id of ids) assert.equal(saved.events.filter(e => e.key === `marketExpire:${id}`).length, 1);
  proc = await start(dir, port);
  const again = await client(port, 'Ana'); clients.push(again.ws); const state = await again.wait('me');
  assert.deepEqual(state.orders?.map(o => o.id), ids); assert.equal(state.coins, before.coins - 30);
  assert.equal(state.orders.find(o => o.side === 'buy')?.coins, 10);
  assert.ok(!again.messages.some(m => m.t === 'toast' && m.text.startsWith('Kým si bol(a) preč:')));
});
