// Pavúky a pavučiny (#57): Les divov (vlčiaky, stará pradlena a ich pavučiny s hodvábom) a kútové pavučiny krížiaka.
// Uložené so svetom: room.spid = { webs: [{ id, x, y, ax, n, silk, o }], nid, corner: { garden: [kľúč kúta], hory: […] } }
//   pavučina zaberá n políčok od (x, y): ax 0 = vodorovne (x … x+n-1), ax 1 = zvisle (y … y+n-1); o = majiteľ (index pavúka)
//   roztrhnutú pavučinu majiteľ utká znova – udalosť 'weave' { o } v plánovači (ukladá sa so svetom)
// Za behu (neukladá sa): room.spf = rozbor lesa (nory, územia, miesta na pavučiny), room.sps = pavúky v lese,
//   room.kz = krížiaky na ceste do kúta (podľa plochy). Pavúky sa po načítaní sveta vždy začínajú doma.
//   V plánovači (room.events, ukladá sa so svetom, po načítaní sa zahodí): udalosť každého pavúka (kľúč spider:<id>)
//   a ťahanie hodvábu hráča (kľúč pull:<hráč>). Pavúky sa hýbu len vtedy, keď je na ich ploche aspoň jeden hráč.
const D = require('./shared/data.js');
const E = require('./engine.js');
const Actions = require('./actions.js');
const { areaTiles } = require('./areas.js');
const Webs = require('./shared/webs.js');
const { analyze, cornerSpots, bfs } = Webs;

const SP = D.SPIDERS, WEB = D.WEB, V = SP.vlciak, PR = SP.pradlena, KZ = SP.kriziak;
const LW = D.LES_W, LH = D.LES_H;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NEAR8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

let io = { toast() {}, sendMe() {}, send() {}, broadcastArea() {} };
function setHooks(h) { io = Object.assign({}, io, h); }

// ---------- Pavučiny ----------
function forest(room) {
  if (!room.spf || room.spf.les !== room.les) room.spf = Object.assign(analyze(room.les, room.lesSeed >>> 0), { les: room.les });
  return room.spf;
}
function webTiles(wb) { const out = []; for (let k = 0; k < wb.n; k++) out.push((wb.y + (wb.ax ? k : 0)) * LW + wb.x + (wb.ax ? 0 : k)); return out; }
function webAt(room, i) { for (const wb of room.spid.webs) if (webTiles(wb).includes(i)) return wb; return null; }
function kindOf(room, o) { const h = forest(room).homes[o]; return h ? h.k : null; }
function target(room, o) { const k = kindOf(room, o); return k ? WEB.count[k === 'p' ? 'pradlena' : 'vlciak'][D.seasonOf(D.dayOfTick(room.tick))] : 0; }
function pending(room, o) { return room.events.filter(e => e.type === 'weave' && e.data && e.data.o === o).length; }

// Utká novú pavučinu na náhodnom voľnom mieste v území majiteľa (nie cez inú pavučinu ani cez hráča).
function weave(room, o) {
  const f = forest(room), used = new Set();
  for (const wb of room.spid.webs) for (const i of webTiles(wb)) used.add(i);
  const occ = new Set();
  if (room.players) for (const p of room.players.values()) if (p.area === 'les') occ.add(Math.floor(p.y) * LW + Math.floor(p.x));
  const free = (f.cands[o] || []).filter(c => c.tiles.every(i => !used.has(i) && !occ.has(i)));
  if (!free.length) return null;
  const c = free[E.randInt(room, free.length)];
  const wb = { id: ++room.spid.nid, x: c.x, y: c.y, ax: c.ax, n: c.n, silk: WEB.silk, o };
  room.spid.webs.push(wb);
  return wb;
}
// Pavučina zmizla (roztrhnutá, vyťahaná) – majiteľ ju o deň utká inde.
function tear(room, wb) {
  room.spid.webs = room.spid.webs.filter(x => x !== wb);
  E.schedule(room, room.tick + WEB.reweave, 'weave', { o: wb.o });
}
// Počet pavučín podľa obdobia: chýbajúce hneď dotkáme, nadbytočné (napr. príchod zimy) pavúky zjedia.
function balance(room) {
  const f = forest(room);
  let changed = false;
  f.homes.forEach((h, o) => {
    const want = target(room, o), have = room.spid.webs.filter(wb => wb.o === o);
    let pend = pending(room, o);
    for (let k = have.length; k > want; k--) { room.spid.webs = room.spid.webs.filter(wb => wb !== have[k - 1]); changed = true; }
    while (pend > 0 && Math.min(have.length, want) + pend > want) {
      const ev = room.events.find(e => e.type === 'weave' && e.data && e.data.o === o);
      room.events = room.events.filter(e => e !== ev); pend--;
    }
    for (let k = Math.min(have.length, want) + pend; k < want; k++) if (weave(room, o)) changed = true;
  });
  room.spid.webs = room.spid.webs.filter(wb => f.homes[wb.o]);
  return changed;
}
function onWeave(room, d) {
  if (!d || !forest(room).homes[d.o]) return;
  if (room.spid.webs.filter(wb => wb.o === d.o).length >= target(room, d.o)) return;
  if (weave(room, d.o)) { room.dirty = true; websMsg(room); }
}

