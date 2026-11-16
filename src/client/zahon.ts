// Záhon v hre (#179): priblížený pohľad (B) – jediný spôsob, ako záhon upravovať. Ťuknutie na záhon kameru priblíži
// nad neho (render3d: S.zoom), ťuknutie na bod urobí to, čo je v ruke: semienko zasadí, pokryv položí (ťahom prsta na
// viac bodov), prázdna ruka zreže rozkvitnutý kvet alebo zoberie pokryv (aj ťahom), motyka vykopá kvet, krhla poleje
// a kompost pohnojí celý záhon. Hore lišta: Späť, názov a stav záhonu, Zrušiť záhon. Klávesy: šípky = bod, E = akcia,
// Esc = späť. Pravidlá bodov sú spoločné so serverom (shared/zahon.ts) – body, na ktoré to nejde, sú sivé.
import * as D from '../shared/data.ts';
import * as Obj from '../shared/objects.ts';
import * as ZR from '../shared/zahon.ts';
import type { ClientMessage, ZahonView } from '../shared/protocol.ts';
import type { ClientState } from './state.ts';
import type { ZoomMark } from './render3d.ts';

export interface ZahonDeps {
  S: ClientState;
  root: HTMLElement;                       // #game – sem príde lišta záhonu
  send: (m: ClientMessage) => void;
  toast: (text: string) => void;
  openModal: (title: string, render: (body: HTMLElement) => void) => void;
  closeModal: () => void;
  pickSpot: (cx: number, cy: number, tx: number, ty: number) => { sx: number; sy: number } | null;
  sfx: (k: 'pop' | 'dig' | 'water') => void;
}
export interface ClientZahon {
  open: (tx: number, ty: number) => void;
  close: () => void;
  active: () => boolean;
  down: (cx: number, cy: number) => void;
  move: (cx: number, cy: number) => void;
  up: (cx: number, cy: number, tap: boolean) => void;
  key: (code: string) => boolean;          // true = kláves použitý (šípky, E, Esc)
  marks: () => readonly ZoomMark[];
  refresh: () => void;                     // nová správa objects / me
}

type Spot = readonly [number, number];
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string | null, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

