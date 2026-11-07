# Simulation engine (`engine.js`, `draft.js`)

The game world is a **discrete-event simulation**. Time is a whole-number counter (`tick`, 288 per game day, 1 tick = 5 game minutes). Anything that should happen in the future is an **event** in one queue, and the engine moves the clock **from event to event**. Ticks with no events in them are never simulated.

Since engine v2 (#105, phase 1 in #107) nothing changes the world directly. Everything that happens in a tick is a **proposal** evaluated on a frozen snapshot of the world; the engine then **commits** the accepted proposals, whole or not at all. The engine is still a set of stateless functions: no module-level state, no classes, no timers:

- **all state** lives in the world object as plain JSON and is saved with it;
- **all behaviour** (what each event does, which events are periodic) comes from a `spec` object the caller passes in.

So a world can be saved, loaded, copied or simulated headless (in tests or balance experiments) with the same code the server uses.

## State (saved with the world)

| Field | Meaning |
|---|---|
| `tick` | current game time in ticks |
| `wall` | real time (ms) that `tick` corresponds to; only used by the real-time driver `advance()` |
| `seed` | the world's secret 128-bit seed (hex). Every proposal's random generator is derived from it; it is never sent to a client (it would let players predict the well, wild seeds, NPC visits) and the debug page strips it |
| `step` | counter of committed rounds; part of the derivation of every generator, so a replay from a save reproduces the run |
| `seq` | counter of scheduled events; keeps the order stable within a tick |
| `events` | the queue, sorted by `(at, seq)` |

An event in the queue:

```js
{ at: 1234, seq: 57, type: 'cDue', data: { id: 7 }, key: 'cDue:7' }          // unique
{ at: 1296, seq: 58, type: 'dawn', data: null, key: 'dawn', periodic: true }  // periodic
{ at: 1300, seq: 59, type: 'jano_sell', data: { sp: 'mak', n: 4 } }           // normal
```

Save format v8 replaced the shared generator state `rng` with `seed` and `step` (`migrate()` in `server.js` creates a seed for older worlds; nothing else changes).

## Spec (behaviour, not saved)

```js
const SIM = {
  handlers:  { dawn(world, data, ev) { … }, cDue(world, data, ev) { … }, … },   // legacy handlers
  proposers: { buy(draft, data, ctx) { … }, … },                               // pure proposals (from phase 2 on)
  periodic: [
    { key: 'dawn',   type: 'dawn',   next: E.daily(D.DAWN_TICK) },
    { key: 'hourly', type: 'hourly', next: E.every(12) },
    { key: 'festStart:jar', type: 'festStart', data: { id: 'jar' }, next: E.every(YEAR, startOfJar) },
    …
  ],
  transient: ['players', 'dirty', …],   // keys on the room that are not game state
  resource(path) { … },                 // optional: path → resource key (default: Draft.resourceOf)
  onError(err, ev, world) { … }         // optional; console.error by default
};
```

**Handlers and proposers both receive a draft, never the world itself** (see below). A legacy handler looks exactly like before: it reads and writes `world.tiles[i].s`, calls `E.rand(world)`, `E.schedule(world, …)` and may send messages to players. The draft records what it did. A proposer is the pure form: it gets a `ctx` with its own random generator (`ctx.rng.rand() / int(n) / pick(list)`), `ctx.emit(msg)` for messages, `ctx.reject(msg)` for a refused action, and `ctx.schedule / scheduleIn / scheduleUnique / cancel / pending` for the queue. Neither kind schedules itself again.

## Three kinds of events

### 1. Normal (one-shot)

```js
E.schedule(world, at, type, data)
E.scheduleIn(world, ticks, type, data)
```

No key. Something happens once at a given time, for example Jano bringing grown flowers to the market (`jano_sell`). There can be any number of these, and they can't be cancelled individually. If you need to cancel one, make it a unique event.

### 2. Unique (keyed)

```js
E.scheduleUnique(world, key, at, type, data)  // replaces a pending event with the same key
E.cancel(world, key)                          // removes it; returns how many were removed
E.pending(world, key)                         // the pending event or null
```

**At most one event per key is ever in the queue.** Scheduling again moves it, and cancelling goes through the key. This is the only way to cancel anything. By convention, keys are `type:id`:

| Key | Meaning |
|---|---|
| `vilyEnd:<player>` | the fairy potion wears off (drinking another one moves it) |
| `scavDone:<player>` | searching the grass finishes (moving or acting cancels it) |
| `cExpire:<contract>` / `cDue:<contract>` | a contract leaves the board / its deadline (delivering it cancels both) |

### 3. Periodic (declared)

Periodic events are **never scheduled by hand**. `spec.periodic` declares them:

```js
{ key, type, data?, next(world, from) }  // next returns the first tick >= from when it should happen
```

The **reconciler** `E.reconcile(world, spec)` keeps the queue consistent with the declarations:

1. drops events whose `type` has no handler or proposer (content removed from the game),
2. drops periodic events whose `key` is no longer declared (a removed festival or NPC),
3. if a periodic key appears more than once, keeps only the earliest,
4. for each declared key with no pending event, plans one at `next(world, tick + 1)`.

When a periodic event runs, it leaves the queue like any other event. The next reconcile sees that its key is missing and plans the next occurrence. So the reconciler is the **only** place that plans periodic events. Other than that, they go through the same queue and executor as everything else.

As a result:

- a handler that throws can't break a periodic chain: the next occurrence is planned by the engine, not by the handler;
- a periodic event added in a new version (a new NPC, a new festival) **appears in existing worlds** on the next reconcile, with no migration needed;
- a periodic event that is removed disappears from saved queues;
- duplicates can't build up.

Helpers for `next`:

| Helper | Meaning |
|---|---|
| `E.daily(tickOfDay)` | every day at that time (`E.daily(D.DAWN_TICK)` = 6:00) |
| `E.every(period, offset)` | at `offset + k·period` (`E.every(12)` = every full hour, `E.every(2*TPD, 84)` = every 2nd day at 7:00, `E.every(YEAR, start)` = yearly) |
| custom | anything, including random times. For example, an NPC visit: `(w, from) => E.nextDailyTick(from + TPD/2, 96 + E.randInt(w, 120))` |

A `next` that uses `E.rand` is deterministic: `E.planAt(world, def, from)` gives it a generator seeded from `(seed, 'plan', key, from)`, so the planned time depends on nothing but the world's seed, the key and the moment it is planned. It is the same whether the engine jumps or steps.

## Proposals: how a tick is executed

Everything due in a tick forms one **batch**. Today a batch holds the due events; later phases of #105 add player actions, movement and NPC actors as inputs of the same batch. `E.commitBatch(world, inputs, spec)` runs it:

```
round:
  for each input, in batch order:
    result = evaluate(world, input)          ← on a draft of the frozen world, own random generator
    if result.reads ∪ result.writes meets the writes of a proposal already applied in this round:
        hold the input for the next round    ← it would have read state that just changed
    else if result is a rejection:  tell the player, apply nothing
    else:                            apply the patches and queue ops, whole
  step += 1
  if anything was held: next round, same tick, against the committed world
```

- **Draft** (`draft.js`): a copy-on-write proxy over the world. Reads pass through; the first write to an object copies it (and the path up to the top-level key), so the world is untouched until commit. Every write is also recorded as a patch `{ op: 'set' | 'del', path, value }`; `E.applyPatches` replays them on the live world **in place**, so objects the server holds (a player's save, a tile) keep their identity. Queue changes (`schedule`, `scheduleUnique`, `cancel`) are recorded as **ops** and executed at commit, where `seq` is assigned in commit order, so scheduling never conflicts.
- **Resources**: reads and writes are recorded at resource granularity, not path granularity, so that unrelated proposals never conflict: `tile:garden:12`, `tile:hory:3`, `save:ana` (a player's save), `pos:ana` (their position: x, y, area, lastTick), `market:seed_mak`, `market:fl_mak`, `market:compost`, `market:festival`, `market:news`, `market:npc:jano`, `contracts`, `storage`, `weather`, `icehouse`, `event:cDue:7` (a keyed event), … Enumerating a collection (`for key in saves`, `tiles.length`) reads the collection key (`save:*`, `tile:garden:*`), which meets every member. `Draft.resourceOf(path)` is the mapping (a resource depends on at most the first three elements of a path); `spec.resource` can replace it.
- **Rounds**: a held proposal is re-evaluated in the next round of the same tick against the committed world. It never runs against a half-built state, and it never waits for the next tick: `dawn` and `hourly` both fire at 6:00, both write every save, so `hourly` runs in round 2 of tick 72, also during a 30-day catch-up. Two buys of the last seed: the first applies in round 1, the second is re-priced in round 2 and refused with the normal "Vypredané" toast. Each round can only shrink, so the loop terminates.
- **Atomicity**: a proposal is applied whole or not at all. A handler that throws after writing coins leaves the coins untouched; the error goes to `spec.onError` and the event is consumed, as before.
- **Randomness**: proposal evaluation gets a mulberry32 generator seeded from `hash(seed, step, id)`, where `id` identifies the input (`ev#<seq>` for events). Streams never shift when another input is added or removed, and the result is the same whether proposals are evaluated sequentially or in parallel. `Math.random()` and `Date.now()` are banned from `engine.js` and `draft.js` (a test greps for them).
- **Legacy handlers** (`spec.handlers`) declare `writes: '*'`: they conflict with everything, so within a round only the first of them applies and the rest are held. The engine evaluates a legacy handler **only when it is the first proposal to apply in its round**, so each one is evaluated exactly once and may keep its side effects (toasts, `broadcast`, `room.dirty = true`). That is what keeps `server.js` working unchanged through phase 1. A proposer in `spec.proposers` has no such guarantee: it may be evaluated several times (once per round it is held), so it must be pure and send messages through `ctx.emit`.
- **What is not state**: keys listed in `spec.transient` (`players`, `dirty`, `ff`, `pomedzie`, …) plus `tick`, `wall`, `daySeconds`, `v`, `migratedFrom` pass straight through to the live room, untracked and uncopied. `rng` is local to the draft: `E.rand(world)` inside a handler draws from the proposal's own generator.

`E.evaluate(world, input, spec)` returns one proposal's result (`{ id, reads, writes, patches, ops, outbox, reject?, error? }`) without committing anything; tests use it to prove that shuffled evaluation gives identical proposals.

## Executor: jumping to the next event

```
advanceTo(world, target, spec):
  loop
    reconcile(world, spec)           ← make sure every periodic event is in the queue
    at = nextAt(world)               ← the head of the queue is the next event, of any kind
    if at is null or at > target: break
    world.tick = at                  ← jump, no empty ticks
    runBatch(world, spec)            ← every event at this tick → one commitBatch
  world.tick = target
```

**Why reconcile first?** Once the reconciler has run, the next occurrence of every periodic event is already in the queue. So "when is the next periodic event?" and "when is the next normal event?" are the same question, and the answer is the head of the queue. There is no need to ask two schedulers and take the minimum.

**Batches.** All events whose `at` equals the current tick run as one batch, in `(at, seq)` order. Anything a handler schedules lands at `tick + 1` at the earliest (the engine clamps it). Nothing can be added to a batch while it runs, and periodic events are replanned only *after* the batch. Two consequences:

- every event runs exactly once, at a well-defined tick;
- jumping 30 days at once gives **exactly the same world** as moving one tick at a time (a test checks this).

**Errors.** Each proposal is evaluated inside try/catch. The error goes to `spec.onError` (by default `console.error` with the event's key, tick and data), nothing of that proposal is applied, the event is consumed and the simulation goes on. A poison event therefore can't crash the server, can't leave a half-applied change, and can't crash it again when catch-up replays the same event after a restart.

**Cost.** Each loop iteration costs one reconcile (O(queue length), and the queue holds a few dozen events) plus the proposals. Idle ticks cost nothing. Evaluating `dawn` through the draft (1 000 tiles behind a proxy) costs a few milliseconds; a 30-day catch-up with a full garden stays well under a second.

## Drivers

| Who | Call | What it does |
|---|---|---|
| server, every 100 ms | `E.advance(room, Date.now(), SIM, 50000)` | moves the world by as many whole ticks as have passed since `room.wall` (at most 50,000 per call) |
| loading a running world | `E.advance(room, Date.now(), SIM)` | catches up downtime (capped at `MAX_CATCHUP_DAYS` by moving `wall`) |
| everyone asleep | `E.advanceTo(room, min(ff.until, tick + 5), SIM)` | fast-forwards the night, 5 ticks per 100 ms so clients can animate it |
| tests, headless simulation | `E.advanceTo(world, world.tick + days * TPD, spec)` | runs any amount of game time as fast as the events allow |
| tests, a batch of actions | `E.commitBatch(world, inputs, spec)` | runs player actions (as `spec.proposers`) and events together at the current tick |

`advance()` is the only function that knows about real time. Everything else works in ticks.

## Determinism and saving

The queue, `seq`, `seed` and `step` are part of the save. Given the same saved world and the same spec, the simulation always produces the same result, whether it runs continuously, is saved and loaded halfway, jumps instead of stepping, or replays recorded batches of actions on a saved snapshot (`test/engine.test.js`, `test/proposals.test.js`).

Save format version 5 added `key` and `periodic` to events (`migrate()` in `server.js` gives keys to the events of older saves). Version 8 added `seed` and `step`, dropped `rng`, and makes sure `scavSalt` exists (it used to be drawn lazily from the shared generator).

## Recipes

**A new periodic event** (for example a weekly market day):

```js
HANDLERS.marketDay = (room) => { … };   // just the effect
PERIODIC.push({ key: 'marketDay', type: 'marketDay', next: E.every(7 * TPD, D.DAWN_TICK + 36) });
```

Existing worlds get it automatically on load.

**Something a player starts, which can be restarted or interrupted:** use a unique key.

```js
E.scheduleUnique(room, 'heat:' + pl.key, room.tick + TPD, 'heatEnd', { key: pl.key });
E.cancel(room, 'heat:' + pl.key);
```

**A pure proposal** (the form every action and event will take in later phases):

```js
SIM.proposers.water = (d, { key, i }, ctx) => {
  const sv = d.saves[key], t = d.tiles[i];
  if (!t.s) return ctx.reject('Tu nie je záhon.');          // nothing is applied, the player gets the toast
  if (sv.water <= 0) return ctx.reject('Krhla je prázdna.');
  sv.water--; t.s.w = 1;                                     // recorded: writes save:<key>, tile:garden:<i>
  ctx.emit({ to: key, t: 'fx', k: 'drops', i });             // sent only if the proposal is applied
};
```

**Removing content:** delete the handler and/or the periodic declaration. Pending events in saved worlds are dropped on load, with a `[engine] zahodená udalosť …` line in the log.

## Current periodic events

| Key | When | Defined in |
|---|---|---|
| `dawn` | every day at 6:00: plants grow, weather, market | `server.js` |
| `hourly` | every full hour: flowers wilt, ice melts | `server.js` |
| `delivery` | every 2nd day at 7:00: wholesaler | `economy.js` |
| `npc_jano`, `npc_fero`, `npc_zuzka` | once a day at a random time between 8:00 and 18:00, at least ½ day after the previous visit | `economy.js` |
| `festAnnounce:<id>`, `festStart:<id>`, `festEnd:<id>` | yearly: 2 days before the festival, at its start, at its end | `economy.js` |
