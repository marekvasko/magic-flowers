// Súbežné udalosti a akcie: čo sa stane, keď v tom istom kroku príde viac vecí naraz (plánovač, reconciler,
// akcie hráčov, ranné udalosti, NPC). Hra beží v tomto procese (server.js bez počúvania na porte) – správy hráčov
// idú tou istou cestou ako od klientov, krok posúvame sami. Každý konflikt sa skúša v oboch / všetkých poradiach.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-parallel-'));
const D = require('../shared/data.js');
const E = require('../engine.js');
const G = require('../server.js');
const TPD = D.TICKS_PER_DAY;
const rethrow = err => { throw err; };

// ---------- plánovač (engine.js) ----------
const world = extra => Object.assign({ tick: 0, wall: 0, daySeconds: 300, rng: 12345, seq: 0, events: [] }, extra);

test('plánovač: udalosť, ktorú zruší skoršia udalosť toho istého kroku, sa nevykoná (v denníku je cancel)', () => {
  const w = world(), log = [];
  const spec = { handlers: { a(w) { log.push('a'); E.cancel(w, 'b'); }, b() { log.push('b'); } }, onError: rethrow };
  E.schedule(w, 5, 'a');
  E.scheduleUnique(w, 'b', 5, 'b');
  E.advanceTo(w, 10, spec);
  assert.deepStrictEqual(log, ['a']);
  assert.deepStrictEqual(E.journal(w).list.filter(e => e.type === 'b').map(e => e.kind), ['add', 'cancel']);
});

test('plánovač: nahradenie počas dávky – nahradená udalosť toho kroku sa nevykoná, nová príde najskôr v ďalšom kroku', () => {
  const w = world(), log = [];
  const spec = {
    handlers: { a(w) { log.push('a@' + w.tick); E.scheduleUnique(w, 'k', w.tick, 'b', 2); }, b(w, d) { log.push('b' + d + '@' + w.tick); } },
    onError: rethrow
  };
  E.schedule(w, 5, 'a');
  E.scheduleUnique(w, 'k', 5, 'b', 1); // tiež v kroku 5, ale za a
  E.advanceTo(w, 10, spec);
  assert.deepStrictEqual(log, ['a@5', 'b2@6']);
  assert.deepStrictEqual(E.journal(w).list.filter(e => e.key === 'k').map(e => [e.kind, e.data]), [['add', 1], ['replace', 1], ['add', 2], ['run', 2]]);
});

test('plánovač: nezávislé udalosti v jednom kroku dajú v ľubovoľnom poradí ten istý svet', () => {
  const mk = () => world({ acc: { x: 0, y: 0, n: 0 } });
  const spec = {
    handlers: { add(w, d) { w.acc.x += d; w.acc.n++; }, mul(w, d) { w.acc.y += d * 2; w.acc.n++; } },
    onError: rethrow
  };
  const evs = Array.from({ length: 12 }, (_, i) => [i % 2 ? 'add' : 'mul', i + 1]);
  const ref = mk();
  for (const [t, d] of evs) E.schedule(ref, 7, t, d);
  E.advanceTo(ref, 7, spec);
  for (let r = 0; r < 20; r++) { // náhodné poradia (rôzne seq v tom istom kroku)
    const w = mk(), order = evs.slice().sort(() => Math.random() - 0.5);
    for (const [t, d] of order) E.schedule(w, 7, t, d);
    E.advanceTo(w, 7, spec);
    assert.deepStrictEqual(w.acc, ref.acc);
  }
});

