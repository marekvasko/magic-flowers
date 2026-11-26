import test from 'node:test';
import assert from 'node:assert';
import * as RM from '../src/shared/robotmodel.ts';
import type { RobotLook } from '../src/shared/robotmodel.ts';
import type { ToolId } from '../src/shared/data.ts';

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;
// predvoľby + veľa vygenerovaných robotov (generátor nesmie postaviť nič rozbité)
const LOOKS: [string, RobotLook][] = [
  ...RM.PRESET_IDS.map((p): [string, RobotLook] => [p, RM.PRESETS[p].look]),
  ...Array.from({ length: 300 }, (_, i): [string, RobotLook] => ['seed ' + i, RM.randomLook(i)])
];
// všetky kombinácie dielov s krajnými rozmermi
for (const loco of RM.LOCOS) for (const body of RM.BODIES) for (const head of RM.HEADS) for (const ext of [0, 1]) {
  const nums = Object.fromEntries(RM.NUM_KEYS.map(k => [k, ext ? RM.NUM[k].max : RM.NUM[k].min]));
  LOOKS.push([`${loco}/${body}/${head}/${ext ? 'max' : 'min'}`, RM.robotLook({ ...nums, loco, body, head, eyes: ext ? 1 : 2, edges: ext ? 'sharp' : 'soft', chimney: true, panel: true, rivets: true, leds: true, acc: 'hat' })]);
}

test('každý robot: kĺby majú rodiča, diely sedia na kĺboch, čísla sú konečné, úchyty existujú', () => {
  for (const [name, look] of LOOKS) {
    const m = RM.robotModel(look);
    const ids = new Set(m.joints.map(j => j.id));
    assert.strictEqual(ids.size, m.joints.length, name + ': kĺby s rovnakým menom');
    for (const j of m.joints) if (j.parent) assert.ok(ids.has(j.parent), `${name}: ${j.id} bez rodiča ${j.parent}`);
    for (const p of m.parts) {
      assert.ok(ids.has(p.j), `${name}: diel na neznámom kĺbe ${p.j}`);
      assert.ok([...p.p, ...(p.r ?? [])].every(Number.isFinite), `${name}: diel s neplatnou polohou`);
    }
    for (const mt of Object.values(m.mounts)) assert.ok(ids.has(mt.j), `${name}: úchyt na neznámom kĺbe ${mt.j}`);
    assert.ok(m.parts.some(p => p.m === 'eye'), name + ': nemá oči');
    assert.ok(m.parts.some(p => p.tag === 'lid'), name + ': nemá viečka');
    for (const id of ['shoulderL', 'shoulderR', 'handL', 'handR', 'body', 'head']) assert.ok(ids.has(id), `${name}: chýba ${id}`);
  }
});

test('rozmery: vysoký 0,55–0,9 políčka, ruky po stranách (pravá na −x) nad zemou, nosič vzadu, temeno nad trupom', () => {
  for (const [name, look] of LOOKS) {
    const m = RM.robotModel(look);
    assert.ok(m.height >= RM.HEIGHT_MIN - 1e-3 && m.height <= RM.HEIGHT_MAX + 1e-3, `${name}: výška ${m.height}`);
    const r = RM.mountAt(m, null, 'handR'), l = RM.mountAt(m, null, 'handL');
    assert.ok(r[0] < -0.06 && l[0] > 0.06, `${name}: ruky ${r[0]} ${l[0]}`);
    assert.ok(near(r[0], -l[0], 1e-6) && near(r[1], l[1], 1e-6), name + ': ruky nie sú súmerné');
    assert.ok(r[1] > 0.04, `${name}: ruka v zemi (${r[1]})`);
    assert.ok(RM.mountAt(m, null, 'back')[2] < -0.1, name + ': nosič nie je na chrbte');
    const body = RM.jointMatrix(m, null, 'body')[3][1];
    assert.ok(m.height > body, name + ': temeno pod stredom trupu');
  }
});

test('predvoľby majú výšku ako ručne naladené roboty (0,6–0,9)', () => {
  for (const p of RM.PRESET_IDS) { const h = RM.robotModel(RM.PRESETS[p].look).height; assert.ok(h >= 0.55 && h <= 0.9, `${p}: ${h}`); }
});

