// Pavúky a pavučiny (#57): Les divov (vlčiaky, stará pradlena a ich pavučiny s hodvábom) a kútové pavučiny krížiaka.
// Uložené so svetom: room.spid = { webs: [{ id, x, y, ax, n, silk, o }], nid, corner: { garden: [kľúč kúta], hory: […] } }
//   pavučina zaberá n políčok od (x, y): ax 0 = vodorovne (x … x+n-1), ax 1 = zvisle (y … y+n-1); o = majiteľ (index pavúka)
//   roztrhnutú pavučinu majiteľ utká znova – udalosť 'weave' { o } v plánovači (ukladá sa so svetom)
// Za behu (neukladá sa): room.spf = rozbor lesa (nory, územia, miesta na pavučiny), room.sps = pavúky v lese,
//   room.kz = krížiaky na ceste do kúta (podľa plochy). Pavúky sa po načítaní sveta vždy začínajú doma.
// Pohyb pavúkov je v reálnom čase (update každých 100 ms), len keď je v Lese divov aspoň jeden hráč.
const D = require('./shared/data.js');
const E = require('./engine.js');
const { areaTiles } = require('./areas.js');

const SP = D.SPIDERS, WEB = D.WEB, V = SP.vlciak, PR = SP.pradlena, KZ = SP.kriziak;
const LW = D.LES_W, LH = D.LES_H;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NEAR8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

let io = { toast() {}, sendMe() {}, send() {}, broadcastArea() {} };
function setHooks(h) { io = Object.assign({}, io, h); }

// ---------- Rozbor lesa: nory, čistina pradleny, územia a miesta na pavučiny ----------
// BFS po priechodných políčkach od starts (najviac max krokov, ok(i) = smie sa vstúpiť). Vráti vzdialenosti (-1 = nedosiahnuté)
// a pri viacerých štartoch aj, od ktorého štartu (src) je políčko najbližšie.
function bfs(w, h, starts, ok, max) {
  const dist = new Int16Array(w * h).fill(-1), src = new Int16Array(w * h).fill(-1), q = [];
  starts.forEach((i, k) => { if (dist[i] < 0) { dist[i] = 0; src[i] = k; q.push(i); } });
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi], x = i % w, y = (i / w) | 0;
    if (max != null && dist[i] >= max) continue;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy, n = ny * w + nx;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || dist[n] >= 0 || !ok(n)) continue;
      dist[n] = dist[i] + 1; src[n] = src[i]; q.push(n);
    }
  }
  return { dist, src };
}

