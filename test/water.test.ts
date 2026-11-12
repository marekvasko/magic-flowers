// Vodné kvety (#38): zóny vody (breh / hĺbka), sadenie do jazierka a plesa, rast, zber, povolenie, uloženie hôr
// a to, že NPC, zákazky, divé semienka ani studňa vodné druhy nevyberú.
import test from 'node:test';
import assert from 'node:assert';
import * as D from '../src/shared/data.ts';
import type { AreaId, SpeciesId } from '../src/shared/data.ts';
import type { Icehouse, PlayerSave, Soil } from '../src/shared/save.ts';
import * as E from '../src/server/engine.ts';
import * as Econ from '../src/server/economy.ts';
import * as Events from '../src/server/events.ts';
import * as Actions from '../src/server/actions.ts';
import * as I from '../src/server/items.ts';
import * as Ice from '../src/server/ice.ts';
import * as Scav from '../src/server/scavenge.ts';
import type { GameWorld, Msg } from '../src/server/game.ts';
import type { Presence } from '../src/server/world.ts';
import { isRecord } from '../src/shared/util.ts';
import { SAVE_V11 } from './save-v11.fixture.ts';
import { must, parseJson, partial, rethrow, testWorld } from './helpers.ts';
const TPD = D.TICKS_PER_DAY;

type W = GameWorld & { presence?: Presence[] | undefined };
// svet v obdodí se (0 jar, 1 leto…), ana stojí v záhrade
function makeWorld(se: number): W {
  const w = testWorld<Partial<GameWorld> & { presence?: Presence[] }>({
    tick: se * D.DAYS_PER_SEASON * TPD + D.DAWN_TICK + 6, wall: 0, daySeconds: 1200, seed: 'voda', step: 0, seq: 0, events: [],
    weather: 'sun', saves: {}, storage: {}, storageFb: {}, market: null, contracts: null, fairyNight: -1, eternal: false, scav: {}, scavSalt: 4242,
    icehouse: partial<Icehouse>({ built: true, ice: 0 }), up: { plots: 0 }, glacierFed: -1, plotsUsed: 0, maxRep: 0,
    tiles: D.buildMap().map(g => ({ g, s: null })), hory: Ice.loadHory(null)
  });
  Ice.applyIcehouse(w.icehouse, w.tiles);
  Econ.initEconomy(w);
  w.saves['ana'] = partial<PlayerSave>({ coins: 500, water: 5, inv: { hoe: 1, can: 1 }, fb: {}, recipes: [], seen: [], vily: 0, rep: 0, up: { can: 0, composter: 0 }, area: 'garden' });
  w.presence = [{ key: 'ana', name: 'Ana', area: 'garden', x: 10.5, y: 30.5, scav: null }];
  return w;
}
const SPEC: E.Spec<W, Presence, Msg> = { proposers: { ...Events.PROPOSERS, ...Actions.PROPOSERS }, periodic: Events.PERIODIC, presence: w => w.presence, onError: rethrow };
let seq = 0;
const act = <T extends keyof Actions.ActionInputs>(type: T, data: Partial<Omit<Actions.ActionInputs[T], 'key'>>): E.Input => ({ type, data: Object.assign({ key: 'ana' }, data), id: 'v#' + (++seq), actor: 'ana' });
const dawn = (w: W): void => { w.tick += TPD; E.commitBatch(w, [{ type: 'dawn', data: null, id: 'd#' + (++seq) }], SPEC); };
const ana = (w: GameWorld): PlayerSave => must(w.saves['ana']);
const idx = (x: number, y: number): number => y * D.W + x;
// prvé políčko vody plochy area v zóne zone
const spot = (area: AreaId, zone: D.WaterZone): number => {
  const g = D.buildArea(area, 0), i = g.findIndex((t, j) => D.waterSpot(area, j)?.zone === zone);
  assert.ok(i >= 0 && g[i] === 'water');
  return i;
};
function plantIn(w: W, area: AreaId, i: number, sp: SpeciesId): string | null | undefined {
  I.addItems(I.playerC(ana(w)), `seed_${sp}`, 1, w.tick);
  const r = E.commitBatch(w, [act('plant', area === 'garden' ? { i, item: `seed_${sp}` } : { i, item: `seed_${sp}`, area })], SPEC);
  return r.rejected[0]?.reject;
}

