// Pohyb hráčov ako udalosti v plánovači (#101).
// Každý hráč má najviac jednu čakajúcu udalosť pohybu s kľúčom move:<hráč>:
//   'arrivedFrom' – klient poslal novú polohu. Server ju neoveruje vopred: hneď ju prepošle ostatným (hooks.forward)
//                   a až potom ju v najbližšom kroku vyhodnotí plánovač (hooks.evaluate – pavučiny, pavúky, prechody…).
//                   Novšia poloha nahradí ešte nevyhodnotenú; odkiaľ hráč išiel (fx, fy), ostane z tej staršej,
//                   takže vyhodnotenie vidí celú cestu od posledného vyhodnotenia.
//   'goTo'        – hráč ťukol na políčko a server ho tam vedie po najkratšej ceste: každý krok je ako arrivedFrom
//                   (odkiaľ → kam) a na konci sa goTo naplánuje znova na ďalší krok (pozri nižšie).
// Obe zdieľajú ten istý kľúč: nový pohyb od klienta zruší vedenie a nové vedenie zruší nevyhodnotený pohyb.
// Z posledného pohybu sa počíta rýchlosť (políčka za krok) – podľa nej pavúk predpovedá, kde hráč bude (pl.mv).
const D = require('./shared/data.js');
const E = require('./engine.js');
const Areas = require('./areas.js');

const WALK = 3.8; // rýchlosť chôdze hráča (políčka za sekundu, rovnako ako klient)
const KEY = pl => 'move:' + pl.key;

let hooks = { forward() {}, evaluate() {}, send() {} };
function setHooks(h) { hooks = Object.assign({}, hooks, h); }

function byKey(room, d) {
  if (!d || !room.players) return null;
  for (const p of room.players.values()) if (p.key === d.pk) return p.id === d.id && p.areaSeq === d.seq ? p : null;
  return null;
}

// Nová poloha od klienta (už orezaná na plochu). nowMs = reálny čas príchodu správy (na odhad rýchlosti).
function arrive(room, pl, x, y, nowMs) {
  const prev = E.pending(room, KEY(pl));
  const from = prev && prev.type === 'arrivedFrom' ? { x: prev.data.fx, y: prev.data.fy } : { x: pl.x, y: pl.y };
  // rýchlosť z dvoch po sebe idúcich správ, prepočítaná na jeden krok; po dlhšej prestávke hráč stál
  const ms = E.tickMs(room), gap = pl.mvAt != null ? nowMs - pl.mvAt : Infinity;
  const k = gap > 0 && gap <= 4 * ms ? ms / gap : 0;
  const vx = +((x - pl.x) * k).toFixed(4), vy = +((y - pl.y) * k).toFixed(4);
  pl.mvAt = nowMs;
  pl.x = x; pl.y = y;
  hooks.forward(pl); // najprv prepošleme…
  return E.scheduleUnique(room, KEY(pl), room.tick + 1, 'arrivedFrom', { pk: pl.key, id: pl.id, seq: pl.areaSeq, t: room.tick, fx: from.x, fy: from.y, x, y, vx, vy }); // …potom vyhodnotíme (t = krok servera pri príchode)
}
function onArrived(room, d) {
  const pl = byKey(room, d);
  if (!pl) return;
  pl.mv = { vx: d.vx || 0, vy: d.vy || 0, t: room.tick };
  hooks.evaluate(room, pl, { x: d.fx, y: d.fy });
}

// ---------- goTo: hráč ťukne na políčko, server ho tam vedie ----------
// Klient pošle cieľové políčko (gx, gy). goTo sa naplánuje na najbližší krok a má tie isté údaje ako arrivedFrom
// (odkiaľ fx, fy → kam x, y v tom kroku, rýchlosť vx, vy, krok servera t) plus cieľ a zvyšok cesty. Keď sa vykoná,
// hráč sa presunie na x, y, poloha ide ostatným, vyhodnotí sa ako príchod a goTo sa naplánuje znova na ďalší krok
// s ďalším úsekom cesty – až kým hráč nedôjde (hlásenie 'goToEnd'). Nedá sa tam dôjsť → 'goToNo' (klient to oznámi).
// n = poradové číslo žiadosti od klienta – správy k staršej, už nahradenej žiadosti klient zahodí.
const CRAWL = 0.45; // plazenie (rovnako ako klient)

