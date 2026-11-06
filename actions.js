// Akcie hráča v plánovači: každý hráč má najviac JEDNU čakajúcu akciu s kľúčom playerAction:<hráč>.
// Pohyb (arriveAt), ťuknutie na cestu (goTo), akcia na políčku (act – kopanie, sadenie, polievanie…), ísť spať
// aj rozpracované akcie (hľadanie scavDone, ťahanie hodvábu pullDone) zdieľajú ten istý kľúč, takže každá nová
// akcia čakajúcu nahradí – zrušenie budúcich udalostí netreba písať pri každej akcii zvlášť.
// Stav rozpracovanej akcie sa číta z jej čakajúcej udalosti (doing), nie z polí hráča – po nahradení nič neostane visieť.
// Keď sa akcia preruší (nahradí ju iná alebo ju zruší odchod, prechod, odhodenie…), zavolá sa jej interrupted(),
// ak ho typ má (napr. hlásenie „Prestal(a) si hľadať.“).
const E = require('./engine.js');

const PREFIX = 'playerAction:';
const KEY = pl => PREFIX + pl.key;
const types = {}; // typ → { interrupted(room, pl, ev, why) }
function define(type, def) { types[type] = def; }

// Hráč, ktorému udalosť patrí – len ak je stále pripojený a na tej istej ploche (inak sa zahodí)
function owner(room, d) {
  if (!d || !room.players) return null;
  for (const p of room.players.values()) if (p.key === d.pk) return p.id === d.id && p.areaSeq === d.seq ? p : null;
  return null;
}
function interrupt(room, pl, ev, why) {
  const t = types[ev.type];
  if (t && t.interrupted && owner(room, ev.data) === pl) t.interrupted(room, pl, ev, why);
}
// Naplánuje akciu hráča (najskôr v najbližšom kroku); čakajúca akcia sa preruší a nahradí
function schedule(room, pl, at, type, data) {
  const prev = E.pending(room, KEY(pl));
  const ev = E.scheduleUnique(room, KEY(pl), at, type, Object.assign({ pk: pl.key, id: pl.id, seq: pl.areaSeq }, data));
  if (prev) interrupt(room, pl, prev, type);
  return ev;
}
// Jednorazový úkon hráča (obchod, kotlík…): obyčajná udalosť bez kľúča – čakajúcu akciu nenahradí a nič nepreruší
function once(room, pl, at, type, data) { return E.schedule(room, at, type, Object.assign({ pk: pl.key, id: pl.id, seq: pl.areaSeq, pa: 1 }, data)); }
// Zruší čakajúcu akciu (why: 'leave', 'travel', 'sleep', 'shove'…)
function cancel(room, pl, why) {
  const prev = E.pending(room, KEY(pl));
  if (!prev) return null;
  E.cancel(room, KEY(pl));
  interrupt(room, pl, prev, why);
  return prev;
}
// Čakajúca akcia hráča (alebo null); doing(…, typ) len ak je toho typu
function current(room, pl) { const e = E.pending(room, KEY(pl)); return e && owner(room, e.data) === pl ? e : null; }
function doing(room, pl, type) { const e = current(room, pl); return e && e.type === type ? e : null; }

// Akcie aj úkony patria len bežiacemu svetu (hráči sa neukladajú s ním) – po načítaní sa zahodia.
const isRuntime = e => (!!e.key && e.key.startsWith(PREFIX)) || !!(e.data && e.data.pa);

module.exports = { PREFIX, KEY, define, owner, schedule, once, cancel, current, doing, isRuntime };
