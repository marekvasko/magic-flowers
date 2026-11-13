import test from 'node:test';
import assert from 'node:assert';
import * as W from '../src/shared/world3d.ts';
import * as MS from '../src/shared/mesher.ts';
import { bakeFine, atlasRects, hex, FACE_SHADE } from '../src/client/finebake.ts';
import { atlasPixels, meshStats, quadAt } from '../src/debug/tabs/mesher-core.ts';
import { must } from './helpers.ts';

const models = (): W.FineModel[] => ['house', 'well', 'tree-' + must(W.TREE_KINDS[0])].map(id => must(W.FINE_MODELS.find(m => m.id === id))).map(e => e.build(1, 0));

test('bakeFine: obdĺžniky v obrázkoch sedia s farbou steny prvej minikocky', () => {
  for (const f of models()) {
    const b = bakeFine(f, 1), r = atlasRects(b);
    assert.strictEqual(b.color.data.length, b.color.W * b.color.H * 4);
    assert.strictEqual(b.ao.data.length, b.ao.W * b.ao.H);
    b.quads.forEach((q, k) => {
      const c = must(r.color[k]), a = must(r.ao[k]);
      assert.ok(c.x >= 1 && c.y >= 1 && c.x + c.w <= b.color.W - 1 && c.y + c.h <= b.color.H - 1, 'farba v obrázku s okrajom');
      assert.ok(a.x >= 1 && a.y >= 1 && a.x + a.w <= b.ao.W - 1 && a.y + a.h <= b.ao.H - 1, 'zatienenie v obrázku s okrajom');
      assert.deepStrictEqual([a.w, a.h], [q.w + 1, q.h + 1]);
      // texel (x, y) obdĺžnika = minikocka (u, v) roviny d
      const p: MS.Vec3 = [0, 0, 0], [, ua, va] = MS.AXES[q.ax];
      p[q.ax] = q.d; p[ua] = q.u; p[va] = q.v;
      const m = must(f.data[(p[2] * f.sy + p[1]) * f.sx + p[0]]), col = hex(W.colorOf(m, 1)), sh = must(FACE_SHADE[MS.faceIndex(q)]);
      const vary = 0.94 + W.hash(p[0], p[1], p[2]) * 0.12, o = (c.y * b.color.W + c.x) * 4;
      assert.strictEqual(b.color.data[o], Math.round(Math.min(1, col[0] * vary) * sh * 255));
      assert.strictEqual(b.color.data[o + 3], W.EMISSIVE[m] ? 255 : 0);
    });
  }
});

test('mesherview: pixely sú nepriehľadné, počty a hľadanie obdĺžnika', () => {
  const f = must(models()[0]), b = bakeFine(f, 1), r = atlasRects(b);
  for (const which of ['color', 'emission', 'ao'] as const) {
    const { W: w, H, px } = atlasPixels(b, which, true);
    assert.strictEqual(px.length, w * H * 4);
    for (let i = 3; i < px.length; i += 4) assert.strictEqual(px[i], 255);
  }
  const s = meshStats(f, b);
  assert.ok(s.quads > 0 && s.quads < s.voxelFaces, 'zlúčenie zmenší počet stien');
  assert.strictEqual(s.trisAfter, b.I.length / 3);
  const k = 5, c = must(r.color[k]);
  assert.strictEqual(quadAt(r.color, c.x + c.w - 1, c.y + c.h - 1), k);
  assert.strictEqual(quadAt(r.color, 0, 0), -1); // okraj
});