export function createZahon(dp: ZahonDeps): ClientZahon {
  const { S } = dp;
  let paint: { add: boolean; spots: Spot[] } | null = null, cursor: Spot = [3, 3], hit: Spot | null = null;
  const bar = el('div', 'zbar hidden'), title = el('div', 'ztitle'), hint = el('div', 'zhint hidden');
  const back = el('button', 'btn zback', '← Späť'), del = el('button', 'btn gray zdel', 'Zrušiť záhon');
  bar.append(back, title, del);
  dp.root.append(bar, hint);
  back.onclick = () => { close(); };
  del.onclick = () => {
    const z = cur();
    if (!z) return;
    dp.openModal('Zrušiť záhon?', body => {
      body.append(el('p', null, 'Rozkvitnuté kvety pôjdu do batohu, ostatné kvety zaniknú. Pokryvy sa vrátia do batohu. Záhon zmizne a uvoľní miesto v povolení na pole.'));
      const yes = el('button', 'btn', 'Zrušiť záhon'), no = el('button', 'btn gray', 'Nechať');
      yes.onclick = () => { dp.send({ t: 'zahon', op: 'destroy', id: z.id }); dp.closeModal(); close(); dp.sfx('dig'); };
      no.onclick = () => { dp.closeModal(); };
      body.append(el('div', 'btns', yes, no));
    });
  };

  function cur(): ZahonView | null {
    const zm = S.zoom;
    if (!zm) return null;
    return S.objects.find((o): o is ZahonView => o.kind === 'zahon' && o.id === zm.id) ?? null;
  }
  function open(tx: number, ty: number): void {
    const z = Obj.zahonAt({ list: S.objects }, tx, ty);
    if (!z) return;
    S.zoom = { id: z.id };
    cursor = [3, 3]; hit = null; paint = null;
    bar.classList.remove('hidden'); hint.classList.remove('hidden'); dp.root.classList.add('zooming');
    refresh();
  }
  function close(): void {
    S.zoom = null; paint = null; hit = null;
    bar.classList.add('hidden'); hint.classList.add('hidden'); dp.root.classList.remove('zooming');
  }
  // Text lišty a nápoveda podľa toho, čo je v ruke
  function refresh(): void {
    const z = cur();
    if (!z) { if (S.zoom) close(); return; }
    title.textContent = `${D.ZAHON_NAMES[z.v]} · ${z.w ? '💧 poliaty' : '🏜️ suchý'}${z.r ? ' · 🌱 pohnojený' : ''}`;
    const sel = S.sel;
    hint.textContent = sel.startsWith('seed_') || D.isWild(sel) ? 'Ťukni na zelený bod – tam kvet zasadíš. 🌱'
      : sel.startsWith('cov_') ? 'Ťukni alebo potiahni prstom po bodoch – položíš pokryv. 🪣'
        : sel === 'can' ? 'Ťukni na záhon – jedno poliatie stačí na celý záhon. 💧'
          : sel === 'compost' ? 'Ťukni na záhon – kompost pohnojí celý záhon. 🟤'
            : sel === 'hoe' ? 'Ťukni na kvet – motykou ho vykopeš. ⛏️'
              : 'Prázdnou rukou zrežeš rozkvitnutý kvet alebo zoberieš pokryv (aj ťahom prsta).';
  }
  const near = (z: ZahonView): boolean => S.area === 'garden' && Math.hypot(S.me.x - (z.x + 0.5), S.me.y - (z.y + 0.5)) <= 2.4;
  setInterval(() => { const z = cur(); if (S.zoom && (!z || !near(z))) close(); }, 300); // odišiel ďaleko / záhon zmizol

  // Akcia na jednom bode (ťuknutie, kláves E)
  function act(z: ZahonView, [sx, sy]: Spot): void {
    const sel = S.sel, here = ZR.spotAt(z, sx, sy);
    if (sel === 'can') { dp.send({ t: 'zahon', op: 'water', id: z.id }); dp.sfx('water'); return; }
    if (sel === 'compost') { dp.send({ t: 'zahon', op: 'compost', id: z.id }); dp.sfx('pop'); return; }
    if (sel.startsWith('seed_') || D.isWild(sel)) {
      const sp = sel.startsWith('seed_') ? D.speciesOfItem(sel) : null;
      const why = ZR.plantError(z, sx, sy, sp);
      if (why) { dp.toast(why); return; }
      dp.send({ t: 'zahon', op: 'plant', id: z.id, sx, sy, item: sel }); dp.sfx('pop'); return;
    }
    if (sel.startsWith('cov_')) { const c = sel.slice(4); if (D.isCoverId(c)) { dp.send({ t: 'zahon', op: 'cover', id: z.id, c, spots: [[sx, sy]] }); dp.sfx('pop'); } return; }
    if (sel === 'hoe') {
      if (here?.p) { dp.send({ t: 'zahon', op: 'dig', id: z.id, sx, sy }); dp.sfx('dig'); } else dp.toast('Tu nič nerastie. Celý záhon zrušíš tlačidlom Zrušiť záhon hore.');
      return;
    }
    if (ZR.blooming(here)) {
      const p = here?.p;
      if (p && p.sp === 'papradie' && !D.isNight(D.minOfTick(S.tick))) { dp.toast('Papraď drží púčik pevne zatvorený… vraj sa otvára len v noci. 🌙'); return; }
      dp.send({ t: 'zahon', op: 'pick', id: z.id, sx, sy }); dp.sfx('pop'); return;
    }
    if (here?.c) { dp.send({ t: 'zahon', op: 'uncover', id: z.id, spots: [[sx, sy]] }); dp.sfx('pop'); return; }
    if (here?.p) { const p = here.p; dp.toast(p.sp === 'wild' ? 'Divé semienko – čo z neho vyrastie? 🤔' : `${D.SPECIES[p.sp].name}${p.d ? ' – uhynula. Motykou ju vykopeš.' : ' – ešte rastie.'}`); }
  }
  // Ťah prstom: s pokryvom v ruke kladie, prázdnou rukou na pokryve zbiera
  function down(cx: number, cy: number): void {
    const z = cur();
    if (!z) return;
    const s = dp.pickSpot(cx, cy, z.x, z.y);
    hit = s ? [s.sx, s.sy] : null;
    paint = null;
    if (!s || !ZR.inner(s.sx, s.sy)) return;
    if (S.sel.startsWith('cov_')) paint = { add: true, spots: [[s.sx, s.sy]] };
    else if (!S.sel && ZR.spotAt(z, s.sx, s.sy)?.c) paint = { add: false, spots: [[s.sx, s.sy]] };
  }
  function move(cx: number, cy: number): void {
    const z = cur();
    if (!z) return;
    const s = dp.pickSpot(cx, cy, z.x, z.y);
    hit = s ? [s.sx, s.sy] : null;
    if (paint && s && ZR.inner(s.sx, s.sy) && !paint.spots.some(([a, b]) => a === s.sx && b === s.sy)) paint.spots.push([s.sx, s.sy]);
  }
  function up(cx: number, cy: number, tap: boolean): void {
    const z = cur(), p = paint;
    paint = null;
    if (!z) return;
    if (p && p.spots.length > 1) {
      const c = S.sel.slice(4), spots = p.spots.map(([a, b]): [number, number] => [a, b]);
      if (p.add && D.isCoverId(c)) dp.send({ t: 'zahon', op: 'cover', id: z.id, c, spots });
      else if (!p.add) dp.send({ t: 'zahon', op: 'uncover', id: z.id, spots });
      dp.sfx('pop');
      return;
    }
    if (!tap && !p) return;
    const s = dp.pickSpot(cx, cy, z.x, z.y);
    if (!s) return;
    cursor = [Math.max(1, Math.min(6, s.sx)), Math.max(1, Math.min(6, s.sy))];
    act(z, [s.sx, s.sy]);
  }
  // Klávesnica: šípky posúvajú vybraný bod (v smere obrazovky ako pri chôdzi), E / Enter = akcia, Esc = späť
  function key(code: string): boolean {
    const z = cur();
    if (!z) return false;
    const mv: Readonly<Partial<Record<string, Spot>>> = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
    const d = mv[code];
    if (d) { cursor = [Math.max(1, Math.min(6, cursor[0] + d[0])), Math.max(1, Math.min(6, cursor[1] + d[1]))]; hit = cursor; return true; }
    if (code === 'KeyE' || code === 'Enter') { act(z, cursor); return true; }
    if (code === 'Escape') { close(); return true; }
    return false;
  }
  // Značky bodov pre render3d: zelené = to, čo je v ruke, sa sem dá; sivé = nedá; vybraný bod svieti
  function marks(): readonly ZoomMark[] {
    const z = cur();
    if (!z) return [];
    const sel = S.sel, out: ZoomMark[] = [];
    const ok = (sx: number, sy: number): boolean | null => {
      const here = ZR.spotAt(z, sx, sy);
      if (sel.startsWith('seed_') || D.isWild(sel)) return !ZR.plantError(z, sx, sy, sel.startsWith('seed_') ? D.speciesOfItem(sel) : null);
      if (sel.startsWith('cov_')) return !ZR.coverError(z, sx, sy);
      if (sel === 'hoe') return here?.p ? true : null;
      if (!sel) return ZR.blooming(here) || here?.c ? true : null;
      return null;
    };
    for (let sy = 1; sy <= 6; sy++) for (let sx = 1; sx <= 6; sx++) {
      const k = ok(sx, sy);
      if (k !== null) out.push({ sx, sy, k: k ? 'ok' : 'no' });
    }
    const hs = paint ? paint.spots : hit ? [hit] : [];
    for (const [sx, sy] of hs) out.push({ sx, sy, k: 'hit' });
    return out;
  }
  return { open, close, active: () => !!cur(), down, move, up, key, marks, refresh };
}