// ---------- Kúty pre krížiaka (záhrada, hory) ----------
const spotCache = new WeakMap();
function spots(room, area) {
  const tiles = areaTiles(room, area);
  let c = spotCache.get(tiles);
  const sig = area === 'garden' ? (room.icehouse && room.icehouse.built ? 1 : 0) : 0;
  if (!c || c.sig !== sig) { c = { sig, list: cornerSpots(tiles, D.areaSize(area).w, D.areaSize(area).h) }; spotCache.set(tiles, c); }
  return c.list;
}
function cornerList(room, area) {
  const byKey = new Map(spots(room, area).map(s => [s.k, s]));
  return (room.spid.corner[area] || []).map(k => byKey.get(k)).filter(Boolean);
}
// kúty, ktoré už neexistujú (napr. na pozemku postavili ľadovňu), zahodíme
function pruneCorners(room) {
  for (const area of D.CORNER_AREAS) {
    const ok = new Set(spots(room, area).map(s => s.k));
    room.spid.corner[area] = (room.spid.corner[area] || []).filter(k => ok.has(k));
  }
}
function freeSpots(room, area) {
  const have = new Set(room.spid.corner[area] || []), busy = new Set(cornerList(room, area).map(s => s.i));
  const kz = room.kz && room.kz[area];
  return spots(room, area).filter(s => !have.has(s.k) && !busy.has(s.i) && !(kz && kz.spot.k === s.k));
}
function addCorner(room, area, spot) {
  const list = room.spid.corner[area] || (room.spid.corner[area] = []);
  if (list.length >= KZ.max || list.includes(spot.k)) return false;
  list.push(spot.k);
  room.dirty = true;
  cornerMsg(room, area);
  return true;
}
function clearCorner(room, area, i) {
  const s = cornerList(room, area).find(c => c.i === i);
  if (!s) return null;
  room.spid.corner[area] = room.spid.corner[area].filter(k => k !== s.k);
  room.dirty = true;
  cornerMsg(room, area);
  return s;
}
function playersIn(room, area) { const out = []; if (room.players) for (const p of room.players.values()) if (p.area === area) out.push(p); return out; }
// Každú hernú hodinu: krížiak sa občas (v jeseni častejšie) vydá do voľného kúta. Keď je na ploche hráč, uvidí ho bežať;
// inak sa pavučina rovno objaví.
function hourlyCorners(room) {
  const se = D.seasonOf(D.dayOfTick(room.tick));
  for (const area of D.CORNER_AREAS) {
    if ((room.spid.corner[area] || []).length >= KZ.max || (room.kz && room.kz[area])) continue;
    if (E.rand(room) >= KZ.perDay / 24 * (se === 2 ? 2 : 1)) continue;
    const free = freeSpots(room, area);
    if (!free.length) continue;
    const spot = free[E.randInt(room, free.length)];
    if (!playersIn(room, area).length || !startKriziak(room, area, spot)) addCorner(room, area, spot);
  }
}
// Krížiak vybehne z miesta 8–14 krokov od kúta (spoza budovy, kríka…) a beží k nemu po priechodných políčkach.
function startKriziak(room, area, spot) {
  const tiles = areaTiles(room, area), { w, h } = D.areaSize(area);
  const { dist } = bfs(w, h, [spot.i], n => D.passable(tiles[n]) && tiles[n].g !== 'gate', 14);
  const far = [];
  for (let i = 0; i < dist.length; i++) if (dist[i] >= 8) far.push(i);
  if (!far.length) return false;
  const start = far[E.randInt(room, far.length)], path = [];
  for (let i = start; i !== spot.i;) { // po klesajúcej vzdialenosti až ku kútu
    const x = i % w, y = (i / w) | 0;
    let nxt = -1;
    for (const [dx, dy] of DIRS) { const n = (y + dy) * w + x + dx; if (x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h && dist[n] === dist[i] - 1) { nxt = n; break; } }
    if (nxt < 0) return false;
    path.push(nxt); i = nxt;
  }
  room.kz = room.kz || {};
  room.kz[area] = { id: 'k' + area, k: 'k', x: start % w + 0.5, y: ((start / w) | 0) + 0.5, a: 0, path, spot, st: 'go', until: 0, left: 2, moving: false };
  E.scheduleUnique(room, KEY(room.kz[area].id), room.tick + 1, 'kriziak', { area });
  return true;
}

// ---------- Hodváb: ťahanie, vbehnutie do pavučiny ----------
function silkOf(pl) { return pl.save.inv.silk || 0; }
function give(pl, n) { if (n > 0) { pl.save.inv.silk = silkOf(pl) + n; io.sendMe(pl); } }
function take(pl, n) { const k = Math.min(n, silkOf(pl)); if (k > 0) { if (k === silkOf(pl)) delete pl.save.inv.silk; else pl.save.inv.silk -= k; io.sendMe(pl); } return k; }
function slow(pl, k, ms) { io.send(pl, { t: 'slow', k, ms }); }

