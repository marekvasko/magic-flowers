// Rada kotlíka pri slize (#84): najbližší recept, nápoveda o chýbajúcom kvete a babkine rady s receptami
import test from 'node:test';
import assert from 'node:assert';
import * as D from '../src/shared/data.ts';
import type { SpeciesId } from '../src/shared/data.ts';
import { keys, must } from '../src/shared/util.ts';

const text = (fl: SpeciesId[], known: string[] = []): string => D.brewHintText(D.brewHint(fl, known));
const recipes = Object.keys(D.RECIPES).map(k => k.split('+'));
// koľko z kvetov fl sa zmestí do receptu r (prienik multimnožín)
const overlap = (fl: readonly string[], r: readonly string[]): number => { const left = r.slice(); let n = 0; for (const f of fl) { const j = left.indexOf(f); if (j >= 0) { n++; left.splice(j, 1); } } return n; };

test('bestRecipe: koľko kvetov sedí k najbližšiemu receptu (multimnožina, dúhový recept sa počíta)', () => {
  assert.deepStrictEqual(D.bestRecipe(['snezienka', 'konvalinka', 'mak'], []), { fit: 2, hit: ['snezienka', 'konvalinka'], rest: ['mak'], miss: 'nevadza', recipe: 'dazd', known: false });
  assert.deepStrictEqual(D.bestRecipe(['ruza', 'mak', 'ruza'], []), { fit: 2, hit: ['ruza', 'ruza'], rest: ['mak'], miss: 'tulipan', recipe: 'laska', known: false });
  assert.deepStrictEqual(D.bestRecipe(['ruza', 'tulipan', 'tulipan'], []), { fit: 2, hit: ['ruza', 'tulipan'], rest: ['tulipan'], miss: 'ruza', recipe: 'laska', known: false });
  assert.strictEqual(D.bestRecipe(['ruza', 'mak', 'mak'], []).fit, 1);
  assert.deepStrictEqual(D.bestRecipe(['cemerica', 'cemerica', 'cemerica'], []), { fit: 0, hit: [], rest: ['cemerica', 'cemerica', 'cemerica'], miss: null, recipe: null, known: false });
  assert.deepStrictEqual(D.bestRecipe(['duhova', 'duhova', 'mak'], []), { fit: 2, hit: ['duhova', 'duhova'], rest: ['mak'], miss: 'duhova', recipe: 'duha', known: false });
});

test('bestRecipe: pri zhode vyhrá recept, ktorý hráč ešte nepozná, inak poradie v RECIPES', () => {
  // levanduľa + mak sedí k hojnosti, levanduľa + harmanček k rastu
  const fl: SpeciesId[] = ['levandula', 'harmancek', 'mak'];
  assert.strictEqual(D.bestRecipe(fl, []).recipe, 'rast');
  assert.deepStrictEqual([D.bestRecipe(fl, ['harmancek+levandula+slnecnica']).recipe, D.bestRecipe(fl, ['harmancek+levandula+slnecnica']).known], ['hojnost', false]);
  const both = D.bestRecipe(fl, ['harmancek+levandula+slnecnica', 'levandula+mak+plesnivec']);
  assert.deepStrictEqual([both.recipe, both.known], ['rast', true]);
});

test('brewHint posiela len to, čo sa zobrazí: obdobia chýbajúceho kvetu, nie jeho druh; známy recept menom', () => {
  assert.deepStrictEqual(D.brewHint(['snezienka', 'konvalinka', 'mak'], []), { fit: 2, hit: ['snezienka', 'konvalinka'], clue: { seasons: [1], magic: false, other: true }, known: null });
  assert.deepStrictEqual(D.brewHint(['snezienka', 'konvalinka', 'mak'], ['konvalinka+nevadza+snezienka']), { fit: 2, hit: ['snezienka', 'konvalinka'], clue: null, known: 'dazd' });
  assert.deepStrictEqual(D.brewHint(['ruza', 'cemerica', 'cemerica'], []), { fit: 1, hit: ['ruza'], clue: null, known: null });
  assert.deepStrictEqual(D.brewHint(['duhova', 'duhova', 'mak'], []), { fit: 2, hit: ['duhova', 'duhova'], clue: { seasons: [], magic: true, other: false }, known: null });
});

