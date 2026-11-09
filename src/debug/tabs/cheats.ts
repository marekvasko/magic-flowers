// Ladiaca stránka (#153): záložka Cheats – mince, reputácia a predmety hráčov, sklad, ľad v ľadovni, skok v čase
// a rýchlosť času. Všetko ide cez POST /api/debug/cheat s tajným kľúčom (drží sa v sessionStorage, kým je karta otvorená).
// Texty po anglicky (nástroj pre správcu), mená predmetov po slovensky ako v hre.
import type * as DT from '../../shared/data.ts';
import type { PlayerSave } from '../../shared/save.ts';
import type { RoomSnapshot } from '../../server/debug.ts';
import type { TabCtx, TabInstance } from '../ui.ts';
import { errText } from '../ui.ts';

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
const KEY_STORE = 'mf-cheat-key';
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
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
  let key = '';
  try { key = sessionStorage.getItem(KEY_STORE) || ''; } catch { /* súkromné okno */ }
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
    const saveKey = (): void => { key = inp.value.trim(); try { sessionStorage.setItem(KEY_STORE, key); } catch { /* súkromné okno */ } void reload(); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') saveKey(); });
    return h('section', null, h('h4', null, 'Cheat key'),
      h('div', { class: 'row' }, inp, h('button', { onclick: saveKey }, 'Use key'),
        key ? h('button', { onclick: () => { key = ''; try { sessionStorage.removeItem(KEY_STORE); } catch { /* súkromné okno */ } status = null; render(); } }, 'Forget') : null),
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

  function render(): void {
    if (!ctx.room) { root.replaceChildren(h('div', { class: 'empty' }, 'Select a room on the left.')); return; }
    if (disabled) { root.replaceChildren(h('section', null, h('h4', null, 'Cheats are off on this server'), h('div', { class: 'muted' }, 'Set DEBUG_CHEATS_KEY in the server environment (deploy: GitHub secret) to turn them on.'))); return; }
    const out: Node[] = [keyBox(), msg, timeBox()];
    if (status && snap) {
      const saves = Object.entries(snap.state.saves || {}).filter((e): e is [string, PlayerSave] => !!e[1]);
      const online = new Map(snap.online.map(o => [o.player, o.name]));
      out.push(playersBox(saves, online), itemsBox(saves, online, snap.state));
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