test('póza: pri chôdzi sa ruka kýve a kolesá krútia, v stoji je ruka na mieste; pri tanci sú ruky hore', () => {
  for (const [name, look] of LOOKS.slice(0, 60)) {
    const m = RM.robotModel(look);
    const still = RM.mountAt(m, RM.robotPose(m, { phase: 0 }), 'handR');
    const a = RM.mountAt(m, RM.robotPose(m, { phase: Math.PI / 2, walking: true }), 'handR');
    const b = RM.mountAt(m, RM.robotPose(m, { phase: -Math.PI / 2, walking: true }), 'handR');
    assert.ok(Math.abs(a[2] - b[2]) > 0.03, `${name}: ruka sa pri chôdzi nekýve`);
    assert.deepStrictEqual(RM.mountAt(m, RM.robotPose(m, { phase: 1.3 }), 'handR'), still, name + ': bez chôdze sa ruka hýbe s fázou');
    const dance = RM.mountAt(m, RM.robotPose(m, { dance: true, t: 0 }), 'handR');
    assert.ok(dance[1] > RM.jointMatrix(m, null, 'body')[3][1], `${name}: pri tanci ruka nie je hore (${dance[1]})`);
    if (m.gait === 'roll') {
      assert.ok(m.wheels.length > 0, name + ': kolesový podvozok bez kolies');
      const w = RM.robotPose(m, { phase: 2, walking: true }).joints.get(m.wheels[0]?.j ?? '');
      assert.ok(w && w.r[0] > 0, name + ': koleso sa nekrúti');
    }
  }
});

test('plazenie robota prikrčí: temeno je nižšie', () => {
  for (const [name, look] of LOOKS.slice(0, 60)) {
    const m = RM.robotModel(look);
    assert.ok(RM.mountAt(m, RM.robotPose(m, { crawl: true }), 'top')[1] < RM.mountAt(m, RM.robotPose(m, {}), 'top')[1] - 0.02, name);
  }
});

test('úchyt vo svete: robot pozerá v smere pohybu a', () => {
  const m = RM.robotModel(RM.PRESETS.hrdzavec.look);
  const loc = RM.mountAt(m, null, 'top');
  // a = 0 → pozerá na +x: dopredu (model +z) je svetové +x, pravá ruka (model −x) je svetové +z
  const w = RM.mountInWorld(m, null, 'top', 5, 1, 7, 0);
  assert.ok(near(w[0], 5 + loc[2]) && near(w[1], 1 + loc[1]) && near(w[2], 7 - loc[0]));
  assert.ok(RM.mountInWorld(m, null, 'handR', 0, 0, 0, 0)[2] > 0.1, 'pravá ruka pri pohľade na +x má byť na +z');
  const z = RM.mountInWorld(m, null, 'top', 0, 0, 0, Math.PI / 2);
  assert.ok(near(z[0], loc[0]) && near(z[2], loc[2]));
});

test('genóm z nedôveryhodného JSON: zlé hodnoty → predvolené, čísla orezané do rozsahu, farby malými písmenami', () => {
  assert.deepStrictEqual(RM.robotLook(null), RM.PRESETS.hrdzavec.look);
  assert.deepStrictEqual(RM.robotLook(RM.PRESETS.kotul.look), RM.PRESETS.kotul.look);
  const l = RM.robotLook({ loco: 'legs3', body: 'rocket', head: '__proto__', edges: 'pointy', eyes: 3, paint: '#ABCDEF', accent: 'red', bw: 9, bh: -1, wear: 'x', leds: 'yes', chimney: true, extra: 1 });
  assert.deepStrictEqual(l, { ...RM.PRESETS.hrdzavec.look, loco: 'legs3', paint: '#abcdef', bh: RM.NUM.bh.min, chimney: true }); // bw už nie je v genóme
  assert.strictEqual(RM.robotLook({ eyeS: 0.9001234 }).eyeS, 0.9);
});

test('generátor: rovnaké semienko = rovnaký robot, je platný a dav má všetky druhy dielov', () => {
  assert.deepStrictEqual(RM.randomLook(42), RM.randomLook(42));
  assert.notDeepStrictEqual(RM.randomLook(42), RM.randomLook(43));
  const looks = Array.from({ length: 300 }, (_, i) => RM.randomLook(RM.hashStr('hráč ' + i)));
  for (const l of looks) assert.deepStrictEqual(RM.robotLook(l), l);
  for (const k of ['loco', 'body', 'head', 'acc', 'eyes', 'edges'] as const) {
    const all = { loco: RM.LOCOS.length, body: RM.BODIES.length, head: RM.HEADS.length, acc: RM.ACCS.length, eyes: 2, edges: 2 }[k];
    assert.strictEqual(new Set(looks.map(l => l[k])).size, all, k);
  }
  for (const l of looks) assert.notStrictEqual(l.paint, l.accent);
});