test('plánovač: dobiehanie skokom dá to isté ako krokovanie po jednom – aj keď sa periodické a jednorazové udalosti stretnú v jednom kroku', () => {
  const run = stepwise => {
    const w = world({ log: [] });
    const spec = {
      handlers: {
        dawn(w) { w.log.push('dawn@' + w.tick + ':' + Math.floor(E.rand(w) * 100)); },
        hourly(w) { w.log.push('h@' + w.tick); },
        once(w, d) { w.log.push(d + '@' + w.tick); if (d === 'x') E.scheduleUnique(w, 'y', w.tick + TPD / 24, 'once', 'y'); }
      },
      periodic: [{ key: 'dawn', type: 'dawn', next: E.daily(0) }, { key: 'hourly', type: 'hourly', next: E.every(TPD / 24) }], onError: rethrow
    };
    E.scheduleUnique(w, 'x', TPD, 'once', 'x'); // presne na úsvit 2. dňa, ako dawn a hourly
    if (stepwise) for (let t = 1; t <= 3 * TPD; t += 97) E.advanceTo(w, t, spec);
    E.advanceTo(w, 3 * TPD, spec);
    return { log: w.log, rng: w.rng, j: E.journal(w).list.map(e => [e.kind, e.key, e.type, e.tick, e.at]) };
  };
  const a = run(false), b = run(true);
  assert.deepStrictEqual(a.log, b.log);
  assert.strictEqual(a.rng, b.rng, 'náhoda sa ťahá v rovnakom poradí');
  assert.deepStrictEqual(a.j.filter(e => e[0] === 'run'), b.j.filter(e => e[0] === 'run'), 'denník vykonaných udalostí je rovnaký');
  assert.ok(a.log.includes('x@' + TPD) && a.log.includes('y@' + (TPD + TPD / 24)));
});

test('plánovač: dva rovnaké svety s rovnakými vstupmi majú rovnaký stav aj denník (determinizmus)', () => {
  const run = () => {
    const w = world({ n: 0 });
    const spec = {
      handlers: { tick(w, d) { w.n += Math.floor(E.rand(w) * 10); if (d < 50) E.scheduleUnique(w, 'k' + (d % 3), w.tick + 1 + (w.n % 4), 'tick', d + 1); } },
      onError: rethrow
    };
    E.scheduleUnique(w, 'k0', 1, 'tick', 0);
    E.scheduleUnique(w, 'k1', 1, 'tick', 1);
    E.advanceTo(w, 500, spec);
    return { n: w.n, rng: w.rng, j: E.journal(w).list.map(({ ms, ...e }) => e) };
  };
  const a = run(), b = run();
  assert.deepStrictEqual(a, b);
  assert.ok(a.j.some(e => e.kind === 'replace'), 'nahrádzanie je súčasťou deja');
});

// ---------- hra v procese ----------
let roomN = 0;
function fakeWs() {
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, msgs: [], send(s) { ws.msgs.push(JSON.parse(s)); }, close() { if (ws.readyState === 1) { ws.readyState = 3; ws.emit('close'); } }, ping() {}, terminate() { ws.close(); } });
  return ws;
}
// Nový svet s pevnou náhodou; hráči sa pripoja ako klienti (správa join cez onConnection)
function game(names) {
  const room = G.getRoom('par' + (++roomN));
  room.rng = 4242; room.weather = 'sun';
  E.reconcile(room, G.SIM);
  const players = {};
  for (const name of names) {
    const ws = fakeWs();
    G.onConnection(ws);
    ws.emit('message', JSON.stringify({ t: 'join', room: room.id, name }));
    const pl = [...room.players.values()].find(p => p.name === name);
    pl.save.coins = 1000;
    players[name] = { ws, pl, send: m => ws.emit('message', JSON.stringify(m)), toasts: () => ws.msgs.filter(m => m.t === 'toast').map(m => m.text) };
  }
  const step = (n = 1) => E.advanceTo(room, room.tick + (n | 0), G.SIM);
  return { room, players, step };
}
const place = (p, x, y, area) => { Object.assign(p.pl, { x, y }); p.pl.save.x = x; p.pl.save.y = y; if (area) p.pl.area = p.pl.save.area = area; };
// Udalosti v kroku `at` dostanú poradie podľa zoznamu predikátov (ostatné za nimi) – iné poradie toho istého kroku
function order(room, at, preds) {
  const evs = room.events.filter(e => e.at === at);
  let seq = -1000;
  for (const pr of preds) for (const e of evs) if (pr(e)) e.seq = seq++;
  room.events.sort((a, b) => a.at - b.at || a.seq - b.seq);
}
const perms = a => a.length <= 1 ? [a] : a.flatMap((x, i) => perms(a.slice(0, i).concat(a.slice(i + 1))).map(p => [x].concat(p)));
const TILE = { x: 7, y: 31 }; // tráva pri spawne
const tileOf = room => room.tiles[TILE.y * D.W + TILE.x];
function plant(room, sp, extra) {
  const t = tileOf(room);
  t.g = 'grass';
  t.s = { k: 'normal', w: 1, r: 0, o: 'x', p: Object.assign({ sp, prog: D.SPECIES[sp].days, q: 3, dry: 0, bt: room.tick - 10 }, extra) };
  return t;
}
const flowers = (p, sp) => p.pl.save.inv['fl_' + sp] || 0;
const harvest = p => p.send({ t: 'act', x: TILE.x, y: TILE.y, item: '' });
const clone = v => JSON.parse(JSON.stringify(v));

