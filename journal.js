// Denník udalostí na disku: append-only JSONL na svet (DATA_DIR/journal-<svet>.jsonl), jeden riadok = jedna zmena
// plánovača (engine.js: add, replace, cancel, run, drop). Engine zapisuje do pamäte, server raz za sekundu dopíše
// nové záznamy na koniec súboru. Pri FILE_MAX sa súbor premenuje na .1.jsonl (starší sa zahodí), takže svet zaberie
// najviac ≈ 2 × FILE_MAX – pohyb hráčov a pavúky zapisujú veľa a disk na hostiteľovi je spoločný.
// Súbor obsahuje kľúče hráčov (ako ukladanie sveta) – /debug ich pred zobrazením nahradí odtlačkom.
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');

const FILE_MAX = 20 * 1024 * 1024;
const READ_MAX = 4 * 1024 * 1024; // /debug číta len koniec denníka (posledné ≈ 4 MB, desaťtisíce záznamov)
const BOOT = Date.now(); // poradové čísla n začínajú pri každom štarte servera od 1 – (b, n) je jedinečné

function create(dir, opts) {
  const max = (opts && opts.fileMax) || FILE_MAX;
  const done = new WeakMap(); // svet → posledné zapísané n
  const sizes = new Map();
  const file = id => path.join(dir, 'journal-' + id + '.jsonl');
  const old = id => path.join(dir, 'journal-' + id + '.1.jsonl');

  function pending(room) {
    const last = done.get(room) || 0;
    return E.journal(room).list.filter(e => e.n > last);
  }
  // Dopíše nové záznamy sveta na koniec jeho denníka (synchrónne – poradie riadkov ostane, aj pri vypnutí servera)
  function flush(room) {
    const list = pending(room);
    if (!list.length) return 0;
    const f = file(room.id);
    let size = sizes.get(room.id);
    if (size == null) { try { size = fs.statSync(f).size; } catch (e) { size = 0; } }
    if (size >= max) { try { fs.renameSync(f, old(room.id)); } catch (e) { /* súbor ešte nie je */ } size = 0; }
    const text = list.map(e => JSON.stringify(Object.assign({ b: BOOT }, e))).join('\n') + '\n';
    try { fs.appendFileSync(f, text); } catch (e) { console.error('[journal]', room.id, e.message); return 0; }
    sizes.set(room.id, size + Buffer.byteLength(text));
    done.set(room, list[list.length - 1].n);
    return list.length;
  }
  // Koniec denníka sveta (najstaršie → najnovšie): zo súborov najviac READ_MAX bajtov, k tomu ešte nezapísané z pamäte
  async function read(id, room) {
    const parts = [];
    let left = READ_MAX;
    for (const f of [file(id), old(id)]) {
      if (left <= 0) break;
      let fh;
      try { fh = await fs.promises.open(f, 'r'); } catch (e) { continue; }
      try {
        const { size } = await fh.stat(), n = Math.min(size, left), buf = Buffer.alloc(n);
        await fh.read(buf, 0, n, size - n);
        let text = buf.toString('utf8');
        if (n < size) text = text.slice(text.indexOf('\n') + 1); // prvý riadok môže byť odrezaný
        parts.unshift(text);
        left -= n;
      } finally { await fh.close(); }
    }
    const out = [];
    for (const text of parts) for (const line of text.split('\n')) { if (line) try { out.push(JSON.parse(line)); } catch (e) { /* rozbitý riadok */ } }
    if (room) for (const e of pending(room)) out.push(Object.assign({ b: BOOT }, e));
    return out;
  }
  return { flush, read, file, BOOT };
}

module.exports = { create, FILE_MAX, READ_MAX };
