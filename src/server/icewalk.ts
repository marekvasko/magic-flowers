// Chôdza po ľade (#157) – rozhoduje server. Návrh pohybu (pos v actions.ts) sem odovzdá požadovanú polohu a tu sa
// rozhodne, kde hráč naozaj je: na ľade sa šmýka s hybnosťou (fyzika zo src/shared/icewalk.ts), pri prudkej zákrute sa
// môže pošmyknúť (kocka enginu ctx.rng), cez otvor v ľade sa prepadne do vody, vo vode pláva a von sa dostane len na
// breh alebo na pevný ľad. Čupnutý (alebo plaziaci sa) hráč sa nepošmykne a pred otvorom zastane.
// Stav je výrez iw:<kľúč> (world.icewalk[kľúč], ukladá sa): hybnosť, čas klienta, pád a plávanie. Klient fyziku len
// predpovedá; na ľade server zapíše vždy svoj výpočet a keď poloha klienta ujde viac ako ICE.tol, pošle mu ho (správa iw).
// Mimo ľadu a vody sa nič nemení: pohyb je taký ako doteraz.
import * as D from '../shared/data.ts';
import type { AreaId } from '../shared/data.ts';
import * as IW from '../shared/icewalk.ts';
import { ICE } from '../shared/icewalk.ts';
import type { IceWalk, PlayerKey } from '../shared/save.ts';
import type { ToastKind } from '../shared/protocol.ts';
import { isRecord } from '../shared/util.ts';
import * as E from './engine.ts';
import * as Areas from './areas.ts';
import { maybe, put, savesOf, sl } from './game.ts';
import type { GameCtx, GameSlices, GameWorld, Keys, Msg, To } from './game.ts';
import type { Tile } from './world.ts';

// Čo k pohybu pridá klient (správa move): vstup (smer × spomalenie, dĺžka ≤ 1), čupnutie, plazenie a jeho čas (ms)
export interface IceInput { ix?: number; iy?: number; ck?: boolean; cr?: boolean; ts?: number }
export type PosData = { key: PlayerKey; x: number; y: number } & IceInput;
type Pt = { x: number; y: number };
export type Pose = 'fall' | 'swim';

const season = (tick: number): D.Season => D.seasonOf(D.dayOfTick(tick));
const toast$ = (to: To, text: string, kind?: ToastKind): Msg => ({ to, t: 'toast', text, kind: kind || 'info' });
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
export const MSG = {
  slip: 'Pošmykol(a) si sa na ľade! 🧊 Čupni si (C alebo tlačidlo 🧎) a pôjdeš opatrne.',
  fallIn: 'Prepadol(a) si sa do vody. Vyplávaj na breh. 🌊',
  out: 'Vyliezol(a) si z vody. Brrr! 🥶'
} as const;

// ---------- Načítanie ----------
// Uložený stav (nedôveryhodný JSON) → stav sveta; zlé záznamy sa zahodia
export function load(saved: unknown): Partial<Record<PlayerKey, IceWalk>> {
  const out: Partial<Record<PlayerKey, IceWalk>> = {};
  if (!isRecord(saved)) return out;
  for (const [k, v] of Object.entries(saved)) {
    if (!isRecord(v)) continue;
    const st: IceWalk = { vx: num(v['vx']), vy: num(v['vy']) };
    if (typeof v['t'] === 'number' && Number.isFinite(v['t'])) st.t = v['t'];
    if (typeof v['fall'] === 'number' && Number.isFinite(v['fall'])) st.fall = v['fall'];
    if (v['sw']) st.sw = 1;
    out[k] = st;
  }
  return out;
}

