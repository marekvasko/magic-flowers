import test from 'node:test';
import assert from 'node:assert';
import { SKY_KEYS, luma, overcast, skyLight } from '../src/client/skylight.ts';
import type { SkyLight } from '../src/client/skylight.ts';

const colors = (L: SkyLight): (readonly number[])[] => [L.ambSky, L.ambGround, L.sun, L.zenith, L.horizon, [L.glow]];
const at = (h: number): SkyLight => skyLight(h * 60);

test('skyLight: kľúče idú po sebe a deň sa uzavrie (polnoc = polnoc)', () => {
  for (let i = 1; i < SKY_KEYS.length; i++) assert.ok((SKY_KEYS[i]?.h ?? 0) > (SKY_KEYS[i - 1]?.h ?? 0), `kľúč ${i}`);
  assert.strictEqual(SKY_KEYS[0]?.h, 0);
  assert.strictEqual(SKY_KEYS[SKY_KEYS.length - 1]?.h, 24);
  assert.deepStrictEqual(skyLight(0), skyLight(1440));
  assert.deepStrictEqual(skyLight(-60), skyLight(1380));
});

test('skyLight: farby v rozsahu 0–1 a bez skokov z minúty na minútu', () => {
  let prev = skyLight(0);
  for (let m = 0; m <= 1440; m += 0.5) {
    const L = skyLight(m);
    for (const c of colors(L)) for (const v of c) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${m}: ${v}`);
    const before = colors(prev);
    colors(L).forEach((c, i) => { c.forEach((v, j) => { assert.ok(Math.abs(v - (before[i]?.[j] ?? v)) < 0.03, `skok v ${m}`); }); });
    prev = L;
  }
});

test('skyLight: v noci nesvieti slnko, svetlo od zeme je vždy slabšie než z oblohy', () => {
  for (const h of [0, 2, 3.5, 22.5, 23.5]) assert.deepStrictEqual(at(h).sun, [0, 0, 0], `${h} h`);
  for (let m = 0; m < 1440; m += 10) { const L = skyLight(m); assert.ok(luma(L.ambGround) < luma(L.ambSky), `${m}`); }
});

test('skyLight: východ a západ sú oranžové, poludnie neutrálne a ostrejšie', () => {
  const warm = (c: readonly [number, number, number]): number => c[0] / Math.max(0.01, c[2]);
  const noon = at(12.5), rise = at(5.5), set = at(20.6);
  for (const L of [rise, set]) {
    assert.ok(warm(L.sun) > 2.5, 'slnko pri obzore je oranžové');
    assert.ok(warm(L.horizon) > 1.5, 'obzor je teplý');
    assert.ok(L.glow > 0.8, 'žiara pri obzore');
  }
  assert.ok(warm(noon.sun) < 1.25, 'na poludnie je slnko takmer biele');
  assert.ok(noon.ambSky[2] > noon.ambSky[0], 'cez deň je okolie z oblohy modrasté');
  assert.ok(noon.zenith[2] > noon.zenith[0] * 2, 'modrá obloha');
  assert.strictEqual(noon.glow, 0);
  // ostrejšie: pomer slnko / okolie je na poludnie vyšší než ráno
  const ratio = (L: SkyLight): number => luma(L.sun) / luma(L.ambSky);
  assert.ok(ratio(noon) > ratio(at(8.5)) && ratio(noon) > ratio(rise));
  // modrá hodinka pred východom: ešte bez slnka, ale svetlejšia a modrejšia než noc
  const blue = at(4.8);
  assert.deepStrictEqual(blue.sun, [0, 0, 0]);
  assert.ok(luma(blue.ambSky) > luma(at(2).ambSky) && blue.ambSky[2] > blue.ambSky[0]);
});

test('overcast: zachová jas a k = 1 je šedá', () => {
  const c: [number, number, number] = [0.9, 0.5, 0.2];
  const g = overcast(c, 1);
  assert.ok(Math.abs(luma(g) - luma(c)) < 1e-9);
  assert.ok(Math.abs(g[0] - g[2]) < 1e-9);
  assert.deepStrictEqual(overcast(c, 0), c);
});
