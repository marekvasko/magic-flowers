// Ladiaca stránka (#153): záložka Cheats – mince, reputácia a predmety hráčov, sklad, ľad v ľadovni, políčko (zem,
// záhon a rastlina sa upravujú priamo na Mape – tile-editor.ts), budovy, skok v čase a rýchlosť času. Všetko ide cez
// POST /api/debug/cheat s tajným kľúčom (cheat-api.ts: drží sa v sessionStorage, kým je karta otvorená).
// Texty po anglicky (nástroj pre správcu), mená predmetov po slovensky ako v hre.
import type * as DT from '../../shared/data.ts';
import type { Dock, PlayerSave } from '../../shared/save.ts';
import { isRecord } from '../../shared/util.ts';
import type { RoomSnapshot } from '../../server/debug.ts';
import { cheatKey, setCheatKey } from './cheat-api.ts';
import type { TabCtx, TabInstance } from '../ui.ts';
import { errText } from '../ui.ts';
import { vehiclesOf, vehicleText } from './vehicles-core.ts';
import * as V from '../../shared/vehicles.ts';

const CSS = `
.ch { max-width: 980px; }
.ch section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin: 0 0 12px; }
.ch h4 { margin: 0 0 8px; font-size: 14px; }
.ch .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
.ch input[type=number], .ch input[type=password], .ch input[type=text] { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; width: 70px; }
.ch input[type=password] { width: 220px; }
.ch select { max-width: 100%; }
.ch button.on { background: var(--accent-bg); color: var(--accent); border-color: var(--accent); font-weight: 600; }
.ch .msg { min-height: 1.4em; }
.ch .msg.err { color: var(--warn); }
.ch .msg.ok { color: var(--ok); }
.ch .inv { font-size: 12.5px; color: var(--muted); }
.ch .pl { border-top: 1px solid var(--line); padding: 6px 0; }
.ch .pl:first-of-type { border-top: none; }
.ch .lbl { min-width: 110px; }
`;
import { SPEEDS } from '../../shared/cheats.ts';
const speedLabel = (x: number): string => (x === 0.25 ? '¼' : x === 0.5 ? '½' : String(x)) + '×';
interface Status { tick: number; speed: number; jump: number | null }

// Všetky predmety hry (id → slovenské meno), v poradí: náradie, suroviny, semienka, kvety, elixíry, divé semienka
function allItems(D: typeof DT): { id: DT.ItemId; name: string }[] {
  const sp = Object.keys(D.SPECIES).filter(D.isSpeciesId), po = Object.keys(D.POTIONS).filter(D.isPotionId);
  const ids: string[] = ['hoe', 'can', 'pick', 'lamp', 'ice', 'compost', 'wilted', 'silk', 'blanket',
    ...sp.map(k => 'seed_' + k), ...sp.map(k => 'fl_' + k), ...po.map(k => 'po_' + k), 'wild_0', 'wild_1', 'wild_2', 'wild_3'];
  return ids.filter(D.isItemId).map(id => ({ id, name: D.itemName(id) }));
}