test('hrdza nie sú diely (je to textúra v nátere): model je pre každú ošúchanosť rovnaký, len vzhľad sa líši', () => {
  const base = RM.PRESETS.hrdzavec.look;
  const parts = (wear: number): number => RM.robotModel({ ...base, wear }).parts.length;
  assert.strictEqual(parts(0), parts(1));
  assert.ok(!RM.robotModel({ ...base, wear: 1 }).parts.some(p => p.m === 'rust'));
  assert.deepStrictEqual(RM.robotModel(base), RM.robotModel(base));
});

const TOOLS: readonly ToolId[] = ['hoe', 'can', 'pick', 'lamp'];
test('nosič: každé náradie má svoje miesto za chrbtom, miesta sú od seba, náradie v puzdre nesiaha na zem', () => {
  for (const [name, look] of LOOKS) {
    const m = RM.robotModel(look);
    const back = Math.min(...m.parts.filter(p => p.j === 'body').map(p => p.p[2]));
    const at = TOOLS.map(t => RM.slotAt(m, null, t));
    for (const [i, p] of at.entries()) {
      assert.ok(p[2] < back * m.scale - 0.01, `${name}: ${TOOLS[i]} nie je za chrbtom (${p[2]})`);
      assert.ok(p[1] > 0.12, `${name}: ${TOOLS[i]} príliš nízko (${p[1]})`);
    }
    for (let i = 0; i < at.length; i++) for (let j = i + 1; j < at.length; j++) {
      const a = at[i] ?? [0, 0, 0], b = at[j] ?? [0, 0, 0];
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 0.05, `${name}: ${TOOLS[i]} a ${TOOLS[j]} na jednom mieste`);
    }
    // motyka a krompáč v puzdrách po krajoch, krhla a lampáš na háčikoch medzi nimi a vyššie
    const [hoe, can, pick, lamp] = at.map(p => p[0]);
    assert.ok((hoe ?? 0) < (can ?? 0) && (can ?? 0) < (lamp ?? 0) && (lamp ?? 0) < (pick ?? 0), name + ': poradie miest na nosiči');
    assert.ok(m.parts.some(p => p.j === 'rack'), name + ': nosič nemá diely');
  }
});

test('pásy: slučka z článkov okolo kolies; pri jazde sa články posúvajú po slučke, dolná vetva stojí na zemi', () => {
  const m = RM.robotModel(RM.PRESETS.hrdzavec.look);
  assert.strictEqual(m.tracks.length, 2);
  for (const tr of m.tracks) {
    assert.ok(tr.links.length >= 18);
    const P = RM.trackLength(tr);
    // slučka je spojitá: body tesne pred a za každým zlomom sú pri sebe
    for (let s = 0; s < P; s += P / 400) { const a = RM.trackAt(tr, s), b = RM.trackAt(tr, s + 1e-4); assert.ok(Math.hypot(a.y - b.y, a.z - b.z) < 1e-3, 's ' + s); }
    assert.ok(near(RM.trackAt(tr, 0).y, tr.y + tr.R) && near(RM.trackAt(tr, P / 2).y, tr.y - tr.R, 1e-6));
    assert.ok(tr.y - tr.R > 0 && tr.y - tr.R < 0.015, 'dolná vetva má byť pri zemi');
    // horná vetva ide pri jazde dopredu
    const l = tr.links[0], pose = RM.robotPose(m, { phase: 1, walking: true });
    assert.ok(l && (pose.joints.get(l.j)?.d?.[2] ?? 0) > 0);
  }
});

