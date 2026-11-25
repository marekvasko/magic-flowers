import test from 'node:test';
import assert from 'node:assert';
import * as RM from '../src/shared/robotmodel.ts';

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

test('každý štýl: kĺby majú rodiča, diely sedia na kĺboch, úchyty rúk aj chrbta existujú', () => {
  for (const s of RM.STYLE_IDS) {
    const m = RM.robotModel(RM.STYLES[s].look);
    const ids = new Set(m.joints.map(j => j.id));
    assert.strictEqual(ids.size, m.joints.length, s + ': kĺby s rovnakým menom');
    for (const j of m.joints) if (j.parent) assert.ok(ids.has(j.parent), `${s}: ${j.id} bez rodiča ${j.parent}`);
    for (const p of m.parts) assert.ok(ids.has(p.j), `${s}: diel na neznámom kĺbe ${p.j}`);
    for (const mt of Object.values(m.mounts)) assert.ok(ids.has(mt.j), `${s}: úchyt na neznámom kĺbe ${mt.j}`);
    assert.ok(m.parts.some(p => p.m === 'eye'), s + ': nemá oči');
    assert.ok(m.parts.some(p => p.tag === 'lid'), s + ': nemá viečka');
  }
});

test('rozmery: roboty stoja na zemi, vysoké 0,6–0,9 políčka, ruky po stranách (pravá na −x)', () => {
  for (const s of RM.STYLE_IDS) {
    const m = RM.robotModel(RM.STYLES[s].look);
    assert.ok(m.height >= 0.6 && m.height <= 0.9, `${s}: výška ${m.height}`);
    const top = RM.mountAt(m, null, 'top'), r = RM.mountAt(m, null, 'handR'), l = RM.mountAt(m, null, 'handL');
    assert.ok(top[1] > 0.5 && top[1] < 0.95, `${s}: temeno ${top[1]}`);
    assert.ok(r[0] < -0.1 && l[0] > 0.1, `${s}: ruky ${r[0]} ${l[0]}`);
    assert.ok(near(r[0], -l[0], 1e-6) && near(r[1], l[1], 1e-6), s + ': ruky nie sú súmerné');
    assert.ok(r[1] > 0.05 && r[1] < 0.5, `${s}: ruka vo výške ${r[1]}`);
    assert.ok(RM.mountAt(m, null, 'back')[2] < -0.1, s + ': nosič nie je na chrbte');
  }
});

test('póza: pri chôdzi sa ruka kýve a kolesá krútia, v stoji je ruka na mieste; pri tanci sú ruky hore', () => {
  for (const s of RM.STYLE_IDS) {
    const m = RM.robotModel(RM.STYLES[s].look);
    const still = RM.mountAt(m, RM.robotPose(m, { phase: 0 }), 'handR');
    const a = RM.mountAt(m, RM.robotPose(m, { phase: Math.PI / 2, walking: true }), 'handR');
    const b = RM.mountAt(m, RM.robotPose(m, { phase: -Math.PI / 2, walking: true }), 'handR');
    assert.ok(Math.abs(a[2] - b[2]) > 0.03, `${s}: ruka sa pri chôdzi nekýve`);
    assert.deepStrictEqual(RM.mountAt(m, RM.robotPose(m, { phase: 1.3 }), 'handR'), still, s + ': bez chôdze sa ruka hýbe s fázou');
    const dance = RM.mountAt(m, RM.robotPose(m, { dance: true, t: 0 }), 'handR');
    assert.ok(dance[1] > RM.mountAt(m, null, 'top')[1] - 0.15, `${s}: pri tanci ruka nie je hore (${dance[1]})`);
    if (m.wheels.length) {
      const w = RM.robotPose(m, { phase: 2, walking: true }).joints.get(m.wheels[0]?.j ?? '');
      assert.ok(w && w.r[0] > 0, s + ': koleso sa nekrúti');
    }
  }
});

test('plazenie robota prikrčí: temeno je nižšie', () => {
  for (const s of RM.STYLE_IDS) {
    const m = RM.robotModel(RM.STYLES[s].look);
    assert.ok(RM.mountAt(m, RM.robotPose(m, { crawl: true }), 'top')[1] < RM.mountAt(m, RM.robotPose(m, {}), 'top')[1] - 0.02, s);
  }
});

test('úchyt vo svete: robot pozerá v smere pohybu a', () => {
  const m = RM.robotModel(RM.STYLES.hrdzavec.look);
  const loc = RM.mountAt(m, null, 'top');
  // a = 0 → pozerá na +x: dopredu (model +z) je svetové +x, pravá ruka (model −x) je svetové +z (vpravo pri pohľade na +x)
  const w = RM.mountInWorld(m, null, 'top', 5, 1, 7, 0);
  assert.ok(near(w[0], 5 + loc[2]) && near(w[1], 1 + loc[1]) && near(w[2], 7 - loc[0]));
  const hr = RM.mountInWorld(m, null, 'handR', 0, 0, 0, 0);
  assert.ok(hr[2] > 0.1, 'pravá ruka pri pohľade na +x má byť na +z');
  // a = π/2 → pozerá na +z (ako model bez otočenia)
  const z = RM.mountInWorld(m, null, 'top', 0, 0, 0, Math.PI / 2);
  assert.ok(near(z[0], loc[0]) && near(z[2], loc[2]));
});

test('vzhľad z nedôveryhodného JSON: zlé hodnoty → predvolené hodnoty štýlu, farby malými písmenami', () => {
  assert.deepStrictEqual(RM.robotLook(null), RM.STYLES.hrdzavec.look);
  assert.deepStrictEqual(RM.robotLook({ style: 'kotul' }), RM.STYLES.kotul.look);
  const l = RM.robotLook({ style: 'kotlik', paint: '#ABCDEF', accent: 'red', eye: 5, wear: 7, acc: 'crown', extra: 1 });
  assert.deepStrictEqual(l, { ...RM.STYLES.kotlik.look, paint: '#abcdef', wear: 1 });
  assert.strictEqual(RM.robotLook({ wear: -1 }).wear, 0);
  assert.strictEqual(RM.robotLook({ style: '__proto__' }).style, 'hrdzavec');
});

test('náhodný vzhľad: rovnaké semienko = rovnaký robot, je platný a dav má rôzne štýly', () => {
  assert.deepStrictEqual(RM.randomLook(42), RM.randomLook(42));
  const looks = Array.from({ length: 40 }, (_, i) => RM.randomLook(RM.hashStr('hráč ' + i)));
  for (const l of looks) assert.deepStrictEqual(RM.robotLook(l), l);
  assert.strictEqual(new Set(looks.map(l => l.style)).size, RM.STYLE_IDS.length);
});

test('hrdza: viac ošúchaný robot má viac škvŕn, nový žiadnu; model je pre ten istý vzhľad rovnaký', () => {
  const base = RM.STYLES.hrdzavec.look;
  const rust = (wear: number): number => RM.robotModel({ ...base, wear }).parts.filter(p => p.m === 'rust').length;
  assert.strictEqual(rust(0), 0);
  assert.ok(rust(1) > rust(0.4) && rust(0.4) > 0);
  assert.deepStrictEqual(RM.robotModel(base), RM.robotModel(base));
});
