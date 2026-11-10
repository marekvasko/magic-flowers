// Fúrik a sane v hre (#158): stav zo servera (správa vehicles), plynulé polohy na kreslenie, predpoveď fúrika, ktorý
// hráč práve tlačí (rovnaký výpočet ako server – shared/vehicles.ts follow), spolujazdec (sedí, nechodí), okno
// fúrika (chytiť, pustiť, ľad, ľadovňa, naskočiť, vystúpiť), riadky v okne Dielne a miesto v lište.
// game.ts volá: onList (správa), update (každú snímku), blocks / moved (pohyb), ctxAt (ťuknutie), open, dielnaRows,
// hotbarSlot, resync (server pohyb odmietol) a icon.
import * as D from '../shared/data.ts';
import type { ClientMessage, VehicleView } from '../shared/protocol.ts';
import type { VehicleId } from '../shared/save.ts';
import * as V from '../shared/vehicles.ts';
import type { ClientState, CtxAction } from './state.ts';
import type * as VehicleArt from './vehicleart.ts';

export interface VehiclesDeps {
  S: ClientState;
  send: (m: ClientMessage) => void;
  toast: (text: string) => void;
  openModal: (title: string, render: (body: HTMLElement) => void) => void;
  changed: () => void;          // stav fúrikov sa zmenil (lišta, otvorené okno)
}
export interface ClientVehicles {
  onList: (list: VehicleView[]) => void;
  update: (dt: number) => void;
  blocks: (x: number, y: number) => boolean;
  moved: (fromX: number, fromY: number) => void;
  resync: () => void;
  riding: () => boolean;
  driving: () => VehicleId | null;
  ctxAt: (tx: number, ty: number) => CtxAction | null;
  open: (id?: VehicleId) => void;
  dielnaRows: (body: HTMLElement) => void;
  hotbarSlot: () => HTMLElement | null;
  icon: (id: VehicleId, ice?: number) => string;
}