// ---------- Kľúče ----------
// Políčka plochy okolo bodu (box ±r), ako kľúče tile:<plocha>:<i>
function around(area: AreaId, x: number, y: number, r: number): string[] {
  const { w, h } = D.areaSize(area), out: string[] = [];
  for (let ty = Math.max(0, Math.floor(y - r)); ty <= Math.min(h - 1, Math.floor(y + r)); ty++)
    for (let tx = Math.max(0, Math.floor(x - r)); tx <= Math.min(w - 1, Math.floor(x + r)); tx++) out.push(`tile:${area}:${ty * w + tx}`);
  return out;
}
// Polomer, v ktorom server sám počíta polohu (najdlhší krok fyziky + telo)
const REACH = ICE.speed * ICE.dtMax + 0.5;
// Kľúče pohybu: vlastný stav iw:<kľúč>, dĺžka dňa (pád trvá pevný počet krokov) a – keď hráč stojí na ľade či vo vode,
// alebo ešte leží – políčka okolo jeho polohy (server tam polohu počíta sám, nielen overuje tú od klienta)
export function posKeys(d: Pick<PosData, 'key'>, w: GameWorld): Keys {
  const sv = savesOf(w)[d.key], area = sv && sv.area && D.AREAS.includes(sv.area) ? sv.area : 'garden';
  const keys: Keys = { writes: [`iw:${d.key}`], reads: ['daySeconds'] };
  if (!sv || !Number.isFinite(sv.x) || !Number.isFinite(sv.y)) return keys;
  const list: readonly Tile[] | undefined = Areas.areaTiles(w, area), { w: aw } = D.areaSize(area);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- čiastočné svety v testoch nemajú všetky plochy
  const t = list ? list[Math.floor(sv.y) * aw + Math.floor(sv.x)] : undefined, se = season(w.tick);
  if (w.icewalk?.[d.key] || IW.isIce(t, se) || (t && t.g === 'water')) return E.mergeKeys(keys, { reads: around(area, sv.x, sv.y, REACH) });
  return keys;
}

// ---------- Pohyb ----------
// Telo hráča na ploche (bodyTiles z actions.ts – podané zvonka, aby sa moduly neimportovali do kruhu)
type Body = (area: string, x: number, y: number) => Set<number>;