// Hráč začne ťahať hodváb z pavučiny: akcia hráča 'pullDone' o WEB.pullMs (actions.js – kľúč playerAction:<hráč>).
// Ťahá, kým ju nenahradí iná akcia (pohyb, iné ťuknutie, zdvihnutý lampáš…). Vráti chybové hlásenie alebo null.
function startPull(room, pl, wb) {
  if (pl.lp) return 'S lampášom v ruke hodváb neutrhneš. Vyber si v lište niečo iné alebo prázdnu ruku. 🏮';
  Actions.schedule(room, pl, room.tick + E.msTicks(room, WEB.pullMs), 'pullDone', { web: wb.id });
  return null;
}
const pulling = (room, pl) => Actions.doing(room, pl, 'pullDone');
Actions.define('pullDone', {
  interrupted(room, pl, ev, why) { if (!QUIET[why]) io.toast(pl, 'Prestal(a) si ťahať hodváb.'); }
});
const QUIET = { leave: 1, travel: 1, sleep: 1, shove: 1 };
// Udalosť 'pullDone': ťahanie sa dokončí, len ak je hráč stále v lese
function onPullDone(room, d) {
  const pl = Actions.owner(room, d);
  if (pl && pl.area === 'les') finishPull(room, pl, null, d.web);
}
// Dokončenie potiahnutia z pavučiny web: +1 hodváb; majiteľ si to všimne s rastúcou šancou, posledné potiahnutie ju roztrhne.
function finishPull(room, pl, rnd, web) {
  const wb = room.spid.webs.find(x => x.id === web);
  if (!wb) return io.toast(pl, 'Pavučina je preč – niekto ju roztrhol. 🕸️');
  const k = WEB.silk - wb.silk; // koľké potiahnutie (0 = prvé)
  wb.silk--;
  give(pl, 1);
  const torn = wb.silk <= 0;
  if (torn) tear(room, wb);
  room.dirty = true;
  websMsg(room);
  const noticed = (rnd != null ? rnd : E.rand(room)) < WEB.notice[Math.min(k, WEB.notice.length - 1)];
  const who = kindOf(room, wb.o) === 'p' ? 'Stará pradlena' : 'Vlčiak';
  if (noticed) alert(room, wb, pl);
  io.toast(pl, torn
    ? `+1 🕸️ Pavúčí hodváb. Pavučina sa roztrhla${noticed ? ` – ${who} to zacítil(a)! Uteč! 🕷️` : '.'}`
    : `+1 🕸️ Pavúčí hodváb (v pavučine ešte ${wb.silk}).${noticed ? ` Pavučina sa zachvela – ${who.toLowerCase()} to zacítil(a)! 🕷️` : ''}`);
  return { torn, noticed };
}
// Hráč vbehol do pavučiny: chvíľu sa lepí, pavučina sa roztrhne (hodváb nedostane) a majiteľ vie, kde je.
function walkIn(room, pl, wb) {
  tear(room, wb);
  room.dirty = true;
  websMsg(room);
  slow(pl, WEB.stick, WEB.stickMs);
  alert(room, wb, pl);
  io.toast(pl, `🕸️ Vbehol(a) si do pavučiny! Lepí sa… a ${kindOf(room, wb.o) === 'p' ? 'stará pradlena' : 'vlčiak'} vie, kde si. 🕷️`);
}
// Hráč prešiel po políčku s pavučinou (kontroluje sa pri každom pohybe v lese – udalosť arriveAt).
// from = odkiaľ išiel od posledného vyhodnotenia: skontrolujú sa všetky políčka na ceste, nielen cieľ.
function checkWalk(room, pl, from) {
  if (pl.area !== 'les' || !room.spid) return;
  const a = from || pl, n = Math.max(1, Math.ceil(Math.hypot(pl.x - a.x, pl.y - a.y) / 0.25));
  const seen = new Set();
  for (let k = 1; k <= n; k++) {
    const x = a.x + (pl.x - a.x) * k / n, y = a.y + (pl.y - a.y) * k / n, i = Math.floor(y) * LW + Math.floor(x);
    if (seen.has(i) || x < 0 || y < 0 || x >= LW || y >= LH) continue;
    seen.add(i);
    const wb = webAt(room, i);
    if (wb) return walkIn(room, pl, wb);
  }
}