test('zóny vody: breh má súš aspoň z jednej zo 4 strán – jazierko 36 + 47 (väčšie jazierko, #160), pleso 10 + 6; inde voda na sadenie nie je', () => {
  const count = (area: AreaId): [number, number] => {
    const g = D.buildArea(area, 0), z = g.map((t, i) => D.waterSpot(area, i)?.zone);
    return [z.filter(v => v === 'shore').length, z.filter(v => v === 'deep').length];
  };
  assert.deepStrictEqual(count('garden'), [36, 47]);
  assert.deepStrictEqual(count('hory'), [10, 6]);
  assert.deepStrictEqual(D.waterSpot('garden', idx(3, 14)), { body: 'jazierko', zone: 'deep' }, 'stred jazierka');
  assert.deepStrictEqual(D.waterSpot('hory', idx(5, 16)), { body: 'pleso', zone: 'deep' });
  assert.strictEqual(D.waterSpot('garden', idx(10, 30)), null, 'tráva nie je voda');
  assert.strictEqual(D.waterSpot('pomedzie', 0), null);
  // uhlopriečka sa neráta: voda obklopená vodou zo 4 strán je hĺbka, aj keď má súš na rohu
  const tiles = (['grass', 'water', 'water', 'water', 'water', 'water', 'water', 'water', 'water'] as const).map(g => ({ g }));
  assert.strictEqual(D.waterZone(tiles, 4, 3), 'deep');
  assert.strictEqual(D.waterZone(tiles, 1, 3), 'shore');
  assert.strictEqual(D.waterZone(tiles, 0, 3), null);
});

test('druhy: 12 vodných kvetov; každý má vodnú plochu a zónu, tajomnú nápovedu, ak sa zatiaľ nedá zasadiť; na trhu za bežné ceny', () => {
  const aqua = (Object.keys(D.SPECIES) as SpeciesId[]).filter(D.isAqua);
  assert.strictEqual(aqua.length, 12);
  for (const sp of aqua) {
    const a = must(D.SPECIES[sp].aqua);
    assert.ok(a.in.length > 0);
    assert.ok(D.SHOP.includes(`seed_${sp}`) && D.PRICES[`seed_${sp}`] === D.SPECIES[sp].seed, sp + ' je na trhu');
    const hint = D.aquaHint(a);
    assert.doesNotMatch(hint, /zatiaľ|implement|neskôr/i, 'nápoveda neprezrádza, že to v hre ešte nie je');
    assert.strictEqual(/Kam sa k nim dostaneš\?/.test(hint), !D.aquaReachable(a), sp);
  }
  // päť scenárov: len jazierko, jazierko aj pleso, len pleso, potok, mŕtve rameno
  const where = (sp: SpeciesId): string[] => must(D.SPECIES[sp].aqua).in.filter(b => D.WATER_BODIES[b].area).sort();
  assert.deepStrictEqual(where('lekno'), ['jazierko']);
  assert.deepStrictEqual(where('mociarka'), ['jazierko', 'pleso']);
  assert.deepStrictEqual(where('iskernik'), ['pleso']);
  assert.deepStrictEqual([where('riecna'), where('kotvica')], [[], []]);
  assert.match(D.aquaHint(must(D.SPECIES.riecna.aqua)), /tečúcej vode/);
  assert.match(D.aquaHint(must(D.SPECIES.kotvica.aqua)), /mŕtvych ramenách/);
});

test('sadenie do jazierka: bez motyky, správna zóna a obdobie, zaberie miesto v povolení; zlé miesto dá slovenskú správu', () => {
  const w = makeWorld(0), shore = spot('garden', 'shore'), deep = spot('garden', 'deep');
  assert.strictEqual(plantIn(w, 'garden', shore, 'kosatec'), undefined);
  const s = must(must(w.tiles[shore]).s ?? undefined);
  assert.deepStrictEqual([s.k, s.w, must(s.p ?? undefined).sp, w.plotsUsed, Econ.plotsUsedOf(w.tiles, w.hory)], ['water', 1, 'kosatec', 1, 1]);
  assert.match(plantIn(w, 'garden', deep, 'kosatec') ?? '', /rastie len pri brehu/);
  assert.match(plantIn(w, 'garden', spot('garden', 'shore') + 1, 'mociarka') ?? '', /potrebuje hlbokú vodu/);
  assert.strictEqual(plantIn(w, 'garden', deep, 'mociarka'), undefined, 'jarná močiarka do hĺbky');
  assert.match(plantIn(w, 'garden', deep + 1, 'iskernik') ?? '', /^Iskerník zakoreňujúci tu nevyrastie\. .*horskom plese/);
  assert.match(plantIn(w, 'garden', deep + 1, 'kotvica') ?? '', /mŕtvych ramenách.*Kam sa k nim dostaneš\?/);
  assert.match(plantIn(w, 'garden', deep + 1, 'lekno') ?? '', /sadí v období: Leto/);
  assert.match(plantIn(w, 'garden', deep + 1, 'tulipan') ?? '', /vo vode nevyrastie/);
  // vodné semienko na súši (aj na prekopanej zemi)
  const land = w.tiles.findIndex(t => t.g === 'grass');
  must(w.tiles[land]).s = { k: 'normal', w: 0, r: 0, p: null, o: 'ana' };
  assert.match(plantIn(w, 'garden', land, 'kosatec') ?? '', /je vodná rastlina – sadí sa priamo do vody/);
  assert.strictEqual(plantIn(w, 'garden', shore, 'zaruzlie'), null, 'obsadené políčko');
  // plné povolenie
  w.plotsUsed = Econ.plotLimit(w.up);
  assert.match(plantIn(w, 'garden', must(w.tiles.findIndex((t, i) => t.g === 'water' && !t.s && D.waterSpot('garden', i)?.zone === 'shore')), 'zaruzlie') ?? '', /povolenie/);
});