// Kde hráč po pohybe naozaj je. from = potvrdená poloha, req = požadovaná (už v ploche). Nepriechodný cieľ, ležanie
// po páde a čupnutý krok do otvoru odmietne (ctx.reject → server vráti hráča na potvrdené miesto). Stav iw:<kľúč> zapíše.
export function move(s: GameSlices, d: PosData, ctx: GameCtx, area: AreaId, from: Pt, req: Pt, body: Body): Pt {
  const se = season(ctx.tick), key = d.key, { w: aw } = D.areaSize(area);
  const idx = (x: number, y: number): number => Math.floor(y) * aw + Math.floor(x);
  const tileAt = (x: number, y: number): Tile | undefined => maybe(s, `tile:${area}:${idx(x, y)}`);
  const bodyOk = (x: number, y: number, swim: boolean): boolean => [...body(area, x, y)].every(i => IW.passableNow(maybe(s, `tile:${area}:${i}`), se, swim));
  const careful = !!d.ck || !!d.cr;
  const t = typeof d.ts === 'number' && Number.isFinite(d.ts) ? Math.round(d.ts) : null;
  const st = sl(s, `iw:${key}`);
  const dt = st && st.t != null && t != null && t > st.t ? Math.min(ICE.dtMax, (t - st.t) / 1000) : ICE.dtDef;
  const stamp = (o: IceWalk): IceWalk => { if (t != null) o.t = t; return o; };
  const ds = s.daySeconds;
  const done = (p: Pt, next: IceWalk | undefined, fix: boolean): Pt => {
    put(s, `iw:${key}`, next);
    if (fix) ctx.emit(msgOf(key, next, ctx.tick, ds, p));
    return p;
  };
  // leží po pošmyknutí / čľapká po prepadnutí: kým nevstane, nehne sa
  if (st && st.fall != null) {
    if (ctx.tick < st.fall) ctx.reject(null);
    delete st.fall; // vstal
  }
  const cur = tileAt(from.x, from.y);
  // vo vode (prepadol sa, alebo stojí vo vode, ktorá roztopila): pláva pomaly, von len na breh či pevný ľad
  if ((st && st.sw) || IW.openWater(cur, se)) {
    const max = ICE.speed * ICE.swim * dt + 0.1, dd = Math.hypot(req.x - from.x, req.y - from.y);
    const p = dd > max ? { x: from.x + (req.x - from.x) / dd * max, y: from.y + (req.y - from.y) / dd * max } : req;
    if (!bodyOk(p.x, p.y, true)) ctx.reject(null);
    if (IW.openWater(tileAt(p.x, p.y), se)) return done(p, stamp({ vx: 0, vy: 0, sw: 1 }), dd > max || !st || !st.sw);
    ctx.emit(toast$(key, MSG.out));
    return done(p, undefined, true);
  }
  const fallIn = (i: number): Pt => {
    const p = { x: i % aw + 0.5, y: Math.floor(i / aw) + 0.5 };
    ctx.emit(toast$(key, MSG.fallIn));
    ctx.emit({ to: E.area(area), t: 'fx', k: 'splash', x: p.x, y: p.y });
    return done(p, stamp({ vx: 0, vy: 0, sw: 1, fall: ctx.tick + IW.ticksOf(ICE.splashS, ds) }), true);
  };
  // na zemi (alebo prvý krok na ľad, alebo stav chýba): poloha od klienta ako doteraz, len s ľadom a otvormi
  if (!st || !IW.isIce(cur, se)) {
    if (!bodyOk(req.x, req.y, false)) ctx.reject(null);
    const c = tileAt(req.x, req.y);
    if (IW.isHole(c, se)) { if (careful) ctx.reject(null); return fallIn(idx(req.x, req.y)); }
    if (!IW.isIce(c, se)) return done(req, undefined, false);
    // vstup na ľad: hybnosť z kroku, ktorý práve urobil (najviac plná rýchlosť)
    const [vx, vy] = IW.clampInput((req.x - from.x) / dt, (req.y - from.y) / dt, ICE.speed * (careful ? ICE.crouch : 1));
    return done(req, stamp({ vx: r3(vx), vy: r3(vy) }), false);
  }
  // na ľade: server počíta sám – hybnosť, náraz do prekážky po osiach (ako klient), poloha klienta platí, ak je blízko
  const [ix, iy] = IW.clampInput(num(d.ix), num(d.iy), careful ? ICE.crouch : 1);
  const risk = careful ? 0 : IW.slipChance(st.vx, st.vy, ix, iy, dt);
  let [vx, vy] = IW.accelerate(st.vx, st.vy, ix, iy, dt);
  const e = Areas.clampPos(area, from.x + vx * dt, from.y + vy * dt);
  if (!bodyOk(e.x, from.y, false)) { e.x = from.x; vx = 0; }
  if (!bodyOk(e.x, e.y, false)) { e.y = from.y; vy = 0; }
  // poloha je vždy výpočet servera (aby sa hybnosť nedala obísť); klientovi sa pošle, len keď jeho predpoveď ujde
  let p: Pt = e, fix = Math.hypot(req.x - e.x, req.y - e.y) > ICE.tol;
  const c = tileAt(p.x, p.y);
  if (IW.isHole(c, se)) {
    if (!careful) return fallIn(idx(p.x, p.y));
    p = from; vx = 0; vy = 0; fix = true; // čupnutý zastane pred otvorom
  }
  if (risk > 0 && ctx.rng.rand() < risk) { // pošmykol sa: leží, hybnosť je preč
    ctx.emit(toast$(key, MSG.slip));
    ctx.emit({ to: E.area(area), t: 'fx', k: 'ice', x: p.x, y: p.y });
    return done(p, stamp({ vx: 0, vy: 0, fall: ctx.tick + IW.ticksOf(ICE.fallS, ds) }), true);
  }
  if (!IW.isIce(tileAt(p.x, p.y), se)) return done(p, undefined, fix); // zišiel z ľadu – na zemi je zase okamžitý
  return done(p, stamp({ vx: r3(vx), vy: r3(vy) }), fix);
}

// ---------- Správy a pohľad ----------
// Stav pre hráča (správa iw): hybnosť, koľko ms ešte leží, či pláva a (pri oprave) poloha, kde naozaj je
export function msgOf(key: PlayerKey, st: IceWalk | undefined, tick: number, daySeconds: number, p?: Pt): Msg {
  const ms = st && st.fall != null && st.fall > tick ? Math.round((st.fall - tick) * daySeconds * 1000 / D.TICKS_PER_DAY) : 0;
  return { to: key, t: 'iw', vx: st ? st.vx : 0, vy: st ? st.vy : 0, fall: ms, sw: st && st.sw ? 1 : 0, ...(p ? { x: r3(p.x), y: r3(p.y) } : {}) };
}
// Póza hráča pre ostatných (správa pl): leží, alebo pláva
export function pose(st: IceWalk | undefined, tick: number): Pose | null {
  if (!st) return null;
  if (st.sw) return 'swim';
  return st.fall != null && st.fall > tick ? 'fall' : null;
}

