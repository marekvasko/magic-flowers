// Záhon (#179): spoločný objekt na jednom políčku záhrady, 8 × 8 bodov (pravidlá v src/shared/zahon.ts). Kúpi sa na trhu
// (všetky druhy rámov rovnako: 40 🪙, reputácia 1), položí sa na čistú trávu a zaberá 1 miesto v spoločnom povolení,
// nech je v ňom kvetov koľkokoľvek. Krhla polieva celý záhon naraz, kompost pohnojí celý záhon (do konca obdobia).
// Kvety a pokryvy (trávnik, štrk, okruhliaky, plochý kameň – kupujú sa po vedrách) sa sadia a rozkladajú v priblíženom
// pohľade (klient); záhon sa nepresúva, dá sa len zrušiť krompáčom: rozkvitnuté kvety idú do batohu, ostatné zaniknú,
// pokryvy sa vrátia. Stav: world.objects (objekty kind 'zahon', save.ts ZahonObject).
import * as D from '../shared/data.ts';
import type { CoverId, ItemId, ZahonFrame, ZahonShape } from '../shared/data.ts';
import type { FxKind, ObjectView, ServerMessage, ToastKind } from '../shared/protocol.ts';
import type { GardenObject, PlayerKey, PlayerSave, ZahonObject, ZahonSpot } from '../shared/save.ts';
import * as Obj from '../shared/objects.ts';
import * as Z from '../shared/zahon.ts';
import { lookup, must } from '../shared/util.ts';
import type { JsonRecord } from '../shared/util.ts';
import * as E from './engine.ts';
import * as I from './items.ts';
import * as Econ from './economy.ts';
import * as Scav from './scavenge.ts';
import { sl } from './game.ts';
import type { GameCtx, GameProposer, GameSlices, Msg, To } from './game.ts';
import type { Presence } from './world.ts';

type XY = readonly [number, number];
export interface ZahonInputs {
  zahonBuy: { key: PlayerKey; v: ZahonFrame; sh?: ZahonShape };
  coverBuy: { key: PlayerKey; c: CoverId };
  zahonPlace: { key: PlayerKey; i: number; v: ZahonFrame; sh?: ZahonShape; rot?: 0 | 1 | 2 | 3 };
  zahonDestroy: { key: PlayerKey; id: number };
  zahonPlant: { key: PlayerKey; id: number; sx: number; sy: number; item: string };
  zahonCover: { key: PlayerKey; id: number; c: CoverId; spots: XY[] };
  zahonUncover: { key: PlayerKey; id: number; spots: XY[] };
  zahonPick: { key: PlayerKey; id: number; sx: number; sy: number };
  zahonDig: { key: PlayerKey; id: number; sx: number; sy: number };
  zahonWater: { key: PlayerKey; id: number };
  zahonCompost: { key: PlayerKey; id: number };
}

const toast$ = (to: To, text: string, kind?: ToastKind): Msg => ({ to, t: 'toast', text, kind: kind || 'info' });
const fx$ = (x: number, y: number, k: FxKind, c?: string): Msg => ({ to: E.area('garden'), t: 'fx', k, x, y, ...(c ? { c } : {}) });
const season = (tick: number): D.Season => D.seasonOf(D.dayOfTick(tick));
const saveOf = (s: GameSlices, key: PlayerKey, ctx: GameCtx): PlayerSave => sl(s, `save:${key}`) || ctx.reject(null);
const give = (sv: PlayerSave, id: ItemId, n: number, tick: number): void => { if (n > 0) I.addItems(I.playerC(sv), id, n, tick); };
const take = (sv: PlayerSave, id: ItemId, n: number, tick: number): boolean => !!I.removeItems(I.playerC(sv), id, n, tick);
const STALL = { x: 12.5, y: 28.5 };
const atStall = (p: Presence | null | undefined): boolean => !!p && p.area === 'garden' && Math.hypot(p.x - STALL.x, p.y - STALL.y) <= 3;
const AT_STALL = 'Obchoduje sa pri trhovom stánku – podíď bližšie.';
// Hráč stojí pri záhone (ako pri ťuknutí na políčko)
const near = (p: Presence | null | undefined, z: Pick<ZahonObject, 'x' | 'y'>): boolean => !!p && p.area === 'garden' && Math.hypot(p.x - (z.x + 0.5), p.y - (z.y + 0.5)) <= 2.4;
// Záhon podľa id (zmizol medzitým → ticho odmietnuť)
function zahon(s: GameSlices, id: number, ctx: GameCtx): ZahonObject {
  const z = s.objects.list.find((o): o is ZahonObject => o.kind === 'zahon' && o.id === id);
  if (!z) return ctx.reject('Tento záhon už nie je.');
  if (!Z.groupOf(s.objects.list, z).some(b => near(ctx.actor, b))) ctx.reject('Podíď bližšie k záhonu.'); // stačí byť pri spojenom záhone (jeden kus)
  return z;
}
// Stred bodu záhonu v súradniciach záhrady (efekty)
const spotXY = (z: ZahonObject, sx: number, sy: number): [number, number] => [z.x + (sx + 0.5) / Z.SPOTS, z.y + (sy + 0.5) / Z.SPOTS];
// Koľko kvetov dá zrezaný kvet (ako na políčku: kvalita, kompost +1, najviac 4)
const bunch = (z: ZahonObject, q: number): number => Math.min(4, q + (z.r ? 1 : 0));