// ---------- Pavúky v lese ----------
// Každý pavúk má v plánovači práve jednu udalosť s kľúčom spider:<id> (krížiak spider:k<plocha>):
//   'spider' – ďalší krok správania; kto sa hýbe, plánuje sa na najbližší krok, kto čaká (doma, na kmeni,
//              v prestávke), až na svoj termín – spiaci pavúk nič nestojí,
//   'goTo'   – naháňanie: cesta k predpovedanej polohe hráča v najbližšom kroku (z jeho posledného pohybu).
// Akcia hráča, ktorá sa pavúka týka (siahne na pavučinu, vbehne do nej, príde blízko, zdvihne lampáš),
// jeho čakajúcu udalosť nahradí reakciou v najbližšom kroku. Termíny sú v krokoch (room.tick), rýchlosti
// v políčkach za sekundu reálneho času – jeden krok pohybu trvá E.tickMs.
// Keď v lese nie je nikto, pavúky sú doma a nemajú žiadnu udalosť (aj pri dobiehaní času po výpadku).
const KEY = id => 'spider:' + id;
const dtOf = room => E.tickMs(room) / 1000;
const T = (room, ms) => E.msTicks(room, ms); // ms reálneho času → kroky
const between = (room, [a, b]) => a + E.rand(room) * (b - a);
function spiders(room) {
  const f = forest(room);
  if (!room.sps || room.sps.length !== f.homes.length) {
    room.sps = f.homes.map((h, o) => ({ id: 's' + o, k: h.k, o, hx: h.x + 0.5, hy: h.y + 0.5, x: h.x + 0.5, y: h.y + 0.5, a: Math.PI / 2, st: 'home', until: 0, path: null, loot: 0, cool: 0, scared: 0 }));
  }
  return room.sps;
}
function resetSpiders(room) { if (room.sps) for (const s of room.sps) Object.assign(s, { x: s.hx, y: s.hy, st: 'home', tgt: null, path: null, loot: 0, until: 0, moving: false, z: 0, tr: null, web: null, scared: 0, cool: 0 }); }
// Nikto v lese: pavúky sú doma a ich udalosti sa zrušia
function sleepAll(room) {
  resetSpiders(room);
  for (const s of room.sps || []) E.cancel(room, KEY(s.id));
}
const tileOf = (x, y) => Math.floor(y) * LW + Math.floor(x);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------- Plánovanie udalostí pavúka ----------
const BUSY = { walk: 1, totree: 1, return: 1, alert: 1, chase: 1, cling: 1 };
const busy = s => !!BUSY[s.st] || s.moving;
// Kde bude hráč v najbližšom kroku: posledný pohyb (arriveAt) predĺžený o jeden krok; kto stojí, ostane stáť.
function predict(room, p) {
  const v = p.mv;
  if (!v || room.tick - v.t > 2) return { x: p.x, y: p.y };
  return { x: p.x + v.vx, y: p.y + v.vy };
}
// Naplánuje jedinú udalosť pavúka podľa jeho stavu (nahradí čakajúcu).
function plan(room, s) {
  const now = room.tick, key = KEY(s.id);
  if (busy(s)) {
    const p = s.st === 'chase' && room.players && [...room.players.values()].find(o => o.id === s.tgt);
    if (p) { const g = predict(room, p); return E.scheduleUnique(room, key, now + 1, 'goTo', { sp: s.id, p: p.id, x: +g.x.toFixed(3), y: +g.y.toFixed(3) }); }
    return E.scheduleUnique(room, key, now + 1, 'spider', { id: s.id });
  }
  let at = Infinity;
  for (const t of [s.until, s.scared, s.cool]) if (t > now && t < at) at = t;
  if (at < Infinity) return E.scheduleUnique(room, key, at, 'spider', { id: s.id });
  E.cancel(room, key); // nič nečaká – zobudí ho až hráč
  return null;
}
// Reakcia v najbližšom kroku (zruší čakanie na termín)
function wake(room, s) {
  const ev = E.pending(room, KEY(s.id));
  if (ev && ev.at <= room.tick + 1) return;
  if (busy(s)) plan(room, s); else E.scheduleUnique(room, KEY(s.id), room.tick + 1, 'spider', { id: s.id });
}
// V lese je hráč: pavúky, ktoré nemajú udalosť (spali, kým tu nikto nebol), sa zobudia.
function ensure(room) {
  if (!room.spid || !room.les || !playersIn(room, 'les').length) return;
  for (const s of spiders(room)) if (!E.pending(room, KEY(s.id))) E.scheduleUnique(room, KEY(s.id), room.tick + 1, 'spider', { id: s.id });
}
// Hráč sa pohol (udalosť arriveAt): pavúky v jeho blízkosti, ktoré čakajú na termín, zareagujú hneď
// (všimnú si ho, zľaknú sa lampáša, zlezú z kmeňa…).
const NOTICE = Math.max(V.sense, SP.lamp + 0.5, WEB.alert) + 1;
function noticePlayer(room, pl) {
  if (pl.area !== 'les' || !room.spid || !room.les) return;
  ensure(room);
  for (const s of spiders(room)) if (dist(s, pl) <= NOTICE) wake(room, s);
}
// Udalosť pavúka ('spider' aj 'goTo'): jeden krok správania a naplánovanie ďalšej
function onSpider(room, d) {
  if (!room.spid || !room.les) return;
  const s = spiders(room).find(x => x.id === (d && (d.sp || d.id)));
  if (!s) return;
  const ps = playersIn(room, 'les');
  if (!ps.length) { sleepAll(room); return; }
  const byId = new Map(ps.map(p => [p.id, p])), lamps = ps.filter(p => p.lp), now = room.tick, dt = dtOf(room);
  s.moving = false;
  const goal = d && d.sp && d.p === s.tgt ? { x: d.x, y: d.y } : null; // predpovedaná poloha naháňaného hráča
  if (s.k === 'v') vlciak(room, s, ps, byId, lamps, now, dt, goal); else pradlena(room, s, byId, lamps, now, dt, goal);
  plan(room, s);
}