function analyze(les, seed) {
  const w = LW, h = LH, N = w * h, g = i => les[i].g;
  const pass = i => !D.BLOCK[g(i)];
  const ent = bfs(w, h, les.map((t, i) => t.g === 'gate' ? i : -1).filter(i => i >= 0), pass).dist;
  const hx = (w - 1) / 2, hy = (h - 1) / 2, H = D.LES_HEART;
  const heart = i => Math.hypot((i % w - hx) / (H.rx + SP.heart), (((i / w) | 0) - hy) / (H.ry + SP.heart)) <= 1;
  const nobody = new Uint8Array(N);
  for (let i = 0; i < N; i++) if ((ent[i] >= 0 && ent[i] <= SP.entrance) || heart(i)) nobody[i] = 1;
  const owner = new Int16Array(N).fill(-1);
  const homes = [];

  // Stará pradlena: čistina (súvislé políčka 'glade' mimo srdca lesa) najďalej od vstupu; jej územie je čistina a 2 políčka okolo
  const comp = new Int32Array(N).fill(-1), comps = [];
  for (let i = 0; i < N; i++) {
    if (g(i) !== 'glade' || comp[i] >= 0) continue;
    const list = [i]; comp[i] = comps.length;
    for (let k = 0; k < list.length; k++) {
      const j = list[k], x = j % w, y = (j / w) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy, n = ny * w + nx;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || comp[n] >= 0 || g(n) !== 'glade') continue;
        comp[n] = comps.length; list.push(n);
      }
    }
    comps.push(list);
  }
  let lairComp = null, best = -1;
  for (const c of comps) {
    if (c.length < 6 || c.some(i => nobody[i] || ent[i] < 0)) continue;
    const d = Math.min(...c.map(i => ent[i]));
    if (d > best) { best = d; lairComp = c; }
  }
  const pradTiles = new Set();
  let lair = null;
  if (lairComp) {
    const cx = lairComp.reduce((s, i) => s + i % w, 0) / lairComp.length, cy = lairComp.reduce((s, i) => s + ((i / w) | 0), 0) / lairComp.length;
    lair = lairComp.reduce((a, i) => Math.hypot(i % w - cx, ((i / w) | 0) - cy) < Math.hypot(a % w - cx, ((a / w) | 0) - cy) ? i : a);
    for (const i of lairComp) {
      pradTiles.add(i);
      const x = i % w, y = (i / w) | 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const n = (y + dy) * w + x + dx; if (x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h && pass(n) && !nobody[n]) pradTiles.add(n); }
    }
  }

  // Nory vlčiakov: pri kmeni vedľa chodníka, ďaleko od vstupu, od pradleny aj od seba (podľa semienka lesa – stále rovnaké)
  const rnd = D.mulberry32(((seed >>> 0) ^ 0x51ed27) >>> 0);
  const cand = [];
  for (let i = 0; i < N; i++) {
    if (!['path', 'moss', 'roots'].includes(g(i)) || nobody[i] || pradTiles.has(i) || ent[i] < SP.entrance + 6) continue;
    const x = i % w, y = (i / w) | 0;
    if (lair != null && Math.hypot(x - lair % w, y - ((lair / w) | 0)) < V.reach) continue;
    if (!DIRS.some(([dx, dy]) => { const t = les[(y + dy) * w + x + dx]; return t && ['tree', 'giant', 'trunk'].includes(t.g); })) continue;
    cand.push(i);
  }
  for (let k = cand.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [cand[k], cand[j]] = [cand[j], cand[k]]; }
  const burrows = [];
  for (const i of cand) {
    if (burrows.length >= V.n) break;
    if (burrows.some(b => Math.hypot(b % w - i % w, ((b / w) | 0) - ((i / w) | 0)) < V.gap)) continue;
    burrows.push(i);
  }
  // Územia vlčiakov: najbližšia nora (po chodníkoch) do V.reach krokov; ničie miesta a územie pradleny vynecháme
  const terr = bfs(w, h, burrows, n => pass(n) && !nobody[n] && !pradTiles.has(n), V.reach);
  for (let i = 0; i < N; i++) if (terr.src[i] >= 0) owner[i] = terr.src[i];
  burrows.forEach(i => homes.push({ k: 'v', i, x: i % w, y: (i / w) | 0 }));
  if (lair != null) {
    const o = homes.length;
    for (const i of pradTiles) owner[i] = o;
    homes.push({ k: 'p', i: lair, x: lair % w, y: (lair / w) | 0 });
  }

  // Miesta na pavučiny: rad priechodných políčok jedného majiteľa medzi dvoma oporami (kmeň, strom, ker, spadnutý kmeň)
  const webable = i => pass(i) && g(i) !== 'gate' && !nobody[i];
  const cands = homes.map(() => []);
  for (let i = 0; i < N; i++) {
    const o = owner[i];
    if (o < 0 || !webable(i)) continue;
    const x = i % w, y = (i / w) | 0;
    for (const ax of [0, 1]) {
      const [sx, sy] = ax ? [0, 1] : [1, 0];
      const bx = x - sx, by = y - sy;
      if (bx < 0 || by < 0 || !D.WEB_ANCHOR[g(by * w + bx)]) continue;
      const tiles = [];
      for (let n = 1; n <= WEB.glade; n++) {
        const tx = x + sx * (n - 1), ty = y + sy * (n - 1), ti = ty * w + tx;
        if (tx >= w || ty >= h || !webable(ti) || owner[ti] !== o) break;
        tiles.push(ti);
        const ex = x + sx * n, ey = y + sy * n;
        if (ex >= w || ey >= h) break;
        if (!D.WEB_ANCHOR[g(ey * w + ex)]) continue;
        if (n <= WEB.span || tiles.some(j => g(j) === 'glade')) cands[o].push({ x, y, ax, n, o, tiles: tiles.slice() });
        break;
      }
    }
  }
  return { owner, homes, cands, nobody, ent };
}

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
// Kút: priechodné políčko P pri konci steny (budova, balvan, skala) – stena je vedľa P v smere d a v smere e (kolmo)
// sa už končí. Pavučina visí na hrane steny pri zemi. Kľúč kúta: "i:d:e" (indexy smerov v DIRS).
function cornerSpots(tiles, w, h) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h ? tiles[y * w + x] : null;
  const wall = t => t && D.CORNER_WALL[t.g];
  const open = t => t && D.passable(t) && t.g !== 'gate' && t.g !== 'glacier';
  const out = [];
  for (let i = 0; i < tiles.length; i++) {
    if (!open(tiles[i])) continue;
    const x = i % w, y = (i / w) | 0;
    DIRS.forEach(([dx, dy], di) => {
      if (!wall(at(x + dx, y + dy))) return;
      DIRS.forEach(([ex, ey], ei) => {
        if (ex * dx + ey * dy !== 0) return; // len kolmo na stenu
        if (wall(at(x + dx + ex, y + dy + ey)) || !open(at(x + ex, y + ey))) return;
        out.push({ k: `${i}:${di}:${ei}`, i, x, y, dx, dy, ex, ey });
      });
    });
  }
  return out;
}
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
  const start = far[Math.floor(Math.random() * far.length)], path = [];
  for (let i = start; i !== spot.i;) { // po klesajúcej vzdialenosti až ku kútu
    const x = i % w, y = (i / w) | 0;
    let nxt = -1;
    for (const [dx, dy] of DIRS) { const n = (y + dy) * w + x + dx; if (x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h && dist[n] === dist[i] - 1) { nxt = n; break; } }
    if (nxt < 0) return false;
    path.push(nxt); i = nxt;
  }
  room.kz = room.kz || {};
  room.kz[area] = { id: 'k' + area, k: 'k', x: start % w + 0.5, y: ((start / w) | 0) + 0.5, a: 0, path, spot, st: 'go', until: 0, left: 2, moving: false };
  return true;
}