test('zber: dvaja hráči trhajú ten istý kvet v jednom kroku – v každom poradí ho dostane práve jeden', () => {
  for (const first of ['Eva', 'Jan']) {
    const { room, players: P, step } = game(['Eva', 'Jan']);
    plant(room, 'narcis');
    place(P.Eva, TILE.x + 0.5, TILE.y + 1.5); place(P.Jan, TILE.x + 1.5, TILE.y + 1.5);
    const second = first === 'Eva' ? 'Jan' : 'Eva';
    harvest(P[first]); harvest(P[second]); // obe akcie v tom istom (najbližšom) kroku
    const at = room.tick + 1;
    assert.deepStrictEqual(room.events.filter(e => e.at === at && e.type === 'act').length, 2);
    step();
    assert.ok(flowers(P[first], 'narcis') > 0, first + ' bol prvý');
    assert.strictEqual(flowers(P[second], 'narcis'), 0);
    assert.strictEqual(tileOf(room).s.p, null, 'kvet je preč, záhon ostal');
    assert.ok(tileOf(room).s, 'záhon nikto neprekopal');
    const runs = E.journal(room).list.filter(e => e.kind === 'run' && e.type === 'act' && e.tick === at);
    assert.strictEqual(runs.length, 2, 'obe akcie sa vykonali (druhá už nemala čo trhať)');
  }
});

test('zber: druhý hráč s motykou v ruke nesmie prekopať záhon, z ktorého prvý práve odtrhol kvet', { todo: 'akcia je „políčko + vec v ruke“ – po zbere prepadne do motyky; opraví ju zámer v akcii (sloveso)' }, () => {
  const { room, players: P, step } = game(['Eva', 'Jan']);
  plant(room, 'narcis');
  P.Jan.pl.save.inv.hoe = 1;
  place(P.Eva, TILE.x + 0.5, TILE.y + 1.5); place(P.Jan, TILE.x + 1.5, TILE.y + 1.5);
  harvest(P.Eva);
  P.Jan.send({ t: 'act', x: TILE.x, y: TILE.y, item: 'hoe' }); // Ján videl kvet a ťukol naň s motykou
  step();
  assert.ok(tileOf(room).s, 'záhon ostal');
});

// Ranný krok (dawn) a zber v tom istom kroku: výsledok nezávisí od poradia
function dawnTick(room, step) {
  const at = E.pending(room, 'dawn').at;
  E.advanceTo(room, at - 1, G.SIM);
  return at;
}
function dawnAndHarvest(setup, who, ord) {
  const { room, players: P, step } = game(who);
  const at = dawnTick(room);
  setup(room);
  who.forEach((n, k) => { place(P[n], TILE.x + 0.5 + k, TILE.y + 1.5); harvest(P[n]); });
  order(room, at, ord.map(n => n === 'dawn' ? e => e.key === 'dawn' : e => e.type === 'act' && e.data.pk === P[n].pl.key));
  assert.deepStrictEqual(room.events.filter(e => e.at === at && (e.key === 'dawn' || e.type === 'act')).map(e => e.key === 'dawn' ? 'dawn' : who.find(n => P[n].pl.key === e.data.pk)), ord, 'poradie v kroku');
  step();
  const p = tileOf(room).s.p;
  return { got: Object.fromEntries(who.map(n => [n, Object.fromEntries(Object.entries(P[n].pl.save.inv).filter(([k]) => k.startsWith('fl_')))])), p: p && { sp: p.sp, prog: p.prog, q: p.q, d: p.d || 0, bt: p.bt, dry: p.dry } };
}