test('ostré hrany: kocky bez zaoblenia, väčšie valce a gule ako mnohosteny; oblé hrany bez mnohostenov (okrem pásov)', () => {
  const soft = RM.robotModel({ ...RM.PRESETS.plechacik.look, edges: 'soft' }), sharp = RM.robotModel({ ...RM.PRESETS.plechacik.look, edges: 'sharp' });
  assert.ok(!soft.parts.some(p => p.flat));
  assert.ok(sharp.parts.filter(p => p.flat).length > 5);
  for (const p of sharp.parts) if (p.shape.k === 'box' && ['paint', 'accent', 'metal', 'dark'].includes(p.m)) assert.ok(p.shape.r <= 0.004);
  assert.ok(RM.robotModel(RM.PRESETS.hrdzavec.look).parts.some(p => p.flat), 'pásy majú ozubené kolesá');
});

test('úchop: rúčka ide cez stred klepeta; palicu drží zvislo pred sebou, zavesené náradie za vodorovné držadlo', () => {
  for (const [name, look] of LOOKS.slice(0, 80)) {
    const m = RM.robotModel(look);
    const axis = (hold: RM.HoldKind): number[] => {
      const z = RM.jointMatrix(m, RM.robotPose(m, { hold }), 'handR')[2], l = Math.hypot(...z);
      return z.map(v => v / l);
    };
    assert.ok((axis('staff')[1] ?? 0) > 0.9, `${name}: palica nie je zvislo (${axis('staff').join(', ')})`);
    assert.ok(Math.abs(axis('hang')[1] ?? 1) < 0.25, `${name}: držadlo zaveseného náradia nie je vodorovne (${axis('hang').join(', ')})`);
    for (const hold of ['staff', 'hang'] as const) {
      const p = RM.mountAt(m, RM.robotPose(m, { hold }), 'handR');
      assert.ok(p[2] > 0.02, `${name}: ${hold} – ruka nie je pred robotom (${p[2]})`);
      assert.ok(p[1] > 0.12, `${name}: ${hold} – ruka príliš nízko (${p[1]})`);
    }
    // klepeto: dva prsty okolo stredu úchopu, ktorý je pod dlaňou
    assert.ok(m.mounts.handR.p[1] < -0.02);
  }
});

test('rovnaké rozmery: každý robot má rovnakú výšku, plecia aj ruky na tom istom mieste, rovnako dlhé ramená', () => {
  const ref = RM.robotModel(RM.PRESETS.hrdzavec.look), refHand = RM.mountAt(ref, null, 'handR'), refL = RM.mountAt(ref, null, 'handL');
  for (const [name, look] of LOOKS) {
    const m = RM.robotModel(look);
    assert.ok(Math.abs(m.height - RM.FRAME.height) < 0.003, `${name}: výška ${m.height}`);
    assert.ok(Math.abs(m.scale - 1) < 0.005, `${name}: zmenšenie ${m.scale}`);
    assert.strictEqual(m.armLen, RM.FRAME.arm, name);
    const sh = RM.jointMatrix(m, null, 'shoulderL')[3];
    assert.ok(Math.hypot(sh[0] - RM.FRAME.shoulder[0], sh[1] - RM.FRAME.shoulder[1], sh[2] - RM.FRAME.shoulder[2]) < 0.004, `${name}: plece ${sh.join(', ')}`);
    for (const [a, b] of [[RM.mountAt(m, null, 'handR'), refHand], [RM.mountAt(m, null, 'handL'), refL]] as const) assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.006, `${name}: ruka ${a.join(', ')}`);
  }
});

// pózy so všetkými animáciami ramien (na kontrolu rozsahu a rýchlosti kĺbov)
const ARM_IDS = ['shoulderR', 'shoulderL', 'elbowR', 'elbowL', 'handR', 'handL'];
const TOOL_IDS = ['hoe', 'can', 'pick', 'lamp'] as const;
test('obmedzenia kĺbov: plece, lakeť ani zápästie nikdy nevyjdú z rozsahu (aj pri IK)', () => {
  for (const [name, look] of LOOKS.slice(0, 40)) {
    const m = RM.robotModel(look);
    const poses: RM.PoseOpts[] = [{}, { walking: true, phase: 1 }, { hold: 'staff' }, { hold: 'hang' }, { crawl: true }, { dance: true, t: 0.3 },
      ...Array.from({ length: 12 }, (_, k) => ({ dig: k / 12 })),
      ...TOOL_IDS.flatMap(tool => Array.from({ length: 24 }, (_, k) => ({ use: { tool, t: (k / 24) * RM.USE_CYCLE[tool] } })))];
    for (const o of poses) {
      const P = RM.robotPose(m, o);
      for (const id of ARM_IDS) {
        const r = P.joints.get(id)?.r;
        assert.ok(r, name + ' ' + id);
        assert.deepStrictEqual(RM.clampJoint(id, r), r, `${name}: ${id} mimo rozsahu ${JSON.stringify(o)}`);
      }
    }
  }
  // lakeť sa ohýba len jedným smerom, plece dozadu len trochu
  assert.deepStrictEqual(RM.clampJoint('elbowR', [0.5, 0, 0]), [0, 0, 0]);
  assert.deepStrictEqual(RM.clampJoint('shoulderL', [1.5, 0, 1.4]), [0.9, 0, 1.1]);
});