// ---------- Hodváb: ťahanie, vbehnutie do pavučiny ----------
function silkOf(pl) { return pl.save.inv.silk || 0; }
function give(pl, n) { if (n > 0) { pl.save.inv.silk = silkOf(pl) + n; io.sendMe(pl); } }
function take(pl, n) { const k = Math.min(n, silkOf(pl)); if (k > 0) { if (k === silkOf(pl)) delete pl.save.inv.silk; else pl.save.inv.silk -= k; io.sendMe(pl); } return k; }
function slow(pl, k, ms) { io.send(pl, { t: 'slow', k, ms }); }

// Hráč začne ťahať hodváb z pavučiny (potrvá WEB.pullMs). Vráti chybové hlásenie alebo null.
function startPull(room, pl, wb, now) {
  if (pl.lp) return 'S lampášom v ruke hodváb neutrhneš. Vyber si v lište niečo iné alebo prázdnu ruku. 🏮';
  if (pl.pull) return 'Ešte ťaháš… 🕸️';
  pl.pull = { id: wb.id, until: now + WEB.pullMs, px: pl.x, py: pl.y };
  return null;
}
function stopPull(pl) { pl.pull = null; }
// Dokončenie potiahnutia: +1 hodváb; majiteľ si to všimne s rastúcou šancou, posledné potiahnutie pavučinu roztrhne.
function finishPull(room, pl, now, rnd) {
  const p = pl.pull;
  pl.pull = null;
  const wb = room.spid.webs.find(x => x.id === p.id);
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
  if (noticed) alert(room, wb, pl, now);
  io.toast(pl, torn
    ? `+1 🕸️ Pavúčí hodváb. Pavučina sa roztrhla${noticed ? ` – ${who} to zacítil(a)! Uteč! 🕷️` : '.'}`
    : `+1 🕸️ Pavúčí hodváb (v pavučine ešte ${wb.silk}).${noticed ? ` Pavučina sa zachvela – ${who.toLowerCase()} to zacítil(a)! 🕷️` : ''}`);
  return { torn, noticed };
}
// Hráč vbehol do pavučiny: chvíľu sa lepí, pavučina sa roztrhne (hodváb nedostane) a majiteľ vie, kde je.
function walkIn(room, pl, wb, now) {
  tear(room, wb);
  room.dirty = true;
  websMsg(room);
  slow(pl, WEB.stick, WEB.stickMs);
  alert(room, wb, pl, now);
  io.toast(pl, `🕸️ Vbehol(a) si do pavučiny! Lepí sa… a ${kindOf(room, wb.o) === 'p' ? 'stará pradlena' : 'vlčiak'} vie, kde si. 🕷️`);
}
// Hráč stojí na políčku s pavučinou (kontroluje sa pri každom pohybe v lese).
function checkWalk(room, pl, now) {
  if (pl.area !== 'les' || !room.spid) return;
  const i = Math.floor(pl.y) * LW + Math.floor(pl.x), wb = webAt(room, i);
  if (wb) walkIn(room, pl, wb, now);
}