// Cesta po políčkach vlastného územia k prvému políčku, ktoré spĺňa goal (bez štartu). null = nedá sa.
function pathTo(room, s, goal) {
  const f = forest(room), start = tileOf(s.x, s.y);
  const prev = new Map([[start, -1]]), q = [start];
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    if (goal(i)) { const out = []; for (let k = i; k !== start; k = prev.get(k)) out.unshift(k); return out; }
    const x = i % LW, y = (i / LW) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy, n = ny * LW + nx;
      if (nx < 0 || ny < 0 || nx >= LW || ny >= LH || prev.has(n) || f.owner[n] !== s.o) continue;
      prev.set(n, i); q.push(n);
    }
  }
  return null;
}
// Naháňanie (goTo): cesta k políčku predpovedanej polohy hráča; keď tam nevedie, k jeho skutočnému políčku.
// Prepočíta sa, keď sa cieľové políčko zmení, alebo najneskôr po 400 ms.
function chaseStep(room, s, p, goal, sp, now, dt) {
  const g = goal || p, gi = inTerr(room, s, g.x, g.y) ? tileOf(g.x, g.y) : tileOf(p.x, p.y);
  if (!s.path || !s.path.length || now >= s.repath || s.goal !== gi) {
    s.path = pathTo(room, s, i => i === gi);
    if (!s.path && gi !== tileOf(p.x, p.y)) { const pi = tileOf(p.x, p.y); s.path = pathTo(room, s, i => i === pi); }
    s.path = s.path || []; s.goal = gi; s.repath = now + T(room, 400);
  }
  walkPath(s, sp, dt);
}
function stepTo(s, x, y, sp, dt) {
  const dx = x - s.x, dy = y - s.y, d = Math.hypot(dx, dy);
  if (d < 1e-6) return true;
  const k = Math.min(1, sp * dt / d);
  s.x += dx * k; s.y += dy * k; s.a = Math.atan2(dy, dx); s.moving = true;
  return k >= 1;
}
function walkPath(s, sp, dt) {
  if (!s.path || !s.path.length) return true;
  const i = s.path[0];
  if (stepTo(s, i % LW + 0.5, ((i / LW) | 0) + 0.5, sp, dt)) s.path.shift();
  return !s.path.length;
}
function goHome(room, s, now) { s.z = 0; s.tr = null; s.st = 'return'; s.tgt = null; s.path = pathTo(room, s, i => i === tileOf(s.hx, s.hy)) || []; s.until = now; }
function inTerr(room, s, x, y) { return forest(room).owner[tileOf(x, y)] === s.o; }
// Krok preč od bodu (x, y) po vlastnom území (na susedné políčko najďalej od neho).
function away(room, s, x, y, sp, dt) {
  const f = forest(room), cx = Math.floor(s.x), cy = Math.floor(s.y);
  let best = null, bd = Math.hypot(s.x - x, s.y - y);
  for (const [dx, dy] of NEAR8) {
    const nx = cx + dx, ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= LW || ny >= LH || f.owner[ny * LW + nx] !== s.o) continue;
    if (dx && dy && (f.owner[cy * LW + nx] !== s.o || f.owner[ny * LW + cx] !== s.o)) continue;
    const d = Math.hypot(nx + 0.5 - x, ny + 0.5 - y);
    if (d > bd) { bd = d; best = [nx + 0.5, ny + 0.5]; }
  }
  if (best) stepTo(s, best[0], best[1], sp, dt);
}
// ---------- Na strome ----------
// Pavúk čaká na kmeni, ktorý drží jednu z jeho pavučín: na strane kmeňa k pavučine (nx, ny = smer od kmeňa k nej),
// hlavou dole. Ker ani spadnutý kmeň nie sú strom – keď pavučinu držia len tie, pavúk počká na chodníku.
const CLIMB = { tree: 1, giant: 1, trunk: 1 };
function trunkSpot(room, wb) {
  const tiles = areaTiles(room, 'les'), out = [];
  const ends = wb.ax ? [[wb.x, wb.y - 1, wb.x, wb.y], [wb.x, wb.y + wb.n, wb.x, wb.y + wb.n - 1]]
    : [[wb.x - 1, wb.y, wb.x, wb.y], [wb.x + wb.n, wb.y, wb.x + wb.n - 1, wb.y]];
  for (const [x, y, wx, wy] of ends) {
    const a = Webs.anchorAt(tiles, LW, LH, x, y);
    if (!a || !CLIMB[a.g]) continue;
    let nx = wx + 0.5 - a.cx, ny = wy + 0.5 - a.cz;
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    out.push({ x: a.cx + nx * (a.r + 0.04), y: a.cz + ny * (a.r + 0.04), nx, ny });
  }
  return out.length ? out[wb.id % out.length] : null;
}
// pri pavučine: na kmeň (ak je), inak postojí na chodníku
function toWeb(room, s) {
  const wb = room.spid.webs.find(w => w.id === s.web), spot = wb && trunkSpot(room, wb);
  if (!spot) return false;
  s.st = 'totree'; s.tr = spot; s.z = 0;
  return true;
}
function startGuard(room, s, P, now) { s.st = 'guard'; s.gz = between(room, P.guard); s.until = now + T(room, between(room, P.guardMs)); }
// Čaká na kmeni: vylezie do svojej výšky (pri zdvihnutom lampáši až na P.high a pavučinu nechá tak),
// po čase zlezie a ide domov.
function guard(room, s, P, lamps, now, dt) {
  if (lamps.some(l => dist(s, l) < SP.lamp + 0.5)) s.scared = now + T(room, P.backMs || 2000);
  const want = now < s.scared ? P.high : now < s.until ? s.gz : 0, dz = want - s.z;
  if (Math.abs(dz) > 1e-6) { s.z = Math.abs(dz) <= P.climb * dt ? want : s.z + Math.sign(dz) * P.climb * dt; s.moving = true; s.up = dz > 0; }
  else if (!want) goHome(room, s, now);
}
// Pavúk na kmeni pri tejto pavučine a pri ňom zdvihnutý lampáš – nechá ju tak.
const hiding = (s, wb, now) => s.st === 'guard' && s.web === wb.id && now < s.scared;

// Pavučinu niekto potiahol alebo do nej vbehol – majiteľ sa rozbehne k nej (pradlena rovno k hráčovi).
// Reakcia nahradí čakajúcu udalosť pavúka (v najbližšom kroku).
function alert(room, wb, pl) {
  const s = spiders(room)[wb.o], now = room.tick;
  if (!s || s.st === 'cling' || hiding(s, wb, now)) return;
  s.z = 0; s.tr = null; // z kmeňa zoskočí
  if (s.k === 'p') { if (s.st !== 'chase') { s.st = 'chase'; s.tgt = pl.id; s.path = null; s.repath = 0; } }
  else if (s.st === 'chase') return;
  else if (s.st === 'guard' && s.web === wb.id) chase(s, pl, now); // čakal priamo pri nej
  else { const t = webTiles(wb), mid = t[Math.floor(t.length / 2)]; s.st = 'alert'; s.tgt = pl.id; s.path = pathTo(room, s, i => i === mid) || []; s.until = now; }
  plan(room, s);
}
function chase(s, pl, now) { s.z = 0; s.tr = null; s.st = 'chase'; s.tgt = pl.id; s.path = null; s.repath = 0; s.seen = now; s.border = 0; }

function nearestLamp(s, lamps) { let b = null; for (const l of lamps) if (!b || dist(s, l) < dist(s, b)) b = l; return b; }