test('zber v kroku, keď kvet ráno odkvitne (zvädne): dá sa ešte odtrhnúť – rovnako pred aj po rannej udalosti', () => {
  const setup = room => plant(room, 'narcis', { bt: E.pending(room, 'dawn').at - D.SPECIES.narcis.life * TPD });
  const a = dawnAndHarvest(setup, ['Eva'], ['dawn', 'Eva']), b = dawnAndHarvest(setup, ['Eva'], ['Eva', 'dawn']);
  assert.ok(a.got.Eva.fl_narcis > 0, 'po rannej udalosti (už zvädnutý) ho ešte odtrhne');
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.p, null);
  // a o krok neskôr už nie (zvädnutý kvet sa netrhá)
  const { room, players: P, step } = game(['Eva']);
  const at = dawnTick(room);
  setup(room);
  place(P.Eva, TILE.x + 0.5, TILE.y + 1.5);
  step(); // ráno: zvädne
  assert.strictEqual(tileOf(room).s.p.d, 1);
  harvest(P.Eva); step();
  assert.strictEqual(flowers(P.Eva, 'narcis'), 0, 'v ďalšom kroku už je zvädnutý');
  assert.ok(at < room.tick);
});

test('zber v kroku, keď kvitnúca rastlina ráno uhynie od sucha: dá sa ešte odtrhnúť v oboch poradiach', () => {
  const setup = room => { const t = plant(room, 'narcis', { dry: 2 }); t.s.w = 0; };
  const a = dawnAndHarvest(setup, ['Eva'], ['dawn', 'Eva']), b = dawnAndHarvest(setup, ['Eva'], ['Eva', 'dawn']);
  assert.ok(a.got.Eva.fl_narcis > 0);
  assert.deepStrictEqual(a, b);
});

test('zber v kroku, keď trvalke ráno skončí kvitnutie: v oboch poradiach rovnaká rastlina aj úroda (a v ten krok už nerastie)', () => {
  const setup = room => plant(room, 'ruza', { b: 1, q: 2, bt: E.pending(room, 'dawn').at - D.SPECIES.ruza.life * TPD });
  const a = dawnAndHarvest(setup, ['Eva'], ['dawn', 'Eva']), b = dawnAndHarvest(setup, ['Eva'], ['Eva', 'dawn']);
  assert.strictEqual(a.got.Eva.fl_ruza, 2);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual([a.p.prog, a.p.q, a.p.bt, a.p.d], [D.SPECIES.ruza.days * 0.5, 3, null, 0], 'trvalka začína nové kvitnutie od polovice');
});

test('zber v kroku, keď kvet ráno rozkvitne: v tom kroku ešte nie (v žiadnom poradí), o krok neskôr áno', () => {
  const setup = room => plant(room, 'narcis', { prog: D.SPECIES.narcis.days - 1, bt: undefined });
  const a = dawnAndHarvest(setup, ['Eva'], ['dawn', 'Eva']), b = dawnAndHarvest(setup, ['Eva'], ['Eva', 'dawn']);
  assert.deepStrictEqual(a.got.Eva, {});
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.p.prog, D.SPECIES.narcis.days, 'ráno rozkvitol');
});

test('zber: zvädnutý kvet v rannom kroku a dvaja hráči – vo všetkých 6 poradiach ho dostane práve jeden a záhon je rovnaký', () => {
  const setup = room => plant(room, 'narcis', { bt: E.pending(room, 'dawn').at - D.SPECIES.narcis.life * TPD });
  const results = perms(['dawn', 'Eva', 'Jan']).map(ord => ({ ord, r: dawnAndHarvest(setup, ['Eva', 'Jan'], ord) }));
  for (const { ord, r } of results) {
    const winners = Object.entries(r.got).filter(([, inv]) => inv.fl_narcis > 0).map(([n]) => n);
    assert.strictEqual(winners.length, 1, ord.join(' → '));
    assert.strictEqual(winners[0], ord.find(n => n !== 'dawn'), 'dostane ho ten, koho akcia ide prvá: ' + ord.join(' → '));
    assert.strictEqual(r.p, null);
  }
  const n = results.map(({ r }) => Object.values(r.got).reduce((s, inv) => s + (inv.fl_narcis || 0), 0));
  assert.ok(n.every(x => x === n[0]), 'úroda je vo všetkých poradiach rovnaká');
});

