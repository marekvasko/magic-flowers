// Prítomnosť hráčov: rýchle znovupripojenie, „kým si bol(a) preč“ a kontrola živých spojení (ping/pong).
import type { AreaId } from '../shared/data.ts';
import type { PlayerView } from '../shared/protocol.ts';

// Koľko celých herných dní ubehlo od posledného odchodu (lastTick). Bez záznamu 0.
export function awayDays(lastTick: number | null | undefined, tick: number, tpd: number): number {
  if (lastTick == null) return 0;
  return Math.max(0, Math.floor((tick - lastTick) / tpd));
}

// Časovače (v testoch náhrada za setTimeout / clearTimeout)
export interface Timers<H> {
  setTimeout(fn: () => void, ms: number): H;
  clearTimeout(h: H): void;
}
export interface Leaving {
  leave(key: string, fn: () => void): void;
  back(key: string): boolean;
  has(key: string): boolean;
}
const NODE_TIMERS: Timers<NodeJS.Timeout> = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: h => { clearTimeout(h); } };

// Odchody s odkladom: hlásenie „odišiel(a)“ sa pošle až po graceMs. Ak sa hráč medzitým vráti,
// back() hlásenie zruší a vráti true – ide o rýchle znovupripojenie.
export function createLeaving(graceMs: number): Leaving;
export function createLeaving<H>(graceMs: number, timers: Timers<H>): Leaving;
export function createLeaving<H>(graceMs: number, timers?: Timers<H>): Leaving {
  return timers ? leavingWith(graceMs, timers) : leavingWith(graceMs, NODE_TIMERS);
}
function leavingWith<H>(graceMs: number, t: Timers<H>): Leaving {
  const pending = new Map<string, H>();
  return {
    leave(key, fn) {
      const old = pending.get(key);
      if (old !== undefined) t.clearTimeout(old);
      pending.set(key, t.setTimeout(() => { pending.delete(key); fn(); }, graceMs));
    },
    back(key) {
      const h = pending.get(key);
      if (h === undefined) return false;
      t.clearTimeout(h);
      pending.delete(key);
      return true;
    },
    has(key) { return pending.has(key); }
  };
}

// Spojenie, ako ho potrebuje kontrola živosti (WebSocket z knižnice ws; isAlive si server pripisuje sám)
export interface LiveSocket {
  isAlive?: boolean;
  terminate(): void;
  ping(): void;
}

// Jedno kolo kontroly spojení: kto neodpovedal na minulý ping, toho odpojíme; ostatným pošleme nový.
// Polootvorené spojenie (vypadnutá wifi, mobil) by inak na serveri viselo bez konca.
export function heartbeat(clients: Iterable<LiveSocket>): void {
  for (const ws of clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* spojenie sa práve zatvára */ }
  }
}
export function watch(ws: Pick<LiveSocket, 'isAlive'> & { on(event: 'pong', fn: () => void): unknown }): void {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
}

// Pripojený hráč, ako ho potrebuje rozosielanie polôh
export interface Recipient {
  joining?: boolean;
  area: AreaId;
  ws: { readyState: number; send(data: string): void };
}

// Polohy hráčov (správa pl): každý dostane zoznam hráčov svojej plochy. Kto sa ešte pripája (nedostal welcome), nedostane
// nič – nepoznal by vlastné id a vlastnú postavičku by si nechal medzi ostatnými ako zamrznutého „ducha“ (#125).
export function sendPlayers(players: Iterable<Recipient>, list: readonly PlayerView[]): void {
  const msgs = new Map<AreaId, string>(); // plocha → JSON (raz pre všetkých na ploche)
  for (const p of players) {
    if (p.joining || p.ws.readyState !== 1) continue;
    let msg = msgs.get(p.area);
    if (msg === undefined) { msg = JSON.stringify({ t: 'pl', list: list.filter(q => q.area === p.area) }); msgs.set(p.area, msg); }
    p.ws.send(msg);
  }
}