// ---------- Cheaty (ladiaca stránka, cheats.ts) ----------
// slip = pošmykne sa na mieste, swim = hodí ho do najbližšej vody (v zime tam vysekne otvor), momentum = nastaví hybnosť,
// clear = zruší stav (vstane, prestane plávať – kto stojí v otvorenej vode, pri ďalšom pohybe zase pláva)
export type IceCheat = { op: 'iw'; key: PlayerKey; what: 'slip' | 'swim' | 'momentum' | 'clear'; vx?: number; vy?: number };
// Najbližšia voda k hráčovi na jeho ploche (index políčka) alebo null
function nearestWater(w: GameWorld, key: PlayerKey): { area: AreaId; i: number } | null {
  const sv = savesOf(w)[key];
  if (!sv) return null;
  const area = sv.area && D.AREAS.includes(sv.area) ? sv.area : 'garden', { w: aw } = D.areaSize(area);
  const list: readonly Tile[] | undefined = Areas.areaTiles(w, area);
  let best = -1, bd = Infinity;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- čiastočné svety v testoch nemajú všetky plochy
  for (const [i, t] of (list || []).entries()) {
    if (t.g !== 'water') continue;
    const d = Math.hypot(i % aw + 0.5 - sv.x, Math.floor(i / aw) + 0.5 - sv.y);
    if (d < bd) { bd = d; best = i; }
  }
  return best < 0 ? null : { area, i: best };
}
export function cheatKeys(d: IceCheat, w: GameWorld): Keys {
  const k: Keys = { writes: [`iw:${d.key}`, `pos:${d.key}`], reads: ['daySeconds'] };
  if (d.what !== 'swim') return k;
  const wt = nearestWater(w, d.key);
  return wt ? E.mergeKeys(k, { writes: [`tile:${wt.area}:${wt.i}`] }) : k;
}
export function cheat(s: GameSlices, d: IceCheat, ctx: GameCtx): void {
  const pos = sl(s, `pos:${d.key}`) || ctx.reject('no such player');
  const area = pos.area && D.AREAS.includes(pos.area) ? pos.area : 'garden', { w: aw } = D.areaSize(area), ds = s.daySeconds;
  const st = sl(s, `iw:${d.key}`);
  let next: IceWalk | undefined, p: Pt | undefined;
  switch (d.what) {
    case 'slip': next = { vx: 0, vy: 0, ...(st && st.t != null ? { t: st.t } : {}), fall: ctx.tick + IW.ticksOf(ICE.fallS, ds) }; break;
    case 'momentum': {
      const [vx, vy] = IW.clampInput(num(d.vx), num(d.vy), ICE.speed);
      next = { ...(st || {}), vx: r3(vx), vy: r3(vy) };
      break;
    }
    case 'clear': next = undefined; break;
    case 'swim': {
      const key = Object.keys(s).find(k => k.startsWith(`tile:${area}:`));
      const tile = key ? sl(s, `tile:${area}:${Number(key.split(':')[2])}`) : undefined;
      if (!key || !tile) ctx.reject('no water in this area');
      const i = Number(key.split(':')[2]);
      if (IW.isWinter(season(ctx.tick))) tile.cut = 1; // v zime cez otvor v ľade
      p = { x: i % aw + 0.5, y: Math.floor(i / aw) + 0.5 };
      pos.x = p.x; pos.y = p.y;
      next = { vx: 0, vy: 0, sw: 1, fall: ctx.tick + IW.ticksOf(ICE.splashS, ds) };
      ctx.emit({ to: E.area(area), t: 'fx', k: 'splash', x: p.x, y: p.y });
      break;
    }
  }
  put(s, `iw:${d.key}`, next);
  ctx.emit(msgOf(d.key, next, ctx.tick, ds, p));
}