test('brewHintText: dva kvety s obdobím chýbajúceho („iné“, keď zvyšný kvet má to isté obdobie), známy recept, jeden kvet, nič', () => {
  assert.strictEqual(text(['snezienka', 'konvalinka', 'mak']), 'Snežienka a konvalinka sa k sebe hodia, ale niečo tomu chýba… možno niečo iné letné?');
  assert.strictEqual(text(['snezienka', 'konvalinka', 'astra']), 'Snežienka a konvalinka sa k sebe hodia, ale niečo tomu chýba… možno niečo letné?');
  assert.strictEqual(text(['nevadza', 'konvalinka', 'mak']), 'Nevädza a konvalinka sa k sebe hodia, ale niečo tomu chýba… možno niečo zimné alebo jarné?');
  assert.strictEqual(text(['ruza', 'mak', 'ruza']), 'Dvakrát ruža – to sa k sebe hodí, ale niečo tomu chýba… možno niečo jarné?');
  assert.strictEqual(text(['duhova', 'duhova', 'mak']), 'Dvakrát dúhová ruža – to sa k sebe hodí, ale niečo tomu chýba… možno niečo čarovné?');
  assert.strictEqual(text(['snezienka', 'konvalinka', 'mak'], ['konvalinka+nevadza+snezienka']),
    'Snežienka a konvalinka sa k sebe hodia – veď sú v recepte na Dažďový odvar, ktorý už poznáš! 📜');
  assert.strictEqual(text(['snezienka', 'snezienka', 'safran']), 'Snežienka sa do nejakého receptu možno hodí, ale tieto tri spolu nie.');
  assert.strictEqual(text(['cemerica', 'cemerica', 'cemerica']), 'Fuj! Tieto kvety sa spolu vôbec neznesú. 🤢');
});

test('každý sliz z obyčajných kvetov (všetky trojice bez receptov; 4 054 s vodnými kvetmi z #38) dostane pravdivú radu', () => {
  const sp = keys(D.SPECIES).filter(k => !D.SPECIES[k].magic);
  let n = 0;
  for (let i = 0; i < sp.length; i++) for (let j = i; j < sp.length; j++) for (let k = j; k < sp.length; k++) {
    const fl = [sp[i], sp[j], sp[k]].filter(x => x !== undefined);
    if (D.RECIPES[fl.slice().sort().join('+')]) continue;
    n++;
    const m = D.bestRecipe(fl, []), h = D.brewHint(fl, []), t = D.brewHintText(h);
    assert.ok(t.length > 10 && !/undefined|null|NaN/.test(t), t);
    // fit = najväčší prienik s niektorým receptom; pomenované kvety v ňom naozaj sú
    assert.strictEqual(m.fit, Math.min(2, Math.max(...recipes.map(r => overlap(fl, r)))));
    for (const f of h.hit) assert.ok(t.includes(D.shortName(f)) || t.includes(D.shortName(f, true)), t);
    if (m.fit === 2) {
      assert.ok(m.recipe && m.miss && m.rest.length === 1);
      assert.strictEqual(D.RECIPES[[...m.hit, m.miss].sort().join('+')], m.recipe);
      // „iné“ práve vtedy, keď zvyšný vložený kvet má niektoré z obdobia v nápovede
      const rest = D.SPECIES[must(m.rest[0])], miss = D.SPECIES[m.miss];
      assert.strictEqual(t.includes('niečo iné '), miss.seasons.some(x => rest.seasons.includes(x)), t);
    }
    // rada nikdy netvrdí, že niektorý z ostatných kvetov do receptu nepatrí – len že trojica spolu nie
    assert.ok(!/ďalšie dva|ostatné nie/.test(t), t);
  }
  // trojice s opakovaním z k druhov = C(k + 2, 3); recepty z obyčajných kvetov sa nerátajú (16 druhov: 816 − 6 = 810, s vodnými 4 060 − 6)
  const all = sp.length * (sp.length + 1) * (sp.length + 2) / 6, plain = Object.keys(D.RECIPES).filter(r => r.split('+').every(f => sp.some(x => x === f))).length;
  assert.strictEqual(n, all - plain);
  assert.strictEqual(n, 4054);
});

test('babkine rady: každý recept má radu v TIPS, rady s receptami z obyčajných kvetov idú prvé, kým hráč nepozná recept', () => {
  assert.deepStrictEqual(Object.keys(D.RECIPE_TIPS).sort(), Object.keys(D.RECIPES).sort());
  for (const t of Object.values(D.RECIPE_TIPS)) assert.ok(D.TIPS.includes(t));
  assert.strictEqual(D.RECIPE_TIP_IDX.length, 6);
  assert.ok(D.RECIPE_TIP_IDX.every(i => D.TIPS[i] !== D.RECIPE_TIPS['duhova+duhova+duhova']));
  assert.match(D.RECIPE_TIPS['konvalinka+nevadza+snezienka'], /sklade/);
  assert.match(D.RECIPE_TIPS['ruza+ruza+tulipan'], /sklade/);
  assert.match(D.RECIPE_TIPS['harmancek+levandula+slnecnica'], /Rumanček/); // to isté meno ako v hre a v rade kotlíka
  // bez receptu: z ktorejkoľvek rady babka skočí na ďalšiu radu s receptom (dokola); s receptom ide po poradí
  for (let i = 0; i < D.TIPS.length; i++) {
    const n = D.nextTipIdx(i, false);
    assert.ok(D.RECIPE_TIP_IDX.includes(n));
    assert.strictEqual(n, D.RECIPE_TIP_IDX.find(j => j > i) ?? D.RECIPE_TIP_IDX[0]);
    assert.strictEqual(D.nextTipIdx(i, true), (i + 1) % D.TIPS.length);
  }
});
