// Riadok tovaru na trhu (#112): pás kusov (počet), posuvník ceny s grafom a jedno tlačidlo.
//  - Pás kusov: každý kus je ikona; ťuknutím na k-tú vyberieš k kusov, ťahaním prstom pridávaš / uberáš (relatívne – posun
//    o šírku ikony = 1 kus), prst za okrajom pásu pridáva / uberá sám. Pri nákupe najviac to, čo zaplatíš (ďalší kus
//    je zamknutý), pri predaji to, čo máš. Kusy nad tým, čo kniha vezme hneď, majú hnedú lištu – počkajú v Dopyte / Ponuke.
//  - Posuvník ceny: stred = trhová cena (najlepšia cena v knihe za 1 kus – nemení sa s počtom), na oboch stranách rovnaký
//    počet mincí podľa 10. a 90. percentilu cien obchodov (a celej knihy); každá minca má skoro rovnakú dĺžku (kde sa veľa
//    obchodovalo, najviac asi 2× dlhšiu). V grafe stĺpiky likvidity: kusy v knihe za každú cenu; kusy, ktoré si objednávka
//    zoberie, sa zafarbia farbou ceny zhora nadol. Fialová zóna = obchod sa vybaví hneď. Cez graf stopa
//    ceny po dňoch (zhora najstaršia, slabne; dole dnešná). Úchyt s cenou a šípkami ‹ › je nad grafom; ťahá sa kdekoľvek po posuvníku.
//    Predvolená cena je tá, za ktorú sa celý počet vybaví naraz.
//  - Tlačidlo: Kúpiť hneď / Predať hneď (okamžitý príkaz) alebo Dopyt / Ponuka (limitná objednávka), suma a cena za kus.
// Tovar bez knihy (elixíry, ľad, zvädnuté kvety…) má len pás kusov a tlačidlo – trh ho vykúpi za pevnú cenu.
import * as Bk from '../shared/book.ts';
import type { Level } from '../shared/book.ts';
import type { ItemId } from '../shared/data.ts';
import type { ClientMessage, MarketItemView } from '../shared/protocol.ts';

export type Side = 'buy' | 'sell';
// Čo si riadok pamätá medzi prekresleniami okna (správy zo servera okno prekreslia): počet a zvolená cena
export interface RowState { n?: number; price?: number | null }
export interface RowInput {
  id: ItemId;
  side: Side;
  icon: string;                    // obrázok tovaru (pás kusov)
  info: HTMLElement;               // ľavý blok s názvom a popisom (postaví game.ts)
  q: MarketItemView | null;        // null = tovar bez knihy, pevná cena fixed
  fixed: number;
  have: number;                    // koľko má hráč (predaj)
  coins: number;
  mine: ReadonlySet<string>;       // id vlastných objednávok (sám so sebou sa neobchoduje)
  own: readonly { p: number; n: number }[];   // vlastné čakajúce objednávky tejto strany (pri nákupe Dopyty, pri predaji Ponuky)
  fresh?: ((i: number) => number) | undefined;   // čerstvosť i-teho predávaného kvetu (postavy platia cena × čerstvosť)
  orderRoom: boolean;              // ešte smie zadať objednávku (limit podľa reputácie)
  state: RowState;
  send(m: ClientMessage): void;
  busy(on: boolean): void;         // počas ťahania sa okno neprekresľuje
}

