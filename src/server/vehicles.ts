// Doprava (#158): fúrik a sane – spoločné vylepšenie Dielne (ako krosná), vozia ľad z hôr do ľadovne.
// Stav je výrez 'vehicles' (world.vehicles: { furik, sane }) – každá akcia s fúrikom ho zapisuje, takže dvaja hráči,
// ktorí ho v jednom rámci chytia naraz, sa v engine pobijú o ten istý kľúč a vyhrá len prvý (druhý dostane odmietnutie).
// Pohyb: fúrik / sane sa hýbu s hráčom, ktorý ich drží – v návrhu pos (actions.ts volá posKeys a onPos) aj so spolujazdcom.
// Fúrik sa tlačí pred sebou, sane sa ťahajú za sebou (shared/vehicles.ts follow). Kam smú: záhrada a hory.
// Náklad: len ľad, najviac 6 kusov, nespomaľuje; ľad sa vo fúriku topí ako v batohu (rovnaké várky, hodinová udalosť).
// Obdobie: fúrik či sane majú vlastný príznak usable (stav sveta), ktorý na začiatku každého obdobia prepne periodická
// udalosť vehSeason – keď sa vozidlo prestane dať používať, kto ho drží a kto v ňom sedí, ho pustí (s hlásením).
import * as D from '../shared/data.ts';
import type { AreaId } from '../shared/data.ts';
import type { ToastKind, VehicleView } from '../shared/protocol.ts';
import type { PlayerKey, PlayerSave, Vehicle, VehicleId, Vehicles } from '../shared/save.ts';
import * as V from '../shared/vehicles.ts';
import { isRecord } from '../shared/util.ts';
import * as E from './engine.ts';
import * as I from './items.ts';
import * as Ice from './ice.ts';
import * as Areas from './areas.ts';
import * as Dielna from './dielna.ts';
import { savesOf, sl } from './game.ts';
import type { GameCtx, GamePeriodic, GameProposer, GameSlices, GameWorld, Msg, To } from './game.ts';
import type { Container, Presence } from './world.ts';

const { VEHICLES } = V;
const season = (tick: number): D.Season => D.seasonOf(D.dayOfTick(tick));
const toast$ = (to: To, text: string, kind?: ToastKind, icon?: VehicleId): Msg => ({ to, t: 'toast', text, kind: kind || 'info', ...(icon ? { icon } : {}) });
const who = (ctx: GameCtx): Presence => ctx.actor || ctx.reject(null);
const nameOf = (ctx: GameCtx, key: PlayerKey): string => (ctx.actor ? ctx.actor.name : key);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- Načítanie a uloženie ----------
// Uloženie bez fúrikov (staršie svety) alebo poškodené → predvolené (nekúpené pred Dielňou). Kto ich držal a kto
// v nich sedel, sa zabudne: po reštarte servera nie je nikto pripojený (fúrik ostane stáť, kde bol).
// tick = čas sveta: uloženie bez príznaku usable (staršie) ho dostane podľa obdobia; várky ľadu sa zladia s počtom.
export function loadVehicles(saved: unknown, tick: number): Vehicles { return parseVehicles(saved, false, tick); }
// keep = nechať aj vodiča a spolujazdca (ladiaca stránka ukazuje uložený stav, ako je)
export function parseVehicles(saved: unknown, keep: boolean, tick: number): Vehicles {
  const out = V.newVehicles(), src = isRecord(saved) ? saved : {};
  for (const id of V.VEHICLE_IDS) {
    const v = src[id];
    out[id].usable = V.inSeason(id, season(tick)); // staršie uloženie: podľa obdobia
    if (!isRecord(v)) continue;
    const t = out[id], num = (k: string, d: number): number => { const n = v[k]; return typeof n === 'number' && Number.isFinite(n) ? n : d; };
    t.bought = !!v['bought'];
    const area = v['area'];
    t.area = V.VEHICLE_AREAS.find(a => a === area) ?? 'garden';
    const p = Areas.clampPos(t.area, num('x', t.x), num('y', t.y));
    t.x = p.x; t.y = p.y; t.a = num('a', t.a);
    t.ice = Math.max(0, Math.min(V.VEHICLE_ICE, Math.round(num('ice', 0))));
    const fb = v['fb'], u = v['usable'];
    // várky ľadu zapísal server ({ n, a, at }); syncAll ich zladí s počtom (chýbajúce = čerstvé)
    t.fb = Array.isArray(fb) ? fb.filter((b): b is D.Batch => isRecord(b) && typeof b['n'] === 'number' && typeof b['a'] === 'number' && typeof b['at'] === 'number') : [];
    const c = container(t); I.syncAll(c, tick); c.done();
    t.usable = typeof u === 'boolean' ? u : V.inSeason(id, season(tick));
    const dr = v['driver'], ps = v['passenger'];
    if (keep) { t.driver = typeof dr === 'string' ? dr : null; t.passenger = typeof ps === 'string' ? ps : null; }
  }
  return out;
}
// Fúriky sveta pre kľúče návrhov – svety v testoch ich nemusia mať
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- čiastočné svety v testoch; na serveri sú vždy
export const vehiclesOf = (w: Pick<GameWorld, 'vehicles'>): Partial<Vehicles> => w.vehicles || {};
// Ľad vo fúriku ako kontajner predmetov (items.ts) – várky sa topia rovnako ako v batohu; po zmene sa počet a várky
// zapíšu späť do vozidla (v.ice, v.fb)
export function container(v: Vehicle): Container & { done: () => void } {
  const c: Container = { inv: v.ice ? { ice: v.ice } : {}, fb: v.fb.length ? { ice: v.fb } : {}, rate: 1 };
  return Object.assign(c, { done: () => { v.ice = c.inv.ice ?? 0; v.fb = c.fb.ice ?? []; } });
}
// Kedy sa roztopí najstarší ľad (krok), alebo null
export function meltAt(v: Vehicle): number | null {
  const b = v.fb[0];
  return b ? b.at + D.ICE_LIFE - b.a : null;
}
export const save = (w: Pick<GameWorld, 'vehicles'>): { vehicles: Vehicles } => ({ vehicles: w.vehicles });