export function mount(el: HTMLElement, ctx0: TabCtx): TabInstance {
  let ctx = ctx0, snap: RoomSnapshot | null = null, status: Status | null = null, disabled: string | null = null, busy = false;
  const { h, D, fmt } = ctx;
  const style = h('style', null, CSS);
  document.head.appendChild(style);
  const root = h('div', { class: 'ch' });
  el.replaceChildren(root);
  let key = cheatKey();
  const msg = h('div', { class: 'msg' });
  const say = (text: string, kind: 'ok' | 'err'): void => { msg.textContent = text; msg.className = 'msg ' + kind; };
  const items = allItems(D);

  async function post(body: Record<string, string | number | boolean | null>): Promise<Status | null> {
    if (!ctx.room) return null;
    busy = true;
    try {
      const r = await fetch('/api/debug/cheat', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Cheat-Key': key }, body: JSON.stringify({ room: ctx.room, ...body }) });
      const j: unknown = await r.json().catch(() => ({}));
      const err = typeof j === 'object' && j && 'error' in j && typeof j.error === 'string' ? j.error : null;
      if (r.status === 404 && err && err.startsWith('cheats are disabled')) { disabled = err; status = null; render(); return null; }
      if (!r.ok) { say(err || 'HTTP ' + r.status, 'err'); return null; }
      disabled = null;
      status = j as Status; // odpoveď nášho servera (CheatHost.status)
      return status;
    } catch (e) { say(errText(e), 'err'); return null; } finally { busy = false; }
  }
  async function reload(): Promise<void> {
    if (!ctx.room) { snap = null; render(); return; }
    try { snap = await ctx.api<RoomSnapshot>('/api/debug/room?id=' + encodeURIComponent(ctx.room)); } catch (e) { snap = null; say(errText(e), 'err'); }
    if (key) await post({ op: 'status' });
    render();
  }
  async function act(body: Record<string, string | number | boolean | null>, done: string): Promise<void> {
    if (busy) return;
    if (!key) { say('Enter the cheat key first.', 'err'); return; }
    if (await post(body)) say(done, 'ok');
    await reload();
  }
  // Kým beží skok v čase, stav sa obnovuje každú sekundu
  const timer = setInterval(() => { if (status && status.jump != null && !busy) void reload(); }, 1000);

  const numIn = (value: number | string, min?: number): HTMLInputElement => h('input', { type: 'number', value, step: 1, min: min ?? null });
  const val = (i: HTMLInputElement): number => Number(i.value) || 0;

  function keyBox(): HTMLElement {
    const inp = h('input', { type: 'password', placeholder: 'DEBUG_CHEATS_KEY', value: key, autocomplete: 'off' });
    const saveKey = (): void => { key = inp.value.trim(); setCheatKey(key); void reload(); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') saveKey(); });
    return h('section', null, h('h4', null, 'Cheat key'),
      h('div', { class: 'row' }, inp, h('button', { onclick: saveKey }, 'Use key'),
        key ? h('button', { onclick: () => { key = ''; setCheatKey(''); status = null; render(); } }, 'Forget') : null),
      h('div', { class: 'muted' }, 'Every cheat needs the secret key of this server (GitHub secret DEBUG_CHEATS_KEY). It is kept only in this browser tab. Players never see a cheat; it shows up only in the Engine and Journal tabs.'));
  }

  function timeBox(): HTMLElement {
    const s = status;
    if (!s) return h('section', null, h('h4', null, 'Time'), h('div', { class: 'muted' }, key ? 'Wrong key or the room could not be loaded.' : 'Enter the key to see the time controls.'));
    const day = D.dayOfTick(s.tick), TPD = D.TICKS_PER_DAY, perH = TPD / 24;
    const jumpTo = (tick: number, label: string): void => { void act({ op: 'jump', tick }, `Jumping to ${fmt.when(tick)} (${label}).`); };
    const plus = (label: string, ticks: number): HTMLElement => h('button', { onclick: () => { jumpTo(s.tick + ticks, label); } }, label);
    const dayIn = numIn(day + 1, 1), timeIn = h('input', { type: 'text', value: '06:00', size: 5 });
    const exact = (): void => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(timeIn.value.trim());
      if (!m) { say('Time must be hh:mm.', 'err'); return; }
      const t = (val(dayIn) - 1) * TPD + Math.round((Number(m[1]) * 60 + Number(m[2])) / D.MIN_PER_TICK);
      if (t <= s.tick) { say('The target time must be in the future.', 'err'); return; }
      jumpTo(t, 'exact time');
    };
    const dawn = Math.ceil((s.tick + 1 - D.DAWN_TICK) / TPD) * TPD + D.DAWN_TICK;
    return h('section', null, h('h4', null, 'Time'),
      h('div', null, h('b', null, fmt.when(s.tick)), h('span', { class: 'muted' }, ` · ${D.SEASON_ICONS[D.seasonOf(day)] ?? ''} ${fmt.SEASON_EN[D.seasonOf(day)] ?? ''} · tick ${s.tick}`),
        s.jump != null ? h('span', null, ' · ', h('span', { class: 'badge warn' }, `jumping to ${fmt.when(s.jump)}`), ' ', h('button', { onclick: () => { void act({ op: 'jumpStop' }, 'Jump stopped.'); } }, 'Stop')) : null),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Speed'),
        SPEEDS.map(x => h('button', { class: x === s.speed ? 'on' : null, onclick: () => { void act({ op: 'speed', x }, `Speed ${speedLabel(x)}.`); } }, speedLabel(x))),
        h('span', { class: 'muted' }, s.speed === 1 ? '' : `one day = ${Math.round(D.BASE_DAY_SECONDS / s.speed / 6) / 10} min · back to 1× after a server restart`)),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Jump'), plus('+1 h', perH), plus('+6 h', 6 * perH), plus('+1 day', TPD), plus('+1 season', D.DAYS_PER_SEASON * TPD), plus('+1 year', 4 * D.DAYS_PER_SEASON * TPD),
        h('button', { onclick: () => { jumpTo(dawn, 'next dawn'); } }, 'Next 6:00')),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Jump to day'), dayIn, h('span', { class: 'muted' }, 'at'), timeIn, h('button', { onclick: exact }, 'Jump')),
      h('div', { class: 'muted' }, 'A jump runs every tick and event up to the target, fast; player actions are ignored until it ends.'));
  }

  function playersBox(saves: [string, PlayerSave][], online: Map<string, string>): HTMLElement {
    if (!saves.length) return h('section', null, h('h4', null, 'Players'), h('div', { class: 'empty' }, 'Nobody has played here yet.'));
    const card = ([id, sv]: [string, PlayerSave]): HTMLElement => {
      const coins = numIn(100), rep = numIn(10), name = online.get(id);
      return h('div', { class: 'pl' }, h('div', null, h('span', { class: 'mono' }, id), name ? h('span', null, ' ', h('span', { class: 'dot' }), name) : null),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, `Coins ${sv.coins}`), coins,
          h('button', { onclick: () => { void act({ op: 'coins', player: id, n: val(coins) }, `${val(coins)} coins added.`); } }, 'Add'),
          h('button', { onclick: () => { void act({ op: 'coins', player: id, n: val(coins), set: true }, `Coins set to ${val(coins)}.`); } }, 'Set')),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, `Rep ${sv.rep || 0} (L${D.repLevel(sv.rep || 0)})`), rep,
          h('button', { onclick: () => { void act({ op: 'rep', player: id, n: val(rep) }, `${val(rep)} reputation added.`); } }, 'Add'),
          h('button', { onclick: () => { void act({ op: 'rep', player: id, n: val(rep), set: true }, `Reputation set to ${val(rep)}.`); } }, 'Set')));
    };
    return h('section', null, h('h4', null, 'Coins and reputation'),
      saves.map(card),
      h('div', { class: 'muted' }, 'Reputation levels start at ' + D.REP_LEVELS.join(', ') + ' points. Negative amounts subtract; nothing goes below 0.'));
  }

  function itemsBox(saves: [string, PlayerSave][], online: Map<string, string>, w: RoomSnapshot['state']): HTMLElement {
    const who = h('select', null, saves.map(([id]) => h('option', { value: id }, online.get(id) ? `${online.get(id) ?? ''} (${id})` : id)), h('option', { value: 'storage' }, 'Shared storage'));
    const item = h('select', null, items.map(i => h('option', { value: i.id }, `${i.name} (${i.id})`)));
    const n = numIn(10);
    // sklad je v uložení inv (id → počet); DebugState ho netypuje
    const invOf = (): Partial<Record<string, number>> => who.value === 'storage' ? (w['storage'] as Partial<Record<string, number>> | undefined) || {} : (saves.find(([id]) => id === who.value)?.[1].inv || {});
    const inv = h('div', { class: 'inv' });
    const showInv = (): void => {
      const list = Object.entries(invOf()).filter(([, v]) => typeof v === 'number' && v > 0);
      inv.textContent = list.length ? list.map(([id, v]) => `${D.itemName(id)} ${String(v)}`).join(' · ') : 'empty';
    };
    who.onchange = showInv; showInv();
    const ice = numIn(w.icehouse ? w.icehouse.ice : 0, 0);
    const send = (set: boolean): void => {
      const label = items.find(i => i.id === item.value)?.name ?? item.value;
      void act({ op: 'item', player: who.value, id: item.value, n: val(n), set }, set ? `${label} set to ${val(n)}.` : `${val(n)} × ${label} added.`);
    };
    return h('section', null, h('h4', null, 'Items'),
      h('div', { class: 'row' }, who, item, n, h('button', { onclick: () => { send(false); } }, 'Add'), h('button', { onclick: () => { send(true); } }, 'Set')),
      inv,
      h('h4', { style: 'margin-top:12px' }, 'Icehouse'),
      h('div', { class: 'row' }, w.icehouse && w.icehouse.built ? null : h('span', { class: 'muted' }, 'not built · '),
        h('span', { class: 'muted' }, `ice ${w.icehouse ? Math.round(w.icehouse.ice * 100) / 100 : 0} / ${D.ICEHOUSE.cap}`), ice,
        h('button', { onclick: () => { void act({ op: 'ice', n: val(ice), set: true }, `Icehouse ice set to ${Math.min(D.ICEHOUSE.cap, val(ice))}.`); } }, 'Set')));
  }

  // Fúrik a sane (#158): kúpiť / odstrániť, pustiť (vodič aj spolujazdec), náklad ľadu, premiestniť (záhrada, hory)
  function vehiclesBox(w: RoomSnapshot['state'], online: Map<string, string>): HTMLElement {
    const row = (v: ReturnType<typeof vehiclesOf>[number]): HTMLElement => {
      const ice = numIn(v.ice, 0), area = h('select', null, V.VEHICLE_AREAS.map(a => h('option', { value: a, selected: a === v.area ? 'selected' : null }, D.AREA_NAMES[a])));
      const x = h('input', { type: 'number', value: v.x.toFixed(1), step: 0.5 }), y = h('input', { type: 'number', value: v.y.toFixed(1), step: 0.5 });
      const go = (body: Record<string, string | number | boolean | null>, done: string): void => { void act({ op: 'vehicle', id: v.id, ...body }, done); };
      const IL = D.ICEHOUSE.lot, home = V.VEHICLE_HOME[v.id];
      return h('div', { class: 'pl' }, h('div', null, h('b', null, v.name), ' ', h('span', { class: 'inv' }, vehicleText(v, online))),
        h('div', { class: 'row' }, v.bought
          ? h('button', { onclick: () => { go({ act: 'remove' }, `${v.name} removed (back to not bought).`); } }, 'Remove')
          : h('button', { onclick: () => { go({ act: 'buy' }, `${v.name} bought (free), in front of the Dielňa.`); } }, 'Buy (free)'),
        h('button', { disabled: v.bought && (v.driver || v.passenger) ? null : 'disabled', onclick: () => { go({ act: 'release' }, `${v.name} released.`); } }, 'Release driver + passenger'),
        h('button', { onclick: () => { go({ act: 'usable' }, `${v.name}: usable toggled (until the next season starts).`); } }, v.usable === false ? 'Make usable' : 'Make unusable')),
        v.bought ? h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Ice'), ice,
          h('button', { onclick: () => { go({ act: 'ice', n: val(ice), set: true }, `${v.name}: ice set to ${Math.min(V.VEHICLE_ICE, val(ice))}.`); } }, 'Set')) : null,
        v.bought ? h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Teleport'), area, x, y,
          h('button', { onclick: () => { go({ act: 'tp', area: area.value, x: Number(x.value), y: Number(y.value) }, `${v.name} moved.`); } }, 'Move'),
          h('button', { onclick: () => { go({ act: 'tp', area: 'garden', x: home.x, y: home.y }, `${v.name} is back at the Dielňa.`); } }, 'To the Dielňa'),
          h('button', { onclick: () => { go({ act: 'tp', area: 'garden', x: IL.x1 + 1.6, y: IL.y0 + 1 }, `${v.name} is at the icehouse.`); } }, 'To the icehouse')) : null);
    };
    return h('section', null, h('h4', null, 'Vehicles (fúrik, sane)'), vehiclesOf(w).map(row),
      h('div', { class: 'muted' }, `Shared by the garden. Fúrik: spring–autumn, sane: winter only; garden and mountains only; at most ${V.VEHICLE_ICE} ice. Moving or removing a vehicle releases its driver and passenger.`));
  }

  // Mólo a loďka (#160): stav zo sveta, stavba, poloha loďky, posádka a zima (prevrátená loďka)
  function dockBox(saves: [string, PlayerSave][], online: Map<string, string>, w: RoomSnapshot['state']): HTMLElement {
    const raw = w['dock'], b = isRecord(raw) && isRecord(raw['boat']) ? raw['boat'] : null;
    const d: Dock | null = isRecord(raw) && b ? { built: !!raw['built'], boat: { x: Number(b['x']) || 0, y: Number(b['y']) || 0, a: Number(b['a']) || 0 }, seats: Array.isArray(raw['seats']) ? raw['seats'].filter((k): k is string => typeof k === 'string') : [], flip: !!raw['flip'] } : null;
    const head = h('h4', null, `${D.DOCK.icon} Dock and boat`);
    if (!d || !d.built) return h('section', null, head, h('div', { class: 'row' }, h('span', { class: 'muted' }, 'The dock is not built.'),
      h('button', { onclick: () => { void act({ op: 'dock', built: true }, 'Dock built (with the boat at the dock).'); } }, 'Build the dock')));
    const name = (k: string): string => online.get(k) ? `${online.get(k) ?? ''} (${k})` : k;
    const bx = numIn(String(D.DOCK.moor.x)), by = numIn(String(D.DOCK.moor.y));
    bx.step = by.step = '0.5';
    const who = h('select', null, saves.map(([id]) => h('option', { value: id }, name(id))));
    return h('section', null, head,
      h('div', null, `Boat at ${d.boat.x.toFixed(2)}, ${d.boat.y.toFixed(2)}${d.flip ? ' – flipped on the dock (winter)' : ''} · seats: ${d.seats.length ? d.seats.map((k, i) => (i ? 'passenger ' : 'rower ') + name(k)).join(', ') : 'empty'}`),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Teleport the boat'), 'x', bx, 'y', by,
        h('button', { onclick: () => { void act({ op: 'boat', x: Number(bx.value), y: Number(by.value) }, 'Boat moved (with its crew).'); } }, 'Move'),
        h('button', { onclick: () => { void act({ op: 'boat', x: D.DOCK.moor.x, y: D.DOCK.moor.y }, 'Boat back at the dock.'); } }, 'To the dock')),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Crew'), who,
        h('button', { onclick: () => { void act({ op: 'seat', player: who.value, on: true }, 'Player put in the boat.'); } }, 'Into the boat'),
        h('button', { onclick: () => { void act({ op: 'seat', player: who.value, on: false }, 'Player put on the shore.'); } }, 'Out of the boat')),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Winter'),
        h('button', { class: d.flip ? 'on' : null, onclick: () => { void act({ op: 'boatFlip', flip: !d.flip }, d.flip ? 'Boat back on the water.' : 'Boat flipped on the dock (winter); the crew is on the dock.'); } }, d.flip ? 'Back on the water' : 'Force winter (flip)'),
        h('button', { onclick: () => { void act({ op: 'dock', built: false }, 'Dock removed.'); } }, 'Remove the dock')),
      h('div', { class: 'muted' }, 'The boat must stay on water (the whole boat, not over the dock). At midnight the game flips the boat for winter and back in spring by itself.'));
  }

  function buildingsBox(w: RoomSnapshot['state']): HTMLElement {
    const ice = w.icehouse, dl = w.dielna;
    const row = (label: string, what: string, on: boolean, extra: string): HTMLElement => h('div', { class: 'row' },
      h('span', { class: 'lbl' }, `${label}: ${on ? 'built' : 'not built'}`),
      h('button', { onclick: () => { void act({ op: 'building', what, on: true }, `${label} built.`); } }, 'Build'),
      h('button', { onclick: () => { void act({ op: 'building', what, on: false }, `${label} removed.`); } }, 'Remove'),
      h('span', { class: 'muted' }, extra));
    return h('section', null, h('h4', null, 'Buildings'),
      row('Icehouse', 'icehouse', !!(ice && ice.built), 'removing it melts the ice'),
      row('Dielňa', 'dielna', !!(dl && dl.built), 'removing it drops the loom, weaving and waiting blankets'),
      row('Loom', 'loom', !!(dl && dl.loom), 'builds the Dielňa if needed'),
      h('div', { class: 'muted' }, 'Building clears any plots on its lot.'));
  }

  function render(): void {
    if (!ctx.room) { root.replaceChildren(h('div', { class: 'empty' }, 'Select a room on the left.')); return; }
    if (disabled) { root.replaceChildren(h('section', null, h('h4', null, 'Cheats are off on this server'), h('div', { class: 'muted' }, 'Set DEBUG_CHEATS_KEY in the server environment (deploy: GitHub secret) to turn them on.'))); return; }
    const out: Node[] = [keyBox(), msg, timeBox()];
    if (status && snap) {
      const saves = Object.entries(snap.state.saves || {}).filter((e): e is [string, PlayerSave] => !!e[1]);
      const online = new Map(snap.online.map(o => [o.player, o.name]));
      out.push(playersBox(saves, online), itemsBox(saves, online, snap.state), vehiclesBox(snap.state, online), dockBox(saves, online, snap.state), buildingsBox(snap.state),
        h('section', null, h('h4', null, 'Tiles'), h('div', { class: 'muted' }, 'Ground objects, plots and plants: open the Map tab (Room), tap a tile and edit it there.')));
    }
    root.replaceChildren(...out);
  }

  render();
  void reload();
  return {
    update(c) { const changed = c.room !== ctx.room; ctx = c; if (changed) { status = null; msg.textContent = ''; } void reload(); },
    unmount() { clearInterval(timer); style.remove(); }
  };
}
