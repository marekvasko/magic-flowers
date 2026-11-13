// Ceny riadku trhu (#112) – spoločné pre klienta (src/client/traderow.ts) a testy, aby to, čo hráč vidí na tlačidle,
// sedelo s tým, čo server naozaj vybaví: mierka posuvníka a prechod knihou (okamžitý obchod, zvyšok čaká, limit kusov).
import * as Bk from './book.ts';
import type { Level } from './book.ts';

export type Side = 'buy' | 'sell';

// ---- Mierka posuvníka ----
export interface Scale { market: number; lo: number; hi: number; P: number[]; toX(p: number): number; toP(x: number): number }
export function quantile(tr: readonly [number, number][], q: number): number {
  const tot = tr.reduce((a, t) => a + t[1], 0);
  let acc = 0;
  for (const [p, n] of tr) { acc += n; if (acc >= q * tot) return p; }
  const last = tr[tr.length - 1];
  return last ? last[0] : 0;
}
// tr = rozdelenie cien [cena, kusy] zoradené podľa ceny
// must = ceny, ktoré musia byť na posuvníku (predvolená cena, úrovne knihy pre zvolený počet)
export function scaleOf(market: number, tr: readonly [number, number][], must: readonly number[] = []): Scale {
  const data = tr.length ? tr : [[market, 1] as [number, number]];
  const q = [0.1, 0.25, 0.75, 0.9].map(v => quantile(data, v));
  const reach = Math.max(0, ...must.map(p => Math.abs(p - market) + 2));
  const span = Math.max(4, reach, Math.ceil(Math.max(market - (q[0] ?? market), (q[3] ?? market) - market) * 1.25));
  const lo = Math.max(1, market - span), hi = market + span;
  const count = new Map(data), sum = data.reduce((a, t) => a + t[1], 0), avg = sum / Math.max(1, hi - lo + 1);
  const weight = (p: number): number => Math.min(1.4, Math.max(0.75, 0.75 + 0.35 * ((count.get(p) ?? 0) + (count.get(p + 1) ?? 0)) / Math.max(1, 2 * avg)));
  const xs = new Map<number, number>();
  const half = (a: number, b: number, x0: number): void => {
    const ws: number[] = [];
    for (let p = a; p < b; p++) ws.push(weight(p));
    const s = ws.reduce((x, w) => x + w, 0) || 1;
    let x = x0; xs.set(a, x);
    ws.forEach((w, i) => { x += 0.5 * w / s; xs.set(a + i + 1, x); });
  };
  half(lo, market, 0); half(market, hi, 0.5);
  if (lo === market) xs.set(lo, 0.5);
  const at = (p: number): number => xs.get(p) ?? 0;
  const toX = (p: number): number => { if (p <= lo) return at(lo); if (p >= hi) return 1; const f = Math.floor(p); return at(f) + (at(f + 1) - at(f)) * (p - f); };
  const toP = (x: number): number => { if (x <= at(lo)) return lo; for (let p = lo; p < hi; p++) if (x <= at(p + 1)) return p + (x - at(p)) / Math.max(1e-9, at(p + 1) - at(p)); return hi; };
  const clamp = (v: number): number => Math.max(lo, Math.min(hi, v));
  return { market, lo, hi, P: [lo, clamp(q[0] ?? market), clamp(q[1] ?? market), market, clamp(q[2] ?? market), clamp(q[3] ?? market), hi], toX, toP };
}

// Prechod knihou pre riadok. book = úrovne strany, s ktorou hráč obchoduje (pri nákupe ponuky, pri predaji dopyty), v poradí
// výberu ako ich poslal server; null = tovar bez knihy (pevná cena fixed). mine = id vlastných objednávok: sám so sebou sa
// neobchoduje – prekryv sa v oboch zruší (pri nákupe tovar z vlastnej ponuky na vyzdvihnutie, pri predaji záloha dopytu
// späť) – preto sa vlastné kusy rátajú do počtu, ale za 0 mincí. fallback = cena, keď je kniha prázdna.
export interface Quoter {
  lv: Level[];                       // úrovne iných
  all: readonly Level[];             // aj vlastné
  isMine: (l: Level) => boolean;
  bookAvail: number;                 // kusov v knihe spolu (aj vlastných)
  thresh: (k: number) => number | null;  // cena, za ktorú sa k kusov vybaví naraz (ak kniha nestačí, jej posledná úroveň)
  walk: (k: number, lim: number) => { n: number; total: number };   // okamžite: koľko kusov a za koľko mincí po limit lim
  quote: (k: number, p: number) => { now: boolean; total: number }; // čo hneď za ceny knihy a zvyšok (čaká) za p
  need: (k: number, p: number) => number;   // mince potrebné pri nákupe: okamžitý = súčet, dopyt = záloha k × p
  defPrice: (k: number) => number;       // predvolená cena: celý počet hneď
  limit: (coins: number, have: number) => number;   // najviac kusov: pri predaji čo má, pri nákupe čo zaplatí
  market: () => number;                  // trhová cena: najlepšia cena iných za 1 kus
}
export function quoter(book: readonly Level[] | null, side: Side, mine: ReadonlySet<string>, o: { fixed: number; fallback: number; fresh?: ((i: number) => number) | undefined }): Quoter {
  const all = book ?? [], isMine = (l: Level): boolean => !!l.id && mine.has(l.id), lv = all.filter(l => !isMine(l));
  const bookAvail = all.reduce((a, l) => a + l.n, 0);
  const thresh = (k: number): number | null => { let got = 0, p: number | null = null; for (const l of all) { got += l.n; p = l.p; if (got >= k) break; } return p; };
  const walk = (k: number, lim: number): { n: number; total: number } => {
    const ok = all.filter(l => (side === 'buy' ? l.p <= lim : l.p >= lim)).map(l => (isMine(l) ? { p: 0, n: l.n, w: l.w } : l)), w = Bk.walk(ok, k, o.fresh);
    return { n: w.n, total: w.total };
  };
  const quote = (k: number, p: number): { now: boolean; total: number } => {
    if (!book) return { now: true, total: k * o.fixed };
    const w = walk(k, p);
    return { now: w.n >= k, total: w.total + (k - w.n) * p };
  };
  const need = (k: number, p: number): number => { const t = quote(k, p); return t.now ? t.total : k * p; };
  const defPrice = (k: number): number => thresh(k) ?? o.fallback;
  const limit = (coins: number, have: number): number => {
    if (side === 'sell') return Math.max(1, have);
    let k = 1;
    while (k < 99 && need(k + 1, defPrice(k + 1)) <= coins) k++;
    return k;
  };
  const market = (): number => (book ? lv[0]?.p ?? o.fallback : o.fixed);
  return { lv, all, isMine, bookAvail, thresh, walk, quote, need, defPrice, limit, market };
}
