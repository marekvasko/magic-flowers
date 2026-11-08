// Oneskorenie medzi hráčmi (#111): dvaja hráči na jednom serveri – ako dlho trvá, kým pohyb jedného uvidí druhý
// (správa move → schránka → rámec → vysielanie polôh `pl` 10× za sekundu) a kým akcia na políčku príde späť
// ako `tile` (správa act → rámec → dávka akcií → notify). Čísla sa vypíšu; stráž je voľná (dva 100 ms časovače + rezerva).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import * as D from '../src/shared/data.ts';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.ts';
import { must, parseMsg } from './helpers.ts';

const json = (v: unknown): string => JSON.stringify(v);
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
type Server = ChildProcessByStdio<null, Readable, Readable>;
type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

// Voľný port od systému (náhodné porty z rozsahov sa občas zrazia medzi testami)
function freePort(): Promise<number> { return new Promise(r => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as AddressInfo).port; srv.close(() => { r(p); }); }); }); }
function startServer(dataDir: string, port: number): Promise<Server> {
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, JOURNAL: '0' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error('server sa nespustil')); }, 8000);
    proc.stdout.on('data', (d: Buffer) => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + String(c))); });
  });
}
function stopServer(proc: Server): Promise<void> { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', () => { r(); }); proc.kill('SIGTERM'); }); }
// Klient: čaká na správu, ktorá spĺňa podmienku (len správy prijaté po zavolaní wait)
type Pred = (m: ServerMessage) => unknown;
interface Client { ws: WebSocket; wait(pred: Pred, ms?: number): Promise<ServerMessage>; send(m: ClientMessage): void; readonly id: number; readonly seq: number; x: number; y: number }
function client(port: number, room: string, name: string): Promise<Client> {
  const ws = new WebSocket('ws://127.0.0.1:' + port), waiters: { pred: Pred; res: (m: ServerMessage) => void }[] = [];
  let welcome: Welcome | null = null;
  const welcomed = (): Welcome => must(welcome ?? undefined);
  ws.on('message', raw => {
    const m = parseMsg(raw);
    if (m.t === 'welcome') welcome = m;
    for (const w of waiters.slice()) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  const wait = (pred: Pred, ms?: number): Promise<ServerMessage> => new Promise((res, rej) => { const t = setTimeout(() => { rej(new Error('nedošlo: ' + pred.toString())); }, ms || 3000); waiters.push({ pred, res: m => { clearTimeout(t); res(m); } }); });
  return new Promise(r => ws.on('open', () => { void (async () => {
    const w = wait(m => m.t === 'welcome');
    ws.send(json({ t: 'join', room, name }));
    await w;
    r({ ws, wait, send: m => { ws.send(json(m)); }, get id() { return welcomed().id; }, get seq() { return welcomed().seq; }, x: welcomed().x, y: welcomed().y });
  })(); }));
}
interface Stats { n: number; min: number; median: number; p90: number; max: number }
const stats = (list: readonly number[]): Stats => { const s = list.slice().sort((a, b) => a - b); return { n: s.length, min: must(s[0]), median: must(s[s.length >> 1]), p90: must(s[Math.floor(s.length * 0.9)]), max: must(s[s.length - 1]) }; };
const fmt = (s: Stats): string => `min ${s.min.toFixed(0)} · medián ${s.median.toFixed(0)} · p90 ${s.p90.toFixed(0)} · max ${s.max.toFixed(0)} ms (n=${s.n})`;

test('oneskorenie: pohyb jedného hráča uvidí druhý do ~200 ms; vlastná akcia na políčku sa vráti ako tile do ~200 ms', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-latencia-'));
  const port = await freePort();
  const proc = await startServer(dir, port);
  let ana: Client | undefined, bob: Client | undefined;
  try {
    ana = await client(port, 'latencia', 'Ana'); bob = await client(port, 'latencia', 'Bob');
    const a = ana, b = bob;
    await b.wait(m => m.t === 'pl' && m.list.some(p => p.name === 'Ana'));
    // 1. pohyb Ana → Bob: čas od odoslania move po prvú správu pl, v ktorej Bob vidí Anu na novej polohe
    const moves: number[] = [];
    for (let k = 0; k < 20; k++) {
      const x = +(a.x + ((k % 5) - 2) * 0.3).toFixed(3), y = +(a.y - (k % 3) * 0.3).toFixed(3);
      const seen = b.wait(m => m.t === 'pl' && m.list.some(p => p.id === a.id && p.x === x && p.y === y));
      const t0 = process.hrtime.bigint();
      a.send({ t: 'move', x, y, dir: 0, ar: a.seq });
      await seen;
      moves.push(Number(process.hrtime.bigint() - t0) / 1e6);
      await sleep(30);
    }
    // 2. akcia Ana → Ana: motyka na trávu pred ňou, čas po správu tile s prekopanou zemou (a späť zarovnanie)
    const acts: number[] = [];
    const map = D.buildMap();
    let i = -1, best = Infinity;
    for (let k = 0; k < map.length; k++) if (map[k] === 'grass') { const d = Math.hypot(k % D.W + 0.5 - a.x, Math.floor(k / D.W) + 0.5 - a.y); if (d < best) { best = d; i = k; } }
    const tx = i % D.W, ty = Math.floor(i / D.W);
    const stand = b.wait(m => m.t === 'pl' && m.list.some(p => p.id === a.id && p.y === ty - 0.5));
    a.send({ t: 'move', x: tx + 0.5, y: ty - 0.5, dir: 0, ar: a.seq }); // Ana sa postaví severne od trávy
    await stand;
    for (let k = 0; k < 10; k++) {
      const tilled = !(k % 2); // striedavo prekopať a zarovnať
      const seen = a.wait(m => m.t === 'tile' && m.i === i && !!m.v.s === tilled);
      const t0 = process.hrtime.bigint();
      a.send({ t: 'act', x: tx, y: ty, item: 'hoe' });
      await seen;
      acts.push(Number(process.hrtime.bigint() - t0) / 1e6);
      await sleep(30);
    }
    const sm = stats(moves), sa = stats(acts);
    console.log(`  pohyb hráča → druhý hráč: ${fmt(sm)}`);
    console.log(`  akcia na políčku → tile:    ${fmt(sa)}`);
    // rámec (do 100 ms) + vysielanie polôh (do 100 ms) + rezerva; akcia: rámec + spracovanie + rezerva
    assert.ok(sm.median < 250 && sm.max < 600, 'pohyb: ' + fmt(sm));
    assert.ok(sa.median < 200 && sa.max < 600, 'akcia: ' + fmt(sa));
  } finally {
    if (ana) ana.ws.close(); if (bob) bob.ws.close();
    await sleep(100);
    await stopServer(proc);
  }
});
