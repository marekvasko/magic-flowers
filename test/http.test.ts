// #145: požiadavka s chybným percentovým kódovaním v ceste (GET /%) zhodila celý server – decodeURIComponent hodil
// URIError a nič ho nezachytilo. Teraz dostane 400 a server slúži ďalej; platné zakódované cesty fungujú ako predtým.
// Rovnako chybný rámec WebSocket (bez masky…): spojenie bez poslucháča 'error' zhodilo proces.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import WebSocket from 'ws';
import { portOf } from './helpers.ts';

const freePort = (): Promise<number> => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = portOf(s); s.close(() => { r(p); }); }); });
type Server = ChildProcessByStdio<null, Readable, Readable> & { stderrText: () => string };
function startServer(dataDir: string, port: number): Promise<Server> {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DEFAULT_MODE: 'paused' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = '';
  child.stderr.on('data', (d: Buffer) => { err += String(d); });
  const proc: Server = Object.assign(child, { stderrText: () => err });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('server sa nespustil\n' + err)); }, 8000);
    proc.stdout.on('data', (d: Buffer) => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + String(c) + '\n' + err)); });
  });
}
function stopServer(proc: Server): Promise<void> {
  return new Promise(r => {
    proc.removeAllListeners('exit');
    if (proc.exitCode !== null || proc.signalCode !== null) { r(); return; }
    proc.on('exit', () => { r(); }); proc.kill('SIGTERM');
  });
}
// surová cesta, ako ju poslal klient (http.get ju nemení)
function get(port: number, urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, res => { res.resume(); res.on('end', () => { resolve(res.statusCode ?? 0); }); });
    req.on('error', reject);
  });
}
// surový rámec po upgrade na WebSocket; čaká, kým server spojenie zavrie
function rawFrame(port: number, frame: number[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let up = false;
    const t = setTimeout(() => { s.destroy(); reject(new Error('server spojenie nezavrel')); }, 5000);
    s.on('data', d => { if (!up && String(d).includes(' 101 ')) { up = true; s.write(Buffer.from(frame)); } });
    s.on('error', () => { /* server môže spojenie zrušiť tvrdo */ });
    s.on('close', () => { clearTimeout(t); if (up) resolve(); else reject(new Error('upgrade neprešiel')); });
  });
}

test('server: chybné percentové kódovanie v ceste dá 400 a server beží ďalej; platné zakódované cesty fungujú (#145)', async () => {
  let dir: string | null = null, proc: Server | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-http-'));
    const port = await freePort();
    proc = await startServer(dir, port);
    const srv = proc;
    let exited: number | null = null;
    srv.on('exit', c => { exited = c ?? -1; });
    assert.strictEqual(await get(port, '/'), 200);
    for (const bad of ['/%', '/%zz', '/%E0%A4%A', '/client/%', '/%?room=zahrada', '/%00', '/client/%00', '/index.html%00']) assert.strictEqual(await get(port, bad), 400, bad);
    // platné zakódované cesty sa dekódujú ako predtým
    assert.strictEqual(await get(port, '/index%2Ehtml'), 200);
    assert.strictEqual(await get(port, '/%69ndex.html'), 200);
    assert.strictEqual(await get(port, '/%2e%2e/package.json'), 403); // ../ po dekódovaní stále nevyjde z public/
    // spojenie WebSocket na rovnakú cestu server nezhodí (ws cestu nedekóduje)
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + port + '/%');
      ws.on('open', () => { ws.close(); resolve(); });
      ws.on('error', reject);
    });
    assert.strictEqual(await get(port, '/'), 200);
    assert.strictEqual(exited, null, 'server skončil\n' + srv.stderrText());
    assert.doesNotMatch(srv.stderrText(), /Chyba pri obsluhe požiadavky/); // 400 nejde cez poslednú poistku (žiadna 500)
  } finally {
    if (proc) await stopServer(proc);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server: chybný rámec WebSocket (bez masky, zlé UTF-8, neznámy opcode) zavrie len to spojenie, server beží ďalej (#145)', async () => {
  let dir: string | null = null, proc: Server | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-ws-'));
    const port = await freePort();
    proc = await startServer(dir, port);
    const srv = proc;
    let exited: number | null = null;
    srv.on('exit', c => { exited = c ?? -1; });
    await rawFrame(port, [0x81, 0x02, 0x41, 0x42]); // textový rámec bez masky
    await rawFrame(port, [0x81, 0x82, 0, 0, 0, 0, 0xff, 0xfe]); // maskovaný text s neplatným UTF-8
    await rawFrame(port, [0x83, 0x80, 0, 0, 0, 0]); // rezervovaný opcode 0x3
    await new Promise(r => { setTimeout(r, 100); });
    assert.strictEqual(exited, null, 'server skončil\n' + srv.stderrText());
    assert.strictEqual(await get(port, '/'), 200);
  } finally {
    if (proc) await stopServer(proc);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});