// ---------- Pavúky v lese ----------
function spiders(room) {
  const f = forest(room);
  if (!room.sps || room.sps.length !== f.homes.length) {
    room.sps = f.homes.map((h, o) => ({ id: 's' + o, k: h.k, o, hx: h.x + 0.5, hy: h.y + 0.5, x: h.x + 0.5, y: h.y + 0.5, a: Math.PI / 2, st: 'home', until: 0, path: null, loot: 0, cool: 0, scared: 0 }));
  }
  return room.sps;
}
function resetSpiders(room) { if (room.sps) for (const s of room.sps) Object.assign(s, { x: s.hx, y: s.hy, st: 'home', tgt: null, path: null, loot: 0, until: 0, moving: false }); }
const tileOf = (x, y) => Math.floor(y) * LW + Math.floor(x);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
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
function goHome(room, s, now) { s.st = 'return'; s.tgt = null; s.path = pathTo(room, s, i => i === tileOf(s.hx, s.hy)) || []; s.until = now; }
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
// Pavučinu niekto potiahol alebo do nej vbehol – majiteľ sa rozbehne k nej (pradlena rovno k hráčovi).
function alert(room, wb, pl, now) {
  const s = spiders(room)[wb.o];
  if (!s || s.st === 'cling') return;
  if (s.k === 'p') { if (s.st !== 'chase') { s.st = 'chase'; s.tgt = pl.id; s.path = null; s.repath = 0; } return; }
  if (s.st === 'chase') return;
  const t = webTiles(wb), mid = t[Math.floor(t.length / 2)];
  s.st = 'alert'; s.tgt = pl.id; s.path = pathTo(room, s, i => i === mid) || []; s.until = now;
}
function chase(s, pl, now) { s.st = 'chase'; s.tgt = pl.id; s.path = null; s.repath = 0; s.seen = now; s.border = 0; }

function update(room, now, dt) {
  if (!room.spid || !room.les) return;
  const ps = playersIn(room, 'les');
  // ťahanie hodvábu (aj keď hráč medzitým odišiel z lesa, ťahanie sa zruší pohybom)
  for (const p of ps) if (p.pull && now >= p.pull.until) finishPull(room, p, now);
  if (!ps.length) { resetSpiders(room); return; }
  const byId = new Map(ps.map(p => [p.id, p])), lamps = ps.filter(p => p.lp);
  for (const s of spiders(room)) {
    s.moving = false;
    if (s.k === 'v') vlciak(room, s, ps, byId, lamps, now, dt); else pradlena(room, s, byId, lamps, now, dt);
  }
}
function nearestLamp(s, lamps) { let b = null; for (const l of lamps) if (!b || dist(s, l) < dist(s, b)) b = l; return b; }

