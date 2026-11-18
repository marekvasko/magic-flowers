// Záhon v hre (#179): priblížený pohľad (B) – jediný spôsob, ako záhon upravovať. Ťuknutie na záhon kameru priblíži
// nad neho (render3d: S.zoom), ťuknutie na bod urobí to, čo je v ruke: semienko zasadí, pokryv položí (ťahom prsta na
// viac bodov), prázdna ruka zreže rozkvitnutý kvet alebo zoberie pokryv (aj ťahom), motyka vykopá kvet, krhla poleje
// a kompost pohnojí celý záhon, krompáč záhon zruší (hneď, bez potvrdenia). Hore názov a stav záhonu. Späť: ťuknutie
// mimo záhonu alebo Esc. Klávesy: šípky = bod, E = akcia. Pravidlá bodov sú spoločné so serverom (shared/zahon.ts) – body, na ktoré to nejde, sú sivé.
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
  pickSpot: (cx: number, cy: number) => PSpot | null;
  pan: (x0: number, y0: number, x1: number, y1: number) => void;   // posun priblíženého záhonu ťahom prsta
  follow: (id: number, sx: number, sy: number) => void;            // pohľad za kurzorom klávesnice
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
  destroyAt: (tx: number, ty: number) => void; // krompáčom na záhon v hre
}

type PSpot = { id: number; sx: number; sy: number }; // bod v časti spojeného záhonu
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string | null, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