function vlciak(room, s, ps, byId, lamps, now, dt, goal) {
  const lamp = nearestLamp(s, lamps);
  const lampNear = lamp && dist(s, lamp) < SP.lamp + 0.3;
  if (lampNear) s.scared = now + T(room, V.backMs);
  // kým nikoho nenaháňa, všimne si hráča, ktorý príde blízko (bez lampáša)
  if (['home', 'walk', 'pause', 'return', 'search', 'totree', 'guard'].includes(s.st) && now >= s.cool && now >= s.scared) {
    const p = ps.find(p => !p.lp && dist(s, p) <= V.sense && inTerr(room, s, p.x, p.y));
    if (p) chase(s, p, now);
  }
  switch (s.st) {
    case 'home':
      if (now >= s.until) {
        const own = room.spid.webs.filter(wb => wb.o === s.o);
        const wb = own.length && E.rand(room) < 0.6 ? own[E.randInt(room, own.length)] : null, goal = wb && webTiles(wb);
        s.web = wb ? wb.id : null;
        const f = forest(room), all = [];
        if (!goal) for (let i = 0; i < f.owner.length; i++) if (f.owner[i] === s.o) all.push(i);
        const g = goal ? goal[0] : all[E.randInt(room, all.length)];
        s.path = pathTo(room, s, i => i === g) || [];
        s.st = 'walk';
      }
      break;
    case 'walk': if (walkPath(s, V.walk, dt) && !toWeb(room, s)) { s.st = 'pause'; s.until = now + T(room, 2000 + E.rand(room) * 2000); } break;
    case 'totree': if (stepTo(s, s.tr.x, s.tr.y, V.walk, dt)) startGuard(room, s, V, now); break;
    case 'guard': guard(room, s, V, lamps, now, dt); break;
    case 'pause': if (now >= s.until) goHome(room, s, now); break;
    case 'return':
      if (walkPath(s, V.walk * 1.5, dt) && stepTo(s, s.hx, s.hy, V.walk, dt)) { s.st = 'home'; s.loot = 0; s.until = now + T(room, 3000 + E.rand(room) * 5000); }
      break;
    case 'alert': {
      const p = byId.get(s.tgt);
      if (p && dist(s, p) <= WEB.alert && inTerr(room, s, p.x, p.y)) { chase(s, p, now); break; }
      if (walkPath(s, V.run, dt)) {
        const q = ps.filter(o => dist(s, o) <= WEB.alert && inTerr(room, s, o.x, o.y)).sort((a, b) => dist(s, a) - dist(s, b))[0];
        if (q) chase(s, q, now); else { s.st = 'search'; s.until = now + T(room, V.lostMs); }
      }
      break;
    }
    case 'search': if (now >= s.until) goHome(room, s, now); break;
    case 'chase': {
      let p = byId.get(s.tgt);
      if (p && dist(s, p) <= V.lose) s.seen = now;
      if (!p || now - s.seen > T(room, V.lostMs)) {
        // stratil ho – skúsi najbližšieho iného hráča vo svojom území, inak to vzdá
        const q = ps.filter(o => o !== p && dist(s, o) <= V.lose && inTerr(room, s, o.x, o.y)).sort((a, b) => dist(s, a) - dist(s, b))[0];
        if (q) { chase(s, q, now); p = q; goal = null; } else { goHome(room, s, now); break; }
      }
      if (!inTerr(room, s, p.x, p.y)) { // za hranicou územia ďalej nejde
        if (!s.border) s.border = now;
        if (now - s.border > T(room, V.borderMs)) goHome(room, s, now);
        break;
      }
      s.border = 0;
      if (p.lp && dist(s, p) < SP.lamp + 0.5) s.scared = now + T(room, V.backMs);
      if (now < s.scared) { // lampáš: drží sa na kraji svetla, kým ho hráč nesklopí
        const l = nearestLamp(s, lamps);
        if (l && dist(s, l) < SP.lamp) away(room, s, l.x, l.y, V.run, dt);
        break;
      }
      const d = dist(s, p);
      if (d < 0.55) { cling(s, p, now); break; }
      if (d < 1.2) stepTo(s, p.x, p.y, V.run, dt);
      else chaseStep(room, s, p, goal, V.run, now, dt);
      break;
    }
    case 'cling': {
      const p = byId.get(s.tgt);
      if (!p || !inTerr(room, s, p.x, p.y)) { goHome(room, s, now); s.cool = now + T(room, V.coolMs); break; } // za hranicou územia sa pustí
      s.x = p.x; s.y = p.y;
      if (p.lp) { // zľakne sa lampáša, pustí sa a hodváb pustí na zem – hráč ho hneď zdvihne
        if (s.loot) { give(p, s.loot); io.toast(p, `🏮 Vlčiak sa zľakol lampáša, pustil sa ťa a pustil aj hodváb. Zdvihol(a) si ${s.loot}× 🕸️.`, 'gift'); }
        else io.toast(p, '🏮 Vlčiak sa zľakol lampáša a pustil sa ťa.');
        s.loot = 0; slow(p, 1, 0);
        chase(s, p, now); s.scared = now + T(room, V.backMs);
        break;
      }
      if (now >= s.next) {
        if (s.taken < V.takeMax && silkOf(p) > 0) {
          take(p, 1); s.loot++; s.taken++;
          slow(p, V.slow, V.takeMs + 300);
          io.toast(p, s.taken === 1 ? '🕷️ Vlčiak ťa chytil a vzal ti 1 hodváb! Zdvihni lampáš, nech ťa pustí.' : '🕷️ Vlčiak ti vzal ďalší hodváb!');
          s.next = now + T(room, V.takeMs);
        } else {
          if (!s.taken) { slow(p, V.slow, 1000); io.toast(p, '🕷️ Vlčiak ťa chytil, ale nemáš žiaden hodváb – pustil sa ťa.'); }
          goHome(room, s, now); s.cool = now + T(room, V.coolMs);
        }
      }
      break;
    }
  }
}
function cling(s, p, now) { s.st = 'cling'; s.tgt = p.id; s.taken = 0; s.next = now; s.path = null; }