// ---------- Pohľad pre klienta ----------
// who(key) = pripojený hráč (číslo a meno ako v správe pl), alebo null
export function view(vs: Vehicles, who: (key: PlayerKey) => { id: number; name: string } | null): VehicleView[] {
  return V.VEHICLE_IDS.map(id => {
    const v = vs[id], d = v.driver ? who(v.driver) : null, r = v.passenger ? who(v.passenger) : null;
    return { id, bought: v.bought, area: v.area, x: v.x, y: v.y, a: +v.a.toFixed(3), ice: v.ice, u: v.usable, mt: meltAt(v), d: d ? d.id : null, r: r ? r.id : null, dn: d ? d.name : null, rn: r ? r.name : null };
  });
}

// Pre ladiacu stránku (/debug → World): kúpené fúriky plochy area z uloženého stavu; vodič a spolujazdec sú kľúče hráčov
// (odpoveď ladiacej stránky ich nahradí odtlačkom, rovnakým ako pri hráčoch)
export function debugView(saved: unknown, area: AreaId, tick: number): VehicleView[] {
  const vs = parseVehicles(saved, true, tick);
  return V.VEHICLE_IDS.filter(id => vs[id].bought && vs[id].area === area).map(id => {
    const v = vs[id];
    return { id, bought: true, area: v.area, x: v.x, y: v.y, a: v.a, ice: v.ice, u: v.usable, mt: meltAt(v), d: v.driver, r: v.passenger };
  });
}

// ---------- Kde kto stojí ----------
type Where = Pick<Presence, 'area' | 'x' | 'y'> | null | undefined;
export function nearVehicle(p: Where, v: Pick<Vehicle, 'area' | 'x' | 'y'>): boolean { return !!p && p.area === v.area && Math.hypot(p.x - v.x, p.y - v.y) <= V.VEHICLE_REACH; }
export function atIcehouse(v: Pick<Vehicle, 'area' | 'x' | 'y'>): boolean {
  const L = D.ICEHOUSE.lot;
  return v.area === 'garden' && Math.hypot(v.x - (L.x0 + L.x1 + 1) / 2, v.y - (L.y0 + L.y1 + 1) / 2) <= V.VEHICLE_ICEHOUSE;
}