// Pre klienta: divé semienko bez druhu, kým nevyklíči (ako Scav.tileView)
export function objectView(o: GardenObject): ObjectView {
  if (o.kind !== 'zahon') return { ...o };
  return { ...o, spots: o.spots.map(s => (s.p && s.p.wild ? { ...s, p: { ...s.p, sp: 'wild' as const } } : { ...s })) };
}

export const PROPOSERS: { [T in keyof ZahonInputs]: GameProposer<ZahonInputs[T]> } = {
  // kúpa záhonu na trhu (do batohu); všetky rámy stoja rovnako
  zahonBuy: {
    keys: d => ({ writes: [`save:${d.key}`] }),
    run(s, d, ctx) {
      if (!atStall(ctx.actor)) ctx.reject(AT_STALL);
      const sv = saveOf(s, d.key, ctx);
      if (D.repLevel(sv.rep || 0) < D.ZAHON.rep) ctx.reject(`Potrebuješ reputáciu úrovne ${String(D.ZAHON.rep)}.`);
      if (sv.coins < D.ZAHON.price) ctx.reject('Nemáš dosť mincí. 🪙');
      sv.coins -= D.ZAHON.price;
      const sh = d.sh ?? 'sq';
      give(sv, D.zahonItem(d.v, sh), 1, ctx.tick);
      ctx.emit(toast$(d.key, `${D.ZAHON.icon} Kúpil(a) si: ${D.zahonName(d.v, sh)}. Vyber ho v lište a ťukni na čistú trávu` + (sh === 'sq' ? '.' : ' – ďalším ťuknutím na to isté miesto ho otočíš.'), 'gift'));
    }
  },
  // vedro pokryvu (D.COVER_BUCKET bodov)
  coverBuy: {
    keys: d => ({ writes: [`save:${d.key}`] }),
    run(s, d, ctx) {
      if (!atStall(ctx.actor)) ctx.reject(AT_STALL);
      const sv = saveOf(s, d.key, ctx), C = D.COVERS[d.c];
      if (sv.coins < C.price) ctx.reject('Nemáš dosť mincí. 🪙');
      sv.coins -= C.price;
      give(sv, `cov_${d.c}`, D.COVER_BUCKET, ctx.tick);
      ctx.emit(toast$(d.key, `🪣 Kúpil(a) si vedro: ${C.name} (na ${String(D.COVER_BUCKET)} bodov záhonu).`, 'gift'));
    }
  },
  // položiť záhon na čistú trávu (bez prekopanej zeme a bez iného objektu); zaberá 1 miesto v povolení
  zahonPlace: {
    keys: d => ({ writes: [`tile:garden:${d.i}`, 'objects', 'plotsUsed', `save:${d.key}`], reads: ['up'] }),
    run(s, d, ctx) {
      const t = sl(s, `tile:garden:${d.i}`), sv = saveOf(s, d.key, ctx), x = d.i % D.W, y = Math.floor(d.i / D.W);
      if (!t) { ctx.reject(null); return; }
      if (t.s) ctx.reject('Najprv zarovnaj motykou.');
      if (t.g !== 'grass') ctx.reject('Záhon sa kladie na čistú trávu.');
      if (s.objects.list.some(o => o.area === 'garden' && Obj.inRect(Obj.objRect(o), x, y))) ctx.reject('Tu už niečo je.');
      const lim = Econ.plotLimit(s.up);
      if (s.plotsUsed >= lim) ctx.reject(`Spoločné povolenie záhrady je na ${lim} miest a všetky sú obsadené (záhon zaberá jedno). Väčšie povolenie môže pre všetkých kúpiť ktokoľvek na trhu (záložka Vylepšiť).`);
      const sh = d.sh ?? 'sq';
      if (!take(sv, D.zahonItem(d.v, sh), 1, ctx.tick)) ctx.reject(null);
      s.objects.list.push({ id: s.objects.nid++, area: 'garden', x, y, kind: 'zahon', v: d.v, ...(sh === 'sq' ? {} : { sh, rot: d.rot ?? 0 }), w: 0, r: 0, spots: [], o: d.key });
      s.plotsUsed++;
      ctx.emit(fx$(x + 0.5, y + 0.5, 'dirt'));
    }
  },
  // zrušiť záhon krompáčom: rozkvitnuté kvety do batohu, ostatné zaniknú, pokryvy sa vrátia; miesto v povolení sa uvoľní
  zahonDestroy: {
    keys: d => ({ writes: ['objects', 'plotsUsed', `save:${d.key}`] }),
    run(s, d, ctx) {
      const z = zahon(s, d.id, ctx), sv = saveOf(s, d.key, ctx);
      if (!sv.inv.pick) ctx.reject('Záhon zrušíš krompáčom – kúpiš ho na trhu (záložka Vylepšiť). ⛏️');
      const got: string[] = [];
      const gather = (b: ZahonObject, sp: ZahonSpot): void => {
        if (sp.c) give(sv, `cov_${sp.c}`, 1, ctx.tick);
        else if (sp.p && Z.blooming(sp)) { const n = bunch(b, sp.p.q); give(sv, `fl_${sp.p.sp}`, n, ctx.tick); got.push(`${String(n)}× ${D.SPECIES[sp.p.sp].name}`); }
      };
      for (const sp of z.spots) gather(z, sp);
      s.objects.list = s.objects.list.filter(o => o !== z);
      // susedným záhonom sa na spoločnej strane vráti rám – čo na nej bolo, dopadne ako pri zrušení
      for (const b of Obj.zahony(s.objects)) {
        if (Math.abs(b.x - z.x) + Math.abs(b.y - z.y) !== 1) continue;
        const open = Z.bedOf(s.objects.list, b).open;
        for (const sp of b.spots.filter(q => Z.cellOf({ ...b, open }, q.sx, q.sy) !== 'in')) gather(b, sp);
        b.spots = b.spots.filter(q => Z.cellOf({ ...b, open }, q.sx, q.sy) === 'in');
      }
      s.plotsUsed = Math.max(0, s.plotsUsed - 1);
      ctx.emit(toast$(d.key, 'Záhon je preč.' + (got.length ? ' Do batohu: ' + got.join(', ') + '.' : '')));
      ctx.emit(fx$(z.x + 0.5, z.y + 0.5, 'dirt'));
    }
  },
  // zasadiť semienko (seed_<druh>) alebo divé semienko (wild_<obdobie>) na bod záhonu
  zahonPlant: {
    keys: d => ({ writes: ['objects', `save:${d.key}`], reads: ['eternal', ...(D.isWild(d.item) ? ['market:fl_*'] : [])] }),
    run(s, d, ctx) {
      const z = zahon(s, d.id, ctx), sv = saveOf(s, d.key, ctx), item = d.item;
      if (D.isWild(item)) {
        const ws = D.wildSeason(item);
        if (ws !== season(ctx.tick) && !s.eternal) ctx.reject(`Toto divé semienko je z obdobia ${must(D.SEASONS[ws]).toLowerCase()} – vtedy ho aj zasaď.`);
        const err = Z.plantError(Z.bedOf(s.objects.list, z), d.sx, d.sy, null);
        if (err) ctx.reject(err);
        if (!take(sv, item, 1, ctx.tick)) ctx.reject(null);
        const m = { flowers: sl(s, 'market:fl_*') };
        z.spots.push({ sx: d.sx, sy: d.sy, p: { sp: Scav.pickWild(ctx.rng, ws, sp => Econ.flowerPrice(m, ctx.tick, sp)), prog: 0, q: 3, dry: 0, wild: 1 } });
        ctx.emit(toast$(d.key, 'Zasadil(a) si divé semienko. Čo z neho vyrastie? 🤔'));
        return;
      }
      const spId = item.startsWith('seed_') ? item.slice(5) : '', sp = lookup(D.SPECIES, spId);
      if (!sp || !D.isSpeciesId(spId) || !D.isItemId(item)) { ctx.reject(null); return; }
      if (!sp.seasons.includes(season(ctx.tick)) && !s.eternal) ctx.reject(`${sp.name} sa sadí v období: ${sp.seasons.map(x => must(D.SEASONS[x])).join(', ')}.`);
      const err = Z.plantError(Z.bedOf(s.objects.list, z), d.sx, d.sy, spId);
      if (err) ctx.reject(err);
      if (!take(sv, item, 1, ctx.tick)) ctx.reject(null);
      z.spots.push({ sx: d.sx, sy: d.sy, p: { sp: spId, prog: 0, q: 3, dry: 0 } });
      if (sp.strict && sp.soil && sp.soil !== 'rich') ctx.emit(toast$(d.key, `Hmm, ${sp.name} tu asi nebude rásť…`));
    }
  },
  // rozložiť pokryv na body (ťahom prsta): na koľko bodov je v batohu, inak len na prvé; iný pokryv na bode sa vráti do batohu
  zahonCover: {
    keys: d => ({ writes: ['objects', `save:${d.key}`] }),
    run(s, d, ctx) {
      const z = zahon(s, d.id, ctx), sv = saveOf(s, d.key, ctx), id: ItemId = `cov_${d.c}`;
      const bed = Z.bedOf(s.objects.list, z);
      let n = 0, first: string | null = null;
      for (const [sx, sy] of d.spots.slice(0, 64)) {
        const why = Z.coverError(bed, sx, sy), here = Z.spotAt(z, sx, sy);
        if (why) { first ??= why; continue; }
        if (here?.c === d.c) continue;
        if (!take(sv, id, 1, ctx.tick)) { first ??= `Došiel ti pokryv: ${D.COVERS[d.c].name}. Kúp ďalšie vedro na trhu.`; break; }
        if (here?.c) give(sv, `cov_${here.c}`, 1, ctx.tick);
        if (here) here.c = d.c; else z.spots.push({ sx, sy, c: d.c });
        n++;
      }
      if (!n) ctx.reject(first);
    }
  },
  // zobrať pokryv z bodov späť do batohu (prázdnou rukou)
  zahonUncover: {
    keys: d => ({ writes: ['objects', `save:${d.key}`] }),
    run(s, d, ctx) {
      const z = zahon(s, d.id, ctx), sv = saveOf(s, d.key, ctx);
      let n = 0;
      for (const [sx, sy] of d.spots.slice(0, 64)) {
        const here = Z.spotAt(z, sx, sy);
        if (!here?.c) continue;
        give(sv, `cov_${here.c}`, 1, ctx.tick);
        z.spots = z.spots.filter(q => q !== here);
        n++;
      }
      if (!n) ctx.reject(null);
    }
  },
  // zrezať rozkvitnutý kvet (ako na políčku: trvalka znova narastie, letnička zmizne)
  zahonPick: {
    keys: d => ({ writes: ['objects', `save:${d.key}`] }),
    run(s, d, ctx) {
      const z = zahon(s, d.id, ctx), sv = saveOf(s, d.key, ctx), here = Z.spotAt(z, d.sx, d.sy), p = here?.p;
      if (!here || !p || !Z.blooming(here)) { ctx.reject('Tu nič nekvitne.'); return; }
      const sp = D.SPECIES[p.sp];
      if (p.sp === 'papradie' && !D.isNight(D.minOfTick(ctx.tick))) ctx.reject('Papraď drží púčik pevne zatvorený… vraj sa otvára len v noci. 🌙');
      const n = bunch(z, p.q);
      give(sv, `fl_${p.sp}`, n, ctx.tick);
      if (sp.perennial) { p.prog = sp.days * 0.5; p.q = 3; p.bt = null; } else z.spots = z.spots.filter(q => q !== here);
      ctx.emit(toast$(d.key, `+${n}× ${sp.name}` + (n >= 3 ? ' ⭐ výborná kvalita!' : '')));
      const [x, y] = spotXY(z, d.sx, d.sy);
      ctx.emit(fx$(x, y, 'pop', sp.color));
    }
  },
  // motykou vykopať kvet z bodu (aj rastúci – záhon sa dá prerobiť); vykopaný kvet zanikne
  zahonDig: {
    keys: () => ({ writes: ['objects'] }),
    run(s, d, ctx) {
      const z = zahon(s, d.id, ctx), here = Z.spotAt(z, d.sx, d.sy);
      if (!here?.p) { ctx.reject(null); return; }
      z.spots = z.spots.filter(q => q !== here);
      const [x, y] = spotXY(z, d.sx, d.sy);
      ctx.emit(fx$(x, y, 'dirt'));
    }
  },
  // jedno poliatie krhlou = celý záhon
  zahonWater: {
    keys: d => ({ writes: ['objects', `save:${d.key}`] }),
    run(s, d, ctx) {
      const z = zahon(s, d.id, ctx), sv = saveOf(s, d.key, ctx);
      if (z.w) ctx.reject('Záhon je dnes už poliaty. 💧');
      if (sv.water <= 0) ctx.reject('Krhla je prázdna – načri vodu v jazierku alebo v studni. 💧');
      sv.water--; z.w = 1;
      ctx.emit(fx$(z.x + 0.5, z.y + 0.5, 'drops'));
    }
  },
  // kompost pohnojí celý záhon (do konca obdobia)
  zahonCompost: {
    keys: d => ({ writes: ['objects', `save:${d.key}`] }),
    run(s, d, ctx) {
      const z = zahon(s, d.id, ctx), sv = saveOf(s, d.key, ctx);
      if (z.r) ctx.reject('Záhon je už pohnojený. 🌱');
      if (!take(sv, 'compost', 1, ctx.tick)) ctx.reject(null);
      z.r = 1;
    }
  }
};