function pradlena(room, s, byId, lamps, now, dt, goal) {
  if (s.st === 'home') { // občas zájde k jednej zo svojich pavučín a počká na jej kmeni
    if (!s.until) s.until = now + T(room, between(room, PR.idleMs));
    if (now < s.until) return;
    const own = room.spid.webs.filter(wb => wb.o === s.o && trunkSpot(room, wb)), wb = own.length ? own[E.randInt(room, own.length)] : null;
    s.until = 0;
    if (!wb) { s.until = now + T(room, between(room, PR.idleMs)); return; }
    const t = new Set(webTiles(wb));
    s.web = wb.id; s.path = pathTo(room, s, i => t.has(i)) || []; s.st = 'walk';
    return;
  }
  if (s.st === 'walk') { if (walkPath(s, PR.walk, dt) && !toWeb(room, s)) goHome(room, s, now); return; }
  if (s.st === 'totree') { if (stepTo(s, s.tr.x, s.tr.y, PR.walk, dt)) startGuard(room, s, PR, now); return; }
  if (s.st === 'guard') { guard(room, s, PR, lamps, now, dt); return; }
  if (s.st === 'return') {
    if (walkPath(s, PR.walk, dt) && stepTo(s, s.hx, s.hy, PR.walk, dt)) { s.st = 'home'; s.until = 0; }
    return;
  }
  // naháňa toho, kto jej siahol na pavučinu – len po svojej čistine
  const p = byId.get(s.tgt);
  if (!p || !inTerr(room, s, p.x, p.y) || now < s.cool) { goHome(room, s, now); return; }
  const near = lamps.filter(l => dist(s, l) < SP.lamp);
  if (near.length) { const l = nearestLamp(s, near); away(room, s, l.x, l.y, PR.push * near.length, dt); return; } // lampáše ju len pomaly odtláčajú
  const d = dist(s, p);
  if (d < 0.9) { bite(room, s, p, now); return; }
  if (d < 1.5) stepTo(s, p.x, p.y, PR.walk, dt);
  else chaseStep(room, s, p, goal, PR.walk, now, dt);
}
// Uhryznutie: vezme až PR.bite hodvábu, spomalí a odhodí hráča za okraj čistiny.
function bite(room, s, p, now) {
  const k = take(p, PR.bite);
  slow(p, PR.slow, PR.slowMs);
  const f = forest(room), les = room.les, start = tileOf(p.x, p.y);
  const { dist: dd } = bfs(LW, LH, [start], n => !D.BLOCK[les[n].g], 12);
  let out = -1;
  for (let i = 0; i < dd.length; i++) if (dd[i] > 0 && f.owner[i] !== s.o && !webAt(room, i) && (out < 0 || dd[i] < dd[out])) out = i;
  if (out >= 0) io.send(p, { t: 'shove', x: out % LW + 0.5, y: ((out / LW) | 0) + 0.5 });
  io.toast(p, k ? `🕷️ Stará pradlena ťa uhryzla a vzala ti ${k}× hodváb! Bez lampáša a kamaráta sa k nej nepribližuj.` : '🕷️ Stará pradlena ťa odhodila zo svojej čistiny!');
  s.loot += k;
  goHome(room, s, now); s.cool = now + T(room, PR.coolMs);
}

// ---------- Krížiak na ceste do kúta ----------
// Beží len pár sekúnd, takže jeho udalosť ('kriziak', kľúč spider:k<plocha>) je v každom kroku.
function onKriziak(room, d) {
  const area = d && d.area, z = room.kz && room.kz[area];
  if (!z) return;
  const ps = playersIn(room, area), now = room.tick, dt = dtOf(room);
  const done = () => { delete room.kz[area]; };
  if (!ps.length) { addCorner(room, area, z.spot); return done(); } // nikto sa nepozerá – rovno dobehne
  z.moving = false;
  const scare = ps.find(p => dist(z, p) < KZ.near || (p.lp && dist(z, p) < SP.lamp));
  if (scare && z.st !== 'flee' && z.st !== 'climb') {
    z.st = 'flee'; z.until = now + T(room, 700); const a = Math.atan2(z.y - scare.y, z.x - scare.x); z.fx = Math.cos(a); z.fy = Math.sin(a);
    z.tree = treeNear(room, area, z, scare);
  }
  if (z.st === 'flee' && z.tree) { // vybehne na najbližší strom a stratí sa v korune
    if (stepTo(z, z.tree.x, z.tree.y, KZ.flee, dt)) { z.st = 'climb'; z.tr = z.tree; z.z = 0; }
  } else if (z.st === 'climb') {
    z.z += KZ.climb * dt; z.moving = true; z.up = true;
    if (z.z >= KZ.gone) return done();
  } else if (z.st === 'flee') {
    z.x += z.fx * KZ.flee * dt; z.y += z.fy * KZ.flee * dt; z.a = Math.atan2(z.fy, z.fx); z.moving = true;
    if (now >= z.until) return done(); // schoval sa – pavučinu tentoraz neutká
  } else if (z.st === 'pause') {
    if (now >= z.until) { z.st = 'go'; z.left = 1.5 + E.rand(room) * 1.5; }
  } else {
    // beží trhane: kúsok rýchlo, chvíľu stojí
    const { w } = D.areaSize(area);
    if (!z.path.length) { addCorner(room, area, z.spot); return done(); }
    const i = z.path[0], before = { x: z.x, y: z.y };
    if (stepTo(z, i % w + 0.5, ((i / w) | 0) + 0.5, KZ.run, dt)) z.path.shift();
    z.left -= dist(z, before);
    if (z.left <= 0) { z.st = 'pause'; z.until = now + T(room, 400 + E.rand(room) * 600); }
  }
  E.scheduleUnique(room, KEY(z.id), now + 1, 'kriziak', { area });
}

