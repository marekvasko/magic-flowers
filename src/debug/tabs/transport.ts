// Ladiaca stránka (#161): záložka Transport – doprava na jednom mieste: fúrik a sane (#158), mólo a loďka (#160),
// kto ich práve používa, ďalšie udalosti dopravy a spoločné cheaty (kľúč z záložky Cheats, sessionStorage).
// Údaje: GET /api/debug/transport?room=<id> (src/server/debug-api/transport.ts). Texty po anglicky (nástroj pre správcu).
import type { TransportApi } from '../../server/debug-api/transport.ts';
import type { TabCtx, TabInstance } from '../ui.ts';
import { errText } from '../ui.ts';

const CSS = `
.tr { max-width: 1100px; }
.tr section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin: 0 0 12px; }
.tr h4 { margin: 0 0 8px; font-size: 14px; }
.tr table { border-collapse: collapse; width: 100%; font-size: 13px; }
.tr th, .tr td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.tr th { color: var(--muted); font-weight: 600; }
.tr .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
.tr .msg { min-height: 1.4em; }
.tr .msg.err { color: var(--warn); }
.tr .msg.ok { color: var(--ok); }
`;
const KEY_STORE = 'mf-cheat-key'; // ten istý kľúč ako v záložke Cheats

export function mount(el: HTMLElement, ctx0: TabCtx): TabInstance {
  let ctx = ctx0, data: TransportApi | null = null, err: string | null = null, busy = false;
  const { h, fmt } = ctx;
  const style = h('style', null, CSS);
  document.head.appendChild(style);
  const root = h('div', { class: 'tr' });
  el.replaceChildren(root);
  const msg = h('div', { class: 'msg' });
  const say = (text: string, kind: 'ok' | 'err'): void => { msg.textContent = text; msg.className = 'msg ' + kind; };
  const key = (): string => { try { return sessionStorage.getItem(KEY_STORE) || ''; } catch { return ''; } };

  async function reload(): Promise<void> {
    if (!ctx.room) { data = null; render(); return; }
    try { data = await ctx.api<TransportApi>('/api/debug/transport?room=' + encodeURIComponent(ctx.room)); err = null; } catch (e) { data = null; err = errText(e); }
    render();
  }
  async function cheat(body: Record<string, string | number | boolean>, done: string): Promise<void> {
    if (busy || !ctx.room) return;
    if (!key()) { say('Enter the cheat key in the Cheats tab first.', 'err'); return; }
    busy = true;
    try {
      const r = await fetch('/api/debug/cheat', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Cheat-Key': key() }, body: JSON.stringify({ room: ctx.room, ...body }) });
      const j: unknown = await r.json().catch(() => ({}));
      const e = typeof j === 'object' && j && 'error' in j && typeof j.error === 'string' ? j.error : null;
      if (r.ok) say(done, 'ok'); else say(e || 'HTTP ' + r.status, 'err');
    } catch (e) { say(errText(e), 'err'); } finally { busy = false; }
    await reload();
  }
  const timer = setInterval(() => { if (!busy && data && data.source === 'memory') void reload(); }, 2000);

  const who = (k: string | null): string => {
    if (!k) return '–';
    const o = data?.online.find(p => p.player === k);
    return o ? `${o.name} (${k})` : k;
  };
  const xy = (x: number, y: number): string => `${x.toFixed(2)}, ${y.toFixed(2)}`;

  function render(): void {
    if (!ctx.room) { root.replaceChildren(h('div', { class: 'empty' }, 'Select a room on the left.')); return; }
    if (!data) { root.replaceChildren(h('div', { class: err ? 'msg err' : 'muted' }, err ? 'Transport: ' + err : 'Loading…')); return; }
    const d = data, D = ctx.D, b = d.dock;
    root.replaceChildren(
      h('div', { class: 'muted', style: 'margin-bottom:8px' }, `Room ${d.room} (${d.source === 'memory' ? 'loaded, live – refreshes every 2 s' : 'read from file'}) · ${fmt.when(d.tick)} · ${fmt.SEASON_EN[d.season] ?? ''}`),
      h('section', null, h('h4', null, '🛞 🛷 Vehicles (fúrik, sane – #158)'),
        h('table', null, h('tr', null, ['Vehicle', 'Bought', 'Usable', 'Where', 'Ice', 'Driver', 'Passenger', ''].map(t => h('th', null, t))),
          d.vehicles.map(v => h('tr', null,
            h('td', null, h('b', null, v.name)),
            h('td', null, v.bought ? 'yes' : 'no'),
            h('td', null, v.usable ? 'yes' : 'no', v.usable !== v.inSeason ? h('span', { class: 'badge warn' }, ' differs from the season') : null),
            h('td', null, `${D.AREA_NAMES[v.area]} ${xy(v.x, v.y)}`),
            h('td', null, `${v.ice} / ${v.cap}`),
            h('td', null, who(v.driver)), h('td', null, who(v.passenger)),
            h('td', null, v.bought && (v.driver || v.passenger) ? h('button', { onclick: () => { void cheat({ op: 'vehicle', id: v.id, act: 'release' }, `${v.name} released.`); } }, 'Release') : null))))),
      h('section', null, h('h4', null, '🛶 Dock and boat (#160)'),
        b.built
          ? h('table', null,
            h('tr', null, h('th', null, 'Boat'), h('td', null, b.flip ? `flipped on the dock (winter) – dock tiles ${b.tiles.map(t => t.x + ',' + t.y).join(' / ')}` : `${xy(b.boat.x, b.boat.y)}, heading ${(b.boat.a * 180 / Math.PI).toFixed(0)}° (moors at ${xy(b.moor.x, b.moor.y)})`)),
            h('tr', null, h('th', null, 'Seats'), h('td', null, b.seats.length ? b.seats.map((k, i) => (i ? 'passenger ' : 'rower ') + who(k)).join(' · ') : 'empty')),
            h('tr', null, h('th', null, 'Deep water'), h('td', null, `${d.deep} tiles out of reach from the shore (boat only; deep-water flowers #38 grow there)`)))
          : h('div', { class: 'muted' }, 'The dock is not built (Market → Upgrade, 800 coins, reputation 2).')),
      h('section', null, h('h4', null, 'Who uses transport'),
        d.players.filter(p => p.role).length
          ? h('table', null, d.players.filter(p => p.role).map(p => h('tr', null, h('td', null, who(p.key)), h('td', null, p.role), h('td', null, `${D.AREA_NAMES[p.area]} ${xy(p.x, p.y)}`))))
          : h('div', { class: 'muted' }, 'Nobody pushes, tows, rows or rides right now.')),
      h('section', null, h('h4', null, 'Next transport events'),
        d.events.length
          ? h('table', null, d.events.map(e => h('tr', null, h('td', null, h('code', null, e.key)), h('td', null, fmt.when(e.at)), h('td', { class: 'muted' }, fmt.inTicks(e.at - d.tick)),
            h('td', { class: 'muted' }, e.type === 'vehSeason' ? 'season start: fúrik usable spring–autumn, sane in winter' : 'midnight: winter flips the boat onto the dock, spring puts it back; an empty boat out of reach drifts back to the dock'))))
          : h('div', { class: 'muted' }, 'None scheduled (the world gets them when it loads).')),
      h('section', null, h('h4', null, 'Cheats (key from the Cheats tab)'),
        h('div', { class: 'row' },
          h('button', { onclick: () => { void cheat({ op: 'transport', act: 'reset' }, 'Everyone released: vehicles let go, the boat crew is on the shore, the boat is back at the dock.'); } }, 'Reset transport'),
          b.built ? h('button', { onclick: () => { void cheat({ op: 'boatFlip', flip: !b.flip }, b.flip ? 'Boat back on the water.' : 'Boat flipped on the dock (winter).'); } }, b.flip ? 'Boat back on the water' : 'Flip the boat (winter)') : null,
          b.built && !b.flip ? h('button', { onclick: () => { void cheat({ op: 'boat', x: b.moor.x, y: b.moor.y }, 'Boat back at the dock.'); } }, 'Boat to the dock') : null,
          d.vehicles.filter(v => v.bought).map(v => h('button', { onclick: () => { void cheat({ op: 'vehicle', id: v.id, act: 'usable' }, `${v.name}: usable toggled.`); } }, `${v.name}: toggle usable`))),
        msg,
        h('div', { class: 'muted' }, 'More (buy, teleport, ice, seat a player) in the Cheats tab. Vehicles never go onto water or the dock; a player holding or riding a vehicle cannot sit in the boat.'))
    );
  }

  render();
  void reload();
  return {
    update(c) { ctx = c; void reload(); },
    unmount() { clearInterval(timer); style.remove(); }
  };
}
