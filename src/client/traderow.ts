// Riadok tovaru na trhu (#112): pás kusov (počet), posuvník ceny s grafom a jedno tlačidlo.
//  - Pás kusov: každý kus je ikona; ťuknutím na k-tú vyberieš k kusov, ťahaním prstom pridávaš / uberáš (relatívne – posun
//    o šírku ikony = 1 kus), prst za okrajom pásu pridáva / uberá sám. Pri nákupe najviac to, čo zaplatíš (ďalší kus
//    je zamknutý), pri predaji to, čo máš. Kusy nad tým, čo kniha vezme hneď, majú hnedú lištu – počkajú v Dopyte / Ponuke.
//  - Posuvník ceny: stred = trhová cena (priemer okamžitého obchodu pre zvolený počet), na oboch stranách rovnaký počet
//    mincí podľa 10. a 90. percentilu cien obchodov; každá minca má skoro rovnakú dĺžku (kde sa veľa obchodovalo,
//    najviac asi 2× dlhšiu). V pozadí kusy: dole predané za posledné dni, hore to, čo je práve v knihe (s počtom).
//    Fialová zóna = obchod sa vybaví hneď. Predvolená cena je tá, za ktorú sa celý počet vybaví naraz.
//  - Tlačidlo: Kúpiť hneď / Predať hneď (okamžitý príkaz) alebo Dopyt / Ponuka (limitná objednávka) a suma.
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
  fresh?: ((i: number) => number) | undefined;   // čerstvosť i-teho predávaného kvetu (postavy platia cena × čerstvosť)
  orderRoom: boolean;              // ešte smie zadať objednávku (limit podľa reputácie)
  state: RowState;
  send(m: ClientMessage): void;
  busy(on: boolean): void;         // počas ťahania sa okno neprekresľuje
}