export function createZahon(dp: ZahonDeps): ClientZahon {
  const { S } = dp;
  let paint: { add: boolean; spots: PSpot[] } | null = null, cursor: PSpot = { id: 0, sx: 3, sy: 3 }, tapAt = { id: 0, sx: 0, sy: 0, t: 0, act: false };
  const bar = el('div', 'zbar hidden'), title = el('div', 'ztitle'), hint = el('div', 'zhint hidden');
  bar.append(title);
  dp.root.append(bar, hint);
  // Zrušenie záhonu krompáčom (v priblíženom pohľade aj priamo na záhon v hre) – hneď, bez okna s potvrdením.
  // Ak bol priblížený a zo spojeného záhonu ostali ďalšie časti, pohľad ostane na nich.
  function destroy(z: ZahonView): void {
    dp.send({ t: 'zahon', op: 'destroy', id: z.id }); dp.sfx('dig');
    if (S.zoom?.id !== z.id) return;
    const rest = group(z).find(b => b.id !== z.id);
    if (rest) S.zoom = { id: rest.id }; else close();
  }

  function cur(): ZahonView | null {
    const zm = S.zoom;
    if (!zm) return null;
    return S.objects.find((o): o is ZahonView => o.kind === 'zahon' && o.id === zm.id) ?? null;
  }
  // Spojený záhon (jeden kus): všetky časti spojené stranami s priblíženým záhonom
  const group = (z: ZahonView): ZahonView[] => ZR.groupOf<ZahonView>(S.objects, z);
  const byId = (id: number): ZahonView | null => S.objects.find((o): o is ZahonView => o.kind === 'zahon' && o.id === id) ?? null;
  function open(tx: number, ty: number): void {
    const z = Obj.zahonAt({ list: S.objects }, tx, ty);
    if (!z) return;
    S.zoom = { id: z.id };
    cursor = { id: z.id, sx: 3, sy: 3 }; paint = null; last = null;
    bar.classList.remove('hidden'); hint.classList.remove('hidden'); dp.root.classList.add('zooming');
    refresh();
  }
  function close(): void {
    S.zoom = null; paint = null;
    bar.classList.add('hidden'); hint.classList.add('hidden'); dp.root.classList.remove('zooming');
  }
  // Text hore (názov a stav; spojený záhon: počet častí) a nápoveda podľa toho, čo je v ruke
  function refresh(): void {
    const z = cur();
    if (!z) { if (S.zoom) close(); return; }
    const g = group(z), n = g.length, wet = g.filter(b => b.w).length;
    const name = n === 1 ? D.ZAHON_NAMES[z.v] : `Spojený záhon · ${String(n)} ${n < 5 ? 'časti' : 'častí'}`;
    title.textContent = `${name} · ${wet === n ? '💧 poliaty' : wet ? '💧 sčasti poliaty' : '🏜️ suchý'}${g.every(b => b.r) ? ' · 🌱 pohnojený' : ''}`;
    const sel = S.sel;
    hint.textContent = sel.startsWith('seed_') || D.isWild(sel) ? 'Ťukni na bod – tam kvet zasadíš. 🌱'
      : sel.startsWith('cov_') ? 'Ťukni alebo potiahni prstom po bodoch – položíš pokryv. 🪣'
        : sel === 'can' ? 'Ťukni na záhon – jedno poliatie stačí na celú časť záhonu. 💧'
          : sel === 'compost' ? 'Ťukni na záhon – kompost pohnojí celú časť záhonu. 🟤'
            : sel === 'hoe' ? 'Ťukni na kvet – motykou ho vykopeš.'
              : sel === 'pick' ? 'Ťukni krompáčom na záhon – zrušíš ho. ⛏️'
              : 'Prázdnou rukou zrežeš rozkvitnutý kvet alebo zoberieš pokryv (aj ťahom prsta).';
    hint.textContent += ' Ťahom prsta posunieš pohľad. Ťukni mimo záhonu (Esc) – späť.';
  }
  // Záhon so susedmi (spojené strany, kvety susedov kvôli zónam)
  const bed = (z: ZahonView): ZahonView & { open: ZR.Open; near: ZR.SpotLike[] } => ZR.bedOf<ZahonView>(S.objects, z);
  const near = (z: ZahonView): boolean => S.area === 'garden' && group(z).some(b => Math.hypot(S.me.x - (b.x + 0.5), S.me.y - (b.y + 0.5)) <= 2.4);
  setInterval(() => { const z = cur(); if (S.zoom && (!z || !near(z))) close(); }, 300); // odišiel ďaleko / záhon zmizol

  // Akcia na jednom bode (ťuknutie, kláves E)
  function act({ id, sx, sy }: PSpot): void {
    const z = byId(id);
    if (!z) return;
    const sel = S.sel, here = ZR.spotAt(z, sx, sy);
    tapAt = { id, sx, sy, t: performance.now(), act: useful({ id, sx, sy }) };
    if (sel === 'can') { dp.send({ t: 'zahon', op: 'water', id }); dp.sfx('water'); return; }
    if (sel === 'compost') { dp.send({ t: 'zahon', op: 'compost', id }); dp.sfx('pop'); return; }
    if (sel.startsWith('seed_') || D.isWild(sel)) {
      const sp = sel.startsWith('seed_') ? D.speciesOfItem(sel) : null;
      const why = ZR.plantError(bed(z), sx, sy, sp);
      if (why) { dp.toast(why); return; }
      dp.send({ t: 'zahon', op: 'plant', id, sx, sy, item: sel }); dp.sfx('pop'); return;
    }
    if (sel.startsWith('cov_')) { const c = sel.slice(4); if (D.isCoverId(c)) { dp.send({ t: 'zahon', op: 'cover', id, c, spots: [[sx, sy]] }); dp.sfx('pop'); } return; }
    if (sel === 'pick') { destroy(z); return; } // krompáč = zrušiť túto časť záhonu
    if (sel === 'hoe') {
      if (here?.p) { dp.send({ t: 'zahon', op: 'dig', id, sx, sy }); dp.sfx('dig'); } else dp.toast('Tu nič nerastie. Záhon zrušíš krompáčom. ⛏️');
      return;
    }
    if (ZR.blooming(here)) {
      const p = here?.p;
      if (p && p.sp === 'papradie' && !D.isNight(D.minOfTick(S.tick))) { dp.toast('Papraď drží púčik pevne zatvorený… vraj sa otvára len v noci. 🌙'); return; }
      dp.send({ t: 'zahon', op: 'pick', id, sx, sy }); dp.sfx('pop'); return;
    }
    if (here?.c) { dp.send({ t: 'zahon', op: 'uncover', id, spots: [[sx, sy]] }); dp.sfx('pop'); return; }
    if (here?.p) { const p = here.p; dp.toast(p.sp === 'wild' ? 'Divé semienko – čo z neho vyrastie? 🤔' : `${D.SPECIES[p.sp].name}${p.d ? ' – uhynula. Motykou ju vykopeš.' : ' – ešte rastie.'}`); }
  }
  const frameAt = (s: PSpot): boolean => { const z = byId(s.id); return !z || ZR.isFrame(bed(z).open, s.sx, s.sy); };
  // Ťah prstom: s pokryvom v ruke kladie, prázdnou rukou na pokryve zbiera (cez všetky časti spojeného záhonu)
  let last: { x: number; y: number } | null = null; // ťah, ktorý nekladie pokryv, posúva pohľad
  function down(cx: number, cy: number): void {
    if (!cur()) return;
    const s = dp.pickSpot(cx, cy);
    paint = null; last = { x: cx, y: cy };
    if (!s || frameAt(s)) return;
    const z = byId(s.id);
    if (S.sel.startsWith('cov_')) paint = { add: true, spots: [s] };
    else if (!S.sel && z && ZR.spotAt(z, s.sx, s.sy)?.c) paint = { add: false, spots: [s] };
  }
  function move(cx: number, cy: number): void {
    if (!cur()) return;
    if (!paint) { if (last) { dp.pan(last.x, last.y, cx, cy); last = { x: cx, y: cy }; } return; }
    const s = dp.pickSpot(cx, cy);
    if (s && !frameAt(s) && !paint.spots.some(q => q.id === s.id && q.sx === s.sx && q.sy === s.sy)) paint.spots.push(s);
  }
  function up(cx: number, cy: number, tap: boolean): void {
    const p = paint;
    paint = null; last = null;
    if (!cur()) return;
    if (p && p.spots.length > 1) {
      const c = S.sel.slice(4);
      for (const id of new Set(p.spots.map(q => q.id))) {
        const spots = p.spots.filter(q => q.id === id).map((q): [number, number] => [q.sx, q.sy]);
        if (p.add && D.isCoverId(c)) dp.send({ t: 'zahon', op: 'cover', id, c, spots });
        else if (!p.add) dp.send({ t: 'zahon', op: 'uncover', id, spots });
      }
      dp.sfx('pop');
      return;
    }
    if (!tap && !p) return;
    const s = dp.pickSpot(cx, cy);
    if (!s) { close(); return; } // ťuknutie mimo záhonu = späť
    cursor = s;
    act(s);
  }
  // Klávesnica: šípky posúvajú vybraný bod (aj do susednej časti spojeného záhonu), E / Enter = akcia, Esc = späť
  function key(code: string): boolean {
    const z = cur();
    if (!z) return false;
    const mv: Readonly<Partial<Record<string, readonly [number, number]>>> = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
    const d = mv[code];
    if (d) {
      const b = byId(cursor.id) ?? z, gx = b.x * ZR.SPOTS + cursor.sx + d[0], gy = b.y * ZR.SPOTS + cursor.sy + d[1];
      const nb = group(z).find(q => Math.floor(gx / ZR.SPOTS) === q.x && Math.floor(gy / ZR.SPOTS) === q.y);
      if (nb) { cursor = { id: nb.id, sx: gx - nb.x * ZR.SPOTS, sy: gy - nb.y * ZR.SPOTS }; dp.follow(cursor.id, cursor.sx, cursor.sy); }
      return true;
    }
    if (code === 'KeyE' || code === 'Enter') { act(cursor); return true; }
    if (code === 'Escape') { close(); return true; }
    return false;
  }
  // Značky bodov pre render3d: sivé = to, čo je v ruke, sem nejde (voľné body sa neznačia); rámik = ťuknutý bod
  // (zanikne ako pri ťuknutí na zem), bod pod kurzorom klávesnice, body ťahu prstom
  function marks(): readonly ZoomMark[] {
    const z = cur();
    if (!z) return [];
    const sel = S.sel, out: ZoomMark[] = [];
    for (const g of group(z)) {
      const b = bed(g);
      const can = (sx: number, sy: number): boolean | null => {
        const here = ZR.spotAt(g, sx, sy);
        if (ZR.isFrame(b.open, sx, sy) || here?.p) return null; // rám a kvet je vidno, netreba ich sivo značiť
        if (sel.startsWith('seed_') || D.isWild(sel)) return !ZR.plantError(b, sx, sy, sel.startsWith('seed_') ? D.speciesOfItem(sel) : null);
        if (sel.startsWith('cov_')) return !ZR.coverError(b, sx, sy);
        return null;
      };
      for (let sy = 0; sy < ZR.SPOTS; sy++) for (let sx = 0; sx < ZR.SPOTS; sx++) if (can(sx, sy) === false) out.push({ id: g.id, sx, sy, k: 'no' });
    }
    if (paint) for (const q of paint.spots) out.push({ ...q, k: 'ring', act: true });
    else if (S.kbd) out.push({ ...cursor, k: 'ring', act: useful(cursor) });
    const age = (performance.now() - tapAt.t) / 600;
    if (age < 1) out.push({ id: tapAt.id, sx: tapAt.sx, sy: tapAt.sy, k: 'ring', act: tapAt.act, age });
    return out;
  }
  // Urobí ťuknutie na bod niečo? (žltý či biely rámik)
  function useful({ id, sx, sy }: PSpot): boolean {
    const z = byId(id);
    if (!z) return false;
    const sel = S.sel, here = ZR.spotAt(z, sx, sy);
    if (sel === 'can' || sel === 'compost') return true;
    if (sel.startsWith('seed_') || D.isWild(sel)) return !ZR.plantError(bed(z), sx, sy, sel.startsWith('seed_') ? D.speciesOfItem(sel) : null);
    if (sel.startsWith('cov_')) return !ZR.coverError(bed(z), sx, sy);
    if (sel === 'pick') return true;
    if (sel === 'hoe') return !!here?.p;
    return ZR.blooming(here) || !!here?.c;
  }
  // krompáčom na záhon v hre (bez priblíženia)
  function destroyAt(tx: number, ty: number): void { const z = Obj.zahonAt({ list: S.objects }, tx, ty); if (z) destroy(z); }
  return { open, close, active: () => !!cur(), down, move, up, key, marks, refresh, destroyAt };
}
