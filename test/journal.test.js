const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const E = require('../engine.js');
const Journal = require('../journal.js');
const Debug = require('../debug.js');

const world = () => ({ id: 'j', tick: 10, rng: 1, seq: 0, events: [] });
const kinds = w => E.journal(w).list.map(e => [e.kind, e.key, e.type]);

test('denník: plánovač zapíše naplánovanie, nahradenie, zrušenie, vykonanie (aj s chybou) a zahodenie', () => {
  const w = world();
  const spec = { handlers: { a() {}, bum() { throw new Error('zlé'); }, dawn() {} }, periodic: [{ key: 'dawn', type: 'dawn', next: (w, f) => f + 100 }], onError() {} };
  E.scheduleUnique(w, 'move:x', 11, 'a', { x: 1 });
  E.scheduleUnique(w, 'move:x', 11, 'a', { x: 2 });
  E.schedule(w, 12, 'bum', null);
  E.scheduleUnique(w, 'pull:x', 20, 'a', null);
  E.cancel(w, 'pull:x');
  w.events.push({ at: 13, seq: 99, type: 'stary', data: null }); // typ bez handlera – reconciler ho zahodí
  E.advanceTo(w, 12, spec);
  assert.deepStrictEqual(kinds(w), [
    ['add', 'move:x', 'a'], ['replace', 'move:x', 'a'], ['add', 'move:x', 'a'], ['add', null, 'bum'], ['add', 'pull:x', 'a'], ['cancel', 'pull:x', 'a'],
    ['drop', null, 'stary'], ['add', 'dawn', 'dawn'], ['run', 'move:x', 'a'], ['run', null, 'bum']
  ]);
  const list = E.journal(w).list;
  assert.deepStrictEqual(list[1].data, { x: 1 }, 'nahradená udalosť so svojimi dátami');
  assert.strictEqual(list[6].why, 'neznámy typ');
  assert.strictEqual(list[7].periodic, true);
  assert.strictEqual(list[9].err, 'zlé', 'chyba handlera pri vykonaní');
  assert.deepStrictEqual(list.map(e => e.n), list.map((e, i) => i + 1), 'poradové čísla idú po sebe');
  assert.strictEqual(list[8].tick, 11, 'krok, v ktorom sa to stalo');
});

test('denník: dáta sú obmedzená kópia z chvíle zápisu; pamäť drží najviac JOURNAL_MAX záznamov', () => {
  const w = world();
  const d = { path: Array.from({ length: 50 }, (_, i) => i), s: 'x'.repeat(500) };
  E.schedule(w, 11, 'a', d);
  d.path.length = 0;
  const e = E.journal(w).list[0];
  assert.strictEqual(e.data.path.length, 21, '20 prvkov + koľko ďalších');
  assert.strictEqual(e.data.path[20], '… 30 more');
  assert.ok(e.data.s.length <= 201);
  for (let i = 0; i < E.JOURNAL_MAX * 1.3; i++) E.schedule(w, 11, 'a', null);
  assert.ok(E.journal(w).list.length <= E.JOURNAL_MAX * 1.2);
  assert.strictEqual(E.journal(w).list[E.journal(w).list.length - 1].n, E.JOURNAL_MAX * 1.3 + 1, 'najnovšie ostanú');
  assert.ok(!JSON.stringify(w).includes('journal'), 'denník sa neukladá so svetom');
});