type Kid = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: { [k: string]: string } | null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  for (const k of kids) if (k) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}
function button(label: string, onclick: () => void, disabled?: boolean): HTMLButtonElement {
  const b = el('button', { class: 'btn' }, label);
  b.onclick = onclick; b.disabled = !!disabled;
  return b;
}
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function createVehicles(dp: VehiclesDeps): ClientVehicles {
  const { S } = dp;
  const srv = new Map<VehicleId, VehicleView>();          // posledný stav zo servera
  const shown = new Map<VehicleId, VehicleView>();        // čo sa kreslí (plynulo dobieha srv; vlastný fúrik predpovedá)
  let pred: (V.Pose & { area: D.AreaId; id: VehicleId }) | null = null; // fúrik, ktorý práve tlačím (predpoveď)
  let target: VehicleId | null = null, gateToastAt = 0;
  // obrázky z 3D modelu – modul s modelmi sa načíta až pri prvej potrebe (dovtedy emoji)
  let art: typeof VehicleArt | null = null, artLoading = false;
  function icon(id: VehicleId, ice = 0): string {
    if (art) return art.vehicleIcon(id, ice);
    if (!artLoading) { artLoading = true; import('./vehicleart.ts').then(m => { art = m; dp.changed(); }).catch((e: unknown) => { console.error(e); }); }
    return '';
  }
  const img = (id: VehicleId, ice: number, px: number): HTMLElement => {
    const url = icon(id, ice);
    return url ? el('img', { src: url, style: `width:${px}px;height:${px}px;flex:none`, alt: '' }) : el('div', { style: `font-size:${Math.round(px * 0.6)}px;width:${px}px;text-align:center;flex:none` }, V.VEHICLES[id].icon);
  };

  const mine = (v: VehicleView): boolean => v.d === S.id;
  const driving = (): VehicleId | null => { for (const v of srv.values()) if (v.bought && mine(v)) return v.id; return null; };
  const ridingIn = (): VehicleId | null => { for (const v of srv.values()) if (v.bought && v.r === S.id) return v.id; return null; };

  let sig = '';
  function onList(list: VehicleView[]): void {
    icon('furik'); // obrázky nech sú pripravené (hlásenie o kúpe, okno Dielne)
    for (const v of list) {
      srv.set(v.id, v);
      const s = shown.get(v.id);
      // nové, iná plocha alebo veľký skok (cheat, prechod): hneď; inak sa poloha plynulo dobehne v update
      if (!s || s.area !== v.area || Math.hypot(s.x - v.x, s.y - v.y) > 3) shown.set(v.id, { ...v });
      else Object.assign(s, { ...v, x: s.x, y: s.y, a: s.a });
    }
    const id = driving();
    if (id) {
      const v = srv.get(id);
      if (v && (!pred || pred.id !== id || pred.area !== v.area)) pred = { id, area: v.area, x: v.x, y: v.y, a: v.a };
    } else pred = null;
    S.vehicles = [...shown.values()];
    // lišta a otvorené okno sa prekreslia, len keď sa zmenilo niečo okrem polohy (pri jazde prichádza správa 10× za sekundu)
    const now = list.map(v => [v.id, v.bought, v.area, v.ice, v.d, v.r, v.dn, v.rn].join(',')).join('|');
    if (now !== sig) { sig = now; dp.changed(); }
  }
  function resync(): void {
    const id = driving(), v = id ? srv.get(id) : undefined;
    if (id && v) pred = { id, area: v.area, x: v.x, y: v.y, a: v.a };
  }

  // Každú snímku: polohy sa plynulo dobiehajú; vlastný fúrik je tam, kde ho predpoveď; spolujazdec sedí vo fúriku
  function update(dt: number): void {
    const k = Math.min(1, dt * 12);
    for (const [id, s] of shown) {
      const v = srv.get(id);
      if (!v) continue;
      if (pred && pred.id === id && pred.area === s.area) { s.x = pred.x; s.y = pred.y; s.a = pred.a; continue; }
      s.x += (v.x - s.x) * k; s.y += (v.y - s.y) * k;
      let da = v.a - s.a; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
      s.a += da * k;
    }
    for (const s of shown.values()) {
      if (s.r == null || !s.bought || s.area !== S.area) continue;
      if (s.r === S.id) { S.me.x = s.x; S.me.y = s.y; S.me.a = s.a; S.me.moving = false; S.path = null; S.pendingAct = null; }
      else { const o = typeof s.r === 'number' ? S.others.get(s.r) : undefined; if (o) { o.x = s.x; o.y = s.y; o.a = s.a; } }
    }
  }

  // Pohyb hráča, ktorý drží fúrik: prejde fúrik tam, kam by ho hráč posunul? (rovnako ako server; inak sa hráč nepohne)
  function poseFor(x: number, y: number): V.Pose | null {
    if (!pred || pred.area !== S.area) return null;
    return V.follow(pred.id, pred, S.me, { x, y });
  }
  function blocks(x: number, y: number): boolean {
    if (!pred || pred.area !== S.area) return false;
    const tx = Math.floor(x), ty = Math.floor(y), here = S.tiles[ty * S.W + tx];
    const g = here && here.g === 'gate' ? D.gateAt(S.area, tx, ty) : null;
    if (g) {
      if (V.VEHICLE_AREAS.includes(g.to)) return false;
      const now = performance.now();
      if (now - gateToastAt > 3000) { gateToastAt = now; dp.toast(`${V.VEHICLES[pred.id].name} sem ${pred.id === 'sane' ? 'neprejdú' : 'neprejde'} – cesta do lesa je úzka a samý koreň. Najprv ${pred.id === 'sane' ? 'ich' : 'ho'} pusti. ${V.VEHICLES[pred.id].icon}`); }
      return true;
    }
    const p = poseFor(x, y);
    if (!p) return false;
    if (Math.hypot(p.x - pred.x, p.y - pred.y) < 1e-6) return false; // sane na voľnom lane
    const i = V.tileIndex(S.area, p.x, p.y);
    if (i < 0 || p.x < 0.2 || p.y < 0.2 || p.x > S.W - 0.2 || p.y > S.H - 0.2) return true;
    const from = S.tiles[V.tileIndex(S.area, pred.x, pred.y)], to = S.tiles[i];
    return !D.canStep(from ?? to, to);
  }
  function moved(fromX: number, fromY: number): void {
    if (!pred || pred.area !== S.area) return;
    const p = V.follow(pred.id, pred, { x: fromX, y: fromY }, S.me);
    pred.x = p.x; pred.y = p.y; pred.a = p.a;
  }

  // Ťuknutie na políčko s fúrikom (aj E na políčko pred sebou) – otvorí jeho okno
  // (políčko pod stredom fúrika, alebo políčko, ktorého stred je od stredu fúrika najviac 0,75 – model je dlhší než políčko)
  function ctxAt(tx: number, ty: number): CtxAction | null {
    let best: VehicleView | null = null, bd = Infinity;
    for (const s of shown.values()) {
      if (!s.bought || s.area !== S.area) continue;
      const d = Math.floor(s.x) === tx && Math.floor(s.y) === ty ? 0 : Math.hypot(s.x - (tx + 0.5), s.y - (ty + 0.5));
      if (d <= 0.75 && d < bd) { best = s; bd = d; }
    }
    if (!best) return null;
    target = best.id;
    return { i: V.VEHICLES[best.id].icon, l: V.VEHICLES[best.id].name, ui: 'vehicle' };
  }

  function near(v: VehicleView): boolean { return v.area === S.area && Math.hypot(S.me.x - v.x, S.me.y - v.y) <= V.VEHICLE_REACH + 0.3; }
  function atIcehouse(v: VehicleView): boolean {
    const L = D.ICEHOUSE.lot;
    return v.area === 'garden' && Math.hypot(v.x - (L.x0 + L.x1 + 1) / 2, v.y - (L.y0 + L.y1 + 1) / 2) <= V.VEHICLE_ICEHOUSE;
  }
  const send = (op: ClientMessage & { t: 'veh' }): void => { dp.send(op); };

  // Okno fúrika či saní
  function render(id: VehicleId, body: HTMLElement): void {
    const v = srv.get(id), X = V.VEHICLES[id], it = id === 'sane' ? 'ich' : 'ho';
    if (!v || !v.bought) { body.appendChild(el('p', null, `${X.name} ešte v Dielni nie ${id === 'sane' ? 'sú' : 'je'}.`)); return; }
    const myIce = S.inv.ice || 0, iDrive = mine(v), iRide = v.r === S.id, other = driving() ?? ridingIn();
    const who = v.d == null ? (id === 'sane' ? 'Nikto ich neťahá.' : 'Nikto ho netlačí.')
      : iDrive ? (id === 'sane' ? 'Ťaháš ich ty.' : 'Tlačíš ho ty.') : `${id === 'sane' ? 'Ťahá ich' : 'Tlačí ho'} ${v.dn ?? 'iný hráč'}.`;
    const pass = v.r == null ? '' : iRide ? ' Sedíš v ' + (id === 'sane' ? 'nich.' : 'ňom.') : ` Sedí v ${id === 'sane' ? 'nich' : 'ňom'} ${v.rn ?? 'iný hráč'}.`;
    body.appendChild(el('div', { class: 'row' }, img(id, v.ice, 64),
      el('div', { class: 'info' }, el('b', null, `🧊 Ľad: ${String(v.ice)}/${String(V.VEHICLE_ICE)}`),
        el('div', { style: 'height:8px;background:#eee;border-radius:4px;overflow:hidden;margin:3px 0' }, el('div', { style: `height:100%;width:${String(v.ice / V.VEHICLE_ICE * 100)}%;background:#6ec6ff` })),
        el('small', null, who + pass))));
    const why = V.seasonText(id, D.seasonOf(S.day));
    const btns: HTMLElement[] = [];
    if (iDrive) btns.push(button('Pustiť', () => { send({ t: 'veh', op: 'drop' }); }));
    else if (v.d == null && !iRide) btns.push(button(id === 'sane' ? 'Chytiť lano' : 'Chytiť', () => { send({ t: 'veh', op: 'grab', id }); }, !!why || !!other || !near(v)));
    if (iRide) btns.push(button('Vystúpiť', () => { send({ t: 'veh', op: 'out' }); }));
    else if (v.d != null && !iDrive && v.r == null) btns.push(button('Naskočiť', () => { send({ t: 'veh', op: 'in', id }); }, !!other || !near(v)));
    body.appendChild(el('div', { class: 'row' }, el('div', { class: 'info' }, el('b', null, iDrive ? (id === 'sane' ? 'Ťaháš sane' : 'Tlačíš fúrik') : X.name),
      el('small', null, why || (iDrive ? (id === 'sane' ? 'Ťaháš ich za sebou na lane. Keď ' + it + ' pustíš, ostanú stáť, kde sú.' : 'Tlačíš ho pred sebou. Keď ho pustíš, ostane stáť, kde je.')
        : !near(v) ? `Podíď bližšie k ${id === 'sane' ? 'saniam' : 'fúriku'}.` : v.d != null ? 'Keď ' + (id === 'sane' ? 'ich' : 'ho') + ' niekto ' + (id === 'sane' ? 'ťahá' : 'tlačí') + ', môžeš si doň naskočiť a viezť sa.' : X.desc))),
      el('div', { class: 'btns' }, ...btns)));
    // ľad: naložiť z batohu, vyložiť do batohu, do ľadovne
    const load = button(myIce ? `Naložiť (${String(Math.min(myIce, V.VEHICLE_ICE - v.ice))})` : 'Nemáš ľad', () => { send({ t: 'veh', op: 'load', id, n: 0 }); }, !myIce || v.ice >= V.VEHICLE_ICE || !near(v));
    const take = button('Do batohu', () => { send({ t: 'veh', op: 'unload', id, n: 0 }); }, !v.ice || myIce >= D.ICE_CARRY || !near(v));
    const ih = button('Do ľadovne', () => { send({ t: 'veh', op: 'icehouse', id }); }, !v.ice || !atIcehouse(v) || !S.icehouse.built || !near(v));
    body.appendChild(el('div', { class: 'row', style: 'flex-wrap:wrap' }, img(id, 6, 40), el('div', { class: 'info' }, el('b', null, 'Ľad'),
      el('small', null, `${cap(X.loc)} sa vozí len ľad – najviac ${V.iceText(V.VEHICLE_ICE)} a nespomalí ťa. ` + (atIcehouse(v) ? `${id === 'sane' ? 'Stoja' : 'Stojí'} pri ľadovni – vylož ľad rovno dnu.` : `Do ľadovne ${it} vyložíš, keď ${id === 'sane' ? 'budú stáť' : 'bude stáť'} pri nej.`))),
      el('div', { class: 'btns', style: 'flex-basis:100%;justify-content:flex-end;flex-wrap:wrap' }, load, take, ih)));
  }
  function open(id?: VehicleId): void {
    const k = id ?? target ?? driving() ?? ridingIn();
    if (!k) return;
    target = k;
    dp.openModal(`${V.VEHICLES[k].icon} ${V.VEHICLES[k].name}`, body => { render(k, body); });
  }

  // Riadky v okne Dielne: kúpa fúrika a saní (spoločné ako krosná)
  function dielnaRows(body: HTMLElement): void {
    for (const id of V.VEHICLE_IDS) {
      const X = V.VEHICLES[id], v = srv.get(id), lvl = D.repLevel(S.rep);
      const seasons = X.seasons.map(s => D.SEASON_ICONS[s] ?? '').join('');
      let side: HTMLElement;
      if (v && v.bought) side = el('small', { style: 'white-space:nowrap' }, '✔ kúpené');
      else side = button(String(X.price) + '🪙', () => { dp.send({ t: 'veh', op: 'buy', id }); }, S.coins < X.price || lvl < X.rep);
      const where = v && v.bought ? ` Teraz ${id === 'sane' ? 'stoja' : 'stojí'} ${D.AREA_IN[v.area]}${v.ice ? ` a ${id === 'sane' ? 'vezú' : 'vezie'} ${V.iceText(v.ice)}` : ''}.` : '';
      body.appendChild(el('div', { class: 'row' }, img(id, 0, 44),
        el('div', { class: 'info' }, el('b', null, `${X.name} ${seasons}`), el('small', null, X.desc + where + (v && v.bought ? '' : ` Pre celú záhradu.${X.rep ? ` · treba ⭐${String(X.rep)}` : ''}`))),
        el('div', { class: 'btns' }, side)));
    }
  }

  // Miesto v lište, kým fúrik tlačím alebo v ňom sedím: obrázok s nákladom, ťuknutie otvorí okno (pustiť, vystúpiť)
  function hotbarSlot(): HTMLElement | null {
    const id = driving() ?? ridingIn(), v = id ? srv.get(id) : undefined;
    if (!id || !v) return null;
    const d = el('div', { class: 'slot', title: V.VEHICLES[id].name, style: 'border-color:#6ec6ff;background:#e8f6ff' });
    const url = icon(id, v.ice);
    d.appendChild(url ? el('img', { src: url }) : el('span', { style: 'font-size:26px' }, V.VEHICLES[id].icon));
    d.appendChild(el('span', { class: 'n' }, `${String(v.ice)}/${String(V.VEHICLE_ICE)}`));
    d.onclick = () => { open(id); };
    return d;
  }

  return { onList, update, blocks, moved, resync, riding: () => ridingIn() !== null, driving, ctxAt, open, dielnaRows, hotbarSlot, icon };
}
