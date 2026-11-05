# Simulation engine (`engine.js`)

The game world is a **discrete-event simulation**. Time is a whole-number counter (`tick`, 288 per game day, 1 tick = 5 game minutes). Anything that should happen in the future is an **event** in one queue, and the engine moves the clock **from event to event**. Ticks with no events in them are never simulated.

The engine is a set of stateless functions. It has no module-level state, no classes and no timers:

- **all state** lives in the world object as plain JSON and is saved with it;
- **all behaviour** (what each event does, which events are periodic) comes from a `spec` object the caller passes in.

So a world can be saved, loaded, copied or simulated headless (in tests or balance experiments) with the same code the server uses.

## State (saved with the world)

| Field | Meaning |
|---|---|
| `tick` | current game time in ticks |
| `wall` | real time (ms) that `tick` corresponds to; only used by the real-time driver `advance()` |
| `rng` | state of the seeded random generator (mulberry32, one uint32) |
| `seq` | counter of scheduled events; keeps the order stable within a tick |
| `events` | the queue, sorted by `(at, seq)` |

An event in the queue:

```js
{ at: 1234, seq: 57, type: 'cDue', data: { id: 7 }, key: 'cDue:7' }          // unique
{ at: 1296, seq: 58, type: 'dawn', data: null, key: 'dawn', periodic: true }  // periodic
{ at: 1300, seq: 59, type: 'jano_sell', data: { sp: 'mak', n: 4 } }           // normal
```

## Spec (behaviour, not saved)

```js
const SIM = {
  handlers: { dawn(world, data, ev) { … }, cDue(world, data, ev) { … }, … },
  periodic: [
    { key: 'dawn',   type: 'dawn',   next: E.daily(D.DAWN_TICK) },
    { key: 'hourly', type: 'hourly', next: E.every(12) },
    { key: 'festStart:jar', type: 'festStart', data: { id: 'jar' }, next: E.every(YEAR, startOfJar) },
    …
  ],
  onError(err, ev, world) { … }  // optional; console.error by default
};
```

**Handlers are plain callbacks.** They change the world and may schedule *other* events, but they never schedule themselves again. They don't need try/catch either: the engine handles errors.

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

1. drops events whose `type` has no handler (content removed from the game),
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

A `next` that uses `E.rand` stays deterministic: it draws from the world's seeded generator at a deterministic moment.

## Executor: jumping to the next event

```
advanceTo(world, target, spec):
  loop
    reconcile(world, spec)           ← make sure every periodic event is in the queue
    at = nextAt(world)               ← the head of the queue is the next event, of any kind
    if at is null or at > target: break
    world.tick = at                  ← jump, no empty ticks
    runBatch(world, spec)            ← run every event at this tick
  world.tick = target
```

**Why reconcile first?** Once the reconciler has run, the next occurrence of every periodic event is already in the queue. So "when is the next periodic event?" and "when is the next normal event?" are the same question, and the answer is the head of the queue. There is no need to ask two schedulers and take the minimum.

**Batches.** All events whose `at` equals the current tick run as one batch, in `(at, seq)` order. Anything a handler schedules lands at `tick + 1` at the earliest (the engine clamps it). Nothing can be added to a batch while it runs, and periodic events are replanned only *after* the batch. Two consequences:

- every event runs exactly once, at a well-defined tick;
- jumping 30 days at once gives **exactly the same world** as moving one tick at a time (a test checks this).

**Errors.** Each handler call is wrapped in try/catch inside `runBatch`. The error goes to `spec.onError` (by default `console.error` with the event's key, tick and data). The event is consumed and the simulation goes on. A poison event therefore can't crash the server, and can't crash it again when catch-up replays the same event after a restart.

**Cost.** Each loop iteration costs one reconcile (O(queue length), and the queue holds a few dozen events) plus the handlers. Idle ticks cost nothing. That's why the reconciler runs before every batch instead of on a separate timer: it is cheap, and the queue is always complete when it's read.

## Drivers

| Who | Call | What it does |
|---|---|---|
| server, every 100 ms | `E.advance(room, Date.now(), SIM, 50000)` | moves the world by as many whole ticks as have passed since `room.wall` (at most 50,000 per call) |
| loading a running world | `E.advance(room, Date.now(), SIM)` | catches up downtime (capped at `MAX_CATCHUP_DAYS` by moving `wall`) |
| everyone asleep | `E.advanceTo(room, min(ff.until, tick + 5), SIM)` | fast-forwards the night, 5 ticks per 100 ms so clients can animate it |
| tests, headless simulation | `E.advanceTo(world, world.tick + days * TPD, spec)` | runs any amount of game time as fast as the events allow |

`advance()` is the only function that knows about real time. Everything else works in ticks.

## Determinism and saving

The queue, `seq` and `rng` are part of the save. Given the same saved world and the same spec, the simulation always produces the same result, whether it runs continuously, is saved and loaded halfway, or jumps instead of stepping (`test/engine.test.js`).

Save format version 5 added `key` and `periodic` to events. `migrate()` in `server.js` gives keys to the events of older saves (`dawn`, `hourly`, `delivery`, `npc_*` → periodic with key = type; festivals → `festX:<id>`; contracts, fairy potions and searching → unique keys). The first reconcile then removes any duplicates and adds whatever is missing.

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

**Removing content:** delete the handler and/or the periodic declaration. Pending events in saved worlds are dropped on load, with a `[engine] zahodená udalosť …` line in the log.

## Current periodic events

| Key | When | Defined in |
|---|---|---|
| `dawn` | every day at 6:00: plants grow, weather, market | `server.js` |
| `hourly` | every full hour: flowers wilt, ice melts | `server.js` |
| `delivery` | every 2nd day at 7:00: wholesaler | `economy.js` |
| `npc_jano`, `npc_fero`, `npc_zuzka` | once a day at a random time between 8:00 and 18:00, at least ½ day after the previous visit | `economy.js` |
| `festAnnounce:<id>`, `festStart:<id>`, `festEnd:<id>` | yearly: 2 days before the festival, at its start, at its end | `economy.js` |