test('poliatie v rannom kroku: poradie s rannou udalosťou rozhoduje o suchu', { todo: 'krhla v rannom kroku: pred dawn sa ráta do rastu, po dawn až na ďalší deň – treba pravidlo ako pri zbere' }, () => {
  const run = ord => {
    const { room, players: P, step } = game(['Eva']);
    const at = dawnTick(room);
    const t = plant(room, 'narcis', { prog: 1, bt: undefined });
    t.s.w = 0;
    P.Eva.pl.save.inv.can = 1; P.Eva.pl.save.water = 3;
    place(P.Eva, TILE.x + 0.5, TILE.y + 1.5);
    P.Eva.send({ t: 'act', x: TILE.x, y: TILE.y, item: 'can' });
    order(room, at, ord.map(n => n === 'dawn' ? e => e.key === 'dawn' : e => e.type === 'act'));
    step();
    return { dry: t.s.p.dry, prog: t.s.p.prog, w: t.s.w };
  };
  assert.deepStrictEqual(run(['dawn', 'Eva']), run(['Eva', 'dawn']));
});

test('ľad: dvaja hráči sekajú to isté políčko ľadovca v jednom kroku – pri 1 vrstve ju dostane jeden, pri 2 obaja', () => {
  for (const layers of [1, 2]) for (const first of ['Eva', 'Jan']) {
    const { room, players: P, step } = game(['Eva', 'Jan']);
    const tiles = room.hory, i = tiles.findIndex(t => t.g === 'glacier'), x = i % D.W, y = (i / D.W) | 0;
    tiles[i].ice = layers;
    // obaja pod políčkom, ďalej než 0,8 od jeho stredu (bližší hráč by bol cieľom ťuknutia – zamávanie)
    P.Eva.pl.save.inv.pick = P.Jan.pl.save.inv.pick = 1;
    place(P.Eva, x - 0.2, y + 1.6, 'hory'); place(P.Jan, x + 1.2, y + 1.6, 'hory');
    const second = first === 'Eva' ? 'Jan' : 'Eva';
    for (const n of [first, second]) P[n].send({ t: 'act', x, y, item: 'pick' });
    step();
    const got = n => P[n].pl.save.inv.ice || 0;
    assert.strictEqual(got('Eva') + got('Jan'), layers, `${layers} vrstvy → ${layers} kusy ľadu`);
    assert.strictEqual(got(first), 1, first + ' bol prvý');
    assert.strictEqual(tiles[i].ice, 0, 'nič sa nevytvorilo ani nestratilo');
    if (layers === 1) assert.ok(P[second].toasts().some(t => /vysekaný až po dno/.test(t)), 'druhý sa dozvie, že tam už nič nie je');
  }
});

test('trh: dvaja hráči kupujú posledný kompost v jednom kroku – dostane ho jeden, druhý počuje „Vypredané“, mince sedia', () => {
  for (const first of ['Eva', 'Jan']) {
    const { room, players: P, step } = game(['Eva', 'Jan']);
    room.market.compost.stock = 1;
    const second = first === 'Eva' ? 'Jan' : 'Eva';
    for (const n of [first, second]) P[n].send({ t: 'buy', id: 'compost', n: 1 });
    step();
    assert.strictEqual(room.market.compost.stock, 0);
    assert.strictEqual(P[first].pl.save.inv.compost, 1);
    assert.ok(!P[second].pl.save.inv.compost);
    assert.strictEqual(P[second].pl.save.coins, 1000, 'druhý nezaplatil');
    assert.ok(P[first].pl.save.coins < 1000);
    assert.ok(P[second].toasts().some(t => /Vypredané/.test(t)));
  }
});