// ---------- Vstupy ----------
export interface VehicleInputs {
  vehBuy: { key: PlayerKey; id: VehicleId };
  vehGrab: { key: PlayerKey; id: VehicleId };
  vehDrop: { key: PlayerKey };
  vehLoad: { key: PlayerKey; id: VehicleId; n: number };
  vehUnload: { key: PlayerKey; id: VehicleId; n: number };
  vehIcehouse: { key: PlayerKey; id: VehicleId };
  vehIn: { key: PlayerKey; id: VehicleId };
  vehOut: { key: PlayerKey };
}
type VehicleInput = { [T in keyof VehicleInputs]: { type: T; data: Omit<VehicleInputs[T], 'key'> } }[keyof VehicleInputs];
// Správa klienta { t: 'veh', op, id, n } → vstup enginu (bez kľúča hráča – ten doplní server), alebo null
export function toInput(m: { [field: string]: unknown }): VehicleInput | null {
  const op = m['op'], id = m['id'], n = Math.max(0, Math.min(V.VEHICLE_ICE, Number(m['n']) | 0));
  if (op === 'drop') return { type: 'vehDrop', data: {} };
  if (op === 'out') return { type: 'vehOut', data: {} };
  if (!V.isVehicleId(id)) return null;
  switch (op) {
    case 'buy': return { type: 'vehBuy', data: { id } };
    case 'grab': return { type: 'vehGrab', data: { id } };
    case 'load': return { type: 'vehLoad', data: { id, n } };
    case 'unload': return { type: 'vehUnload', data: { id, n } };
    case 'icehouse': return { type: 'vehIcehouse', data: { id } };
    case 'in': return { type: 'vehIn', data: { id } };
  }
  return null;
}

const saveOf = (s: GameSlices, key: PlayerKey, ctx: GameCtx): PlayerSave => sl(s, `save:${key}`) || ctx.reject(null);
const all = (s: GameSlices, ctx: GameCtx): Vehicles => s.vehicles || ctx.reject(null);
// Kúpený fúrik (inak odmietnutie)
function bought(s: GameSlices, id: VehicleId, ctx: GameCtx): Vehicle {
  const v = all(s, ctx)[id];
  if (!v.bought) ctx.reject(`${VEHICLES[id].name} ešte v Dielni nie ${id === 'sane' ? 'sú' : 'je'}. Kúpiš ${id === 'sane' ? 'ich' : 'ho'} v Dielni za ${String(VEHICLES[id].price)} 🪙.`);
  return v;
}
const closer = (id: VehicleId): string => `Podíď bližšie k ${id === 'sane' ? 'saniam' : 'fúriku'}.`;
// Spolujazdec sa vezie: jeho poloha je poloha fúrika; klient ju dostane správou pos (server podľa nej posunie aj prítomnosť)
function carry(s: GameSlices, v: Vehicle, ctx: GameCtx): void {
  if (!v.passenger) return;
  const pos = sl(s, `pos:${v.passenger}`);
  if (!pos) return;
  pos.x = v.x; pos.y = v.y; pos.lastTick = ctx.tick;
  ctx.emit({ to: v.passenger, t: 'pos', x: v.x, y: v.y });
}

