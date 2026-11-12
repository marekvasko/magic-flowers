// Úprava políčka cheatom (#153) – panel na Mape pri vybranom políčku: zem (objekt z generátora alebo zem z generátora)
// a v záhrade záhon s rastlinou. Volanie servera robí volajúci (act).
import type * as DT from '../../shared/data.ts';
import type { Soil } from '../../shared/save.ts';
import { PLACEABLE, PLANT_STAGES, isPlaceable } from '../../shared/cheats.ts';
import type { PlantStage } from '../../shared/cheats.ts';
import type { h as H } from '../ui.ts';
import type { CheatBody } from './cheat-api.ts';

const STAGE_LABEL: Readonly<Record<PlantStage, string>> = { seed: 'seedling', grow: 'growing', bloom: 'blooming' };
export interface EditTile { i: number; tile: { g: DT.Ground; s?: Soil | null | undefined }; changed: boolean }   // changed = zem už zmenil cheat
export interface TileEditorOpts {
  h: typeof H; D: typeof DT;
  area: DT.AreaId;
  tiles: readonly EditTile[];                    // vybrané políčka (aspoň jedno); hodnoty formulára sú z prvého
  owners: readonly { id: string; label: string }[];
  act: (body: CheatBody, done: string) => void;
}
// Jedno políčko alebo viac naraz: zmena ide na všetky; čo sa na niektorom políčku nedá (budova, netillable zem), server preskočí
export function tileEditor(o: TileEditorOpts): Node[] {
  const { h, D } = o, n = o.tiles.length, where = n === 1 ? 'Tile' : `${n} tiles`, skip = n > 1 ? ' (tiles that can’t take it are skipped)' : '';
  const out: Node[] = [];
  const row = (...kids: (Node | string | null)[]): HTMLElement => h('div', { class: 'te-row' }, ...kids);
  const free = o.tiles.filter(e => isPlaceable(e.tile.g) || e.changed), first = free[0] ?? o.tiles[0];
  if (free.length && first) {
    const is = free.map(e => e.i), changed = free.some(e => e.changed);
    const gSel = h('select', null, PLACEABLE.map(g => h('option', { value: g, selected: g === first.tile.g ? 'selected' : null }, g)));
    out.push(row(h('span', { class: 'te-lbl' }, 'Ground'), gSel,
      h('button', { onclick: () => { o.act({ op: 'ground', area: o.area, i: is, g: gSel.value }, `${where}: ${gSel.value} placed${skip}.`); } }, 'Place'),
      changed ? h('button', { title: 'Back to what the world generator made', onclick: () => { o.act({ op: 'ground', area: o.area, i: is, g: null }, `${where}: generated ground restored.`); } }, 'Reset') : null));
  }
  if (free.length < n) {
    const kinds = [...new Set(o.tiles.filter(e => !free.includes(e)).map(e => e.tile.g))].join(', ');
    out.push(h('p', { class: 'muted' }, `${kinds}: buildings, gates, lots, giant trees, glacier and cliffs can’t be changed.`));
  }
  const tillable = o.area === 'garden' ? o.tiles.filter(e => e.tile.g !== 'ring' && D.TILLABLE[e.tile.g]) : [];
  const t0 = tillable[0];
  if (t0) {
    const is = tillable.map(e => e.i), s = t0.tile.s || null, p = s && s.p, sp = p && D.isSpeciesId(p.sp) ? p.sp : null;
    const stageNow: PlantStage = p && sp ? (p.prog >= D.SPECIES[sp].days ? 'bloom' : p.prog > 0 ? 'grow' : 'seed') : 'seed';
    const plots = tillable.filter(e => e.tile.s).length;
    const owner = h('select', null, o.owners.map(x => h('option', { value: x.id, selected: s && s.o === x.id ? 'selected' : null }, x.label)));
    const spSel = h('select', null, h('option', { value: '' }, '– no plant –'),
      Object.keys(D.SPECIES).filter(D.isSpeciesId).map(id => h('option', { value: id, selected: id === sp ? 'selected' : null }, D.SPECIES[id].name)));
    const stage = h('select', null, PLANT_STAGES.map(x => h('option', { value: x, selected: x === stageNow ? 'selected' : null }, STAGE_LABEL[x])));
    const num = (v: number): HTMLInputElement => h('input', { type: 'number', value: v, min: 0, step: 1, class: 'te-num' });
    const q = num(p ? p.q : 3), dry = num(p ? p.dry : 0);
    const box = (label: string, on: boolean): [HTMLInputElement, HTMLElement] => { const c = h('input', { type: 'checkbox' }); c.checked = on; return [c, h('label', null, c, ' ' + label)]; };
    const [wet, wetL] = box('watered', !!(s && s.w)), [comp, compL] = box('composted', !!(s && s.r)), [dead, deadL] = box('dead', !!(p && p.d));
    const sub = n === 1 ? (s ? `Plot (${s.k})` : 'No plot') : `${tillable.length} tillable, ${plots} with a plot`;
    out.push(h('div', { class: 'te-sub' }, sub),
      row(h('span', { class: 'te-lbl' }, 'Plant'), spSel, stage),
      row(h('span', { class: 'te-lbl' }, 'Quality'), q, h('span', { class: 'muted' }, 'dry days'), dry),
      row(wetL, compL, deadL),
      row(h('span', { class: 'te-lbl' }, 'Owner'), owner),
      row(h('button', { onclick: () => {
        o.act({ op: 'plot', i: is, owner: owner.value, sp: spSel.value, stage: stage.value, q: Number(q.value) || 0, dry: Number(dry.value) || 0, w: wet.checked, r: comp.checked, dead: dead.checked },
          `${where}: ${spSel.value ? (spSel.selectedOptions[0]?.textContent ?? spSel.value) + ' planted' : 'plot set'}.`);
      } }, plots ? 'Set plot' : 'Till plot'),
      plots ? h('button', { onclick: () => { o.act({ op: 'plot', i: is, till: false }, `${where}: plot cleared.`); } }, 'Clear plot') : null));
  }
  return out;
}
