# Simulation engine (`engine.js`)

The game world is a **discrete-event simulation**. Time is a whole-number counter (`tick`, 288 per game day, 1 tick = 5 game minutes). Anything that should happen in the future is an **event** in one queue, and the engine moves the clock **from event to event**. Ticks with no events in them are never simulated.

Since engine v2 (#105; phase 1 in #107, phase 2 in #109) nothing changes the world directly. Everything that happens in a tick is a **proposal**: it declares which **slices** of the world it reads and writes, runs on plain copies of exactly those slices, and the engine then **commits** the accepted proposals, whole or not at all, and writes one entry per batch to a **journal**. The engine is still a set of stateless functions: no module-level state, no classes, no timers:

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
| `plotsUsed`, `maxRep` | derived counters (tilled garden plots; the highest reputation among the players) kept in state so that proposals can declare narrow keys instead of reading every tile or every save; recounted on load, maintained by whoever changes a plot or a reputation |
| `glacierFed` | the day the glacier last grew from rain or snow (at most once a day) |

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
  proposers: {                                   // by event type (later also by player action)
    dawn:   { keys: (data, world) => ({ writes: ['tile:garden:*', 'save:*', 'weather', …], reads: ['eternal'] }),
              run(slices, data, ctx) { … } },
    cDue:   { keys: ({ id }, world) => …, run(slices, { id }, ctx) { … } },
    …
  },
  periodic: [
    { key: 'dawn',   type: 'dawn',   next: E.daily(D.DAWN_TICK) },
    { key: 'hourly', type: 'hourly', next: E.every(12) },
    { key: 'npc_jano', type: 'npc_jano', next: (from, rng) => E.nextDailyTick(from + TPD / 2, 96 + rng.int(120)) },
    …
  ],
  presence: world => [...],              // optional: a snapshot of what is not state (connected players), given to run as ctx.presence
  onBatch: (world, out) => { … },        // optional: after every committed batch – send out.outbox, store out.entry (journal)
  slice: (world, key) => { get(), set(v) } | null,   // optional: override the default key → slice mapping
  onError(err, ev, world) { … }          // optional; console.error by default
};
```

A **proposer** has two pure parts. `keys(data, world)` returns the keys it will read and write; it may look at read-only facts of the world (which saves exist, who took a contract) but must not change anything. `run(slices, data, ctx)` receives plain **copies** of exactly the declared slices, indexed by key (`slices['tile:garden:12']`, `slices['save:ana']`, `slices['market:*']`, `slices.weather`), mutates them with ordinary code and returns. `ctx` carries `tick`, `rng` (own generator: `rand() / int(n) / pick(list)`), `emit(msg)` for messages to players, `reject(msg)` for a refused action, `schedule / scheduleIn / scheduleUnique / cancel / pending` for the queue, and `presence`. A proposer never schedules itself again and never touches anything outside its slices: an undeclared slice is simply `undefined`, so touching it throws, and changing a slice declared only for reading is reported as an error of the proposal.

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
    keys = proposer.keys(data, world)
    if keys meet the writes of a proposal already applied in this round: hold the input (not even evaluated)
    slices = copies of the declared slices; result = proposer.run(slices, data, ctx)   ← own random generator
    if the result's keys (incl. event:<key> touched through ctx) meet earlier writes: hold
    else if rejected: tell the player, apply nothing
    else: write the slices back into the world (in place), then the queue ops; record the changes
  step += 1
  if anything was held: next round, same tick, against the committed world
spec.onBatch(world, { applied, rejected, outbox, entry })
```

### Slices and keys

A **key** names a slice of the world. `E.sliceOf(world, key)` is the default mapping (game knowledge: how the world is stored, see `serialize` in `server.js`):

| Key | Slice |
|---|---|
| `tile:garden:12`, `tile:hory:3` | one tile of one area; `tile:garden:*` the whole tile array of the area (`garden` → `world.tiles`, `hory`, `les`) |
| `save:ana` | one player's save (coins, inventory, reputation, position, …); `save:*` all saves |
| `market:seed_mak`, `market:fl_mak`, `market:compost`, `market:festival`, `market:hist`, `market:news`, `market:npc:jano` | one market entry; `market:seed_*`, `market:fl_*`, `market:npc:*` a collection; `market:*` the whole market |
| `contracts` | the board (`list`, `nextId`) |
| `storage` | the shared storage as `{ inv, fb }` (`world.storage` + `world.storageFb`) |
| `event:<key>` | a keyed event: added by the engine when `ctx.scheduleUnique / cancel / pending` is called with that key |
| anything else | the world property with that name: `weather`, `eternal`, `fairyNight`, `icehouse`, `scav`, `scavSalt`, `up`, `plotsUsed`, `maxRep`, `glacierFed` |