export const PROPOSERS: { [T in keyof VehicleInputs]: GameProposer<VehicleInputs[T]> } = {
  // kúpa v Dielni (spoločná ako krosná): 400 🪙, reputácia 2; nový stojí pred Dielňou
  vehBuy: {
    keys: d => ({ writes: ['vehicles', `save:${d.key}`], reads: ['dielna'] }),
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx), v = all(s, ctx)[d.id], X = VEHICLES[d.id];
      if (!s.dielna.built) ctx.reject('Najprv treba postaviť Dielňu. Kúpiš ju na trhu (záložka Vylepšiť). 🪚');
      if (!Dielna.nearDielna(me)) ctx.reject('Podíď bližšie k Dielni.');
      if (v.bought) ctx.reject(`${X.name} už v Dielni ${d.id === 'sane' ? 'sú' : 'je'}.`);
      if (D.repLevel(sv.rep || 0) < X.rep) ctx.reject(`Potrebuješ reputáciu úrovne ${String(X.rep)}.`);
      if (sv.coins < X.price) ctx.reject('Nemáš dosť mincí. 🪙');
      sv.coins -= X.price;
      Object.assign(v, V.newVehicle(d.id), { bought: true, usable: V.inSeason(d.id, season(ctx.tick)) });
      ctx.emit(toast$(E.ALL, d.id === 'sane'
        ? `🛷 ${nameOf(ctx, d.key)} kúpil(a) do Dielne sane! Stoja pred Dielňou – v zime na nich odvezieš naraz ${V.iceText(V.VEHICLE_ICE)} z hôr do ľadovne.`
        : `🛞 ${nameOf(ctx, d.key)} kúpil(a) do Dielne fúrik! Stojí pred Dielňou – odvezieš v ňom naraz ${V.iceText(V.VEHICLE_ICE)} z hôr do ľadovne.`, 'gift', d.id));
    }
  },
  // chytiť: fúrik (alebo sane) drží naraz len jeden hráč; mimo obdobia sa nedá
  vehGrab: {
    keys: () => ({ writes: ['vehicles'] }),
    run(s, d, ctx) {
      const me = who(ctx), vs = all(s, ctx), v = bought(s, d.id, ctx), X = VEHICLES[d.id];
      if (v.driver === d.key) ctx.reject(d.id === 'sane' ? 'Sane už ťaháš. 🛷' : 'Fúrik už tlačíš. 🛞');
      if (v.driver) ctx.reject(d.id === 'sane' ? 'Sane práve ťahá niekto iný.' : 'Fúrik práve tlačí niekto iný.');
      if (V.ridden(vs, d.key)) ctx.reject('Najprv vystúp. Kým sa vezieš, nič neťaháš.');
      const other = V.drivenBy(vs, d.key);
      if (other) ctx.reject(`Najprv pusti ${VEHICLES[other].acc}. Naraz udržíš len jedno.`);
      if (!nearVehicle(me, v)) ctx.reject(closer(d.id));
      if (!v.usable) ctx.reject(V.seasonText(d.id, season(ctx.tick)) || (d.id === 'sane' ? 'Sane sa teraz používať nedajú.' : 'Fúrik sa teraz používať nedá.'));
      v.driver = d.key;
      v.a = V.round3(V.grabAngle(d.id, v, me));
      ctx.emit(toast$(d.key, X.push
        ? `🛞 Chytil(a) si fúrik. Tlač ho pred sebou – ľad doňho naložíš ťuknutím naň. Pustíš ho v lište dole (ťukni na fúrik).`
        : `🛷 Chytil(a) si sane. Ťaháš ich za sebou – ľad na ne naložíš ťuknutím na ne. Pustíš ich v lište dole (ťukni na sane).`, 'info', d.id));
    }
  },
  // pustiť: fúrik ostane stáť, kde je (aj so spolujazdcom)
  vehDrop: {
    keys: () => ({ writes: ['vehicles'] }),
    run(s, d, ctx) {
      const vs = all(s, ctx), id = V.drivenBy(vs, d.key);
      if (!id) { ctx.reject(null); return; }
      vs[id].driver = null;
      ctx.emit(toast$(d.key, id === 'sane' ? 'Pustil(a) si sane. Ostanú tu stáť, kým ich niekto nechytí. 🛷' : 'Pustil(a) si fúrik. Ostane tu stáť, kým ho niekto nechytí. 🛞', 'info', id));
      if (vs[id].passenger) ctx.emit(toast$(vs[id].passenger, `${nameOf(ctx, d.key)} pustil(a) ${VEHICLES[id].acc}. Sedíš ďalej, kým nevystúpiš.`, 'info', id));
    }
  },
  // naložiť ľad z batohu (len ľad, najviac 6 kusov)
  vehLoad: {
    keys: d => ({ writes: ['vehicles', `save:${d.key}`] }),
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx), v = bought(s, d.id, ctx);
      if (!nearVehicle(me, v)) ctx.reject(closer(d.id));
      const have = sv.inv.ice || 0;
      if (!have) ctx.reject(`Nemáš ľad. ${cap(VEHICLES[d.id].loc)} sa vozí len ľad – vysekáš ho krompáčom na ľadovci v horách. ⛏️`);
      const k = Math.min(d.n > 0 ? d.n : have, have, V.VEHICLE_ICE - v.ice);
      if (k <= 0) ctx.reject(`${cap(VEHICLES[d.id].loc)} je už ${V.iceText(V.VEHICLE_ICE)} – viac sa nezmestí. 🧊`);
      const c = container(v);
      I.addItems(c, 'ice', k, ctx.tick, I.removeItems(I.playerC(sv), 'ice', k, ctx.tick)); // ľad si nesie svoj vek
      c.done();
      ctx.emit(toast$(d.key, `🧊 Naložil(a) si ${V.iceText(k)}. ${cap(VEHICLES[d.id].loc)} je ${String(v.ice)}/${String(V.VEHICLE_ICE)}.`, 'info', d.id));
    }
  },
  // vyložiť ľad do batohu (najviac toľko, koľko unesieš)
  vehUnload: {
    keys: d => ({ writes: ['vehicles', `save:${d.key}`] }),
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx), v = bought(s, d.id, ctx);
      if (!nearVehicle(me, v)) ctx.reject(closer(d.id));
      if (!v.ice) ctx.reject(`${cap(VEHICLES[d.id].loc)} nie je žiadny ľad.`);
      const room = D.ICE_CARRY - (sv.inv.ice || 0);
      if (room <= 0) ctx.reject(`Viac ľadu neunesieš (najviac ${String(D.ICE_CARRY)}).`);
      const k = Math.min(d.n > 0 ? d.n : v.ice, v.ice, room);
      const c = container(v);
      I.addItems(I.playerC(sv), 'ice', k, ctx.tick, I.removeItems(c, 'ice', k, ctx.tick)); // najstarší ľad, aj s vekom
      c.done();
      ctx.emit(toast$(d.key, `🧊 Vzal(a) si si ${V.iceText(k)}. ${cap(VEHICLES[d.id].loc)} ostáva ${String(v.ice)}/${String(V.VEHICLE_ICE)}.`, 'info', d.id));
    }
  },
  // vyložiť celý náklad do ľadovne (fúrik musí stáť pri nej)
  vehIcehouse: {
    keys: () => ({ writes: ['vehicles', 'icehouse', 'storage'] }),
    run(s, d, ctx) {
      const me = who(ctx), v = bought(s, d.id, ctx);
      if (!s.icehouse.built) ctx.reject('Ľadovňa ešte nie je postavená. Kúpiš ju na trhu (záložka Vylepšiť). 🧊');
      if (!nearVehicle(me, v)) ctx.reject(closer(d.id));
      if (!atIcehouse(v)) ctx.reject(d.id === 'sane' ? 'Dotiahni sane bližšie k ľadovni. 🧊' : 'Dotlač fúrik bližšie k ľadovni. 🧊');
      if (!v.ice) ctx.reject(`${cap(VEHICLES[d.id].loc)} nie je žiadny ľad.`);
      const k = Ice.fillIcehouse(s.icehouse, s.storage, ctx.tick, v.ice);
      if (!k) ctx.reject('Ľadovňa je plná. 🧊');
      const c = container(v);
      I.removeItems(c, 'ice', k, ctx.tick); // najstarší ľad ide do ľadovne prvý
      c.done();
      ctx.emit(toast$(d.key, `🧊 Vyložil(a) si do ľadovne ${V.iceText(k)}. V ľadovni je ${String(Math.ceil(s.icehouse.ice))}/${String(D.ICEHOUSE.cap)}.`, 'info', d.id));
      const L = D.ICEHOUSE.lot;
      ctx.emit({ to: E.area('garden'), t: 'fx', k: 'ice', x: L.x0 + 1, y: L.y0 + 1 });
    }
  },
  // naskočiť: len keď fúrik niekto tlačí (sane ťahá) a nikto v ňom nesedí
  vehIn: {
    keys: d => ({ writes: ['vehicles', `pos:${d.key}`] }),
    run(s, d, ctx) {
      const me = who(ctx), vs = all(s, ctx), v = bought(s, d.id, ctx), X = VEHICLES[d.id];
      if (v.passenger === d.key) ctx.reject('Už sa vezieš.');
      if (V.drivenBy(vs, d.key)) ctx.reject(`Najprv pusti ${VEHICLES[V.drivenBy(vs, d.key) ?? d.id].acc}. Sám sa neodvezieš.`);
      if (V.ridden(vs, d.key)) ctx.reject('Už sa vezieš.');
      if (v.passenger) ctx.reject(`${cap(X.loc)} už niekto sedí. Zmestí sa len jeden.`);
      if (!v.driver) ctx.reject(d.id === 'sane' ? 'Naskočiť sa dá, len keď sane niekto ťahá.' : 'Naskočiť sa dá, len keď fúrik niekto tlačí.');
      if (!nearVehicle(me, v)) ctx.reject(closer(d.id));
      v.passenger = d.key;
      carry(s, v, ctx);
      const driver = ctx.presence?.find(p => p.key === v.driver);
      ctx.emit(toast$(d.key, `${X.icon} Naskočil(a) si ${d.id === 'sane' ? 'na sane' : 'do fúrika'}${driver ? ` – vezie ťa ${driver.name}` : ''}. Vystúpiš v lište dole (ťukni na obrázok).`, 'info', d.id));
      if (v.driver) ctx.emit(toast$(v.driver, `${nameOf(ctx, d.key)} ti naskočil(a) ${d.id === 'sane' ? 'na sane' : 'do fúrika'}! ${X.icon}`, 'info', d.id));
    }
  },
  // vystúpiť: spolujazdec stojí tam, kde fúrik
  vehOut: {
    keys: () => ({ writes: ['vehicles'] }),
    run(s, d, ctx) {
      const vs = all(s, ctx), id = V.ridden(vs, d.key);
      if (!id) { ctx.reject(null); return; }
      vs[id].passenger = null;
      ctx.emit(toast$(d.key, `Vystúpil(a) si ${id === 'sane' ? 'zo saní' : 'z fúrika'}.`, 'info', id));
    }
  }
};