test('trh: hráč a záhradník Jano kupujú semienka v jednom kroku – sklad nikdy nie je záporný a nič sa nestratí', () => {
  const sp = 'narcis';
  const outcomes = [];
  for (const ord of [['jano', 'Eva'], ['Eva', 'jano']]) {
    const { room, players: P, step } = game(['Eva']);
    Object.assign(room.market.seeds[sp], { stock: 4 });
    room.market.npcs.jano.coins = 10000;
    const at = room.tick + 1;
    E.schedule(room, at, 'npc_jano', null);
    P.Eva.send({ t: 'buy', id: 'seed_' + sp, n: 3 });
    order(room, at, ord.map(n => n === 'jano' ? e => e.type === 'npc_jano' : e => e.type === 'buy'));
    const evaBefore = P.Eva.pl.save.inv['seed_' + sp] || 0;
    step();
    const eva = (P.Eva.pl.save.inv['seed_' + sp] || 0) - evaBefore, left = room.market.seeds[sp].stock;
    const jano = room.events.filter(e => e.type === 'jano_sell' && e.data.sp === sp).reduce((s, e) => s + e.data.n / 2, 0);
    assert.ok(left >= 0, ord.join(' → '));
    assert.strictEqual(eva + jano + left, 4, 'kúpené hráčom + Janom + zvyšok = pôvodný sklad: ' + ord.join(' → '));
    outcomes.push({ ord: ord.join(' → '), eva, jano, left });
  }
  // poradie rozhoduje, kto koľko kúpi (prvý berie) – zapíšeme to, aby zmena bola vidieť
  assert.strictEqual(outcomes[1].eva, 3, 'hráč prvý: kúpi všetky 3');
});

test('akcie hráča v jednom kroku: z dvoch akcií toho istého hráča sa vykoná len posledná; akcie dvoch hráčov obe', () => {
  const { room, players: P, step } = game(['Eva', 'Jan']);
  plant(room, 'narcis');
  place(P.Eva, TILE.x + 0.5, TILE.y + 1.5); place(P.Jan, TILE.x + 3.5, TILE.y + 1.5);
  harvest(P.Eva);
  P.Eva.send({ t: 'move', x: TILE.x + 0.5, y: TILE.y + 1.8, dir: 0, ar: 0 }); // v tom istom kroku sa pohne – zber nahradí
  P.Jan.send({ t: 'move', x: TILE.x + 3.5, y: TILE.y + 1.8, dir: 0, ar: 0 });
  const at = room.tick + 1;
  step();
  assert.strictEqual(flowers(P.Eva, 'narcis'), 0, 'zber nahradil pohyb');
  assert.ok(tileOf(room).s.p, 'kvet ostal');
  assert.deepStrictEqual([P.Eva.pl.y, P.Jan.pl.y], [TILE.y + 1.8, TILE.y + 1.8], 'oba pohyby sa vykonali');
  const j = E.journal(room).list.filter(e => e.tick >= at - 1 && e.key && e.key.startsWith('playerAction:'));
  assert.deepStrictEqual(j.filter(e => e.key.endsWith(':eva')).map(e => e.kind + ' ' + e.type), ['add act', 'replace act', 'add arriveAt', 'run arriveAt']);
});

test('akcie hráča: kúpa v kroku, keď hľadanie končí, hľadanie nepreruší; pohyb v tom kroku áno', () => {
  for (const what of ['buy', 'move']) {
    const { room, players: P, step } = game(['Eva']);
    const i = room.tiles.findIndex((t, k) => t.g === 'grass' && !t.s && Math.hypot(k % D.W - 10, ((k / D.W) | 0) - 31) < 3);
    const x = i % D.W, y = (i / D.W) | 0;
    place(P.Eva, x + 0.5, y + 0.5);
    P.Eva.send({ t: 'act', x, y, item: '' });
    step();
    const done = E.pending(room, 'playerAction:eva');
    assert.strictEqual(done.type, 'scavDone');
    E.advanceTo(room, done.at - 1, G.SIM); // krok pred koncom hľadania
    if (what === 'buy') P.Eva.send({ t: 'buy', id: 'compost', n: 1 });
    else P.Eva.send({ t: 'move', x: x + 0.5, y: y + 0.9, dir: 0, ar: 0 });
    step();
    const result = P.Eva.toasts().filter(t => /Nič tu nie je|Našiel/.test(t));
    if (what === 'buy') assert.strictEqual(result.length, 1, 'hľadanie dobehlo aj s kúpou v tom istom kroku');
    else {
      assert.strictEqual(result.length, 0, 'pohyb hľadanie zrušil ešte pred jeho koncom');
      assert.ok(P.Eva.toasts().some(t => /Pohol\(a\) si sa skôr/.test(t)));
    }
  }
});

