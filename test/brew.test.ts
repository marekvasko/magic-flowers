// Rada kotlíka pri slize (#84): najbližší recept, nápoveda o chýbajúcom kvete a babkine rady s receptami
import test from 'node:test';
import assert from 'node:assert';
import * as D from '../src/shared/data.ts';
import type { SpeciesId } from '../src/shared/data.ts';
import { keys } from '../src/shared/util.ts';

const hint = (fl: SpeciesId[], known: string[] = []): D.BrewHint => D.brewHint(fl, known);

test('brewHint: koľko kvetov sedí k najbližšiemu receptu (multimnožina, dúhový recept sa počíta)', () => {
  assert.deepStrictEqual(hint(['snezienka', 'konvalinka', 'mak']), { fit: 2, hit: ['snezienka', 'konvalinka'], miss: 'nevadza', recipe: 'dazd', known: false });
  assert.deepStrictEqual(hint(['ruza', 'mak', 'ruza']), { fit: 2, hit: ['ruza', 'ruza'], miss: 'tulipan', recipe: 'laska', known: false });
  assert.deepStrictEqual(hint(['ruza', 'tulipan', 'tulipan']), { fit: 2, hit: ['ruza', 'tulipan'], miss: 'ruza', recipe: 'laska', known: false });
  assert.deepStrictEqual(hint(['ruza', 'mak', 'mak']).fit, 1);
  assert.deepStrictEqual(hint(['cemerica', 'cemerica', 'cemerica']), { fit: 0, hit: [], miss: null, recipe: null, known: false });
  assert.deepStrictEqual(hint(['duhova', 'duhova', 'mak']), { fit: 2, hit: ['duhova', 'duhova'], miss: 'duhova', recipe: 'duha', known: false });
});

test('brewHint: pri zhode vyhrá recept, ktorý hráč ešte nepozná, inak poradie v RECIPES', () => {
  // levanduľa + mak sedí k hojnosti, levanduľa + harmanček k rastu
  const fl: SpeciesId[] = ['levandula', 'harmancek', 'mak'];
  assert.strictEqual(hint(fl).recipe, 'rast');
  assert.strictEqual(hint(fl, ['harmancek+levandula+slnecnica']).recipe, 'hojnost');
  assert.deepStrictEqual(hint(fl, ['harmancek+levandula+slnecnica']).known, false);
  const both = hint(fl, ['harmancek+levandula+slnecnica', 'levandula+mak+plesnivec']);
  assert.deepStrictEqual([both.recipe, both.known], ['rast', true]);
});

test('brewHintText: dva kvety s obdobím chýbajúceho, známy recept menom, jeden kvet, nič', () => {
  assert.strictEqual(D.brewHintText(hint(['snezienka', 'konvalinka', 'mak'])), 'Snežienka a konvalinka sa k sebe hodia, ale niečo tomu chýba… možno niečo letné?');
  assert.strictEqual(D.brewHintText(hint(['nevadza', 'konvalinka', 'mak'])), 'Nevädza a konvalinka sa k sebe hodia, ale niečo tomu chýba… možno niečo zimné alebo jarné?');
  assert.strictEqual(D.brewHintText(hint(['ruza', 'mak', 'ruza'])), 'Dvakrát ruža – to sa k sebe hodí, ale niečo tomu chýba… možno niečo jarné?');
  assert.strictEqual(D.brewHintText(hint(['duhova', 'duhova', 'mak'])), 'Dvakrát dúhová ruža – to sa k sebe hodí, ale niečo tomu chýba… možno niečo čarovné?');
  assert.strictEqual(D.brewHintText(hint(['snezienka', 'konvalinka', 'mak'], ['konvalinka+nevadza+snezienka'])),
    'Snežienka a konvalinka sa k sebe hodia – veď sú v recepte na Dažďový odvar, ktorý už poznáš! 📜');
  assert.strictEqual(D.brewHintText(hint(['ruza', 'cemerica', 'cemerica'])), 'Ruža sem možno patrí, ale tie ďalšie dva nie.');
  assert.strictEqual(D.brewHintText(hint(['cemerica', 'cemerica', 'cemerica'])), 'Fuj! Tieto kvety sa spolu vôbec neznesú. 🤢');
});

test('každý z 810 slizov z obyčajných kvetov (816 trojíc bez 6 receptov) dostane radu; pri fit 2 chýbajúci kvet dopĺňa recept', () => {
  const sp = keys(D.SPECIES).filter(k => !D.SPECIES[k].magic);
  let n = 0;
  for (let i = 0; i < sp.length; i++) for (let j = i; j < sp.length; j++) for (let k = j; k < sp.length; k++) {
    const fl = [sp[i], sp[j], sp[k]].filter(x => x !== undefined);
    if (D.RECIPES[fl.slice().sort().join('+')]) continue;
    const h = hint(fl); n++;
    assert.ok(D.brewHintText(h).length > 10);
    if (h.fit === 2) {
      assert.ok(h.recipe && h.miss);
      const key = [...h.hit, h.miss].sort().join('+');
      assert.strictEqual(D.RECIPES[key], h.recipe);
    }
  }
  assert.strictEqual(n, 810);
});

test('babkine rady: každý recept má radu v TIPS, RECIPE_TIP_IDX sú rady s receptami z obyčajných kvetov', () => {
  assert.deepStrictEqual(Object.keys(D.RECIPE_TIPS).sort(), Object.keys(D.RECIPES).sort());
  for (const t of Object.values(D.RECIPE_TIPS)) assert.ok(D.TIPS.includes(t));
  assert.strictEqual(D.RECIPE_TIP_IDX.length, 6);
  assert.ok(D.RECIPE_TIP_IDX.every(i => D.TIPS[i] !== D.RECIPE_TIPS['duhova+duhova+duhova']));
  assert.match(D.RECIPE_TIPS['konvalinka+nevadza+snezienka'], /sklade/);
  assert.match(D.RECIPE_TIPS['ruza+ruza+tulipan'], /sklade/);
});