// ---------- Pohyb (návrh pos v actions.ts) ----------
// Hráč, ktorý fúrik drží, ho posúva; kľúče: fúrik, spolujazdcova poloha a políčko, kam sa fúrik posunie.
// Spolujazdec sám chodiť nesmie (len prečíta fúriky, aby pohyb odmietol). Ostatní hráči nič navyše nedeklarujú.
export function posKeys(d: { key: PlayerKey; x: number; y: number }, w: Pick<GameWorld, 'vehicles' | 'saves'>): E.Keys {
  const vs = vehiclesOf(w);
  if (V.ridden(vs, d.key)) return { reads: ['vehicles'] };
  const id = V.drivenBy(vs, d.key), v = id ? vs[id] : undefined, sv = savesOf(w)[d.key];
  if (!id || !v || !sv || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return {};
  const area = sv.area && D.AREAS.includes(sv.area) ? sv.area : 'garden', to = Areas.clampPos(area, d.x, d.y);
  const p = V.follow(id, v, sv, to), i = V.tileIndex(area, p.x, p.y), under = V.tileIndex(area, v.x, v.y);
  return { writes: ['vehicles'].concat(v.passenger ? [`pos:${v.passenger}`] : []), reads: [i, under].filter(n => n >= 0).map(n => `tile:${area}:${n}`) };
}
// Volá sa v návrhu pos po overení novej polohy hráča p (pred prechodom do inej plochy); from = doterajšia poloha.
// Spolujazdec: pohyb sa odmietne (vezie sa). Kto drží fúrik: na prechod do Lesa na pomedzí s ním nesmie (odmietnutie
// s vysvetlením), cez prechod medzi záhradou a horami ide fúrik aj so spolujazdcom s ním; inak sa fúrik posunie za
// hráčom – a keď by tam neprešiel (strom, budova, okraj plochy, priveľký schod na ľadovci), hráč sa nepohne.
export function onPos(s: GameSlices, d: { key: PlayerKey }, ctx: GameCtx, from: { area: AreaId; x: number; y: number }, p: { x: number; y: number }): void {
  const vs = s.vehicles;
  if (!vs) return; // návrh fúriky nedeklaroval – hráč žiadny nedrží
  if (V.ridden(vs, d.key)) ctx.reject(null);
  const id = V.drivenBy(vs, d.key);
  if (!id) return;
  const v = vs[id], area = from.area, X = VEHICLES[id];
  const tx = Math.floor(p.x), ty = Math.floor(p.y), { w } = D.areaSize(area), here = sl(s, `tile:${area}:${ty * w + tx}`);
  const gate = here && here.g === 'gate' ? D.gateAt(area, tx, ty) : null;
  if (gate) {
    const a = D.arrival(area, gate.to);
    if (!V.VEHICLE_AREAS.includes(gate.to)) ctx.reject(`${id === 'sane' ? 'Sane' : 'Fúrik'} do ${gate.to === 'les' ? 'Lesa divov' : 'Lesa na pomedzí'} ${id === 'sane' ? 'neprejdú' : 'neprejde'} – cesta je úzka a samý koreň. Najprv ${id === 'sane' ? 'ich' : 'ho'} pusti. ${X.icon}`);
    if (!a) return;
    v.area = gate.to; v.x = a.x; v.y = a.y;
    if (v.passenger) {
      const pp = sl(s, `pos:${v.passenger}`);
      if (pp) { pp.area = gate.to; pp.x = a.x; pp.y = a.y; pp.lastTick = ctx.tick; ctx.emit({ to: v.passenger, t: 'travel', from: area, area: gate.to }); }
    }
    return;
  }
  const n = V.follow(id, v, from, p);
  if (Math.hypot(n.x - v.x, n.y - v.y) < 1e-6 && n.a === v.a) return; // sane na voľnom lane stoja
  const i = V.tileIndex(area, n.x, n.y), to = i >= 0 ? sl(s, `tile:${area}:${i}`) : undefined;
  const fromTile = sl(s, `tile:${area}:${V.tileIndex(area, v.x, v.y)}`);
  const pos = Areas.clampPos(area, n.x, n.y);
  if (!to || pos.x !== n.x || pos.y !== n.y || !D.canStep(fromTile ?? to, to)) ctx.reject(null);
  v.x = V.round3(n.x); v.y = V.round3(n.y); v.a = V.round3(n.a);
  carry(s, v, ctx);
}
// Odchod hráča: kto fúrik držal, pustí ho (ostane stáť); kto v ňom sedel, vystúpi
export function leaveKeys(d: { key: PlayerKey }, w: Pick<GameWorld, 'vehicles'>): E.Keys {
  const vs = vehiclesOf(w);
  return V.drivenBy(vs, d.key) || V.ridden(vs, d.key) ? { writes: ['vehicles'] } : {};
}
export function onLeave(s: GameSlices, d: { key: PlayerKey }): void {
  const vs = s.vehicles;
  if (!vs) return;
  for (const id of V.VEHICLE_IDS) {
    if (vs[id].driver === d.key) vs[id].driver = null;
    if (vs[id].passenger === d.key) vs[id].passenger = null;
  }
}

// ---------- Cheaty z ladiacej stránky (#153) ----------
// kúpiť / odstrániť (nekúpený, späť pred Dielňou), premiestniť (aj do hôr), nastaviť náklad, pustiť (vodič aj spolujazdec)
export type VehicleCheat =
  | { act: 'buy' | 'remove' | 'release' | 'usable'; id: VehicleId }
  | { act: 'tp'; id: VehicleId; area: AreaId; x: number; y: number }
  | { act: 'ice'; id: VehicleId; n: number; set: boolean };
// Telo požiadavky → cheat, alebo text chyby
export function parseCheat(b: { [field: string]: unknown }): VehicleCheat | string {
  const id = b['id'], act = b['act'];
  if (!V.isVehicleId(id)) return 'unknown vehicle';
  if (act === 'buy' || act === 'remove' || act === 'release' || act === 'usable') return { act, id };
  if (act === 'tp') {
    const area = b['area'], x = Number(b['x']), y = Number(b['y']);
    const a = V.VEHICLE_AREAS.find(k => k === area);
    if (!a) return 'vehicles go only to the garden and the mountains';
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Areas.inside(a, Math.floor(x), Math.floor(y))) return 'position outside the area';
    return { act, id, area: a, x, y };
  }
  if (act === 'ice') {
    const n = Number(b['n']);
    if (!Number.isFinite(n)) return 'bad n';
    return { act, id, n, set: b['set'] === true };
  }
  return 'unknown vehicle action';
}
export const cheatKeys = (): E.Keys => ({ writes: ['vehicles'] });
export function cheatRun(s: GameSlices, d: VehicleCheat, ctx: GameCtx): void {
  const vs = s.vehicles || ctx.reject('no vehicles'), v = vs[d.id];
  switch (d.act) {
    case 'buy': if (v.bought) ctx.reject('already bought'); Object.assign(v, V.newVehicle(d.id), { bought: true, usable: V.inSeason(d.id, season(ctx.tick)) }); return;
    case 'usable': v.usable = !v.usable; if (!v.usable) { v.driver = null; v.passenger = null; } return; // prepnúť (ďalšia vehSeason ho nastaví podľa obdobia)
    case 'remove': if (!v.bought) ctx.reject('not bought'); Object.assign(v, V.newVehicle(d.id)); return;
    case 'release': v.driver = null; v.passenger = null; return;
    case 'tp': {
      if (!v.bought) ctx.reject('not bought');
      const p = Areas.clampPos(d.area, d.x, d.y);
      Object.assign(v, { area: d.area, x: V.round3(p.x), y: V.round3(p.y), driver: null, passenger: null });
      return;
    }
    case 'ice': {
      if (!v.bought) ctx.reject('not bought');
      const want = Math.max(0, Math.min(V.VEHICLE_ICE, Math.round(d.set ? d.n : v.ice + d.n))), c = container(v);
      if (want > v.ice) I.addItems(c, 'ice', want - v.ice, ctx.tick); else if (want < v.ice) I.removeItems(c, 'ice', v.ice - want, ctx.tick);
      c.done();
      return;
    }
  }
}