const COL = { ink: '#2b2116', muted: '#7a6a4a', violet: '#6b3fa0', violetSoft: '#ece3f7', violetPale: 'rgba(107,63,160,.32)', edge: '#8b5a2b', bars: '#c9b48a', plot: '#faf3e2' };
const HANDLE = 30;   // výška pásu s úchytom nad grafom
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const W = 24; // šírka ikony v páse aj s medzerou

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---- Mierka posuvníka ----
interface Scale { market: number; lo: number; hi: number; P: number[]; toX(p: number): number; toP(x: number): number }
function quantile(tr: readonly [number, number][], q: number): number {
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
// Farba výhodnosti ceny: na trhovej cene čierna, ďalej od nej zelenejšia (lepšie pre hráča) alebo červenšia (horšie)
function advColor(sc: Scale, price: number, side: Side): string {
  const better = side === 'buy' ? price < sc.market : price > sc.market;
  const t = Math.min(1, Math.abs(sc.toX(price) - 0.5) / 0.5) ** 0.7;
  const a = [43, 33, 22], b = better ? [24, 160, 58] : [214, 40, 34];
  return `rgb(${a.map((v, i) => Math.round(v + ((b[i] ?? v) - v) * t)).join(',')})`;
}

// Trend ceny za posledné dni (TREND_DAYS denných cien späť): farba stopy ceny od sivohnedej (do 3 %) po sýtu zelenú
// (pohyb hráčovi pomáha: pri nákupe zlacnenie, pri predaji zdraženie) alebo červenú pri 20 %; angle = sklon šípky
// podľa veľkosti pohybu (rovno → skoro kolmo)
const TREND_DAYS = 3;
export function trend(hist: readonly number[], cur: number, side: Side): { angle: number; color: string } {
  const old = hist[Math.max(0, hist.length - 1 - TREND_DAYS)] ?? cur, pct = old ? (cur - old) / old : 0, a = Math.abs(pct);
  if (a < 0.03) return { angle: 0, color: 'rgb(138,122,98)' };
  const good = side === 'buy' ? pct < 0 : pct > 0, k = Math.min(1, a / 0.2) ** 0.7, from = [138, 122, 98], to = good ? [30, 150, 60] : [210, 45, 35];
  return { angle: Math.min(80, 15 + a / 0.2 * 65) * Math.sign(pct), color: `rgb(${from.map((v, i) => Math.round(v + ((to[i] ?? v) - v) * k)).join(',')})` };
}

export function tradeRow(r: RowInput): HTMLElement {
  const { id, side, q } = r;
  const lv: Level[] = q ? (side === 'buy' ? q.a : q.b).filter(l => !l.id || !r.mine.has(l.id)) : [];
  const bookAvail = lv.reduce((a, l) => a + l.n, 0);
  // cena, za ktorú sa k kusov vybaví naraz (posledná potrebná úroveň knihy; ak kniha nestačí, jej posledná úroveň)
  const thresh = (k: number): number | null => { let got = 0, p: number | null = null; for (const l of lv) { got += l.n; p = l.p; if (got >= k) break; } return p; };
  const walk = (k: number, lim: number): { n: number; total: number } => {
    const ok = lv.filter(l => (side === 'buy' ? l.p <= lim : l.p >= lim)), w = Bk.walk(ok, k, r.fresh);
    return { n: w.n, total: w.total };
  };
  // čo stojí / vynesie k kusov za cenu p: čo kniha vezme hneď, za jej ceny, a zvyšok (čaká v dopyte / ponuke) za p
  const quote = (k: number, p: number): { now: boolean; total: number } => {
    if (!q) return { now: true, total: k * r.fixed };
    const w = walk(k, p);
    return { now: w.n >= k, total: w.total + (k - w.n) * p };
  };
  // koľko mincí treba mať pri nákupe: okamžitý nákup = súčet, dopyt si server zálohuje celý k × p (rozdiel vráti)
  const need = (k: number, p: number): number => { const t = quote(k, p); return t.now ? t.total : k * p; };
  const defPrice = (k: number): number => thresh(k) ?? (q ? q.p : r.fixed);
  const limit = (): number => {
    if (side === 'sell') return Math.max(1, r.have);
    let k = 1;
    while (k < 99 && need(k + 1, defPrice(k + 1)) <= r.coins) k++;
    return k;
  };
  const st = r.state;
  let n = Math.max(1, Math.min(limit(), st.n ?? (side === 'sell' ? r.have : 1)));
  st.n = n;

  const row = el('div', 'item');
  const top = el('div', 'top'); const ic = el('img'); ic.src = r.icon; top.append(ic, r.info);
  // pás kusov a popis počtu
  const qty = el('div', 'qty'), strip = el('div', 'strip'), track = el('div', 'track');
  strip.tabIndex = 0; strip.setAttribute('role', 'slider'); strip.setAttribute('aria-label', 'Počet kusov'); strip.setAttribute('aria-valuemin', '1');
  strip.append(track); qty.append(strip);
  row.append(top, qty);
  // posuvník ceny (len tovar s knihou), tlačidlo, riadok s cenou
  const trade = el('div', 'trade'), go = el('button', 'go');
  go.type = 'button';
  let slider: HTMLDivElement | null = null, cv: HTMLCanvasElement | null = null;
  if (q) {
    slider = el('div', 'slider'); cv = el('canvas'); cv.setAttribute('aria-hidden', 'true');
    slider.tabIndex = 0; slider.setAttribute('role', 'slider'); slider.setAttribute('aria-label', 'Cena za kus');
    slider.append(cv); trade.append(slider);
  }
  trade.append(go); row.append(trade);
  const hint = el('div', 'hint'); hint.setAttribute('aria-live', 'polite');
  // vlastné čakajúce objednávky tej istej strany: v grafe šrafovaný stĺpik, pod riadkom krátky popis
  const ownLine = el('div', 'own');
  if (q) row.append(hint, ownLine);

  let sc: Scale = scaleOf(1, []), price = 1;
  // trhová cena: najlepšia cena v knihe za 1 kus (pri nákupe najlacnejšia ponuka, pri predaji najvyšší dopyt) – nezávisí
  // od zvoleného počtu, takže stred posuvníka a čiara trhu pri zmene počtu stoja na mieste
  const market = (): number => (q ? lv[0]?.p ?? q.p : r.fixed);
  const trades = (): [number, number][] => {
    if (!q) return [];
    if (q.t.length) return q.t;
    // ešte žiadne obchody: náhradou kusy v knihe na strane, s ktorou hráč obchoduje, inak denné ceny veľkoobchodníka
    const by = new Map<number, number>();
    const src: [number, number][] = (side === 'buy' ? q.a : q.b).map(l => [l.p, l.n]);
    for (const [p, k] of src.length ? src : q.h.map(p => [p, 1] as [number, number])) by.set(p, (by.get(p) ?? 0) + k);
    return [...by.entries()].sort((a, b) => a[0] - b[0]);
  };

  function fillStrip(center: boolean): void {
    const lim = limit();
    const shown = side === 'sell' ? Math.max(1, r.have) : Math.min(lim + 1, Math.max(bookAvail, n) + 3, 99);
    track.innerHTML = '';
    for (let k = 1; k <= shown; k++) {
      const c = el('div', 'pc' + (k <= n ? ' on' : '') + (k === n ? ' last' : '') + (q && k > bookAvail && k <= lim ? ' wait' : '') + (k > lim ? ' lock' : ''));
      const im = el('img'); im.src = r.icon; im.alt = ''; c.append(im);
      if (k > lim) { c.title = 'Viac nezaplatíš'; c.insertAdjacentHTML('beforeend', '<svg class="padlock" viewBox="0 0 14 16" aria-hidden="true"><path d="M4 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="1.5" y="7" width="11" height="8" rx="2" fill="currentColor"/><circle cx="7" cy="11" r="1.3" fill="#fff8e7"/></svg>'); }
      track.append(c);
    }
    // posun pásu: po ťuknutí vybraný kus do stredu, pri ťahaní len aby bol vidieť
    const view = strip.clientWidth || 200, maxScroll = Math.max(0, shown * W - view);
    let left = strip.scrollLeft;
    if (center) left = (n - 0.5) * W - view / 2;
    else {
      const want = Math.min(shown, n + 1) * W - view;
      if (want > left) left = want; else if ((n - 1) * W < left) left = (n - 2) * W;
    }
    left = Math.round(Math.max(0, Math.min(maxScroll, left)));
    if (left !== strip.scrollLeft) strip.scrollTo({ left, behavior: center ? 'smooth' : 'auto' });
    strip.classList.toggle('fl', left > 1);
    strip.classList.toggle('fr', left + view < shown * W - 3);
    strip.setAttribute('aria-valuenow', String(n)); strip.setAttribute('aria-valuemax', String(lim));
  }

  function draw(): void {
    if (!cv || !q) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    // hore pás s úchytom (mimo pozadia grafu), pod ním graf po os (base), pod osou ceny
    const x = (p: number): number => 6 + sc.toX(p) * (w - 12), base = h - 16, top = HANDLE;
    g.fillStyle = COL.plot; g.beginPath(); g.roundRect(0, top, w, h - top, 9); g.fill();
    // fialová zóna: odtiaľ sa celý počet vybaví hneď (presne od ceny, za ktorú sa vybaví posledný potrebný kus)
    const best = n <= bookAvail ? thresh(n) : null, edgeX = best == null ? null : x(best);
    if (edgeX != null) {
      g.fillStyle = COL.violetSoft; g.beginPath();
      if (side === 'buy') g.roundRect(edgeX, top, w - edgeX, base - top, [0, 9, 0, 0]); else g.roundRect(0, top, edgeX, base - top, [9, 0, 0, 0]);
      g.fill();
      g.setLineDash([2, 2]); g.strokeStyle = COL.violet; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(edgeX, top); g.lineTo(edgeX, base); g.stroke(); g.setLineDash([]);
    }
    // os a značky percentilov (bez popisu trhu – trh je čiarkovaná čiara), čiarkovaná čiara trhu
    g.strokeStyle = COL.bars; g.lineWidth = 1; g.beginPath(); g.moveTo(6, base + 0.5); g.lineTo(w - 6, base + 0.5); g.stroke();
    g.font = `700 10px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'top';
    const shownAt = [x(sc.market)];
    for (const i of [1, 5, 2, 4]) {
      const p = sc.P[i] ?? sc.market, at = x(p);
      g.fillStyle = COL.muted; g.fillRect(at - 0.5, base, 1, 4);
      if (shownAt.some((v, k) => Math.abs(v - at) < (k === 0 ? 16 : 24))) continue;
      shownAt.push(at); g.fillText(String(p), at, base + 4);
    }
    g.setLineDash([3, 3]); g.strokeStyle = COL.ink; g.globalAlpha = 0.5;
    g.beginPath(); g.moveTo(x(sc.market) + 0.5, top); g.lineTo(x(sc.market) + 0.5, base); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    // stopa ceny: denné ceny (q.h, najstaršia hore) a dnešná dole pri osi ako hladká krivka cez graf – zhora slabne
    // do stratena, dole je najsýtejšia; farba podľa trendu za posledné dni (šedá, zelená / červená). Denné ceny sú
    // ceny veľkoobchodníka (pri predaji iná úroveň než dopyty), preto sa kreslí pomer k dnešnej cene: stopa končí
    // na čiare trhu a ukazuje, ako sa cena hýbala
    const hist = [...q.h, q.p];
    if (hist.length >= 2 && q.p > 0) {
      const t = trend(q.h, q.p, side), y0 = top + 4, y1 = base - 3, last = hist.length - 1;
      const pts = hist.map((p, i): [number, number] => [x(Math.max(sc.lo, Math.min(sc.hi, sc.market * p / q.p))), y0 + (y1 - y0) * i / last]);
      const at = (i: number): [number, number] => pts[Math.max(0, Math.min(last, i))] ?? [0, 0];
      const fade = g.createLinearGradient(0, y0, 0, y1);
      fade.addColorStop(0, t.color.replace('rgb(', 'rgba(').replace(')', ',0)'));
      fade.addColorStop(1, t.color.replace('rgb(', 'rgba(').replace(')', ',0.85)'));
      g.strokeStyle = fade; g.lineWidth = 2; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(...at(0));
      // Catmull-Rom cez denné body → kubické Bézierove úseky (hladká krivka, prechádza každým dňom)
      for (let i = 0; i < last; i++) {
        const [ax, ay] = at(i - 1), [bx, by] = at(i), [cx, cy] = at(i + 1), [dx, dy] = at(i + 2);
        g.bezierCurveTo(bx + (cx - ax) / 6, by + (cy - ay) / 6, cx - (dx - bx) / 6, cy - (dy - by) / 6, cx, cy);
      }
      g.stroke();
      const [ex, ey] = at(last);
      g.fillStyle = t.color; g.beginPath(); g.arc(ex, ey, 2.8, 0, Math.PI * 2); g.fill();
    }
    // jazdec: čiara od úchytu po os, úchyt nad grafom (cena a šípky ‹ ›). Pri okraji sa úchyt nevycentruje nad cenou –
    // jeho dolný roh na strane hrotu je vtedy skoro ostrý a hrot z neho plynule vychádza
    const px = x(price), col = advColor(sc, price, side);
    g.fillStyle = col; g.fillRect(px - 1.5, top - 4, 3, base - top + 4);
    {
      const hw = 58, hh = 24, hx = Math.max(1, Math.min(w - hw - 1, px - hw / 2)), hy = 1, cy = hy + hh / 2;
      const nearL = px - hx < 17, nearR = hx + hw - px < 17, tipX = Math.max(hx + 5, Math.min(hx + hw - 5, px));
      g.save(); g.shadowColor = 'rgba(60,40,20,.25)'; g.shadowBlur = 4; g.shadowOffsetY = 1.5;
      g.fillStyle = col; g.beginPath(); g.roundRect(hx, hy, hw, hh, [12, 12, nearR ? 2 : 12, nearL ? 2 : 12]); g.fill(); g.restore();
      g.fillStyle = col; g.beginPath(); g.moveTo(tipX - 5, hy + hh - 1); g.lineTo(tipX + 5, hy + hh - 1); g.lineTo(px, hy + hh + 5); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 2; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(hx + 12, cy - 4.5); g.lineTo(hx + 7.5, cy); g.lineTo(hx + 12, cy + 4.5); g.stroke();
      g.beginPath(); g.moveTo(hx + hw - 12, cy - 4.5); g.lineTo(hx + hw - 7.5, cy); g.lineTo(hx + hw - 12, cy + 4.5); g.stroke();
      g.fillStyle = '#fff'; g.font = `800 12px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillText(String(price), hx + hw / 2, cy + 0.5);
    }
    // stĺpiky likvidity nad jazdcom: kusy v knihe za každú cenu (všetky objednávky spolu), bledofialové; kusy, ktoré si
    // objednávka s touto cenou a počtom zoberie (od najlepšej ceny), sa zafarbia farbou ceny zhora nadol
    const inBook = new Map<number, number>(), taken = new Map<number, number>();
    for (const l of lv) inBook.set(l.p, (inBook.get(l.p) ?? 0) + l.n);
    let left = n;
    for (const l of lv) {
      if (left <= 0 || (side === 'buy' ? l.p > price : l.p < price)) break;
      const k = Math.min(l.n, left); taken.set(l.p, (taken.get(l.p) ?? 0) + k); left -= k;
    }
    const topMax = Math.max(1, ...inBook.values(), ...r.own.map(o => o.n)), hMax = base - top - 12;
    for (const [p, k] of inBook) {
      if (p < sc.lo || p > sc.hi) continue;
      const bw = Math.max(3, Math.min(6, (x(p + 0.5) - x(p - 0.5)) * 0.7)), hh = Math.max(3, (k / topMax) * hMax), th = hh * Math.min(1, (taken.get(p) ?? 0) / k);
      g.fillStyle = COL.violetPale; g.fillRect(x(p) - bw / 2, base - hh + th, bw, hh - th);
      if (th > 0) { g.fillStyle = advColor(sc, p, side); g.fillRect(x(p) - bw / 2, base - hh, bw, th); }
    }
    // vlastné čakajúce objednávky tejto strany (Dopyt pri nákupe, Ponuka pri predaji): šrafovaný stĺpik s obrysom
    // vo farbe objednávky – v knihe proti nim obchod nie je, len aby hráč videl, kde jeho objednávka stojí
    const ownCol = side === 'buy' ? COL.violet : COL.edge;
    for (const o of r.own) {
      if (o.p < sc.lo || o.p > sc.hi) continue;
      const bw = 7, hh = Math.max(6, (o.n / topMax) * hMax), bx = x(o.p) - bw / 2, by = base - hh;
      g.save(); g.beginPath(); g.rect(bx, by, bw, hh); g.clip();
      g.fillStyle = side === 'buy' ? 'rgba(107,63,160,.18)' : 'rgba(139,90,43,.18)'; g.fillRect(bx, by, bw, hh);
      g.strokeStyle = ownCol; g.lineWidth = 1.2;
      g.beginPath(); for (let k = -bw; k < hh + bw; k += 4) { g.moveTo(bx, by + k + bw); g.lineTo(bx + bw, by + k); } g.stroke();
      g.restore();
      g.strokeStyle = ownCol; g.lineWidth = 1.5; g.strokeRect(bx + 0.75, by + 0.75, bw - 1.5, hh - 1.5);
    }
  }

  // prepočet riadku; resetPrice = cena späť na predvolenú (celý počet hneď)
  function render(resetPrice: boolean, center = false): void {
    st.n = n;
    if (q) {
      // na posuvníku musí byť predvolená cena, zvolená cena a kniha až kúsok za to, čo by objednávka mohla zobrať
      const reach: number[] = []; let got = 0;
      for (const l of lv) { if (got > n * 2 + 3) break; reach.push(l.p + (side === 'buy' ? 1 : -1)); got += l.n; }
      sc = scaleOf(market(), trades(), [defPrice(n), ...reach, ...r.own.map(o => o.p), ...(st.price != null ? [st.price] : [])]);
      if (resetPrice || st.price == null) { st.price = null; price = defPrice(n); }
      else price = st.price;
      price = Math.max(1, Math.round(price));
      if (slider) {
        slider.setAttribute('aria-valuenow', String(price)); slider.setAttribute('aria-valuetext', `${String(price)} mincí za kus`);
        slider.setAttribute('aria-valuemin', String(sc.lo)); slider.setAttribute('aria-valuemax', String(sc.hi));
      }
    } else price = r.fixed;
    fillStrip(center);
    const { now, total } = quote(n, price);
    const verb = now ? (side === 'buy' ? 'Kúpiť hneď' : 'Predať hneď') : (side === 'buy' ? 'Dopyt' : 'Ponuka');
    go.className = 'go ' + (now ? 'now' : 'wait');
    go.innerHTML = '';
    // pod sumou cena za kus: pri okamžitom obchode cez viac cien priemer (≈), inak presne
    // v tlačidle aj počet kusov (pás nad ním má celú šírku); keď sa časť vybaví hneď a zvyšok počká, aj koľko počká
    const each = total / Math.max(1, n), waits = q && !now ? n - walk(n, price).n : 0;
    go.append(el('small', '', !now && !r.orderRoom ? 'Plno objednávok' : verb),
      el('b', 'pcs', `${String(n)} ks` + (waits && waits < n ? ` · ${String(waits)} čaká` : '')), el('span', 'amt', `${String(total)} 🪙`),
      el('small', 'each', `${Number.isInteger(each) ? '' : '≈ '}${String(Math.round(each))} 🪙/ks`));
    go.disabled = (side === 'buy' ? need(n, price) > r.coins : n > r.have) || (!now && !r.orderRoom);
    if (q) {
      // porovnanie s trhovou cenou a koľko kusov je v knihe za túto cenu alebo lepšiu (na všetko to objednávka dosiahne);
      // cena za kus je na úchyte
      const diff = Math.round(Math.abs(price / sc.market - 1) * 100);
      ownLine.textContent = r.own.length ? `${side === 'buy' ? '🏷️ Tvoj dopyt' : '🏷️ Tvoja ponuka'}: ${r.own.map(o => `${String(o.n)} ks za ${String(o.p)} 🪙`).join(', ')} · v Moje` : '';
      ownLine.hidden = !r.own.length;
      hint.innerHTML = '';
      if (price === sc.market || !diff) hint.append(el('b', '', 'trhová cena'));
      else { const s = el('span', 'adv', `${String(diff)} % ${price > sc.market ? 'nad' : 'pod'} trhom`); s.style.color = advColor(sc, price, side); hint.append(s); }
      const k = lv.filter(l => (side === 'buy' ? l.p <= price : l.p >= price)).reduce((a, l) => a + l.n, 0);
      hint.append(document.createTextNode(' · ' + (side === 'buy' ? (k ? `${String(k)} ks v ponuke` : 'žiadna ponuka') : (k ? `${String(k)} ks v dopyte` : 'žiadny dopyt'))));
    }
    draw();
  }
  const set = (k: number, center = false): void => {
    const v = Math.max(1, Math.min(limit(), k));
    if (v !== n) { n = v; render(true, center); } else if (center) fillStrip(true);
  };

  // ---- ovládanie pásu ----
  const idxAt = (cx: number): number => Math.max(1, Math.floor((cx - strip.getBoundingClientRect().left + strip.scrollLeft) / W) + 1);
  let drag: { x0: number; n0: number; moved: boolean } | null = null, edge: ReturnType<typeof setInterval> | null = null;
  const stopEdge = (): void => { if (edge) clearInterval(edge); edge = null; };
  strip.addEventListener('pointerdown', e => { strip.setPointerCapture(e.pointerId); drag = { x0: e.clientX, n0: n, moved: false }; r.busy(true); });
  strip.addEventListener('pointermove', e => {
    const d = drag;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) > 6) { d.moved = true; strip.classList.add('drag'); d.x0 = e.clientX; }
    if (!d.moved) return;
    const rc = strip.getBoundingClientRect(), dir = e.clientX > rc.right ? 1 : e.clientX < rc.left ? -1 : 0;
    stopEdge();
    const want = d.n0 + Math.round((e.clientX - d.x0) / W);
    set(want);
    if (want !== n) { d.n0 = n; d.x0 = e.clientX; } // narazil na hranicu: od tohto miesta znova
    if (dir) { const cx = e.clientX; edge = setInterval(() => { set(n + dir); d.n0 = n; d.x0 = cx; }, 160); }
  });
  const end = (e: PointerEvent): void => {
    const d = drag;
    if (!d) return;
    stopEdge(); strip.classList.remove('drag');
    if (!d.moved && e.type === 'pointerup') { const k = idxAt(e.clientX); set(k === n && k > 1 ? k - 1 : k, true); }
    drag = null; r.busy(false);
  };
  strip.addEventListener('pointerup', end); strip.addEventListener('pointercancel', end);
  strip.addEventListener('keydown', e => {
    const d = ({ ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 } as Partial<Record<string, number>>)[e.key];
    if (d) { e.preventDefault(); set(n + d); } else if (e.key === 'Home') { e.preventDefault(); set(1); } else if (e.key === 'End') { e.preventDefault(); set(limit()); }
  });

  // ---- posuvník ceny ----
  // vlastné ťahanie (skrytý <input type=range> na mobile reagoval len pri chytení neviditeľného palca): ťuknutie kamkoľvek
  // posunie jazdca pod prst, ťahanie ho vedie; cena = mince pod prstom. touch-action: pan-y – zvislý pohyb posúva okno.
  if (slider && cv) {
    const sl = slider, canvas = cv;
    const priceAt = (cx: number): number => { const rc = canvas.getBoundingClientRect(); return Math.round(sc.toP(Math.max(0, Math.min(1, (cx - rc.left - 6) / Math.max(1, rc.width - 12))))); };
    const setPrice = (p: number): void => { const v = Math.max(Math.max(1, sc.lo), Math.min(sc.hi, p)); if (v !== price) { st.price = v; render(false); } };
    let held = false;
    sl.addEventListener('pointerdown', e => { if (e.button > 0) return; held = true; sl.setPointerCapture(e.pointerId); sl.classList.add('drag'); r.busy(true); setPrice(priceAt(e.clientX)); });
    sl.addEventListener('pointermove', e => { if (held) setPrice(priceAt(e.clientX)); });
    const release = (): void => { if (!held) return; held = false; sl.classList.remove('drag'); r.busy(false); };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) sl.addEventListener(ev, release);
    sl.addEventListener('keydown', e => {
      const d = ({ ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 5, PageDown: -5 } as Partial<Record<string, number>>)[e.key];
      if (d) { e.preventDefault(); setPrice(price + d); }
      else if (e.key === 'Home') { e.preventDefault(); setPrice(sc.lo); } else if (e.key === 'End') { e.preventDefault(); setPrice(sc.hi); }
    });
  }

  go.addEventListener('click', () => {
    const { now } = quote(n, price);
    if (now) r.send({ t: side, id, n, lim: price });
    else r.send({ t: 'order', id, side, n, p: price });
    st.price = null; if (side === 'buy') st.n = 1; else delete st.n;
  });

  // prvé vykreslenie, až keď má plátno rozmer; pri zmene šírky znova
  render(st.price == null);
  if (cv) new ResizeObserver(() => { draw(); }).observe(cv);
  requestAnimationFrame(() => { fillStrip(false); });
  return row;
}