test('kĺby sa nehýbu okamžite: animácie náradia, hrabanie ani tanec nepotrebujú kĺb rýchlejší, ako dovolí jointSpeed', () => {
  for (const [name, look] of LOOKS.slice(0, 12)) {
    const m = RM.robotModel(look);
    const anims: [string, number, (t: number) => RM.PoseOpts][] = [
      ...TOOL_IDS.map((tool): [string, number, (t: number) => RM.PoseOpts] => [tool, RM.USE_CYCLE[tool], t => ({ use: { tool, t } })]),
      ['hrabanie', 1 / RM.DIG_RATE, t => ({ dig: t + 1e-6 })], // dig: 0 znamená „nehrabe“ ['tanec', 2 * Math.PI / 3, t => ({ dance: true, t })]
    ];
    for (const [anim, cycle, at] of anims) {
      const n = 600, dt = cycle / n;
      let prev = RM.robotPose(m, at(0));
      for (let k = 1; k <= n; k++) {
        const P = RM.robotPose(m, at(k * dt));
        for (const id of ARM_IDS) {
          const a = prev.joints.get(id)?.r ?? [0, 0, 0], b = P.joints.get(id)?.r ?? [0, 0, 0];
          const v = Math.max(...a.map((x, i) => Math.abs((b[i] ?? 0) - x))) / dt;
          assert.ok(v <= RM.jointSpeed(id) * 1.02, `${name}, ${anim}: ${id} ${v.toFixed(1)} rad/s (najviac ${RM.jointSpeed(id)}) v čase ${(k * dt).toFixed(3)}`);
        }
        prev = P;
      }
    }
  }
});

test('jednoduchý štýl (hra): tie isté kĺby (okrem článkov pásov), úchyty, rozmery a miesta náradia, ale len z kvádrov, bez drobností a s plochými stenami', () => {
  for (const [name, look] of LOOKS.slice(0, 60)) {
    const d = RM.robotModel(look), s = RM.robotModel(look, true);
    // (pásy majú v jednoduchom štýle menej, väčších článkov – ich kĺby sa líšia)
    const noTrack = (m: RM.RobotModel): RM.Joint[] => m.joints.filter(j => !j.id.startsWith('track'));
    assert.deepStrictEqual(noTrack(s), noTrack(d), name + ': kĺby');
    assert.deepStrictEqual(s.mounts, d.mounts, name + ': úchyty');
    assert.deepStrictEqual(s.slots, d.slots, name + ': miesta náradia');
    assert.strictEqual(s.height, d.height, name);
    assert.deepStrictEqual(s.shoulder, d.shoulder, name);
    assert.ok(s.parts.every(p => p.flat), name + ': diel bez plochých stien');
    // len kvádre s ostrými hranami; kolesá a guľa podvozku sú osemboké hranoly
    for (const p of s.parts) {
      const sh = p.shape, wheel = /^(wheel|ball|caster)/.test(p.j);
      if (wheel) assert.ok(sh.k === 'box' || ((sh.k === 'cyl' || sh.k === 'sphere') && (sh.n ?? 99) <= 8), `${name}: koleso ${JSON.stringify(sh)}`);
      else assert.ok(sh.k === 'box' && sh.r === 0 && Math.min(...sh.s) >= 0.009, `${name}: ${p.j} nie je kváder: ${JSON.stringify(sh)}`);
    }
    // oči, viečka a držiaky náradia ostali
    assert.ok(s.parts.some(p => p.m === 'eye') && s.parts.some(p => p.tag === 'lid'), name);
    for (const t of ['hoe', 'can', 'pick', 'lamp']) assert.ok(s.parts.some(p => p.tag === 'holder:' + t), `${name}: držiak ${t}`);
  }
});