// ---------- Udalosti: obdobie a topenie ----------
export interface VehicleEvents { vehSeason: Record<string, never> }
// Na začiatku obdobia: fúrik / sane sa dajú (alebo prestanú dať) používať. Kto drží vozidlo, ktoré sa práve prestalo
// dať používať, ho pustí; spolujazdec vystúpi – obaja dostanú hlásenie.
export const EVENTS: { [T in keyof VehicleEvents]: GameProposer<VehicleEvents[T]> } = {
  vehSeason: {
    keys: () => ({ writes: ['vehicles'] }),
    run(s, d, ctx) {
      const vs = s.vehicles;
      if (!vs) return;
      const se = season(ctx.tick);
      for (const id of V.VEHICLE_IDS) {
        const v = vs[id], want = V.inSeason(id, se);
        if (v.usable === want) continue;
        v.usable = want;
        if (want || !v.bought) continue;
        const text = `${V.seasonText(id, se)} ${id === 'sane' ? 'Sane ostali stáť' : 'Fúrik ostal stáť'}, kde ${id === 'sane' ? 'boli' : 'bol'}.`;
        for (const who of [v.driver, v.passenger]) if (who) ctx.emit(toast$(who, text, 'day', id));
        v.driver = null; v.passenger = null;
      }
    }
  }
};
// Začiatok každého obdobia (polnoc prvého dňa obdobia)
export const PERIODIC: GamePeriodic[] = [{ key: 'vehSeason', type: 'vehSeason', next: E.every(D.DAYS_PER_SEASON * D.TICKS_PER_DAY) }];
// Každú hernú hodinu (udalosť hourly v events.ts): ľad vo fúriku a v saniach sa topí ako v batohu
export function meltHourly(s: GameSlices, ctx: GameCtx): void {
  const vs = s.vehicles;
  if (!vs) return;
  for (const id of V.VEHICLE_IDS) {
    const v = vs[id];
    if (!v.fb.length) continue;
    const c = container(v), k = I.meltSweep(c, ctx.tick);
    c.done();
    if (!k) continue;
    for (const who of [v.driver, v.passenger]) if (who) ctx.emit(toast$(who, `💧 ${cap(VEHICLES[id].loc)} sa roztopil ľad (${String(k)}×). Odvez ho rýchlo do ľadovne.`, 'info', id));
  }
}