Rules:

- A key ending in `*` is a collection and **meets** every key with the same prefix (`save:*` meets `save:ana`; `market:*` meets `market:seed_mak`). Two proposals whose keys never meet are independent and could be evaluated in parallel.
- **Write-back is in place.** Objects already in the world are changed from the inside, so the objects the server holds (a player's save, a tile, the market) keep their identity. Arrays are synced element by element while their length is unchanged (tiles, a full news list); an array whose length changed is replaced as a whole. So an element removed from a list keeps its own values, but a list element is not a stable identity across a batch: look it up again by id.
- **Granularity is the proposer's choice.** `dawn` legitimately changes every tile and every save and declares the collections (`tile:garden:*`, `save:*`): that only holds `hourly` and the market events to round 2 of the 6:00 tick, also during a 30-day catch-up. Market events (`delivery`, NPC visits, festivals) declare the whole market (`market:*`); finer keys exist for the player actions of phase 3 (`market:seed_mak` + `save:ana` for a buy). Reading every tile to count plots or every save to find the best reputation would make a hoe conflict with everything, which is why `plotsUsed` and `maxRep` live in state.
- **Rounds**: a held proposal is re-evaluated in the next round of the same tick against the committed world, with a fresh generator (`step` advanced). It never runs against a half-built state and never waits for the next tick. Two buys of the last seed: the first applies in round 1, the second is re-priced in round 2 and refused with the normal "Vypredané" toast. Each round can only shrink, so the loop terminates.
- **Atomicity**: a proposal is applied whole or not at all. A `run` that throws after writing coins leaves the coins untouched (it only wrote its copy); the error goes to `spec.onError` and the event is consumed.
- **Randomness**: `ctx.rng` is a mulberry32 generator seeded from `hash(seed, step, id)`, where `id` identifies the input (`ev#<seq>` for events). Streams never shift when another input is added or removed, and the result is the same whether proposals are evaluated sequentially or in parallel. `Math.random()` and `Date.now()` are banned from `engine.js`, `events.js`, `economy.js`, `items.js`, `ice.js` and `scavenge.js` (a test greps for them). Actions that still mutate the world directly on the server (phase 3 moves them onto the engine) get the same kind of generator through `E.liveCtx(world, id)`.
- **Messages**: `ctx.emit({ to, t, … })` goes to the batch outbox and is delivered by the server only after the proposal is applied (`to`: `'*'` everyone, `'area:hory'` the players on an area, otherwise a player's key). What else to refresh on the clients (tiles, inventory, market, board, storage) the server derives from the written keys and recorded changes, so a proposer never calls `sendMe` or `tileMsg` (first step of the notifier, phase 5 removes the manual calls from player actions too). `ctx.presence` is the snapshot `spec.presence(world)` took when the batch was formed (which players are connected, where they stand, whether they are searching the grass); it is input, not state.

`E.evaluate(world, input, spec)` returns one proposal's result (`{ id, reads, writes, slices, ops, outbox, reject?, error? }`) without committing anything; tests use it to prove that shuffled evaluation gives identical proposals.

### Journal

Every committed batch produces an **entry** (`out.entry`), and the server appends it as one JSON line to `data/journal-<room>.jsonl`:

```js
{ wall, tick, step,
  inputs:    [{ id, type, data, ev: { at, seq, key } }],                        // as they arrived / came due
  proposals: [{ id, type, round, reads, writes, outcome, msg?, changes? }],       // one per proposal per round
  outbox:    [{ to, t, … }] }
```

`outcome` is `applied`, `held` (re-evaluated in the next round), `rejected` (with `msg`) or `error` (with `msg`). `changes` lists, per written key, the leaves that actually changed inside the slice: `{ p: ['inv', 'fl_mak'], from, to }` (`to` missing = deleted), so a `dawn` over 1 000 tiles records only the plants that grew. The file is rotated when it exceeds `JOURNAL_MAX_MB` (20 MB by default; the previous file is kept as `.1`), `JOURNAL=0` disables it. `E.replay(world, entries, spec)` replays a journal on a saved world: due events come back from the queue, other inputs (player actions, from phase 3) are committed from the entries; the result and the new journal are identical to the original run (a test checks this). The debug page will show it (#106).

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

**Cost.** Each loop iteration costs one reconcile (O(queue length), and the queue holds a few dozen events) plus the proposals: copying the declared slices, running, writing them back and diffing them for the journal. Idle ticks cost nothing. A 30-day catch-up with a full garden (≈1 000 events) takes about 30 ms, roughly 27 µs per event (the engine before #108, which mutated the world directly, took about 12 µs; the phase-1 recorder took about 200 µs). `test/proposals.test.js` prints the number.

## Drivers

| Who | Call | What it does |
|---|---|---|
| server, every 100 ms | `E.advance(room, Date.now(), SIM, 50000)` | moves the world by as many whole ticks as have passed since `room.wall` (at most 50,000 per call); after every batch `SIM.onBatch` sends the outbox and writes the journal |
| loading a running world | `E.advance(room, Date.now(), SIM)` | catches up downtime (capped at `MAX_CATCHUP_DAYS` by moving `wall`) |
| everyone asleep | `E.advanceTo(room, min(ff.until, tick + 5), SIM)` | fast-forwards the night, 5 ticks per 100 ms so clients can animate it |
| tests, headless simulation | `E.advanceTo(world, world.tick + days * TPD, spec)` | runs any amount of game time as fast as the events allow |
| tests, a batch of actions | `E.commitBatch(world, inputs, spec)` | runs player actions (as `spec.proposers`) and events together at the current tick |

`advance()` is the only function that knows about real time. Everything else works in ticks.

## Determinism and saving

The queue, `seq`, `seed` and `step` are part of the save. Given the same saved world and the same spec, the simulation always produces the same result, whether it runs continuously, is saved and loaded halfway, jumps instead of stepping, or replays recorded batches of actions on a saved snapshot (`test/engine.test.js`, `test/proposals.test.js`).

Save format version 5 added `key` and `periodic` to events (`migrate()` in `server.js` gives keys to the events of older saves). Version 8 added `seed` and `step`, dropped `rng`, and makes sure `scavSalt` exists (it used to be drawn lazily from the shared generator). The derived counters `plotsUsed` and `maxRep` and `glacierFed` are saved too but need no version: they are recounted (or default) on load.

## Recipes

**A new periodic event** (for example a weekly market day):

```js
PROPOSERS.marketDay = { keys: () => ({ writes: ['market:*'] }), run(s, d, ctx) { … s['market:*'] … } };
PERIODIC.push({ key: 'marketDay', type: 'marketDay', next: E.every(7 * TPD, D.DAWN_TICK + 36) });
```

Existing worlds get it automatically on load.

**Something a player starts, which can be restarted or interrupted:** use a unique key.

```js
E.scheduleUnique(room, 'heat:' + pl.key, room.tick + TPD, 'heatEnd', { key: pl.key });   // from a direct action
ctx.scheduleUnique('heat:' + key, ctx.tick + TPD, 'heatEnd', { key });                      // from a proposer
E.cancel(room, 'heat:' + pl.key);
```

**A proposal** (events today, player actions from phase 3):

```js
SIM.proposers.water = {
  keys: ({ key, i }) => ({ writes: ['save:' + key, 'tile:garden:' + i] }),
  run(s, { key, i }, ctx) {
    const sv = s['save:' + key], t = s['tile:garden:' + i];
    if (!t.s) return ctx.reject('Tu nie je záhon.');          // nothing is applied, the player gets the toast
    if (sv.water <= 0) return ctx.reject('Krhla je prázdna.');
    sv.water--; t.s.w = 1;                                     // copies; written back on commit
    ctx.emit({ to: key, t: 'fx', k: 'drops', i });             // sent only if the proposal is applied
  }
};
```

**A helper that the server also calls directly** (`Econ.deliverContract`, `Ice.fillIcehouse`, …) takes the slices it needs (`contracts`, `tick`, the save, `maxRep`, a `ctx`) instead of the room, so the same function runs on a proposal's copies and, until phase 3, on the live room with `E.liveCtx(room, id)`.

**Removing content:** delete the proposer and/or the periodic declaration. Pending events in saved worlds are dropped on load, with a `[engine] zahodená udalosť …` line in the log.

## Current periodic events

| Key | When | Defined in |
|---|---|---|
| `dawn` | every day at 6:00: plants grow, weather, ice, market, composters, board | `events.js` (market part `Econ.DAWN`) |
| `hourly` | every full hour: flowers wilt, ice melts | `events.js` |
| `delivery` | every 2nd day at 7:00: wholesaler | `economy.js` |
| `npc_jano`, `npc_fero`, `npc_zuzka` | once a day at a random time between 8:00 and 18:00, at least ½ day after the previous visit | `economy.js` |
| `festAnnounce:<id>`, `festStart:<id>`, `festEnd:<id>` | yearly: 2 days before the festival, at its start, at its end | `economy.js` |
