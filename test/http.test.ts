// #145: požiadavka s chybným percentovým kódovaním v ceste (GET /%) zhodila celý server – decodeURIComponent hodil
// URIError a nič ho nezachytilo. Teraz dostane 400 a server slúži ďalej; platné zakódované cesty fungujú ako predtým.
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
// surová cesta, ako ju poslal klient (http.get ju nemení)
function get(port: number, urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, res => { res.resume(); res.on('end', () => { resolve(res.statusCode ?? 0); }); });
    req.on('error', reject);
  });
}

test('server: chybné percentové kódovanie v ceste dá 400 a server beží ďalej; platné zakódované cesty fungujú (#145)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-http-'));
  const port = await freePort();
  const proc = await startServer(dir, port);
  let exited: number | null = null;
  proc.on('exit', c => { exited = c ?? -1; });
  try {
    assert.strictEqual(await get(port, '/'), 200);
    for (const bad of ['/%', '/%zz', '/%E0%A4%A', '/client/%', '/%?room=zahrada']) assert.strictEqual(await get(port, bad), 400, bad);
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
    assert.strictEqual(exited, null, 'server skončil');
  } finally {
    await stopServer(proc);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
