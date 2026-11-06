// Pohyb hráčov ako udalosti v plánovači (#101).
// Každý hráč má najviac jednu čakajúcu udalosť pohybu s kľúčom move:<hráč>:
//   'arrivedFrom' – klient poslal novú polohu. Server ju neoveruje vopred: hneď ju prepošle ostatným (hooks.forward)
//                   a až potom ju v najbližšom kroku vyhodnotí plánovač (hooks.evaluate – pavučiny, pavúky, prechody…).
//                   Novšia poloha nahradí ešte nevyhodnotenú; odkiaľ hráč išiel (fx, fy), ostane z tej staršej,
//                   takže vyhodnotenie vidí celú cestu od posledného vyhodnotenia.
//   'goTo'        – server vedie hráča po naplánovanej ceste k cieľu (po krokoch, každý krok sa vyhodnotí ako príchod).
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
  return E.scheduleUnique(room, KEY(pl), room.tick + 1, 'arrivedFrom', { pk: pl.key, id: pl.id, seq: pl.areaSeq, fx: from.x, fy: from.y, x, y, vx, vy }); // …potom vyhodnotíme
}
function onArrived(room, d) {
  const pl = byKey(room, d);
  if (!pl) return;
  pl.mv = { vx: d.vx || 0, vy: d.vy || 0, t: room.tick };
  hooks.evaluate(room, pl, { x: d.fx, y: d.fy });
}

// Server vedie hráča k políčku (x, y) – cesta sa naplánuje v prvom kroku.
function goTo(room, pl, x, y) {
  return E.scheduleUnique(room, KEY(pl), room.tick + 1, 'goTo', { pk: pl.key, id: pl.id, seq: pl.areaSeq, x, y, path: null });
}
// Cesta po priechodných políčkach plochy (4 smery) – zoznam políčok bez štartu, null = nedá sa
function route(room, area, from, to) {
  const tiles = Areas.areaTiles(room, area), { w, h } = D.areaSize(area);
  const start = Math.floor(from.y) * w + Math.floor(from.x), goal = Math.floor(to.y) * w + Math.floor(to.x);
  const prev = new Map([[start, -1]]), q = [start];
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    if (i === goal) { const out = []; for (let k = i; k !== start; k = prev.get(k)) out.unshift(k); return out; }
    const cx = i % w, cy = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy, n = ny * w + nx;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || prev.has(n) || !D.passable(tiles[n])) continue;
      prev.set(n, i); q.push(n);
    }
  }
  return null;
}
function onGoTo(room, d) {
  const pl = byKey(room, d);
  if (!pl) return;
  const { w } = D.areaSize(pl.area);
  const path = d.path || route(room, pl.area, pl, d);
  if (!path) return;
  const from = { x: pl.x, y: pl.y };
  let left = WALK * E.tickMs(room) / 1000;
  while (left > 1e-9) { // jeden krok chôdze po ceste; posledný úsek je presne do cieľa
    const last = path.length <= 1;
    const tx = last ? d.x : path[0] % w + 0.5, ty = last ? d.y : ((path[0] / w) | 0) + 0.5;
    const dx = tx - pl.x, dy = ty - pl.y, dd = Math.hypot(dx, dy);
    if (dd <= left) { pl.x = tx; pl.y = ty; left -= dd; if (last) { path.length = 0; break; } path.shift(); }
    else { pl.x += dx / dd * left; pl.y += dy / dd * left; left = 0; }
  }
  pl.mv = { vx: pl.x - from.x, vy: pl.y - from.y, t: room.tick };
  hooks.send(pl, { t: 'shove', x: pl.x, y: pl.y });
  hooks.forward(pl);
  if (path.length) E.scheduleUnique(room, KEY(pl), room.tick + 1, 'goTo', Object.assign({}, d, { path }));
  hooks.evaluate(room, pl, from);
}

// Hráč odišiel – jeho nevyhodnotený pohyb netreba
function forget(room, pl) { E.cancel(room, KEY(pl)); }

// Udalosti pohybu patria len bežiacemu svetu (hráči sa neukladajú s ním) – po načítaní sa zahodia.
const isRuntime = e => e.type === 'arrivedFrom' || (e.type === 'goTo' && e.data && e.data.pk != null);

module.exports = { KEY, WALK, setHooks, arrive, goTo, route, forget, isRuntime, HANDLERS: { arrivedFrom: onArrived, goTo: onGoTo } };