function vlciak(room, s, ps, byId, lamps, now, dt) {
  const lamp = nearestLamp(s, lamps);
  const lampNear = lamp && dist(s, lamp) < SP.lamp + 0.3;
  if (lampNear) s.scared = now + V.backMs;
  // kým nikoho nenaháňa, všimne si hráča, ktorý príde blízko (bez lampáša)
  if (['home', 'walk', 'pause', 'return', 'search'].includes(s.st) && now >= s.cool && now >= s.scared) {
    const p = ps.find(p => !p.lp && dist(s, p) <= V.sense && inTerr(room, s, p.x, p.y));
    if (p) chase(s, p, now);
  }
  switch (s.st) {
    case 'home':
      if (now >= s.until) {
        const own = room.spid.webs.filter(wb => wb.o === s.o);
        const goal = own.length && Math.random() < 0.6 ? webTiles(own[Math.floor(Math.random() * own.length)]) : null;
        const f = forest(room), all = [];
        if (!goal) for (let i = 0; i < f.owner.length; i++) if (f.owner[i] === s.o) all.push(i);
        const g = goal ? goal[0] : all[Math.floor(Math.random() * all.length)];
        s.path = pathTo(room, s, i => i === g) || [];
        s.st = 'walk';
      }
      break;
    case 'walk': if (walkPath(s, V.walk, dt)) { s.st = 'pause'; s.until = now + 2000 + Math.random() * 2000; } break;
    case 'pause': if (now >= s.until) goHome(room, s, now); break;
    case 'return':
      if (walkPath(s, V.walk * 1.5, dt) && stepTo(s, s.hx, s.hy, V.walk, dt)) { s.st = 'home'; s.loot = 0; s.until = now + 3000 + Math.random() * 5000; }
      break;
    case 'alert': {
      const p = byId.get(s.tgt);
      if (p && dist(s, p) <= WEB.alert && inTerr(room, s, p.x, p.y)) { chase(s, p, now); break; }
      if (walkPath(s, V.run, dt)) {
        const q = ps.filter(o => dist(s, o) <= WEB.alert && inTerr(room, s, o.x, o.y)).sort((a, b) => dist(s, a) - dist(s, b))[0];
        if (q) chase(s, q, now); else { s.st = 'search'; s.until = now + V.lostMs; }
      }
      break;
    }
    case 'search': if (now >= s.until) goHome(room, s, now); break;
    case 'chase': {
      let p = byId.get(s.tgt);
      if (p && dist(s, p) <= V.lose) s.seen = now;
      if (!p || now - s.seen > V.lostMs) {
        // stratil ho – skúsi najbližšieho iného hráča vo svojom území, inak to vzdá
        const q = ps.filter(o => o !== p && dist(s, o) <= V.lose && inTerr(room, s, o.x, o.y)).sort((a, b) => dist(s, a) - dist(s, b))[0];
        if (q) { chase(s, q, now); p = q; } else { goHome(room, s, now); break; }
      }
      if (!inTerr(room, s, p.x, p.y)) { // za hranicou územia ďalej nejde
        if (!s.border) s.border = now;
        if (now - s.border > V.borderMs) goHome(room, s, now);
        break;
      }
      s.border = 0;
      if (p.lp && dist(s, p) < SP.lamp + 0.5) s.scared = now + V.backMs;
      if (now < s.scared) { // lampáš: drží sa na kraji svetla, kým ho hráč nesklopí
        const l = nearestLamp(s, lamps);
        if (l && dist(s, l) < SP.lamp) away(room, s, l.x, l.y, V.run, dt);
        break;
      }
      const d = dist(s, p);
      if (d < 0.55) { cling(room, s, p, now); break; }
      if (d < 1.2) stepTo(s, p.x, p.y, V.run, dt);
      else {
        const pi = tileOf(p.x, p.y);
        if (!s.path || !s.path.length || now >= s.repath || s.goal !== pi) { s.path = pathTo(room, s, i => i === pi) || []; s.goal = pi; s.repath = now + 400; }
        walkPath(s, V.run, dt);
      }
      break;
    }
    case 'cling': {
      const p = byId.get(s.tgt);
      if (!p || !inTerr(room, s, p.x, p.y)) { goHome(room, s, now); s.cool = now + V.coolMs; break; } // za hranicou územia sa pustí
      s.x = p.x; s.y = p.y;
      if (p.lp) { // zľakne sa lampáša, pustí sa a hodváb pustí na zem – hráč ho hneď zdvihne
        if (s.loot) { give(p, s.loot); io.toast(p, `🏮 Vlčiak sa zľakol lampáša, pustil sa ťa a pustil aj hodváb. Zdvihol(a) si ${s.loot}× 🕸️.`, 'gift'); }
        else io.toast(p, '🏮 Vlčiak sa zľakol lampáša a pustil sa ťa.');
        s.loot = 0; slow(p, 1, 0);
        chase(s, p, now); s.scared = now + V.backMs;
        break;
      }
      if (now >= s.next) {
        if (s.taken < V.takeMax && silkOf(p) > 0) {
          take(p, 1); s.loot++; s.taken++;
          slow(p, V.slow, V.takeMs + 300);
          io.toast(p, s.taken === 1 ? '🕷️ Vlčiak ťa chytil a vzal ti 1 hodváb! Zdvihni lampáš, nech ťa pustí.' : '🕷️ Vlčiak ti vzal ďalší hodváb!');
          s.next = now + V.takeMs;
        } else {
          if (!s.taken) { slow(p, V.slow, 1000); io.toast(p, '🕷️ Vlčiak ťa chytil, ale nemáš žiaden hodváb – pustil sa ťa.'); }
          goHome(room, s, now); s.cool = now + V.coolMs;
        }
      }
      break;
    }
  }
}
function cling(room, s, p, now) { s.st = 'cling'; s.tgt = p.id; s.taken = 0; s.next = now; s.path = null; }

