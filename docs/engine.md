# Simulation engine (`engine.ts`)

The game world is a **discrete-event simulation**. Time is a whole-number counter (`tick`, 11 520 per game day, 1 tick = 7.5 game seconds; before save version 9 it was 288 per day and `migrate()` scales every stored tick ×40). Anything that should happen in the future is an **event** in one queue, and the engine moves the clock **from event to event**. Ticks with no events in them are never simulated.

Since engine v2 (#105; phase 1 in #107, phase 2 in #109, phases 3–5 in #111) nothing changes the world directly. Everything that happens in a tick, a due event, a player's action, a move, a player joining or leaving, is a **proposal**: it declares which **slices** of the world it reads and writes, runs on plain copies of exactly those slices, and the engine then **commits** the accepted proposals, whole or not at all, and writes one entry per batch to a **journal**. The engine is still a set of stateless functions: no module-level state, no classes, no timers:

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
  proposers: {                                   // by input type: event types (events.ts, economy.ts) and player actions (actions.ts)
    dawn:   { keys: (data, world, presence) => ({ writes: ['tile:garden:*', 'save:*', 'weather', …], reads: ['eternal'] }),
              run(slices, data, ctx) { … } },
    cDue:   { keys: ({ id }, world) => …, run(slices, { id }, ctx) { … } },
    buy:    { keys: ({ key, id }) => ({ writes: ['market:seed_mak', 'save:' + key] }), run(slices, { key, id, n }, ctx) { … } },
    …
  },
  periodic: [
    { key: 'dawn',   type: 'dawn',   next: E.daily(D.DAWN_TICK) },
    { key: 'hourly', type: 'hourly', next: E.every(12) },
    { key: 'npc_jano', type: 'npc_jano', next: (from, rng) => E.nextDailyTick(from + TPD / 2, 96 + rng.int(120)) },
    …
  ],
  presence: world => [{ key, name, area, x, y, scav }, …],   // optional: a snapshot of what is not state (connected players); each proposal gets its own copy as ctx.presence, the entry of input.actor as ctx.actor
  onBatch: (world, out) => { … },        // optional: after every committed batch – send out.outbox, store out.entry (journal)
  slice: (world, key) => { get(), set(v) } | null,   // optional: override the default key → slice mapping
  onError(err, ev, world) { … }          // optional; console.error by default
};
```

A **proposer** has two pure parts. `keys(data, world, presence)` returns the keys it will read and write; it may look at read-only facts of the world (which saves exist, who took a contract, which plants stand around a tile) and at the presence snapshot (who is connected, for a wish that pays everyone) but must not change anything. `run(slices, data, ctx)` receives plain **copies** of exactly the declared slices, indexed by key (`slices['tile:garden:12']`, `slices['save:ana']`, `slices['market:*']`, `slices.weather`), mutates them with ordinary code and returns. `ctx` carries `tick`, `id` (the input's identity), `rng` (own generator: `rand() / int(n) / pick(list)`), `emit(msg)` for messages to players, `reject(msg)` for a refused action (`reject(null)` refuses silently), `schedule / scheduleIn / scheduleUnique / cancel / pending` for the queue, `presence` (the proposal's own copy of the snapshot) and `actor` (the presence entry of the acting player, `input.actor`). A proposer never schedules itself again and never touches anything outside its slices: an undeclared slice is simply `undefined`, so touching it throws, and changing a slice declared only for reading is reported as an error of the proposal.

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
| `pull:<player>` | pulling silk from a web finishes (`pullDone`; moving or raising the lantern cancels it) |

### 3. Periodic (declared)

Periodic events are **never scheduled by hand**. `spec.periodic` declares them:

```js
{ key, type, data?, next(from, rng) }  // next returns the first tick >= from when it should happen; rng is a generator for random times
```

The **reconciler** `E.reconcile(world, spec)` keeps the queue consistent with the declarations:

1. drops events whose `type` has no handler or proposer (content removed from the game),
2. drops periodic events whose `key` is no longer declared (a removed festival or NPC),
3. if a periodic key appears more than once, keeps only the earliest,
4. for each declared key with no pending event, plans one at `next(tick + 1, rng)`.

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
| custom | anything, including random times. For example, an NPC visit: `(from, rng) => E.nextDailyTick(from + TPD/2, 96 + rng.int(120))` |

A `next` that draws random numbers is deterministic: `E.planAt(world, def, from)` gives it a generator seeded from `(seed, 'plan', key, from)`, so the planned time depends on nothing but the world's seed, the key and the moment it is planned. It is the same whether the engine jumps or steps.

## Proposals: how a tick is executed

Everything due in a tick forms one **batch**: either the due events of the tick (from the queue) or the player actions of one server frame (`{ type, data, id: 'a#<n>', actor: '<player key>' }`, see *Player actions* below). Events and actions are never mixed in one batch; later phases of #105 add movement and NPC actors as inputs. `E.commitBatch(world, inputs, spec)` runs it:

```
round:
  for each input, in batch order:
    keys = proposer.keys(data, world)
    if keys meet the writes of a proposal already applied in this round: hold the input (not even evaluated)
    slices = copies of the declared slices; result = proposer.run(slices, data, ctx)   ← own random generator
    if the result's keys (incl. event:<key> touched through ctx) meet earlier writes: hold
    else if rejected: apply nothing (out.rejected carries the message for the actor; events never reject)
    else: write the slices back into the world (in place), then the queue ops; record the changes
  step += 1
  if anything was held: next round, same tick, against the committed world