const COL = { ink: '#2b2116', muted: '#7a6a4a', violet: '#6b3fa0', violetSoft: '#ece3f7', edge: '#8b5a2b', bars: '#c9b48a', plot: '#faf3e2' };
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
  const qty = el('div', 'qty'), strip = el('div', 'strip'), track = el('div', 'track'), count = el('div', 'count');
  strip.tabIndex = 0; strip.setAttribute('role', 'slider'); strip.setAttribute('aria-label', 'Počet kusov'); strip.setAttribute('aria-valuemin', '1');
  strip.append(track); qty.append(strip, count);
  row.append(top, qty);
  // posuvník ceny (len tovar s knihou), tlačidlo, riadok s cenou
  const trade = el('div', 'trade'), go = el('button', 'go');
  go.type = 'button';
  let slider: HTMLDivElement | null = null, cv: HTMLCanvasElement | null = null, inp: HTMLInputElement | null = null;
  if (q) {
    slider = el('div', 'slider'); cv = el('canvas'); inp = el('input');
    inp.type = 'range'; inp.min = '0'; inp.max = '1000'; inp.id = `cena-${side}-${id}`; inp.setAttribute('aria-label', 'Cena za kus');
    slider.append(cv, inp); trade.append(slider);
  }
  trade.append(go); row.append(trade);
  const hint = el('div', 'hint'); hint.setAttribute('aria-live', 'polite');
  if (q) row.append(hint);

  let sc: Scale = scaleOf(1, []), price = 1;
  const marketOf = (k: number): number => {
    if (!q) return r.fixed;
    const kk = Math.min(k, bookAvail);
    return kk > 0 ? Math.round(walk(kk, side === 'buy' ? 1e9 : 0).total / kk) : q.p;
  };
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
    const atMax = n >= lim, waiting = q ? Math.max(0, n - bookAvail) : 0;
    const sub = side === 'buy'
      ? (atMax ? 'viac nezaplatíš' : waiting ? `${waiting} v dopyte` : 'hneď')
      : (waiting ? `${waiting} v ponuke` : atMax ? 'všetko hneď' : 'hneď');
    count.innerHTML = '';
    const s2 = el('small', atMax && side === 'buy' ? 'max' : '', sub);
    count.append(el('small', 'lbl', side === 'buy' ? 'kúpiš' : 'predáš'), el('b', '', `${n} ks`), s2);
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
    const x = (p: number): number => 6 + sc.toX(p) * (w - 12), base = h - 16;
    g.fillStyle = COL.plot; g.fillRect(0, 0, w, h);
    // fialová zóna: odtiaľ sa celý počet vybaví hneď
    const best = n <= bookAvail ? thresh(n) : null;
    if (best != null) { g.fillStyle = COL.violetSoft; if (side === 'buy') g.fillRect(x(best), 0, w - x(best), base); else g.fillRect(0, 0, x(best), base); }
    // dole: predané kusy za cenu za posledné dni
    const tr = trades(), max = Math.max(1, ...tr.map(t => t[1]));
    for (const [p, k] of tr) {
      if (p < sc.lo || p > sc.hi) continue;
      const bw = Math.max(2, Math.min(7, (x(p + 0.5) - x(p - 0.5)) * 0.7)), hh = (k / max) * (base - 30);
      g.fillStyle = COL.bars; g.fillRect(x(p) - bw / 2, base - hh, bw, hh);
    }
    // hore: kusy v knihe za každú cenu (všetky objednávky spolu), s počtom
    const inBook = new Map<number, number>();
    for (const l of lv) inBook.set(l.p, (inBook.get(l.p) ?? 0) + l.n);
    const topMax = Math.max(1, ...inBook.values()), bookCol = side === 'buy' ? COL.violet : COL.edge, labels: [string, number, number][] = [];
    let lastLabel = -1e9;
    for (const p of [...inBook.keys()].sort((a, b) => a - b)) {
      if (p < sc.lo || p > sc.hi) continue;
      const k = inBook.get(p) ?? 0, bw = Math.max(4, Math.min(8, (x(p + 0.5) - x(p - 0.5)) * 0.7)), hh = 3 + (k / topMax) * 13;
      g.fillStyle = bookCol; g.globalAlpha = 0.75; g.fillRect(x(p) - bw / 2, 1, bw, hh); g.globalAlpha = 1;
      if (x(p) - lastLabel >= 11) { labels.push([String(k), x(p), hh + 2]); lastLabel = x(p); }
    }
    // os, značky percentilov (trh má prednosť, popisy sa neprekrývajú), čiarkovaný stred
    g.strokeStyle = COL.bars; g.lineWidth = 1; g.beginPath(); g.moveTo(6, base + 0.5); g.lineTo(w - 6, base + 0.5); g.stroke();
    g.font = `700 10px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'top';
    const shownAt = [x(sc.market)];
    for (const i of [3, 1, 5, 2, 4]) {
      const p = sc.P[i] ?? sc.market, at = x(p);
      g.fillStyle = i === 3 ? COL.ink : COL.muted;
      g.fillRect(at - 0.5, base, 1, 4);
      if (i !== 3 && shownAt.some((v, k) => Math.abs(v - at) < (k === 0 ? 32 : 24))) continue;
      if (i !== 3) shownAt.push(at);
      g.fillText(i === 3 ? `${p} trh` : String(p), at, base + 4);
    }
    g.setLineDash([3, 3]); g.strokeStyle = COL.ink; g.globalAlpha = 0.5;
    g.beginPath(); g.moveTo(x(sc.market) + 0.5, 0); g.lineTo(x(sc.market) + 0.5, base); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    // jazdec: čiara cez graf, kruh s cenou dole
    const px = x(price), ky = base - 15, col = advColor(sc, price, side);
    g.fillStyle = col; g.fillRect(px - 1.5, 0, 3, base);
    g.beginPath(); g.arc(px, ky, 11, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = `800 11px ${FONT}`; g.textBaseline = 'middle'; g.fillText(String(price), px, ky + 0.5);
    g.font = `800 9px ${FONT}`; g.textBaseline = 'top'; g.fillStyle = bookCol;
    for (const [t, lx, ly] of labels) g.fillText(t, lx, ly);
  }

  // prepočet riadku; resetPrice = cena späť na predvolenú (celý počet hneď)
  function render(resetPrice: boolean, center = false): void {
    st.n = n;
    if (q) {
      sc = scaleOf(marketOf(n), trades(), [defPrice(n), ...(st.price != null ? [st.price] : [])]);
      if (resetPrice || st.price == null) { st.price = null; price = defPrice(n); }
      else price = st.price;
      price = Math.max(1, Math.round(price));
      if (inp) inp.value = String(Math.round(sc.toX(price) * 1000));
    } else price = r.fixed;
    fillStrip(center);
    const { now, total } = quote(n, price);
    const verb = now ? (side === 'buy' ? 'Kúpiť hneď' : 'Predať hneď') : (side === 'buy' ? 'Dopyt' : 'Ponuka');
    go.className = 'go ' + (now ? 'now' : 'wait');
    go.innerHTML = '';
    go.append(el('small', '', !now && !r.orderRoom ? 'Plno objednávok' : verb), el('span', 'amt', `${String(total)} 🪙`));
    go.disabled = (side === 'buy' ? need(n, price) > r.coins : n > r.have) || (!now && !r.orderRoom);
    if (q) {
      const better = side === 'buy' ? price < sc.market : price > sc.market, diff = Math.round(Math.abs(price / sc.market - 1) * 100);
      hint.innerHTML = '';
      hint.append(el('b', '', `${String(price)} 🪙/ks`), document.createTextNode(' · '));
      if (price === sc.market || !diff) hint.append(el('b', '', 'trhová cena'));
      else { const s = el('span', 'adv', `${String(diff)} % ${side === 'buy' ? (better ? 'lacnejšie' : 'drahšie') : (better ? 'drahšie' : 'lacnejšie')}`); s.style.color = advColor(sc, price, side); hint.append(s); }
      const k = lv.filter(l => l.p === price).reduce((a, l) => a + l.n, 0);
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
  if (inp) {
    const input = inp;
    input.addEventListener('input', () => { st.price = Math.max(1, Math.round(sc.toP(Number(input.value) / 1000))); render(false); });
    input.addEventListener('pointerdown', () => { r.busy(true); });
    for (const ev of ['pointerup', 'pointercancel', 'change'] as const) input.addEventListener(ev, () => { r.busy(false); });
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