// Najkratšie cesty sa pamätajú (na svet, plochu, štart a cieľ). Pred použitím sa cesta overí po políčkach,
// takže zmena sveta (ľad, pavučina) zapamätanú cestu len zneplatní a vypočíta sa nová.
const ROUTES = new WeakMap(), ROUTE_MAX = 256;
function routeKey(area, s, g, cr) { return area + ':' + s + ':' + g + (cr ? ':c' : ''); }
function webAt(room, area, i) { // ťuknutím sa do pavučiny nevbehne (joystickom áno)
  if (area !== 'les' || !room.spid) return false;
  for (const wb of room.spid.webs) for (let k = 0; k < wb.n; k++) if ((wb.y + (wb.ax ? k : 0)) * D.LES_W + wb.x + (wb.ax ? 0 : k) === i) return true;
  return false;
}
function stepOk(room, area, tiles, a, b, cr) { return D.canStep(tiles[a], tiles[b], 0, cr) && !webAt(room, area, b); }
function pathOk(room, area, start, path, cr) {
  const tiles = Areas.areaTiles(room, area);
  for (let k = 0, a = start; k < path.length; a = path[k++]) if (a !== path[k] && !stepOk(room, area, tiles, a, path[k], cr)) return false;
  return true;
}
// Cesta po políčkach plochy (4 smery, výšky ako pri chôdzi, bez pavučín) – zoznam políčok bez štartu, null = nedá sa
function route(room, area, from, to, cr) {
  const { w, h } = D.areaSize(area);
  const start = Math.floor(from.y) * w + Math.floor(from.x), goal = Math.floor(to.y) * w + Math.floor(to.x);
  let memo = ROUTES.get(room);
  if (!memo) ROUTES.set(room, memo = new Map());
  const key = routeKey(area, start, goal, cr), hit = memo.get(key);
  if (hit && pathOk(room, area, start, hit, cr)) { memo.delete(key); memo.set(key, hit); return hit.slice(); }
  const tiles = Areas.areaTiles(room, area);
  const prev = new Map([[start, -1]]), q = [start];
  let out = null;
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    if (i === goal) { out = []; for (let k = i; k !== start; k = prev.get(k)) out.unshift(k); break; }
    const cx = i % w, cy = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy, n = ny * w + nx;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || prev.has(n) || !stepOk(room, area, tiles, i, n, cr)) continue;
      prev.set(n, i); q.push(n);
    }
  }
  if (!out) { memo.delete(key); return null; }
  memo.set(key, out);
  if (memo.size > ROUTE_MAX) memo.delete(memo.keys().next().value);
  return out.slice();
}
// Rýchlosť chôdze v políčkach za krok (plazenie, ľad v batohu, lepkavá pavučina / pavúk na chrbte – pl.slow)
function walkPerTick(room, pl) {
  const ice = (pl.save && pl.save.inv && pl.save.inv.ice) || 0;
  const slowK = pl.slow && room.tick < pl.slow.until ? pl.slow.k : 1;
  return WALK * E.tickMs(room) / 1000 * (pl.cr ? CRAWL : 1) * Math.max(0.4, 1 - D.ICE_SLOW * ice) * slowK;
}
// Ďalší úsek cesty z (x, y): kam hráč dôjde za jeden krok. Overí zvyšok cesty; keď je zatarasená,
// cesta sa vypočíta znova. Vráti { x, y, path } alebo null (nedá sa ďalej).
function nextStep(room, pl, x, y, path, gx, gy) {
  const area = pl.area, { w } = D.areaSize(area);
  const here = Math.floor(y) * w + Math.floor(x);
  if (!pathOk(room, area, here, path, pl.cr)) {
    path = route(room, area, { x, y }, { x: gx + 0.5, y: gy + 0.5 }, pl.cr);
    if (!path) return null;
  }
  path = path.slice();
  let left = walkPerTick(room, pl);
  while (left > 1e-9) { // posledný úsek je presne do stredu cieľového políčka
    const last = path.length <= 1;
    const tx = last ? gx + 0.5 : path[0] % w + 0.5, ty = last ? gy + 0.5 : ((path[0] / w) | 0) + 0.5;
    const dx = tx - x, dy = ty - y, dd = Math.hypot(dx, dy);
    if (dd <= left) { x = tx; y = ty; left -= dd; if (last) { path.length = 0; break; } path.shift(); }
    else { x += dx / dd * left; y += dy / dd * left; left = 0; }
  }
  return { x: +x.toFixed(4), y: +y.toFixed(4), path };
}
function plan(room, pl, d, fx, fy, step) {
  return E.scheduleUnique(room, KEY(pl), room.tick + 1, 'goTo', {
    pk: pl.key, id: pl.id, seq: pl.areaSeq, n: d.n, t: room.tick,
    fx, fy, x: step.x, y: step.y, vx: +(step.x - fx).toFixed(4), vy: +(step.y - fy).toFixed(4),
    gx: d.gx, gy: d.gy, path: step.path
  });
}
function reject(pl, n, why) { hooks.send(pl, { t: 'goToNo', n, why }); }

