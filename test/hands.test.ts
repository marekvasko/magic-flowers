// Ruka postavičky pre lano saní (#158): shared/charpose.ts handAt – tá istá ruka, ktorú kreslí Art.char (art.ts kreslí
// ruky z handsOf tej istej pózy). Kontrola pre všetkých 8 smerov, mávanie pri chôdzi, tanec a plazenie.
import test from 'node:test';
import assert from 'node:assert';
import { charPose, handAt, handsOf } from '../src/shared/charpose.ts';

const S = 100, X = 48, Y = 124;
const near = (a: { x: number; y: number }, x: number, y: number, what: string): void => { assert.ok(Math.hypot(a.x - x, a.y - y) < 1e-9, `${what}: ${JSON.stringify(a)} ≠ ${x}, ${y}`); };

test('ruka pre lano: v stoji v každom z 8 smerov – pri pohľade doľava ľavá ruka, inak pravá, vo výške pása', () => {
  const hand = { left: [X - 22, Y - 36], right: [X + 22, Y - 36] } as const;
  // smer → ruka (0 dole, 1 vľavo, 2 vpravo, 3 hore, 4 vľavo dole, 5 vpravo dole, 6 vľavo hore, 7 vpravo hore)
  const want = ['right', 'left', 'right', 'right', 'right', 'right', 'right', 'right'] as const;
  want.forEach((w, dir) => { const [x, y] = hand[w]; near(handAt(X, Y, S, dir, 0), x, y, `smer ${dir}`); });
});

test('ruka pre lano: pri chôdzi sa hýbe s mávaním rúk (spredu, zozadu a šikmo hore-dole, zboku nie) a s pohupovaním tela', () => {
  for (const phase of [0.5, 1.2, 2.8, 4.4]) {
    const bob = Math.abs(Math.sin(phase)) * S * 0.04, sw = Math.sin(phase) * S * 0.06;
    for (let dir = 0; dir < 8; dir++) {
      const sideView = dir === 1 || dir === 2, x = dir === 1 ? X - 22 : X + 22;
      near(handAt(X, Y, S, dir, phase), x, Y - bob - 36 - (sideView ? 0 : sw), `smer ${dir}, fáza ${phase}`);
    }
  }
});

test('ruka pre lano: tanec a plazenie – handAt je ruka z pózy, pri plazení otočená spolu s trupom okolo bokov', () => {
  for (let dir = 0; dir < 8; dir++) for (const phase of [0, 0.9, 3.3]) {
    const dance = charPose(Y, S, dir, phase, { dance: true }), h = handsOf(X, S, dance), [hx, hy] = dance.d === 1 ? h.l : h.r;
    near(handAt(X, Y, S, dir, phase, { dance: true }), hx, hy, `tanec, smer ${dir}`);
    // plazenie: vzdialenosť ruky od bokov (stred otáčania) sa nemení, len sa posunie a natočí
    const p = charPose(Y, S, dir, phase, { crawl: true }), hp = handsOf(X, S, p), [ax, ay] = p.d === 1 ? hp.l : hp.r;
    const c = handAt(X, Y, S, dir, phase, { crawl: true });
    const pivot = { x: X - p.fx * S * 0.08, y: p.yb - S * 0.2 + p.kn + (p.fx ? 0 : S * 0.07) };
    assert.ok(Math.abs(Math.hypot(c.x - pivot.x, c.y - pivot.y) - Math.hypot(ax - X, ay - (p.yb - S * 0.2))) < 1e-9, `plazenie, smer ${dir}`);
    if (p.fx) assert.ok(Math.abs(c.y - ay) > 1e-3 || Math.abs(c.x - ax) > 1e-3, 'trup je predklonený');
  }
});
