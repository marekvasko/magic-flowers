// Studňa prianí (#100): tabuľka výsledkov so semienkom sveta, dážď bez prepadu na papraď, papraď raz za obdobie, vrecúško bez prísnych druhov.
import test from 'node:test';
import assert from 'node:assert';
import * as D from '../src/shared/data.ts';
import { entries } from '../src/shared/util.ts';
import * as E from '../src/server/engine.ts';
import * as Econ from '../src/server/economy.ts';
import * as Actions from '../src/server/actions.ts';
import { act, json, makeWorld, save, SPEC, textOf, TPD } from './game-world.ts';
import type { W } from './game-world.ts';

// Studňa (#100): n hodov za sebou v jednom kroku, výsledky podľa súkromných správ hádzajúceho
type WellOut = 'tip' | 'seeds' | 'rain' | 'calm' | 'fern' | 'kept' | 'gold' | 'potion' | 'nothing';
function throwWell(w: W, n: number, stop?: (o: WellOut) => boolean): Record<WellOut, number> {
  const c: Record<WellOut, number> = { tip: 0, seeds: 0, rain: 0, calm: 0, fern: 0, kept: 0, gold: 0, potion: 0, nothing: 0 };
  for (let k = 0; k < n; k++) {
    const text = E.commitBatch(w, [act('well', 'ana', {})], SPEC).outbox.map(textOf).join(' | ');
    const o: WellOut = /zašepkal/.test(text) ? 'tip' : /vrecúško/.test(text) ? 'seeds' : /spustil dážď/.test(text) ? 'rain'
      : /obloha ostala/.test(text) ? 'calm' : /Papraďové semienko/.test(text) ? 'fern' : /si papraď tento raz nechala/.test(text) ? 'kept'
        : /gejzír/.test(text) ? 'gold' : /fľaštička/.test(text) ? 'potion' : 'nothing';
    c[o]++;
    if (stop && stop(o)) break;
  }
  return c;
}
test('studňa: tabuľka výsledkov, dážď bez prepadu na papraď, papraď raz za obdobie, vrecúško bez prísnych druhov (#100)', () => {
  // vrecúško: len obyčajné druhy, ktoré rastú kdekoľvek
  assert.ok(!Actions.WELL_SEEDS.includes('plesnivec') && Actions.WELL_SEEDS.every(sp => !D.SPECIES[sp].magic && !D.SPECIES[sp].strict));
  assert.strictEqual(Actions.WELL_SEEDS.length, Econ.PLANTABLE.filter(sp => !D.SPECIES[sp].strict).length);
  // tabuľka so semienkom sveta: 4 000 hodov za slnečného jarného rána
  const w = makeWorld(31), sv = save(w, 'ana'); sv.coins = 1e6;
  const c = throwWell(w, 4000), share = (k: WellOut): number => c[k] / 4000;
  assert.ok(Math.abs(share('tip') - 0.45) < 0.03 && Math.abs(share('seeds') - 0.20) < 0.025, json(c));
  assert.strictEqual(c.rain, 1, 'prvý dážď zmení počasie, ďalšie hody už dážď neprivolajú');
  assert.ok(Math.abs(share('calm') - 0.10) < 0.02, 'keď dážď prísť nemôže, je to „nič“: ' + json(c));
  assert.ok(c.fern === 1 && c.kept >= 5, 'papraď len raz za obdobie, ďalšie zablysnutia si studňa nechá: ' + json(c));
  assert.ok(c.gold >= 8 && c.gold <= 35 && c.potion >= 8 && c.potion <= 35, json(c));
  assert.ok(Math.abs(share('nothing') - 0.235) < 0.03, json(c));
  assert.strictEqual(sv.inv.seed_papradie, 1);
  assert.strictEqual(sv.wellFern, Actions.seasonNo(w.tick));
  assert.ok(!sv.inv.seed_plesnivec && !sv.inv.seed_duhova, 'vo vrecúšku nie sú prísne ani čarovné druhy');
  assert.strictEqual(2 * c.seeds, entries(sv.inv).filter(([id]) => id.startsWith('seed_') && id !== 'seed_papradie').reduce((s, [, n]) => s + (n || 0), 0));
  assert.strictEqual((sv.inv.po_rast || 0) + (sv.inv.po_dazd || 0), c.potion);
  assert.strictEqual(sv.coins, 1e6 - 4000 * 5 + c.gold * Actions.WELL_GOLD);
  // v zime a keď už prší: žiadny dážď ani prepad do paprade – podiel paprade ostane okolo 0,5 %, nie 10 %
  for (const [seed, tick, weather] of [[32, D.DAWN_TICK + 6 + 3 * D.DAYS_PER_SEASON * TPD, 'sun'], [33, D.DAWN_TICK + 6, 'rain']] as const) {
    const x = makeWorld(seed, tick); x.weather = weather; save(x, 'ana').coins = 1e6;
    const k = throwWell(x, 2000);
    assert.strictEqual(k.rain, 0);
    assert.ok(k.fern + k.kept <= 25 && Math.abs(k.calm / 2000 - 0.10) < 0.025, json(k));
    assert.strictEqual(x.weather, weather);
  }
  // obdobie: papraď už v tomto období bola → nič; v ďalšom období znova
  const y = makeWorld(34), sy = save(y, 'ana'); sy.coins = 1e6; sy.wellFern = Actions.seasonNo(y.tick);
  const kept = throwWell(y, 5000, o => o === 'kept');
  assert.ok(kept.kept === 1 && kept.fern === 0 && !sy.inv.seed_papradie);
  sy.wellFern = Actions.seasonNo(y.tick) - 1;
  const got = throwWell(y, 5000, o => o === 'fern');
  assert.ok(got.fern === 1 && sy.inv.seed_papradie === 1 && sy.wellFern === Actions.seasonNo(y.tick));
  assert.strictEqual(Actions.seasonNo(D.DAYS_PER_SEASON * TPD - 1), 1);
  assert.strictEqual(Actions.seasonNo(D.DAYS_PER_SEASON * TPD), 2);
});