spec.onBatch(world, { applied, rejected, outbox, entry })
```

### Slices and keys

A **key** names a slice of the world. `E.sliceOf(world, key)` is the default mapping (game knowledge: how the world is stored, see `serialize` in `server.js`):

| Key | Slice |
|---|---|
| `tile:garden:12`, `tile:hory:3` | one tile of one area; `tile:garden:*` the whole tile array of the area (`garden` → `world.tiles`, `hory`, `les`, `pomedzie`) |
| `save:ana` | one player's save (coins, inventory, reputation, …; the key may contain `:`, never `*`) **without** the position fields; `save:*` all saves, likewise |
| `pos:ana` | the same save's `x`, `y`, `area`, `lastTick`: written by every move, so it is its own slice and a save write-back never touches it (`E.POS_FIELDS`) |
| `market:seed_mak`, `market:fl_mak`, `market:compost`, `market:festival`, `market:hist`, `market:news`, `market:npc:jano` | one market entry; `market:seed_*`, `market:fl_*`, `market:npc:*` a collection; `market:*` the whole market. A flower entry carries its festival multiplier (`flowers[sp].fest`, written by `festStart` / `festEnd`), so a sale needs only its own entry; `market:festival` is the client-facing summary |
| `contracts` | the board (`list`, `nextId`) |
| `storage` | the shared storage as `{ inv, fb }` (`world.storage` + `world.storageFb`) |
| `event:<key>` | a keyed event: added by the engine when `ctx.scheduleUnique / cancel / pending` is called with that key |
| `spider:<id>`, `spider:*`, `kz:<area>` | one spider in Les divov / all of them (`world.sps`), a krížiak on its way to a corner (`world.kz`): mapped by `spec.slice` (`Spiders.slice`, falling back to `sliceOf`) |
| anything else | the world property with that name: `weather`, `eternal`, `fairyNight`, `icehouse`, `scav`, `scavSalt`, `up`, `plotsUsed`, `maxRep`, `glacierFed`, `webs`, `corners` (spiders), `daySeconds`, `lesSeed`. Collections (`saves`, `tiles`, `market`, …) and the queue are not slices under their property names |

Rules:

- A key ending in `*` is a collection and **meets** every key with the same prefix (`save:*` meets `save:ana`; `market:*` meets `market:seed_mak`). Two proposals whose keys never meet are independent and could be evaluated in parallel. One proposal must not declare two keys that meet (`save:*` and `save:ana` would be two independent copies of the same data); writing to a slice it did not declare, or changing a slice declared only for reading, is an error of the proposal.
- **Write-back is in place.** Objects already in the world are changed from the inside, so the objects the server holds (a player's save, a tile, the market) keep their identity. Arrays are synced element by element while their length is unchanged (tiles, a full news list); an array whose length changed is replaced as a whole. So an element removed from a list keeps its own values, but a list element is not a stable identity across a batch: look it up again by id.
- **Granularity is the proposer's choice.** `dawn` legitimately changes every tile and every save and declares the collections (`tile:garden:*`, `save:*`): that only holds `hourly` and the market events to round 2 of the 6:00 tick, also during a 30-day catch-up. Market events (`delivery`, NPC visits, festivals) declare the whole market (`market:*`); player actions declare one item (`Econ.marketKey(id)`: `market:seed_mak` + `save:ana` for a buy, so two players buying different seeds in one frame never wait for each other). Reading every tile to count plots or every save to find the best reputation would make a hoe conflict with everything, which is why `plotsUsed` and `maxRep` live in state. A proposal whose effect depends on its own dice (the wishing well may bring rain) declares the keys of every outcome up front.
- **Rounds**: a held proposal is re-evaluated in the next round of the same tick against the committed world, with a fresh generator (`step` advanced). It never runs against a half-built state and never waits for the next tick. Two buys of the last seed: the first applies in round 1, the second is re-priced in round 2 and refused with the normal "Vypredané" toast; two hoes on the same tile: the second is refused with "Tu už je záhon.". Each round can only shrink, so the loop terminates.
- **Atomicity**: a proposal is applied whole or not at all. A `run` that throws after writing coins leaves the coins untouched (it only wrote its copy); the error goes to `spec.onError` and the event is consumed.
- **Randomness**: `ctx.rng` is a mulberry32 generator seeded from `hash(seed, step, id)`, where `id` identifies the input (`ev#<seq>` for events, `a#<n>` for player actions). Streams never shift when another input is added or removed, and the result is the same whether proposals are evaluated sequentially or in parallel. `Math.random()` and `Date.now()` are banned from `engine.ts`, `events.ts`, `actions.ts`, `economy.ts`, `items.ts`, `ice.ts` and `scavenge.ts` (a test greps for them). The only thing that still runs over the live world is the creation of the market and the board when a world is loaded (`E.liveCtx(world, 'ekonomika')`).
- **Messages**: `ctx.emit({ to, t, … })` goes to the batch outbox and is delivered by the server after the batch is committed, only for applied proposals (`to`: `E.ALL` everyone, `E.area('hory')` the players on an area, otherwise a player's key as a string). A refused proposal's message goes as a toast to its actor. What else to refresh on the clients (tiles, inventory, market, board, storage, plot permit, weather) the server derives from the written keys and recorded changes, so a proposer never calls `sendMe` or `tileMsg`. A few messages addressed to a player are directives for the server's presence instead of client messages: `scavStart` / `scavDone` (the player started / stopped searching the grass), `me` (refresh the inventory view). `ctx.presence` is the snapshot `spec.presence(world)` took when the batch was formed (which players are connected, where they stand, whether they are searching the grass); each proposal gets its own copy, `ctx.actor` is the acting player's entry, and the snapshot is recorded in the journal entry so a replay sees the same presence. It is input, not state.

`E.evaluate(world, input, spec, presence)` returns one proposal's result (`{ id, reads, writes, slices, ops, outbox, reject?, error? }`) without committing anything; tests use it to prove that shuffled evaluation gives identical proposals.

### Player actions, movement and presence

Phases 3–5 (#111) made every message that changes game state an input of the engine. The socket handler only checks that the message type is known and appends `{ pl, m, seq, tick }` to the room's **inbox** (`seq` = arrival order, `tick` = the tick at arrival; the inbox is capped per room and per player, extra messages are dropped). Once per 100 ms the server runs a **frame** for each room:

1. **Resolution round** over the inbox. Messages of players who have left are dropped (except their own `leave`). `move` messages are coalesced per player (the latest wins): direction, crawl and lantern go straight to presence (cosmetic), the position is mirrored into presence at once (the `pl` broadcast relays it) **and** becomes a `pos` input, so an action in the same frame is checked against the player's latest position; the other messages follow in `seq` order. Presence-only messages (`jump`, `sleep`, `settings`, `chat`, the emote itself) are handled directly. Everything else becomes an engine input `{ type, data: { key, … }, id: 'a#<seq>', actor: key }`: a tap on a tile (`act`) is first turned into a concrete action by `Actions.resolveAct(world, presence, actor, m)`, which looks at the tile, the item in hand and who stands there and yields `till`, `water`, `plant`, `pick`, `gift`, `well`, `potion`, `scavStart`, … (or a toast for a presence-only refusal such as "Si príliš ďaleko"); a dance emote in the mushroom ring adds a `dance` input with the message's wall time; joining, leaving and the 15 s "last seen" refresh are `join`, `leave` and `seen` inputs the server queues itself. Of one player's tile actions only the first is admitted per frame; the next few stay at the head of the inbox for the next frame (at most `DEFER_MAX`, more are dropped). Market, board, storage and inventory messages are admitted in order, unfiltered.
2. **One action batch** `E.commitBatch(room, inputs, SIM)` at the current tick. Because the world only moves inside the frame, the current tick is exactly the tick every message that arrived since the last frame was stamped with, so those actions evaluate against the world as it was when they arrived, after the events of that tick and before the events of the next. A deferred tile action is committed in a later frame at that frame's tick (the stamp is kept on the inbox entry only for inspection).
3. **Advance** game time (`E.advance`), which commits the due event batches.

So the journal is an exact timeline of alternating event batches (inputs with `ev`) and action batches (inputs with `actor`), never mixed. `actions.ts` holds the proposers; `Econ.*`, `Ice.*`, `Scav.*` and `I.*` are the same helpers the events use, called on slices. Stopping a grass search (acting elsewhere, going to sleep) is itself an input (`scavStop`) that cancels the `scavDone` event, so nothing touches the queue outside a batch.

**Movement is state.** The `pos` proposer writes `pos:<key>` and reads the tiles under the four corners of the player's body. It clamps the point to the area, refuses it silently if any corner stands on impassable ground (the client's own rule, minus the jump height the server cannot know; there is no speed check), lets players share a tile, and sets `lastTick`. On a gate tile it writes the arrival point of the target area and emits a `travel` directive; a searching player who moved more than 0.35 tiles from where the search started gets the search cancelled. A refused move makes the server reset presence to the committed position and send the client a `pos` correction, so the two can never drift apart for long. `join` creates or migrates the save (start capital and look come in the input, so the journal is complete) and emits a `joined` directive on which the server sends the welcome, time, market, board, inventory and room; `leave` and `seen` only write `lastTick`; `dance` reads the dancers from presence (`emote`, `emoteAt` against the input's `now`) and pays the fairies' seeds once per night.

**Directives** are messages a proposer addresses to a player that the server consumes instead of forwarding: `scavStart`, `scavDone`, `travel`, `joined`, `me`. **What stays outside the engine:** presence itself (where the socket says the player is before the batch confirms it, direction, crawl, lantern, emote timing, sleeping, the room's running/paused mode, chat), and the `pl` broadcast that relays it ten times a second.

### Journal

Every committed batch produces an **entry** (`out.entry`), and the server appends it as one JSON line to `data/journal-<room>.jsonl`:

```js
{ wall, tick, step,
  inputs:    [{ id, type, data, ev: { at, seq, key } }],                        // as they arrived / came due
  proposals: [{ id, type, round, reads, writes, outcome, msg?, changes? }],       // one per proposal per round
  outbox:    [{ to, t, … }] }
```

`outcome` is `applied`, `held` (re-evaluated in the next round), `rejected` (with `msg`, `null` for a silent refusal) or `error` (with `msg`). Inputs carry `actor` for player actions and `ev` for events, and the entry carries `presence`, the snapshot the batch saw. When a world is loaded the server writes a marker line `{ load: true, tick, step, seq }` first, so a reader can tell where a run restarted (after a crash the ticks caught up on load are journaled again). `changes` lists, per written key, the leaves that actually changed inside the slice: `{ p: ['inv', 'fl_mak'], from, to }` (`to` missing = deleted), so a `dawn` over 1 000 tiles records only the plants that grew. The file is rotated when it exceeds `JOURNAL_MAX_MB` (20 MB by default; the previous file is kept as `.1`), `JOURNAL=0` disables it. `E.replay(world, entries, spec)` replays a journal on a saved world: due events come back from the queue, player actions are committed from the entries, each batch with the presence recorded in its entry; the result and the new journal are identical to the original run (tests check this for a headless run and for a server session with real messages). Everything that changes a save, a tile, the market, the board or the queue is in the journal, including joins, leaves, moves and the fairy dance (its wall-clock time travels in the input); what is not is presence itself (direction, emotes, sleeping, the mode switch) and the player's `look`, which the join input carries. Journals written before save version 9 use the old tick grid and cannot be replayed onto a migrated world.

### Debug view (#106)

The server also keeps the last batches of every loaded room in memory (`room.trace`, a ring buffer of `DEBUG_TRACE` records, 600 by default; never saved) for /debug → Engine. A record is the journal entry itself (not a copy) plus what the journal does not hold: each applied proposal's messages and queue operations (`r.outbox`, `r.ops`; `applyResult` writes the `seq` the commit gave an inserted event onto its op, so the queue view can tell which proposal scheduled a pending event), the actor filter's decisions of that frame with their rule, which driver produced the batch (`frame`, `live`, `catchup`, `ff`) and timings. Timings come from an optional `spec.clock` (`() → ms`; the server passes `performance.now`): `commitBatch` then returns `out.timing = { schedule, evaluate, resolve, commit }` (`schedule` = reconcile and collecting the due events, measured by `advanceTo` / `runBatch`); the server adds `filter`, `journal` and `notify`. Timings are never in the entry, so a replayed journal stays identical. Everything else on the page (why a proposal was held: the earlier applied proposal of the same round whose writes meet its keys; resolver groups; world changes per concrete key) is derived from the entry by `debug/api/engine.js`. Re-running a past batch to check determinism is not offered: it needs the world as it was before the batch, which is not kept (`E.replay` over a saved world and its journal does that offline).

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
| server, every 100 ms | `frame(room)` (its action batch, then `E.reconcile`, so periodic events an action cancelled are re-planned before anything else, exactly as `E.replay` does before each entry), then `E.advance(room, Date.now(), SIM, 50000)` | first the frame's moves, player actions and presence inputs as one `commitBatch` at the current tick, then the world moves by as many whole ticks as have passed since `room.wall` (about one per frame at 9.6 ticks/s; at most 50,000 per call); after every batch `SIM.onBatch` sends the outbox and writes the journal. The `time` message goes to clients at most once a second |
| loading a running world | `E.advance(room, Date.now(), SIM)` | catches up downtime (capped at `MAX_CATCHUP_DAYS` by moving `wall`) |
| everyone asleep | `E.advanceTo(room, min(ff.until, tick + 200), SIM)` | fast-forwards the night, 200 ticks per 100 ms (about 3 s for the night) so clients can animate it |
| tests, headless simulation | `E.advanceTo(world, world.tick + days * TPD, spec)` | runs any amount of game time as fast as the events allow |
| tests, a batch of actions | `E.commitBatch(world, inputs, spec)` | runs a batch of player actions (`Actions.PROPOSERS`) at the current tick |

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

**Something a player starts, which can be restarted or interrupted:** use a unique key, from the proposer.

```js
ctx.scheduleUnique('heat:' + key, ctx.tick + TPD, 'heatEnd', { key });   // the engine adds the key 'event:heat:<key>' to the proposal
ctx.cancel('heat:' + key);
```

**A player action** (`actions.ts`): a proposer per message type, with the actor's key in `data`; the server builds the input from the message and the socket's player.

```js
PROPOSERS.water = {
  keys: ({ key, i }) => ({ writes: ['save:' + key, 'tile:garden:' + i] }),
  run(s, { key, i }, ctx) {
    const sv = s['save:' + key], t = s['tile:garden:' + i];
    if (!t.s) return ctx.reject(null);                         // nothing happens, no toast
    if (sv.water <= 0) return ctx.reject('Krhla je prázdna.');  // nothing is applied, the player gets the toast
    sv.water--; t.s.w = 1;                                     // copies; written back on commit
    ctx.emit({ to: E.area('garden'), t: 'fx', k: 'drops', x, y });   // sent only if the proposal is applied
  }
};
```

A new message type needs: the type in the server's `MESSAGES` set, a case in `toInput` that validates the shape and builds `data`, and the proposer. A new tile action is a new branch in `resolveAct`. The client is refreshed from the written keys (`save:` → `me`, `tile:` → `tile`, `market:` → `market`, `contracts` → `board`, `storage` / `icehouse` / `eternal` → `room`, `plotsUsed` / `up` → `plots`), so nothing else is needed.

**A helper shared by events and actions** (`Econ.deliverContract`, `Ice.fillIcehouse`, `Scav.pickWild`, …) takes the slices it needs (`contracts`, `tick`, the save, `maxRep`, a `ctx`) instead of the room, so the same function runs on any proposal's copies.

**Removing content:** delete the proposer and/or the periodic declaration. Pending events in saved worlds are dropped on load, with a `[engine] zahodená udalosť …` line in the log.

## Current periodic events

| Key | When | Defined in |
|---|---|---|
| `dawn` | every day at 6:00: plants grow, weather, ice, market, composters, board | `events.ts` (market part `Econ.DAWN`) |
| `hourly` | every full hour: flowers wilt, ice melts | `events.ts` |
| `delivery` | every 2nd day at 7:00: wholesaler | `economy.ts` |
| `npc_jano`, `npc_fero`, `npc_zuzka` | once a day at a random time between 8:00 and 18:00, at least ½ day after the previous visit | `economy.ts` |
| `festAnnounce:<id>`, `festStart:<id>`, `festEnd:<id>` | yearly: 2 days before the festival, at its start, at its end | `economy.ts` |
| `spider:s0` … `spider:s6` | one per spider in Les divov: planned from the spider's own state (`world.sps[id].next`: every 200 ms of real time while it moves, its own deadline while idle, a week ahead while it sleeps). Whoever wakes a spider (a move, a pull, walking into a web) sets `next` and cancels the event, and the next reconcile plans it again | `spiders.ts` |
| `kz:garden`, `kz:hory` | the krížiak on its way to a corner (`world.kz[area].next`), likewise | `spiders.ts` |
| `weave:0` … `weave:6` | a spider weaves again the webs torn a day ago: planned from the earliest due time in `webs.pend[o]` (a week ahead when there is none); tearing a web cancels it so reconcile re-plans it | `spiders.ts` |
| `webDawn` | every day at 6:00: the number of webs per spider by season | `spiders.ts` |
| `kriziakTrip` | at a random time, on average twice a day (twice as often in autumn): a krížiak sets out to a free corner | `spiders.ts` |