function pradlena(room, s, byId, lamps, now, dt) {
  if (s.st === 'home') return;
  if (s.st === 'return') {
    if (walkPath(s, PR.walk, dt) && stepTo(s, s.hx, s.hy, PR.walk, dt)) s.st = 'home';
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
  else {
    const pi = tileOf(p.x, p.y);
    if (!s.path || !s.path.length || now >= s.repath || s.goal !== pi) { s.path = pathTo(room, s, i => i === pi) || []; s.goal = pi; s.repath = now + 400; }
    walkPath(s, PR.walk, dt);
  }
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
  goHome(room, s, now); s.cool = now + PR.coolMs;
}

// ---------- Krížiak na ceste do kúta ----------
function updateKriziak(room, now, dt) {
  if (!room.kz) return;
  for (const area of Object.keys(room.kz)) {
    const z = room.kz[area], ps = playersIn(room, area);
    if (!ps.length) { addCorner(room, area, z.spot); delete room.kz[area]; continue; } // nikto sa nepozerá – rovno dobehne
    z.moving = false;
    const scare = ps.find(p => dist(z, p) < KZ.near || (p.lp && dist(z, p) < SP.lamp));
    if (scare && z.st !== 'flee') { z.st = 'flee'; z.until = now + 700; const a = Math.atan2(z.y - scare.y, z.x - scare.x); z.fx = Math.cos(a); z.fy = Math.sin(a); }
    if (z.st === 'flee') {
      z.x += z.fx * KZ.flee * dt; z.y += z.fy * KZ.flee * dt; z.a = Math.atan2(z.fy, z.fx); z.moving = true;
      if (now >= z.until) delete room.kz[area]; // schoval sa – pavučinu tentoraz neutká
      continue;
    }
    if (z.st === 'pause') { if (now >= z.until) { z.st = 'go'; z.left = 1.5 + Math.random() * 1.5; } continue; }
    // beží trhane: kúsok rýchlo, chvíľu stojí
    const { w } = D.areaSize(area);
    if (!z.path.length) { addCorner(room, area, z.spot); delete room.kz[area]; continue; }
    const i = z.path[0], before = { x: z.x, y: z.y };
    if (stepTo(z, i % w + 0.5, ((i / w) | 0) + 0.5, KZ.run, dt)) z.path.shift();
    z.left -= dist(z, before);
    if (z.left <= 0) { z.st = 'pause'; z.until = now + 400 + Math.random() * 600; }
  }
}

// ---------- Správy pre klientov ----------
function websView(room) {
  const f = forest(room);
  return { t: 'webs', webs: room.spid.webs.map(wb => ({ id: wb.id, x: wb.x, y: wb.y, ax: wb.ax, n: wb.n, silk: wb.silk })), homes: f.homes.map(h => ({ k: h.k, x: h.x, y: h.y })) };
}
function websMsg(room) { io.broadcastArea(room, 'les', websView(room)); }
function cornerView(room, area) { return { t: 'corner', area, list: cornerList(room, area).map(s => ({ x: s.x, y: s.y, dx: s.dx, dy: s.dy, ex: s.ex, ey: s.ey })) }; }
function cornerMsg(room, area) { io.broadcastArea(room, area, cornerView(room, area)); }
// Čo hráč na ploche dostane pri príchode (pavučiny lesa alebo kúty)
function areaViews(room, area) {
  if (!room.spid) return [];
  if (area === 'les') return [websView(room)];
  if (D.CORNER_AREAS.includes(area)) return [cornerView(room, area)];
  return [];
}
// Pavúky a krížiak na ploche (10× za sekundu, len keď sú)
function entities(room, area) {
  const out = [];
  const r = v => +v.toFixed(2);
  if (area === 'les' && room.sps) for (const s of room.sps) out.push({ id: s.id, k: s.k, x: r(s.x), y: r(s.y), a: r(s.a), m: s.moving ? 1 : 0, c: s.st === 'cling' ? 1 : 0, h: s.st === 'home' ? 1 : 0 });
  const z = room.kz && room.kz[area];
  if (z) out.push({ id: z.id, k: 'k', x: r(z.x), y: r(z.y), a: r(z.a), m: z.moving ? 1 : 0 });
  return out;
}

// ---------- Načítanie a uloženie ----------
function load(room, saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
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
  setHooks, analyze, cornerSpots, forest, webTiles, webAt, target, weave, tear, balance, onWeave,
  spots, cornerList, clearCorner, addCorner, hourlyCorners, startKriziak, pruneCorners,
  startPull, stopPull, finishPull, walkIn, checkWalk, alert, spiders, update, updateKriziak,
  websView, cornerView, areaViews, entities, load, save
};