// Správa 'zahon' od klienta → vstup (null = neplatná). Overenie stavu urobí návrh.
type ZahonInput = { [T in keyof ZahonInputs]: { type: T; data: Omit<ZahonInputs[T], 'key'> } }[keyof ZahonInputs];
const num = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) ? v : -1);
function spotsOf(v: unknown): XY[] {
  if (!Array.isArray(v)) return [];
  const out: XY[] = [];
  for (const p of v.slice(0, 64)) if (Array.isArray(p)) { const sx = num(p[0]), sy = num(p[1]); if (Z.inGrid(sx, sy) && !out.some(q => q[0] === sx && q[1] === sy)) out.push([sx, sy]); }
  return out;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export function toInput(m: JsonRecord): ZahonInput | null {
  const id = num(m['id']), sx = num(m['sx']), sy = num(m['sy']), v = str(m['v']), c = str(m['c']);
  switch (m['op']) {
    case 'buy': { const sh = str(m['sh']) || 'sq'; return D.isZahonFrame(v) && (sh === 'sq' || D.isZahonCorner(sh)) ? { type: 'zahonBuy', data: { v, sh } } : null; }
    case 'bucket': return D.isCoverId(c) ? { type: 'coverBuy', data: { c } } : null;
    case 'destroy': return { type: 'zahonDestroy', data: { id } };
    case 'plant': return { type: 'zahonPlant', data: { id, sx, sy, item: str(m['item']) } };
    case 'cover': return D.isCoverId(c) ? { type: 'zahonCover', data: { id, c, spots: spotsOf(m['spots']) } } : null;
    case 'uncover': return { type: 'zahonUncover', data: { id, spots: spotsOf(m['spots']) } };
    case 'pick': return { type: 'zahonPick', data: { id, sx, sy } };
    case 'dig': return { type: 'zahonDig', data: { id, sx, sy } };
    case 'water': return { type: 'zahonWater', data: { id } };
    case 'compost': return { type: 'zahonCompost', data: { id } };
  }
  return null;
}
// Správa pre klienta s celým zoznamom objektov (pozemky a záhony)
export function objectsMsg(list: readonly GardenObject[]): ServerMessage { return { t: 'objects', list: list.map(objectView) }; }