// Strom do KZ.tree políčok od krížiaka, radšej ďalej od toho, kto ho vyľakal; miesto na kmeni na strane ku krížiakovi
function treeNear(room, area, z, from) {
  const tiles = areaTiles(room, area), { w, h } = D.areaSize(area), R = KZ.tree;
  let best = null, bs = Infinity;
  for (let y = Math.max(0, Math.floor(z.y - R)); y <= Math.min(h - 1, Math.floor(z.y + R)); y++) {
    for (let x = Math.max(0, Math.floor(z.x - R)); x <= Math.min(w - 1, Math.floor(z.x + R)); x++) {
      const a = Webs.anchorAt(tiles, w, h, x, y);
      if (!a || !CLIMB[a.g]) continue;
      const d = Math.hypot(a.cx - z.x, a.cz - z.y);
      if (d > R) continue;
      const sc = d - 0.6 * (Math.hypot(a.cx - from.x, a.cz - from.y) - dist(z, from));
      if (sc < bs) { bs = sc; best = a; }
    }
  }
  if (!best) return null;
  let nx = z.x - best.cx, ny = z.y - best.cz;
  const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
  return { x: best.cx + nx * (best.r + 0.03), y: best.cz + ny * (best.r + 0.03), nx, ny };
}

// ---------- Správy pre klientov ----------
function websView(room) {
  const f = forest(room);
  return { t: 'webs', webs: room.spid.webs.map(wb => ({ id: wb.id, x: wb.x, y: wb.y, ax: wb.ax, n: wb.n, silk: wb.silk })), homes: f.homes.map(h => ({ k: h.k, x: h.x, y: h.y })) };
}
function websMsg(room) { io.broadcastArea(room, 'les', websView(room)); }
function cornerView(room, area) { return { t: 'corner', area, list: cornerList(room, area).map(s => ({ x: s.x, y: s.y, dx: s.dx, dy: s.dy, ex: s.ex, ey: s.ey, f: s.faces })) }; }
function cornerMsg(room, area) { io.broadcastArea(room, area, cornerView(room, area)); }
// Čo hráč na ploche dostane pri príchode (pavučiny lesa alebo kúty)
function areaViews(room, area) {
  if (!room.spid) return [];
  if (area === 'les') return [websView(room)];
  if (D.CORNER_AREAS.includes(area)) return [cornerView(room, area)];
  return [];
}
// Pavúky a krížiak na ploche (raz za krok, len keď sú)
function entities(room, area) {
  const out = [];
  const r = v => +v.toFixed(2);
  // na kmeni: z = výška, n = smer od kmeňa (strana, na ktorej sedí), u = lezie hore (inak hlavou dole)
  const tree = (o, s) => { if (s.tr && s.st !== 'totree' && s.st !== 'flee') Object.assign(o, { z: r(s.z || 0), n: [r(s.tr.nx), r(s.tr.ny)], u: s.moving && s.up ? 1 : 0 }); return o; };
  if (area === 'les' && room.sps) for (const s of room.sps) out.push(tree({ id: s.id, k: s.k, x: r(s.x), y: r(s.y), a: r(s.a), m: s.moving ? 1 : 0, c: s.st === 'cling' ? 1 : 0, h: s.st === 'home' ? 1 : 0 }, s));
  const z = room.kz && room.kz[area];
  if (z) out.push(tree({ id: z.id, k: 'k', x: r(z.x), y: r(z.y), a: r(z.a), m: z.moving ? 1 : 0 }, z));
  return out;
}

// ---------- Načítanie a uloženie ----------
// Udalosti pavúkov a ťahania hodvábu patria len bežiacemu svetu: po načítaní (aj po výpadku servera) sa zahodia
// a pavúky začínajú doma – zmeškaný čas sa za nich nesimuluje.
const RUNTIME = { spider: 1, kriziak: 1, pullDone: 1 };
const isRuntime = e => RUNTIME[e.type] || (e.type === 'goTo' && e.data && e.data.sp != null);
function load(room, saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  if (room.events) room.events = room.events.filter(e => !isRuntime(e));
  room.sps = null; room.kz = null;
  room.spid = {
    webs: Array.isArray(s.webs) ? s.webs.filter(wb => wb && Number.isInteger(wb.x) && Number.isInteger(wb.y) && wb.n >= 1 && wb.silk >= 1).map(wb => ({ id: wb.id | 0, x: wb.x, y: wb.y, ax: wb.ax ? 1 : 0, n: wb.n | 0, silk: wb.silk | 0, o: wb.o | 0 })) : [],
    nid: s.nid | 0,
    corner: {}
  };
  for (const area of D.CORNER_AREAS) room.spid.corner[area] = Array.isArray(s.corner && s.corner[area]) ? s.corner[area].map(String) : [];
  room.spid.nid = Math.max(room.spid.nid, ...room.spid.webs.map(wb => wb.id));
  forest(room);
  // pavučiny, ktoré už na mapu nesedia (iné rozloženie lesa), zahodíme
  const f = room.spf;
  room.spid.webs = room.spid.webs.filter(wb => f.cands[wb.o] && f.cands[wb.o].some(c => c.x === wb.x && c.y === wb.y && c.ax === wb.ax && c.n === wb.n));
  pruneCorners(room);
  balance(room);
  if (!saved) for (const area of D.CORNER_AREAS) { const free = freeSpots(room, area); if (free.length) room.spid.corner[area].push(free[E.randInt(room, free.length)].k); }
}
function save(room) { return room.spid; }

module.exports = {
  setHooks, analyze, cornerSpots, forest, trunkSpot, webTiles, webAt, target, weave, tear, balance, onWeave,
  spots, cornerList, clearCorner, addCorner, hourlyCorners, startKriziak, pruneCorners,
  startPull, pulling, finishPull, walkIn, checkWalk, alert, spiders, plan, wake, ensure, noticePlayer, predict, sleepAll,
  websView, cornerView, areaViews, entities, load, save, isRuntime,
  // obsluha udalostí v plánovači (server ich pridá do svojich HANDLERS; goTo pavúka má v dátach sp)
  HANDLERS: { spider: onSpider, goTo: onSpider, kriziak: onKriziak, pullDone: onPullDone }
};