test('act: na vode semienko sadí, motyka odstráni uhynutú rastlinu, krhla stále naberá, krompáč v zime seká ľad; v plese tiež', () => {
  const w = makeWorld(0), shore = spot('garden', 'shore'), me = must(must(w.presence)[0]);
  const bank = must([shore - 1, shore + 1, shore - D.W, shore + D.W].find(j => D.passable(w.tiles[j]))); // súš vedľa brehu
  me.x = bank % D.W + 0.5; me.y = Math.floor(bank / D.W) + 0.5;
  const inv = ana(w).inv;
  inv.seed_kosatec = 1; inv.wild_0 = 1; inv.compost = 1; inv.pick = 1;
  const r = (item: string, i?: number, who?: Presence): ReturnType<typeof Actions.resolveAct> => Actions.resolveAct(w, w.presence, who || me, { x: (i ?? shore) % D.W, y: Math.floor((i ?? shore) / D.W), item });
  assert.deepStrictEqual(r('seed_kosatec'), { type: 'plant', data: { key: 'ana', i: shore, item: 'seed_kosatec' } });
  assert.match(JSON.stringify(r('wild_0')), /Divé semienko vo vode nevyrastie/);
  assert.match(JSON.stringify(r('compost')), /kompost nepotrebujú/);
  assert.match(JSON.stringify(r('can')), /drawWater/);
  must(w.tiles[shore]).s = { k: 'water', w: 1, r: 0, o: 'ana', p: { sp: 'kosatec', prog: 1, q: 3, dry: 0, d: 1 } };
  assert.deepStrictEqual(r('hoe'), { type: 'clear', data: { key: 'ana', i: shore } });
  assert.match(JSON.stringify(r('can')), /drawWater/, 'krhla naberie aj z políčka s kvetom');
  assert.match(JSON.stringify(r('pick')), /digIce/);
  // pleso: hráč na brehu plesa
  const hs = spot('hory', 'shore'), hb = must([hs - 1, hs + 1, hs - D.W, hs + D.W].find(j => D.passable(w.hory[j])));
  const hp: Presence = { ...me, area: 'hory', x: hb % D.W + 0.5, y: Math.floor(hb / D.W) + 0.5 };
  inv.seed_zaruzlie = 1;
  assert.deepStrictEqual(r('seed_zaruzlie', hs, hp), { type: 'plant', data: { key: 'ana', i: hs, item: 'seed_zaruzlie', area: 'hory' } });
  must(w.hory[hs]).s = { k: 'water', w: 1, r: 0, o: 'ana', p: { sp: 'zaruzlie', prog: D.SPECIES.zaruzlie.days, q: 3, dry: 0 } };
  assert.deepStrictEqual(r('', hs, hp), { type: 'pick', data: { key: 'ana', i: hs, area: 'hory' } });
  assert.match(JSON.stringify(r('hoe', hb, hp)), /V horách je pôda kamenistá/, 'na súši v horách sa stále nepestuje');
});