test('akcie hráča: odchod v kroku, keď hľadanie končí – hľadanie sa zruší, nič sa nevyhodnotí', () => {
  const { room, players: P, step } = game(['Eva']);
  const i = room.tiles.findIndex((t, k) => t.g === 'grass' && !t.s && Math.hypot(k % D.W - 10, ((k / D.W) | 0) - 31) < 3);
  place(P.Eva, i % D.W + 0.5, ((i / D.W) | 0) + 0.5);
  P.Eva.send({ t: 'act', x: i % D.W, y: (i / D.W) | 0, item: '' });
  step();
  const done = E.pending(room, 'playerAction:eva');
  E.advanceTo(room, done.at - 1, G.SIM);
  P.Eva.ws.close();
  step();
  assert.strictEqual(E.pending(room, 'playerAction:eva'), null);
  const j = E.journal(room).list.filter(e => e.type === 'scavDone');
  assert.deepStrictEqual(j.map(e => e.kind), ['add', 'cancel'], 'v denníku zrušené, nie vykonané');
});

test('determinizmus: ten istý priebeh hry (správy hráčov, ráno, NPC) v dvoch svetoch dá rovnaký stav aj denník', () => {
  const run = () => {
    const { room, players: P, step } = game(['Eva', 'Jan']);
    // svet vytvorený rovnako: rovnaký plán (zákazky, NPC), trh, čas a náhoda ako základný svet
    for (const k of ['market', 'contracts', 'events', 'tick', 'seq', 'rng', 'weather']) room[k] = clone(base[k]);
    const j0 = E.journal(room).list.length;
    plant(room, 'narcis');
    place(P.Eva, TILE.x + 0.5, TILE.y + 1.5); place(P.Jan, TILE.x + 1.5, TILE.y + 1.5);
    const script = [
      () => { harvest(P.Jan); harvest(P.Eva); },
      () => P.Eva.send({ t: 'buy', id: 'compost', n: 2 }),
      () => { P.Jan.send({ t: 'move', x: TILE.x + 1.5, y: TILE.y + 1.9, dir: 0, ar: 0 }); P.Eva.send({ t: 'sell', id: 'fl_narcis', n: 1 }); },
      () => P.Eva.send({ t: 'act', x: TILE.x, y: TILE.y, item: 'compost' })
    ];
    for (const s of script) { s(); step(); }
    step(TPD); // celý deň: ráno, každú hodinu, NPC
    const st = JSON.parse(G.serialize(room));
    for (const k of ['wall', 'pomedzieSeed', 'lesSeed', 'les', 'spid', 'hory']) delete st[k];
    for (const sv of Object.values(st.saves)) delete sv.lastSeen;
    // ms = reálny čas zápisu, id v dátach akcie = číslo spojenia (počítadlo naprieč svetmi), now = reálny čas príchodu
    // správy (vstup – pri prehrávaní by sa použil zapísaný) – nie sú stavom hry
    const j = E.journal(room).list.slice(j0).map(({ ms, n, ...e }) => (e.data && e.data.pk ? Object.assign({}, e, { data: Object.assign({}, e.data, { id: 0, now: 0 }) }) : e));
    return { st, j };
  };
  const base = game([]).room;
  const a = run(), b = run();
  const diff = Object.keys(a.st).filter(k => JSON.stringify(a.st[k]) !== JSON.stringify(b.st[k]));
  assert.deepStrictEqual(diff, [], 'rozdielne časti stavu');
  assert.deepStrictEqual(a.st, b.st);
  const k = a.j.findIndex((e, i) => JSON.stringify(e) !== JSON.stringify(b.j[i]));
  assert.strictEqual(k, -1, k < 0 ? '' : `denník sa líši od záznamu ${k}: ${JSON.stringify(a.j[k])} ≠ ${JSON.stringify(b.j[k])}`);
  assert.deepStrictEqual(a.j, b.j);
  assert.ok(a.j.some(e => e.type === 'dawn' && e.kind === 'run'), 'priebeh obsahuje ráno');
});