// Žiadosť klienta: dôjdi na políčko (gx, gy). Vráti true, ak sa naplánovala; inak hráčovi pošle 'goToNo'.
function goTo(room, pl, gx, gy, n) {
  const { w, h } = D.areaSize(pl.area);
  if (!Number.isInteger(gx) || !Number.isInteger(gy) || gx < 0 || gy < 0 || gx >= w || gy >= h) return reject(pl, n, 'far'), false;
  const path = route(room, pl.area, pl, { x: gx + 0.5, y: gy + 0.5 }, pl.cr);
  if (!path) return reject(pl, n, 'far'), false;
  // nevyhodnotený pohyb od klienta sa nestratí: goTo ho vyhodnotí spolu so svojím prvým krokom
  const prev = E.pending(room, KEY(pl));
  const from = prev && (prev.type === 'arrivedFrom' || prev.type === 'goTo') ? { x: prev.data.fx, y: prev.data.fy } : { x: pl.x, y: pl.y };
  const step = nextStep(room, pl, pl.x, pl.y, path, gx, gy);
  if (!step) return reject(pl, n, 'far'), false;
  plan(room, pl, { n, gx, gy }, from.x, from.y, step);
  return true;
}
function onGoTo(room, d) {
  const pl = byKey(room, d);
  if (!pl) return;
  // úsek bol naplánovaný o krok skôr – keď sa medzitým zatarasil, hráč nevkročí, ale ide inou cestou odtiaľ, kde je
  const { w } = D.areaSize(pl.area), at = Math.floor(pl.y) * w + Math.floor(pl.x), to = Math.floor(d.y) * w + Math.floor(d.x);
  if (at !== to && !stepOk(room, pl.area, Areas.areaTiles(room, pl.area), at, to, pl.cr)) {
    const step = nextStep(room, pl, pl.x, pl.y, [to].concat(d.path || []), d.gx, d.gy);
    return step ? plan(room, pl, d, pl.x, pl.y, step) : reject(pl, d.n, 'blocked');
  }
  pl.x = d.x; pl.y = d.y;
  if (pl.save) { pl.save.x = pl.x; pl.save.y = pl.y; }
  pl.mv = { vx: d.vx || 0, vy: d.vy || 0, t: room.tick };
  const sx = d.x - d.fx, sy = d.y - d.fy;
  if (sx || sy) { pl.a = +Math.atan2(sy, sx).toFixed(3); pl.dir = Math.abs(sx) > Math.abs(sy) ? (sx < 0 ? 1 : 2) : (sy < 0 ? 3 : 0); }
  hooks.forward(pl);
  hooks.send(pl, { t: 'goStep', n: d.n, x: pl.x, y: pl.y, tk: room.tick });
  const seq = pl.areaSeq;
  hooks.evaluate(room, pl, { x: d.fx, y: d.fy });
  if (pl.areaSeq !== seq || E.pending(room, KEY(pl))) return; // prešiel na inú plochu alebo ho niečo zastavilo / nahradilo
  if (pl.x === d.gx + 0.5 && pl.y === d.gy + 0.5) return hooks.send(pl, { t: 'goToEnd', n: d.n, x: pl.x, y: pl.y });
  const step = nextStep(room, pl, pl.x, pl.y, d.path || [], d.gx, d.gy);
  if (!step) return reject(pl, d.n, 'blocked');
  plan(room, pl, d, pl.x, pl.y, step);
}
// Vedenie sa preruší (pradlena hráča odhodila…) – nevyhodnotený pohyb od klienta ostane
function stop(room, pl) { const e = E.pending(room, KEY(pl)); if (e && e.type === 'goTo') E.cancel(room, KEY(pl)); }

// Hráč odišiel – jeho nevyhodnotený pohyb netreba
function forget(room, pl) { E.cancel(room, KEY(pl)); }

// Udalosti pohybu patria len bežiacemu svetu (hráči sa neukladajú s ním) – po načítaní sa zahodia.
const isRuntime = e => e.type === 'arrivedFrom' || (e.type === 'goTo' && e.data && e.data.pk != null);

module.exports = { KEY, WALK, setHooks, arrive, goTo, route, stop, forget, isRuntime, HANDLERS: { arrivedFrom: onArrived, goTo: onGoTo } };