test('pleso: kvet rastie každé ráno bez zálievky, kvitne, zber dá kvety; jednoročný uvoľní miesto, trvalka ostane; mráz ho zničí', () => {
  const w = makeWorld(0), shore = spot('hory', 'shore'), deep = spot('hory', 'deep');
  assert.strictEqual(plantIn(w, 'hory', shore, 'zaruzlie'), undefined);
  assert.strictEqual(plantIn(w, 'hory', deep, 'mociarka'), undefined);
  assert.strictEqual(w.plotsUsed, 2);
  for (let d = 0; d < D.SPECIES.zaruzlie.days; d++) dawn(w);
  for (const i of [shore, deep]) {
    const p = must(must(w.hory[i]).s?.p ?? undefined);
    assert.ok(!p.d && p.prog >= D.SPECIES[p.sp].days, `${p.sp} kvitne (${JSON.stringify(p)})`);
    assert.strictEqual(must(w.hory[i]).s?.w, 1, 'voda je vždy „poliata“');
  }
  let r = E.commitBatch(w, [act('pick', { i: deep, area: 'hory' }), act('pick', { i: shore, area: 'hory' })], SPEC);
  assert.deepStrictEqual(r.rejected, []);
  assert.deepStrictEqual([ana(w).inv.fl_mociarka, ana(w).inv.fl_zaruzlie], [3, 3]);
  assert.strictEqual(must(w.hory[deep]).s, null, 'jednoročná močiarka po zbere zmizne');
  assert.strictEqual(must(must(w.hory[shore]).s?.p ?? undefined).sp, 'zaruzlie', 'trvalka ostáva');
  assert.deepStrictEqual([w.plotsUsed, Econ.plotsUsedOf(w.tiles, w.hory)], [1, 1]);
  assert.ok(r.outbox.some(m => typeof m.to === 'object' && 'area' in m.to && m.to.area === 'hory' && m.t === 'fx'), 'efekt zberu vidia hráči v horách');
  // zima: mráz zničí aj vodný kvet; motyka ho odstráni a uvoľní miesto
  w.tick = 3 * D.DAYS_PER_SEASON * TPD + D.DAWN_TICK + 6 - TPD;
  dawn(w);
  assert.strictEqual(must(must(w.hory[shore]).s?.p ?? undefined).why, 'mráz');
  r = E.commitBatch(w, [act('clear', { i: shore, area: 'hory' })], SPEC);
  assert.deepStrictEqual([r.rejected, must(w.hory[shore]).s, w.plotsUsed], [[], null, 0]);
});

test('jazierko: ráno v slnečnom dni sa vodné políčko „nevysuší“ (w = 1), zemné áno; uloženie hôr drží kvety v plese', () => {
  const w = makeWorld(1), deep = spot('garden', 'deep');
  assert.strictEqual(plantIn(w, 'garden', deep, 'lekno'), undefined);
  const land = w.tiles.findIndex(t => t.g === 'grass');
  must(w.tiles[land]).s = { k: 'normal', w: 1, r: 0, p: null, o: 'ana' };
  const weather = (): string => w.weather; // ráno ho zmení
  for (let n = 0; n < 20; n++) { dawn(w); if (weather() === 'sun') break; }
  assert.strictEqual(weather(), 'sun');
  assert.deepStrictEqual([must(w.tiles[deep]).s?.w, must(w.tiles[land]).s?.w], [1, 0]);
  // uloženie a načítanie hôr (JSON)
  const hs = spot('hory', 'shore');
  assert.strictEqual(plantIn(w, 'hory', hs, 'iskernik'), undefined);
  const back = Ice.loadHory(parseJson<unknown>(JSON.stringify(Ice.saveHory(w.hory))));
  assert.deepStrictEqual(back[hs]?.s, w.hory[hs]?.s);
  assert.strictEqual(back.filter(t => t.s).length, 1);
  // neplatná pôda v uložení sa zahodí (súš alebo neznámy druh)
  const bad = JSON.parse(JSON.stringify(Ice.saveHory(w.hory))) as unknown[];
  bad[hs] = { s: { k: 'water', w: 1, r: 0, o: 'ana', p: { sp: 'bodliak', prog: 0, q: 3, dry: 0 } } };
  bad[0] = { s: { k: 'water', w: 1, r: 0, o: 'ana', p: { sp: 'lekno', prog: 0, q: 3, dry: 0 } } };
  assert.strictEqual(Ice.loadHory(bad).filter(t => t.s).length, 0);
});