test('denník: JSONL na disku – len sa dopisuje, pri veľkosti sa otočí do .1, čítanie vráti koniec aj nezapísané', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-journal-'));
  try {
    const J = Journal.create(dir, { fileMax: 2000 });
    const w = world();
    E.schedule(w, 11, 'a', { i: 1 });
    E.schedule(w, 11, 'a', { i: 2 });
    assert.strictEqual(J.flush(w), 2);
    assert.strictEqual(J.flush(w), 0, 'nič nové');
    const lines = fs.readFileSync(J.file('j'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepStrictEqual(lines.map(l => [l.n, l.kind, l.data.i, l.b]), [[1, 'add', 1, J.BOOT], [2, 'add', 2, J.BOOT]]);
    E.schedule(w, 11, 'a', { i: 3 }); // ešte nezapísaný
    assert.deepStrictEqual((await J.read('j', w)).map(e => e.data.i), [1, 2, 3]);
    assert.deepStrictEqual((await J.read('j', null)).map(e => e.data.i), [1, 2], 'svet nenačítaný – len súbor');
    for (let i = 4; i < 60; i++) { E.schedule(w, 11, 'a', { i }); J.flush(w); }
    assert.ok(fs.existsSync(path.join(dir, 'journal-j.1.jsonl')), 'starší súbor po otočení');
    assert.ok(fs.statSync(J.file('j')).size < 2000 + 400);
    const all = (await J.read('j', w)).map(e => e.data.i);
    assert.strictEqual(all[all.length - 1], 59);
    assert.deepStrictEqual(all, all.slice().sort((a, b) => a - b), 'staršie z .1 pred novšími');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('debug: denník – filter podľa kľúča (presne aj predponou), druhu a typu; kľúče hráčov nahradené odtlačkom', async () => {
  const KEY = 'tajny-kluc-hraca';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-jdebug-'));
  const debugDir = path.join(dir, 'debug'); fs.mkdirSync(debugDir);
  const w = Object.assign(world(), { id: 'zivy', saves: { [KEY]: {} }, players: new Map() });
  const J = Journal.create(dir);
  E.scheduleUnique(w, 'move:' + KEY, 11, 'arriveAt', { pk: KEY, x: 1 });
  E.scheduleUnique(w, 'spider:s1', 11, 'spider', { id: 's1' });
  E.scheduleUnique(w, 'spider:s2', 11, 'spider', { id: 's2' });
  E.schedule(w, 11, 'hourly', null);
  E.advanceTo(w, 11, { handlers: { arriveAt() {}, spider() {}, hourly() {} } });
  J.flush(w);
  const handle = Debug.create({ dataDir: dir, debugDir, rooms: new Map([['zivy', w]]), serialize: r => JSON.stringify({ saves: r.saves }), migrate: s => s, journal: id => J.read(id, w) });
  const srv = http.createServer((req, res) => { if (!handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const get = async q => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/debug/journal?id=zivy&${q}`); return { status: r.status, text: await r.text() }; };
  try {
    const all = await get('');
    assert.strictEqual(all.status, 200);
    assert.ok(!all.text.includes(KEY), 'kľúč hráča sa neukáže ani v kľúči udalosti, ani v dátach');
    const j = JSON.parse(all.text), pk = 'move:' + Debug.keyId(KEY);
    assert.strictEqual(j.total, 8);
    assert.deepStrictEqual(j.entries.map(e => e.n), [8, 7, 6, 5, 4, 3, 2, 1], 'najnovšie prvé');
    assert.deepStrictEqual(j.facets.family.map(f => [f.k, f.n]), [['spider:*', 4], ['-', 2], ['move:*', 2]]);
    const keys = async q => JSON.parse((await get(q)).text).entries.map(e => [e.kind, e.key]);
    assert.deepStrictEqual(await keys('key=' + encodeURIComponent(pk)), [['run', pk], ['add', pk]], 'presný kľúč (s odtlačkom)');
    assert.deepStrictEqual(await keys('key=spider:*&kind=run'), [['run', 'spider:s2'], ['run', 'spider:s1']], 'predpona a druh');
    assert.deepStrictEqual(await keys('key=-'), [['run', null], ['add', null]], 'bez kľúča');
    assert.deepStrictEqual(await keys('key=spider:s1,-&type=spider'), [['run', 'spider:s1'], ['add', 'spider:s1']], 'viac kľúčov a typ');
    assert.deepStrictEqual(await keys('q=%22s2%22&limit=1'), [['run', 'spider:s2']], 'text a počet');
    assert.strictEqual((await get('')).status, 200);
    assert.strictEqual((await fetch(`http://127.0.0.1:${srv.address().port}/api/debug/journal?id=..`)).status, 400);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