test('vodné druhy si nevyberie Jano, zákazky, divé semienka, studňa ani štartové semienka nového hráča', () => {
  for (const se of [0, 1, 2, 3] as const) assert.ok(Scav.wildCandidates(se).every(sp => !D.isAqua(sp)));
  assert.ok(Actions.WELL_SEEDS.every(sp => !D.isAqua(sp)));
  for (let t = 0; t < 4 * D.DAYS_PER_SEASON; t++) {
    const sv = Actions.newSave(t * TPD + D.DAWN_TICK, { coins: 30, rep: 0 });
    assert.ok(Object.keys(sv.inv).every(id => !id.startsWith('seed_') || !D.isAqua(must(D.speciesOfItem(id) ?? undefined))));
  }
  // rok sveta: Jano kupuje a zákazky vznikajú, ale nikdy s vodným kvetom
  const w = makeWorld(0);
  E.reconcile(w, SPEC);
  const contracts = new Set<SpeciesId>(), jano = new Set<SpeciesId>();
  const spy: E.Spec<W, Presence, Msg> = { ...SPEC, onBatch: x => {
    for (const c of x.contracts?.list ?? []) contracts.add(c.sp);
    for (const e of x.events) { const sp: unknown = e.type === 'jano_sell' && isRecord(e.data) ? e.data['sp'] : null; if (typeof sp === 'string' && D.isSpeciesId(sp)) jano.add(sp); }
  } };
  E.advanceTo(w, w.tick + 4 * D.DAYS_PER_SEASON * TPD, spy);
  assert.ok(contracts.size > 3 && jano.size > 1, `zákazky ${String(contracts.size)}, Jano ${String(jano.size)}`);
  assert.deepStrictEqual([...contracts, ...jano].filter(D.isAqua), []);
});

test('uložený trh spred vodných kvetov (v11): pri načítaní dostane ich položky, takže dodávka, NPC, ráno aj nákup a predaj fungujú', () => {
  const w = makeWorld(1), old = parseJson<NonNullable<GameWorld['market']>>(JSON.stringify(SAVE_V11.market));
  assert.strictEqual(old.seeds.lekno, undefined, 'fixture je spred #38');
  w.market = old;
  Econ.initEconomy(w); // ako getRoom v server.ts pri načítaní
  for (const sp of Object.keys(D.SPECIES) as SpeciesId[]) if (D.isAqua(sp)) assert.ok(w.market.seeds[sp] && w.market.flowers[sp], sp);
  assert.strictEqual(w.market.seeds.mak?.stock, SAVE_V11.market.seeds.mak.stock, 'staré položky ostanú');
  const ev = (type: string): E.Input => ({ type, data: null, id: 'e#' + (++seq) });
  E.commitBatch(w, [ev('delivery'), ev('npc_jano'), ev('npc_fero'), ev('npc_zuzka')], SPEC);
  dawn(w);
  I.addItems(I.playerC(ana(w)), 'fl_lekno', 2, w.tick);
  const r = E.commitBatch(w, [act('buy', { id: 'seed_lekno', n: 1 }), act('sell', { id: 'fl_lekno', n: 2 })], SPEC);
  assert.deepStrictEqual(r.rejected, []);
  assert.deepStrictEqual([ana(w).inv.seed_lekno, ana(w).inv.fl_lekno ?? 0], [1, 0]);
});

test('každý vodný kvet zasadený v 1. deň svojho obdobia stihne zakvitnúť – bez kompostu, ktorý sa do vody nedáva', () => {
  for (const sp of (Object.keys(D.SPECIES) as SpeciesId[]).filter(D.isAqua)) for (const se of D.SPECIES[sp].seasons) {
    const zone = must(D.SPECIES[sp].aqua).zone, i = spot('garden', zone); // na vodnej ploche rast nezávisí
    const tiles = D.buildMap().map((g): { g: D.Ground; s: Soil | null } => ({ g, s: null }));
    must(tiles[i]).s = { k: 'water', w: 1, r: 0, o: 'ana', p: { sp, prog: 0, q: 3, dry: 0 } };
    const day0 = se * D.DAYS_PER_SEASON + 1;
    let bloom = 0;
    for (let day = day0 + 1; day <= day0 + D.DAYS_PER_SEASON + 2 && !bloom; day++) {
      Events.growPlant(tiles, i, (day - 1) * TPD + D.DAWN_TICK, D.seasonOf(day), false);
      const p = must(must(tiles[i]).s?.p ?? undefined);
      assert.ok(!p.d, `${sp} (${must(D.SEASONS[se])}) uhynul ${String(day - day0)}. deň: ${p.why ?? ''}`);
      if (p.prog >= D.SPECIES[sp].days) bloom = day - day0;
    }
    assert.ok(bloom > 0, `${sp} (${must(D.SEASONS[se])}) nezakvitne`);
  }
});
