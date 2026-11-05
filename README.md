# 🌸 Čarovná záhrada

[![CI](https://github.com/marekvasko/magic-flowers/actions/workflows/ci.yml/badge.svg)](https://github.com/marekvasko/magic-flowers/actions/workflows/ci.yml)

A multiplayer web game about growing flowers, in the spirit of Stardew Valley. It is designed for **mobile phones in portrait mode**, and it also runs in a desktop browser.

## Running the game

```bash
npm install
npm start            # http://localhost:3000
```

- `PORT=8080 npm start` changes the port.
- `DAY_SECONDS=60 npm start` makes a game day shorter (the default is 300 s, so one day lasts 5 minutes). `npm run dev` uses 60 s for testing.

**Playing together:** both players open the same address and enter the same **garden code** (or one sends the other a link like `http://<ip>:3000/?room=zahrada`). Up to 4 players can share a garden. On a local network, use your computer's IP address, for example `http://192.168.1.20:3000`.

The world is saved to `data/room-<code>.json`. This includes the garden, money and inventory, keyed by player name.

## Docker + Traefik

```bash
cp .env.example .env      # set DOMAIN=...
docker compose up -d --build
```

The container joins the external `web` network and Traefik exposes it on the `websecure` entrypoint with a certificate from the `tlschallenge` resolver. WebSockets work through Traefik without extra configuration. Saved gardens live in the `magicflowers-data` Docker volume (kept on `docker compose down`, removed only by `down -v`).

**Environments (CI/CD):** deployments are automatic, done by a self-hosted GitHub Actions runner on the host via `scripts/deploy.sh`:

- every PR gets a preview at `https://pr-<n>.zahrada.spis-ai.com/`, removed when the PR closes (plus a daily/after-dev-deploy cleanup of previews whose PR is no longer open);
- `dev` is staging at `https://dev.zahrada.spis-ai.com/`;
- releases (`v*` tags on `main`) go to production at `https://zahrada.spis-ai.com/`.

On the GitHub Deployments page only the deployment that is currently running stays active: each new deploy marks the older deployments of its environment (or of its PR) `inactive`, and closing a PR marks all its preview deployments `inactive` (`scripts/deployments.sh`; history is kept, nothing is deleted).

The branching model, worktrees and the release procedure are described in [AGENTS.md](AGENTS.md).

## Time and world settings

- Game time is **discrete**: every day has exactly 288 steps (1 step = 5 game minutes). Day, hour and season are always derived from a single integer counter, so there is no drift, and a delayed timer catches up the missed steps.
- Everything that should happen in the future (dawn, end of potion effects, …) is an **event in a scheduler** (`engine.js`). The queue, the step counter and the random generator's state are saved with the world, so they survive a server restart. Periodic events (dawn, hourly, deliveries, NPCs, festivals) are only declared; the engine makes sure each one is always planned. Time jumps from event to event instead of stepping through empty steps. See [docs/engine.md](docs/engine.md).
- One game day lasts **20 minutes** of real time (fixed: `BASE_DAY_SECONDS` in `shared/data.js`; the `DAY_SECONDS` env variable is only for testing). A season is 4 days (~80 min), a year ~5.3 hours.
- **World setting** (Menu → ⚙️, per garden): whether the world keeps running when nobody is playing.
- A running world catches up the time the server was down (at most `MAX_CATCHUP_DAYS` game days, default 30).
- New worlds use `DEFAULT_MODE` (`running` by default). Gardens saved in the old format are migrated automatically and keep the paused behaviour; switch them in the menu.
- **Shared storage** in the house: items are shared by everyone in the garden, money is per player.
- `npm test` runs the engine tests (`test/`).

## Economy

All of it lives in `economy.js` and runs on the event scheduler; its state (`room.market`, `room.contracts`) is saved with the world.

- **Poor start:** 30 coins, 4 seeds of the cheapest in-season flower, a watering can for 5 pours. Players from older versions keep what they had (can 25). In PR previews and dev, `scripts/deploy.sh` sets `START_COINS=5000` and `START_REP=3` (reputation level), so new players there can test everything right away; production keeps the poor start.
- **Field permit (*Povolenie na pole*):** shared by the whole garden, like the icehouse. Every tilled tile of every player counts toward one limit (`room.up.plots`, saved with the world): 8 → 16 → 28 → 48 → 96 tiles. Any player can buy the next level for everyone (100 / 350 / 1000 / 2500 coins, reputation 0 / 1 / 2 / 3). Tilling is shared too: any player can level any empty tilled tile with the hoe, which frees a slot (the tile still remembers who tilled it, for notifications). Save version 6 migrated the old personal permits: the garden got the highest level any player had; fields above the limit stay, but no new ones can be tilled until the total drops.
- **Upgrades** (Market → Upgrade): bigger watering can, the shared field permit, composter (compost every morning). Higher tiers need reputation. The same tab sells the **pickaxe** (60 coins, once per player), the **lantern** (80 coins, once per player, see below) and the shared **icehouse** building (400 coins, reputation 1, see *Ice* below).
- **Lantern (*lampáš*):** a tool with its own hotbar slot, bought once at the market (no fuel). While it is selected and it's dark, it lights a radius of 6.5 tiles around the player and flickers like a flame. Without a lantern in hand, a player gives off no light at all. The selection is sent with every move (`lp`), so other players see the lantern in the carrier's hand and its light. **In *Les divov*** it is needed: there it lights up even by day and widens what you can see (see below). Planned use (#23): fighting off spiders in the dark forest.
- **Living market:** limited seed stock; seed price depends on stock and season (in season they are expensive and scarce). The flower buy-back price drops as the market fills up, recovers overnight, is higher off-season and during festivals. Prices are recorded every morning and shown as small charts.
- **Wholesaler** delivers every 2 days at 7:00 – mostly seeds for the *next* season.
- **NPC traders:** gardener Jano buys the seeds with the best expected profit per day, grows them and later floods the market with flowers; speculator Fero hoards cheap seeds before the season and sells them when they are expensive; florist Zuzka buys flowers from the market. Everything shows up in Market → News.
- **Festivals** (Mother's Day, wedding season, All Souls' Day, Christmas), announced 2 days ahead, with higher buy-back prices for specific flowers.
- **Flowers wilt** (`items.js`): every cut flower has a vase life per species (poppy 2 days, tulip 4, chrysanthemum 7, lavender 8, edelweiss 12, fern flower 1). Flowers are kept in batches with an age; the oldest go first. Freshness lowers the buy-back price down to 50 %. When the life runs out (checked every game hour, for offline players too) they turn into *wilted flowers*; 4 of them make 1 compost in the storage. In the cool shared storage flowers age 2× slower, and 4× slower while the icehouse has ice (the batches are rebased whenever that rate changes, so no flower jumps in age). A blooming plant left in the field fades after the same time – annuals die, perennials (rose, lavender) bloom again later.
- **Contract board** at Babka's hut: short contracts, contracts for the next season (posted in advance so you can plan) and big contracts from reputation 2. Reserve a contract, the deadline is fixed, you can deliver in parts. Completion gives coins and reputation; a missed deadline costs 5 reputation. Reputation level = how many contracts you may hold at once.

## How much of the world you see (same on every device)

The game always fills the whole screen, on a phone and on a computer, in portrait and in landscape. So that no device shows more of the world than another, the zoom is set so that the **screen diagonal always spans exactly `VIEW_DIAG` = 22 blocks** (`shared/data.js`):

- A screen of `pxW × pxH` pixels shows `22·pxW/√(pxW²+pxH²)` × `22·pxH/√(pxW²+pxH²)` blocks (`GameData.viewSize`). For example, a phone held upright (390 × 844) shows 9.2 × 20.0 blocks and a 1440 × 900 monitor shows 18.7 × 11.7 blocks.
- The player is always in the centre of the screen; the orthographic camera's view plane has the 22-block diagonal.

## Gameplay

- **Movement:** put a finger anywhere on the screen and drag – a joystick appears right there and stays anchored at that spot until you lift your finger. Or tap the spot you want to walk to (the character finds a path around obstacles). On a computer use WASD / arrow keys or drag with the mouse, E / Enter for the action and 1–9 for the toolbar.
- **Jump and crawl** (just for fun, other players see it): Space = jump, hold Shift = crawl (slower, low to the ground). On touch devices there are two thumb buttons at the bottom right above the toolbar (⤴ jump, 🐛 crawl on/off); while steering with the joystick, a tap with a second finger anywhere also jumps.
- **Tap an object** (market, Babka, cauldron, well, blooming flower, another player) to use it right away – if it's far away, the character walks there first. Ground actions (digging, watering, planting) need you to be close: the first tap walks there, the second one acts.
- **Ground actions** (dig, water, plant, pick): tap a tile next to you; what happens depends on the item selected in the toolbar.
- **Time and seasons:** a new day starts at 6:00, and plants grow at that moment. Each season lasts 4 days. In winter, frost kills everything except winter flowers. When the season changes, out-of-season plants get 2 days of grace (growing at half speed), and flowers that are already blooming survive.
- **Sleeping:** from 18:00 you can go to bed in the house (tap the house → 🛏️). When every player in the garden is asleep, the server fast-forwards the night (5 steps per 100 ms, ~3 s) up to 6:00, so dawn, growth and all scheduled events run normally; the skipped time is not caught up afterwards. While someone is waiting for the others they can get up again; the others see 💤 above them. Night-only magic (fern flower, fairies) is skipped.
- **Weather:** rain waters the whole garden.
- **Coming back:** after an absence of at least one game day you get a toast saying how many days passed. A quick reconnect (a dropped connection, or the same name opened again within 10 s) counts as staying: no "while you were away" toast and no "left / arrived" messages for the others.
- **What each flower needs:** season, light (sun / shade near the forest), soil (normal, **sand** by the pond, **rock garden** in the south-east, **compost** = rich soil) and water. A happy plant gives 3 flowers, and compost adds one more.
- **Scavenging wild seeds** (a way back when you have nothing): tap an untilled grass tile with an empty hand (select an empty toolbar slot; one is always shown) or while holding anything that does nothing there (seeds, flowers, compost, the watering can…). The hoe still digs and potions are still used as usual. The character first walks onto that tile (the server also requires standing on it), then crouches and digs through the grass with both hands with 🔍 above the head, and a few bits of soil and grass fly subtly from the centre of the tile, right to left (world-space particles in `particles3d.mjs` that land on the ground and follow the ✨ particle setting). At the next game tick (within 5 game minutes) the server answers, but only if you are still searching then (moving or any other action stops it). The search is **spatial**: every game hour the server secretly picks which grass tiles hold a seed (about 7 % of them; more at the forest edge, fewer next to paths and buildings, most in the morning dew 6:00–10:00, almost none at night, more in summer and autumn, few in winter). You have to walk from tile to tile; on the right tile you find it with a 75 % chance, and a searched tile stays empty until the next hour. The client knows nothing about where the seeds are. One search per tick lets you try about 12 tiles per game hour, so steady searching in daylight gives about 8–10 seeds per game day in spring (about 5 % per search in an open field), and more at the forest edge, in the morning and in summer/autumn. You find a *Divé semienko* (wild seed) of the current season. It can only be planted in that season and can't be sold, but it can be gifted. What grows from it is decided at planting time. Any in-season flower can come up (not edelweiss, and no magic flowers), and the higher a flower's market price is at that moment, the more likely it is (weight = price²). You only see what it is once it sprouts at dawn (`scavenge.js`, `D.SCAVENGE`).
- **Market:** buy seeds and compost, sell flowers and elixirs, buy upgrades, read market news (see Economy).
- **Babka bylinkárka (the herb grandma):** her hut has the contract board (see Economy) and she gives tips.
- **Gifts:** select an item and tap another player.
- **Emotes:** 👋 ❤️ 💃 and chat 💬 (key **T**) float in a row just above the toolbar; the view-rotate buttons ⟲ ⟳ sit at the ends of the same row (screen edges on mobile, panel edges on desktop). Messages appear as speech bubbles above the player (wrapped, up to 4 lines) and briefly in the corner; opening the chat shows the history of the last 50 messages.

## Areas: the garden, Les na pomedzí, Les divov and the mountains

The world has several play areas. Each has its own size (`D.AREA_SIZE`, used for movement, collision, tile messages and the 3D world) and its own `gate` tiles on its edges; each gate has a target area (`D.GATES[area] = [{ x, y, to }]`) and every connection has an arrival point (`D.ARRIVE['from>to']`, read with `D.arrival(from, to)`). The rules live in `areas.js` (`gateTarget`, `clampPos`, `areaTiles`), tested in `test/areas.test.js`.

- **Záhrada** (garden): the north-east trail leads up to the mountains, the trail at the **east edge** (where the village path ends, rows 25–26) to *Les na pomedzí*.
- **Les na pomedzí** (the borderland forest, internal id `pomedzie`, same size as the garden): an in-between area on the way to *Les divov*. For now you just walk through it – nothing can be planted or searched there. In the **south** there is a meadow full of wildflowers (by season) with a few trees and bushes, in the **middle** a mild forest with bushes, ferns and a few winding trails (the main one goes from the garden gate in the west to the north edge, side trails end in small clearings, one trail wanders across the meadow). Towards the **north** the trees get denser (more and more conifers) until only the trail to the north edge is left – the gate to *Les divov* is there (columns 9–10). The **light fades** towards the north: ambient light and sunlight drop with the tile row (`D.gloomAt`, up to −80 % at the north edge, nothing in the meadow) and a dark green haze settles in; the sky follows where you stand. Lanterns are not dimmed and light up in the dark forest even during the day. Weather, seasons and day/night work as in the garden on top of that. In the **last rows before the gate to Les divov** (rows 10 → 2, `D.DARK_RAMP` / `D.darkAt`) the look of Les divov fades in gradually by where you stand: its dark ambient light, dappled sun instead of the shadow map, dark background, the limited sight around your character, the weaker lantern and no tree outlines – at the gate it looks exactly like Les divov, so walking through doesn't jump.
- The forest layout is generated from a per-world seed (`D.buildPomedzie(seed)`, saved as `pomedzieSeed`): every world has its own forest, and it is always the same. Every walkable tile is reachable from both the garden gate and the north end (closed-off corners are filled with trees).
- Save format v4 adds `pomedzieSeed`; older saves get a new seed, their gardens and players' positions stay as they are.
- **Les divov** (the forest of wonders, internal id `les`): the big dark forest north of *Les na pomedzí*, **2× the garden in each direction** (40 × 68 tiles, `D.LES_W × D.LES_H`). You arrive from the north edge of Les na pomedzí at the bottom of the forest; the gate at the **south edge** (columns 19–20) leads back. It's a maze of **narrow paths** (1–2 tiles; wherever an open 3 × 3 spot would appear outside a clearing, its centre gets a bush) between **giant trees** whose trunks take 2 × 2 tiles (`giant` in the top-left corner, `trunk` on the other three), with smaller trees, bushes and fallen logs (`log`) in between and a few **clearings** (`glade`, where #23 will put the cobwebs). The ground is dark moss, roots, ferns and mushrooms (`moss`, `roots`, `fern`, `fungi` – walkable decoration). The maze is a random spanning tree over 4 × 4-tile cells plus a few extra loops, built from the world's seed (`D.buildLes(seed)`, `lesSeed`); every walkable tile is reachable from the entrance (closed-off corners grow trees). Nothing can be planted or searched there yet.
- **Darkness** (`D.DARK.les`): without the lantern you only see about **3 tiles**, dimly; with the lantern in hand about **4.5**. The lantern lights up even by day, but dimmer and with a shorter reach than elsewhere (`lampR` 4.5 tiles instead of 6.5, `lampK` 60 % strength), and other players' lanterns light up their surroundings, so you can see them (and only them) from further away. Trees fade exactly as in the dark part of Les na pomedzí (`FADE_DEFAULTS.dark`): whatever hides your character or the ground in the direction it looks fades – but **without an outline**, so it doesn't distract in the dark (`FADE_DEFAULTS.les`, `window.MF_FADE = { les: { outline: 0.7 } }` brings it back). Other players don't show through trees that haven't faded and nothing is highlighted; a player hidden behind a solid tree has no name label either. Only your own character still shows through as a silhouette.
- Save format v5 stores Les divov's whole layout with the world (`les`: one character per tile, `Areas.saveLes` / `Areas.loadLes`), so later changes to the generator don't move an existing forest. Older saves get a new seed and the layout is generated on first load; gardens, Les na pomedzí and players' positions stay as they are.

## Ice, mountains and the icehouse

All the rules live in `ice.js` (pure functions over the room, tested in `test/ice.test.js`).

- **Mountains (*Hory*)** are a second play area of the same size as the garden (20 × 34, `D.buildMountains()`): rock cliffs and a **glacier** in the north, scree with boulders and a mountain tarn in the middle, an alpine meadow with spruces and pines in the south. The trail at the **north-east edge of the garden** (behind Babka's hut, `gate` tiles) leads there; the trail at the bottom of the mountains leads back. Walking onto a `gate` tile moves you to the gate's target area. The switch fades through black (~0.3 s): the new area is built behind the black screen, and only once its world is built and drawn (building can freeze a phone for a moment) does its name (*Záhrada*, *Hory*, *Les na pomedzí*, *Les divov*) appear for about a second, with a glow and ornaments in the area's style around the edges, then the view fades back in. Input is paused meanwhile; with *reduce motion* the fades are instant. Other players fade in when they arrive in your area and fade out when they leave. The look of each area's transition (icon, glow colour, ornaments) lives in `D.AREA_FX`, so a new area adds an entry there and in `D.AREA_NAMES` / `D.AREA_IN`. Gate tiles show arrows pointing out of the area and a signpost with the target area's icon.
- Every player is in one area at a time (`pl.area`, saved as `sv.area`). Tiles, effects and the player list are sent only to the players in that area; chat and toasts go to everyone. Moves carry an area sequence number so a stale move from the previous area is ignored.
- **Pickaxe (*krompáč*):** bought at the market. The glacier is built from quarter-block layers and rises in levels: half a block (2 layers) at the edge, half a block more on every tile further in (`D.glacierLevels`; 38 tiles, 128 layers in total). Each pick takes the top layer of the tapped tile = one *Ľad* item, so the glacier visibly sinks where you dig.
- **Walking on the glacier:** players walk on top of the ice, and their height follows the tile's ice level. You can step up at most half a block (2 layers), or up to a block with a jump, and step down any height (`D.canStep`). While crawling you can't cross any height difference, up or down, anywhere (glacier ice, the rock garden, scree…), so you can crawl to an edge without falling off. The full glacier is a staircase you can walk up. A tile dug down to the bottom can be walked across, so you can work your way into the glacier. Without the pickaxe in hand, tapping the glacier just walks there.
- **Ice is scarce.** The glacier does not regrow on its own: it grows only on a rainy day (+14 layers) or a snowy day (+20), at most once a day (rain from the rain brew or the wishing well counts too), from the tiles under the cliffs downwards. It never grows under a player standing on a tile, and a tile grows only while it stays at most half a block above its lowest walkable neighbour, so regrowth can't wall anybody in. Every morning it melts from the edges inwards: 4 layers a day in spring and autumn, 12 in summer, none in winter. That is roughly balanced over a year without digging; heavy digging (or selling ice) can use it up. Tapping the glacier shows how full it is.
- **Carrying ice:** at most 6 per player (`D.ICE_CARRY`, also for gifts), each block slows you down by 6 %, and carried ice melts away 12 game hours after it was dug (oldest first, checked every game hour). Ice can't go into the shared storage – only into the icehouse. The market buys ice: 12 coins in summer, 5 in spring and autumn, 1 in winter.
- **Frozen pond (winter):** with the pickaxe you can dig ice from any water tile (the garden pond and the mountain tarn), once per tile per day. The hole (`cut`) refreezes overnight.
- **Icehouse (*Ľadovňa*):** a shared building bought at the market by any player for the whole garden. It stands on the lot next to the house (2 × 2 tiles at x 0–1, y 30–31; the lot can't be tilled, and a plot dug there before this version must be levelled before you can build). It holds 12 ice blocks; put ice in by tapping it. Ice melts every game hour: 2 blocks a day in spring and autumn, 4 in summer, none in winter. While it has ice, flowers in the shared storage wilt 4× slower instead of 2×.
- Save format v3 stores the mountain tiles (`hory`: ice layers left, holes) and `icehouse` (`built`, `ice`). Older saves migrate with a full glacier and no icehouse.

## Flowers (real species from Slovakia, Czechia and Europe)

| Flower | Season | Needs |
|---|---|---|
| Snowdrop (*Galanthus nivalis*) | winter, spring | shade |
| Christmas rose (*Helleborus niger*) | winter | shade, rich soil |
| Heuffel's crocus (*Crocus heuffelianus*) | spring | sun |
| Tulip, Wild daffodil | spring | sun / anywhere |
| Lily of the valley (*Convallaria majalis*) | spring | shade |
| Chamomile (*Matricaria chamomilla*) | spring, summer | sun, tolerates drought |
| Corn poppy, Cornflower | summer | sun, poppy likes sand |
| Sunflower | summer | lots of water |
| Lavender | summer | sand / rock, perennial |
| Dog rose (*Rosa canina*) | summer | rich soil, perennial |
| New York aster, Autumn crocus, Chrysanthemum | autumn | – |
| Edelweiss (*Leontopodium*) | summer | **rock garden only** (like in the Belianske Tatry) |

Every flower has a short real-world fact in the 📖 **Herbár** (the in-game plant book).

## ✨ Magic (spoilers!)

<details>
<summary>Show the secrets</summary>

- **Magic cauldron** next to Babka's hut: 3 flowers make an elixir.
  - Chamomile + Lavender + Sunflower → *Elixir of growth*
  - Snowdrop + Lily of the valley + Cornflower → *Rain brew*
  - Crocus + Tulip + Daffodil → *Elixir of eternal spring* (the season doesn't matter)
  - Poppy + Lavender + Edelweiss → *Elixir of plenty*
  - Aster + Chrysanthemum + Autumn crocus → *Fairy elixir*
  - Rose + Rose + Tulip → *Love elixir* (give it to another player → rainbow seeds for both)
  - 3× Rainbow rose → *Rainbow elixir* (a rainbow over the garden, 300 coins for everyone)
  - Anything else → *Strange slime* 🫠
- **Fairy ring** in the forest (north-west): at night (21:00–4:00), when **two players dance** 💃 inside the ring, fairies appear and give each of them a *fern seed* and a *rainbow seed*. Alone, it only works with the *Fairy elixir*.
- **Fern flower** (Slavic legend): grows in shade and can only be picked **at night**. Using it grants a wish: a golden rain of coins, eternal spring (the garden waters itself forever) or a fairy treasure.
- **Rainbow rose:** changes colour and grows in every season.
- **Wishing well:** throw in 5 coins and you get a hint, seeds, rain… or rarely a fern seed.
- **The moon:** tap 🌙 in the top bar 7 times at night.

</details>

## 3D view

The game is 3D only, rendered with Three.js (`public/render3d.mjs`) at `/` (`/?room=<code>`). Old `/3d` links redirect to `/` and keep the query string.

- **Orthographic camera** at 45° with an isometric tilt (~35°); the ⟲ ⟳ buttons in the top corners (or `[` `]`) rotate the view by 90°.
- **World of cubes** (`shared/world3d.js`): 1 block = 2×2×2 sub-cubes. Low terrain heights (the pond is lower, the rock garden higher) and procedurally generated low-poly models: trees by season (spring blossom, autumn colours, bare winter branches with snow), spruces, rocks, Babka's hut, the house, the market stall, the well, the cauldron. Only visible faces are meshed.
- **Fine models from mini-cubes (1 block = 8×8×8):** the player's house is a detailed Čičmany-style log house – log walls with grooves and protruding corner logs, white Čičmany ornaments, recessed windows with mullions, shutters and flower boxes, a door with frame and handle, a shingle roof with overhang and a recessed gable with a round window, a chimney and a lantern that glows at night; snow on the roof in winter. A fine model is also stamped into the coarse grid as an invisible stand-in, so it casts sun shadows, darkens corners next to it and can be tapped like any other object. Babka's hut (whitewashed log house with a blue base, thick hipped straw roof, small windows with geraniums, bundles of drying herbs under the eaves, a bench), the cauldron (cast-iron pot on a tripod with a chain over a fire pit with flames that glow at night, glowing brew with bubbles, a ladle), the market stall (plank counter with crates of flowers, seed sacks, a sloped striped awning with a scalloped edge, a sign with "TRH" written in mini-cubes, a lantern) and the well (round stone curb with water, a windlass with crank, rope and bucket, a small shingle roof) are built the same way.
- **Trees from mini-cubes**, 6 kinds: beech, oak, birch, apple tree, spruce and pine. Deciduous trees have their own colours for every season (birch turns yellow, beech orange-red, oak brown) and bare branches with snow in winter (the branch skeleton is there all year, hidden in the leaves). The apple trees around Babka's hut form an orchard that blossoms in spring and has apples in summer and autumn; conifers keep their needles and get snow on every tier. Each tree is randomly rotated by a multiple of 90°. Trees cast sun shadows through their invisible coarse stand-in, so the gameplay sun-hours calculation sees them too.
- **Mountains:** terrain heights per tile type (scree and snow higher than grass, the glacier a block higher still as a wall of ice, cliffs 3.5–5 blocks with jagged heights and mixed stone), spruces and pines from the tree models. The glacier has its own mesh and shader with the same ice look as the frozen pond (colour, brushed stripes, frost sparkles, Fresnel sky reflection, anisotropic highlight) on every face; its ice stands on the ground as a column of quarter-block layers per tile (side walls only where the neighbour is lower). Also and holes dug into the frozen pond as dark discs on the ice. The world mesh is rebuilt when you change area or the icehouse is built.
- **Les divov:** giant trees as fine models on 2 × 2 tiles (a thick, slightly crooked trunk with moss mostly on the north side, lichen, buttress roots, a few thick branches and only a small dark crown; 3 shapes × 4 rotations, bare with snow in winter), fallen logs with moss and some with mushrooms, spruces, beeches and oaks. **Glowing sap** (`M.SAP`, emissive) drips in short streaks down the giant trunks: it glows yellow day and night, even beyond your sight radius (emissive colour is applied after the darkness), and every drop has a soft, slowly pulsing yellow halo (glow particles in `particles3d.mjs`). Identical models share one geometry (each mesh only has its own position), so the hundreds of trees cost little to build. Rendering in a dark area (`darkOn` in the world shader): low ambient light (darker still at night), **no shadow map** – sunlight only falls in **dappled patches** (pixelated value noise on upward faces) and on the **clearings** (`canopy` texture: how open the canopy is per tile), plus a few **light shafts** by day (additive cylinders towards the sun over clearings and here and there over paths; on low particle quality only one per clearing). Around the player there is a dim light (`eyeLit`), and beyond the sight radius (`eye.w`: 3 tiles, 4.5 with the lantern) everything fades into dark green (by day) or almost black (at night) – the background too; places lit by a lantern stay visible. Trees are drawn whole, crowns included (in the dark they're dark silhouettes); only models outside the camera's view are skipped (the usual frustum culling).
- **Les na pomedzí:** trees from the same models (no orchard; conifers get more common towards the north), **bushes** as fine models (a dense leafy ball on a few twigs, some with blueberries in summer and rose hips in autumn, bare twigs with snow in winter), ferns and meadow flowers painted in the ground texture. The darkening towards the north is done in the world shader by the world z coordinate (`gloom` uniform), so the far north looks dark even from the meadow; sprites use the same curve.
- **Icehouse:** a fine model – a stone cellar under a steep shingle roof that reaches to the ground, a wooden door with a small ice-blue window above it, stone steps; snow on the roof in winter.
- **Rocks from mini-cubes:** the boulders in the rock garden come in 3 shapes (a big boulder, a pile of smaller stones, a flat slab with a stone on top) with several shades of stone, moss and lichen outside winter and snow in winter; each is randomly rotated.
- **Walking behind objects** (in *Les divov* everywhere as in the dark part of Les na pomedzí, without outlines): when a building or tree stands between the camera and your character, it smoothly fades to a see-through version (~30 %), so you can see your character. **In the dark forest** – in *Les na pomedzí* from where the forest takes so much light that the lantern lights up even by day (`D.gloomAt` ≥ 0.2, from about row 14 northwards; not in the meadow and the mild middle) – the ground in the direction your character is looking stays visible too: a fan of points on the walkable ground ahead of the character (up to 2 blocks, getting wider; tiles with an object on them are skipped) casts rays towards the camera, and every object a ray passes through fades – to 20 % when it hides ground near the character, 50 % at the end of the fan (settings `dark` in `FADE_DEFAULTS`). Objects beside or behind that ground hide nothing and stay solid. Every faded object gets a subtle outline, so you can see the way ahead and still recognise the objects. All parameters can be tuned live in the browser console: `window.MF_FADE = { min: 0.25, dark: { reach: 3 } }` overrides only the given values (defaults and their meaning are in `window.MF_FADE_DEFAULTS` / `FADE_DEFAULTS` in `render3d.mjs`; `dir: 'camera'` uses the direction towards the camera instead of where the character looks). Only the front surface of the faded object is drawn, so its inner faces don't show through. Occluders are found 10× per second by marching rays towards the camera through the coarse grid, where every cell remembers which fine model it belongs to (no triangle tests), the outline is drawn with the stencil buffer in the same frame (all faded objects are marked first, then each is drawn shifted by ~1.5 px around it outside the marked area, so overlapping objects – e.g. trees in a dense forest – share one outline around the whole group instead of a tangle of outlines) – no render-target switching, which caused the whole screen to flicker on mobile GPUs. An object stays faded ~0.4 s after the last hit, so it doesn't flicker when you stand right at its edge. Taps go through faded objects to the ground behind them.
- Faded objects are cheap to draw: the depth pre-pass uses an empty fragment shader, the see-through surface uses 4 shadow-map taps instead of 16, and the outline needs 4 offset passes. `window.MF_NOFADE = true` disables fading (for measuring).
- Debug: `window.MF_TIME = { season: 0–3, min: 0–1439 }` in the browser console overrides the displayed season and time (local rendering only).
- **Textures:** the top of the terrain is drawn procedurally by `art.js` (grass, path, soil, snow); flowers, mushrooms, Babka and players are 2D sprites from the same art. Characters have 8 directions (diagonals included) and a blob shadow; they show through buildings and trees as a translucent silhouette.
- **Shading:** flat, no diffuse falloff, no reflections (except on the pond, see below). Fixed brightness per face side (like Minecraft), ambient occlusion in block corners, and a **sun shadow from a GPU shadow map**: the world is rendered from the sun's point of view into a 2048×2048 depth texture (real geometry, so shutters, branches and gaps in tree crowns cast shadows) and sampled with a 16-tap rotated Poisson-disk kernel (PCF) for soft edges. The map is re-rendered once per game tick (5 game minutes) or when the world changes, always at the start of a frame. The sun moves with the time of day (east → south → west) and is lower in winter, so shadows get longer. At night, light comes from windows, the cauldron, lanterns, players holding a lantern, fairies and glowing flowers. Every light flickers like a flame: the cauldron fire and the market lantern the most, the house lantern less, windows and the rest only gently.
- **Water (pond):** a separate surface 1/8 block below the ground with its own shader (the world shader is unchanged).
  - **Reflections:** the scene is rendered from a camera mirrored below the surface into a render target. Everything under the surface is cut off by an oblique near plane on the mirror camera's projection. Sprites are flipped for that pass.
  - **Shading:** Schlick Fresnel with a stylised base (water 0.42, ice 0.28), a sun glint lit through the shadow map, lamp glints at night, shallow/deep colour bands and foam computed from the per-pixel distance to the shore.
  - **Waves:** procedural (directional waves plus noise), stepped to 16 px per block and 8 steps per second so they read as pixel art. Ripples appear when someone fills the watering can or walks along the shore.
  - **Ice (winter):** no waves, brushed-metal look with a reflection blurred along the streaks and an anisotropic (Ward) highlight.
  - **Lily pads:** small mini-cube meshes on top of the water.
  - **Menu → "🌊 Odrazy vody"** (per device, `localStorage.mfWater`, default *skutočné*):
    - *žiadne* – sky colour only;
    - *stredné* – half-resolution mirror, terrain and models only;
    - *skutočné* – full resolution including players, flowers and Babka.
  - The mirror pass is skipped while the pond is off-screen. The well is unchanged.
- **Particles** (`public/particles3d.mjs`). They live in world space, so they move with the camera and are hidden behind buildings:
  - **Rain:** camera-facing streaks in a box around the player, slanted by the wind. Drops make small splashes on the ground and ripples on the pond.
  - **Snow** (snowy weather, or now and then in winter): soft white flakes fall slowly in a box around the player, swaying in a light wind. Each flake lands on the ground under it, lies there for a moment and melts (on the pond it melts at once); past the edge of the island it keeps falling.
  - **Fire under the cauldron:** glowing mini-cube flames that lick around the pot, rising embers and a little smoke, plus a pulsing glow. A large point sprite has one depth, so fire particles are shifted towards the orthographic camera, which changes only their depth and not their place on screen; otherwise the ground and pot would hide them.
  - **Market lantern:** a small two-cube flame flickers inside it with a glow and an occasional spark; its light flickers as strongly as the cauldron fire.
  - **Fairies** (the fairy visit and the fairy potion): a glow with a white core, fluttering wings and a sparkle trail. At night each fairy is also a moving point light.
  - **Falling leaves** from deciduous trees in their seasonal colours: many in autumn, a few in summer, apple blossom petals in spring, none in winter. Leaves flip as they fall and rest on the ground for a moment.
  - **Fireflies** at night around trees, the pond and the mushroom ring: many in summer, fewer in spring and autumn, none in winter or in rain. They drift slowly at knee-to-head height and blink (a short flash, then a faint glow). They fade in at dusk and fade out at dawn.
  - Snow is still drawn on the canvas overlay (`#cv`) on top of the 3D view.
  - **Menu → "✨ Častice"** (per device, `localStorage.mfParticles`): *menej* (default on touch devices) or *viac*.
- **Menu → "📊 Počítadlo snímok (FPS)"** (per device, `localStorage.mfFps`, default off): a small overlay under the clock with FPS, frame time (avg / min / max) and a graph of the last 120 frames, CPU time of the 3D frame and its passes (shadows, water reflection, scene), draw calls and triangles summed over all passes, geometries, textures and the canvas resolution. When off it costs nothing; `Render3D.setStats(on)` / `stats()` expose the numbers.
- **Gameplay hook:** `World3D.sunHours(grid, x, y, season)` returns how many hours of direct sun a tile gets per day. Leafless deciduous trees let more sun through in winter. Tapping a plant already shows it; later it can replace the simple "shade = next to a tree" rule on the server.
- Joystick and keyboard directions are relative to the screen (recomputed for the camera rotation); tapping objects uses a ray into the scene.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) on every push and pull request:

1. **Tests** – syntax check of all JS files and `npm test` (engine, economy, items).
2. **Docker image** – builds the image and runs a smoke test (the container must start and serve the game).
3. **Publish** – on `main` and on `v*` tags the image is pushed to GitHub Container Registry:
   - `ghcr.io/marekvasko/magic-flowers:latest` (main)
   - `ghcr.io/marekvasko/magic-flowers:sha-<commit>`
   - `ghcr.io/marekvasko/magic-flowers:<version>` (tag `v1.2.3` → `1.2.3`)

To run the published image instead of building locally, set `image: ghcr.io/marekvasko/magic-flowers:latest` in `docker-compose.yml`, remove `build: .` and use `docker compose pull && docker compose up -d`.

## Debug page (`/debug`)

A maintainer page (in English) for looking at worlds and the game's content without playing (#64). A rooms list on the left (filter, who's online), an area selector, and tabs. Selections are kept in the URL hash, so a view can be shared as a link.

| Tab | What it shows |
|---|---|
| **Room** | Day, season, time, mode, weather, players (save stats, online names), upcoming events with their kind (periodic / unique / plain), the **reconciler state** (every declared periodic event: scheduled or missing, and what reconcile would drop and why; `E.reconcilePlan`), and the raw save as a JSON tree. |
| **Map** | A top-down plan of an area: ground height, paths, objects, gates and arrivals, grid; tile inspector and area stats. *Seed* mode shows any seed, *Room* mode the room's real layout with beds, ice and players. (`debug/tabs/map.mjs`, `map-core.mjs`) |
| **World** | The game's own 3D renderer without a player: free camera (mouse, touch, keys; follow an online player), time / season / weather controls independent of the room clock, layer toggles, and helpers: bounding boxes, tile grid, tap areas, gates and arrivals, lights and sun, wireframe, shadow camera, plus FPS and renderer stats. Uses optional hooks in `public/render3d.mjs` (`placeCamera`, `noPlayer`, `layers`, `beforeRender`, `debugView()`, `dispose()`) that the game never passes. |
| **Assets** | Every fine 3D model (`World3D.FINE_MODELS`: buildings, market stall, well, cauldron, trees, bushes, rocks) in any season and rotation or a 4×4 grid, with size, voxel count and materials; a 2D flower gallery from `art.js`. |
| **Generators** | Tree parameter sliders (`World3D.TREE_PARAMS`) with a live default-vs-tweaked preview and *Copy parameters* (JSON for `treeModel(kind, season, rot, overrides)`); area layouts (`D.buildArea`) for several seeds side by side. Tweaks never touch the game. |
| **Market** | Prices of the selected world broken into their factors (`Econ.seedPriceParts` / `flowerPriceParts` / `compostPriceParts`, the same functions the game prices with), sell-back prices, history charts, NPCs (Jano, Fero), festivals, market news, upcoming market events, contracts, and *How prices work*. |

The FPS counter for players is separate: in the game menu (see *3D view*).

- **Open to anyone at `/debug`, but read-only.** Nothing can be changed there: the page and its API only answer `GET`.
- `GET /api/debug/rooms` lists all worlds (saved files and rooms in memory, who's online). `GET /api/debug/room?id=…` returns a snapshot: a loaded room is serialized from memory; an unloaded one is only parsed from `data/room-<id>.json` (and run through `migrate()` on the copy). It's never loaded into the server, advanced or saved.
- **Player save keys never leave the server.** They're a player's identity (whoever has one can play as that player), so the API replaces them with short hashes (`p-…`).
- Files: `debug.js` (server side), `debug/` (page; not under `public/`, served only through `/debug/…`): `debug/debug.js` (shell, Room tab), `debug/tabs/*.mjs` (other tabs; `modelview.mjs` is the shared voxel model viewer), `debug/api/*.js` (tab data).
- Tab data endpoints: `GET /api/debug/market?id=<room>` (price breakdown, NPCs, festivals, events, contracts), `GET /api/debug/world?room=<id>&area=<a>` or `?seed=<n>&area=<a>` (an area's tiles built as the server builds them, plus players on it).
- **Adding a tab:** create `debug/tabs/<id>.mjs` exporting `mount(el, ctx)` → `{ update?(ctx), unmount?() }` and list the tab in `TABS` in `debug/debug.js` (until the module exists, the tab shows its description). `ctx` has the selected `room`, `area`, room snapshot `snap`, `api(path)`, `param` / `setParam` (kept in the URL hash), `setArea`, the `h` element helper, `D` (`shared/data.js`) and formatters.
- **Adding server data for a tab:** create `debug/api/<name>.js` exporting `(query, tools) => object`; it answers `GET /api/debug/<name>`. `tools.load(id)` gives a copy of a world's state (never the live room); player keys are stripped from the response automatically.
- Locally: `PORT=8099 DATA_DIR=/tmp/mf npm start`, then open `http://localhost:8099/debug`.

## Contributing

Bugs, ideas and questions go to [GitHub issues](https://github.com/marekvasko/magic-flowers/issues/new/choose) (🐞 Bug, ✨ Feature or 💬 Discussion). How issues, labels, priority/size and pull requests work is described in [`CONTRIBUTING.md`](CONTRIBUTING.md); coding agents also follow [`AGENTS.md`](AGENTS.md).

- `.github/workflows/triage.yml` turns the form's category / priority / size answers into labels and marks issues without exactly one kind (`bug` / `feature` / `discussion`) or without a category with `triage`.
- `.github/workflows/pr-check.yml` checks that a PR links its issue and comes from an `issue/<n>-…` branch into `dev`.
- `scripts/labels.sh` syncs the label set (`DRY_RUN=1` to preview).

## License

[MIT](LICENSE) © 2026 Marek Vaško

## Technical details

- `server.js` – Node.js HTTP + WebSocket server (`ws`). The game state lives on the server: time, weather, growth, inventory and magic.
- `shared/data.js` – data shared by the server and the client (flowers, recipes, the maps of all areas, gates between them).
- `areas.js` – areas: tiles of each area, sizes, gates and arrival points, saving Les divov's layout.
- `ice.js` – mountains, ice digging and the icehouse.
- `presence.js` – players' presence: days away (`sv.lastTick`, also refreshed on every 15 s autosave), the 10 s reconnect grace for left/arrived messages, and a 30 s WebSocket ping/pong that closes half-open connections.
- `public/` – client: `index.html`, `style.css`, `art.js` (ground textures, sprites and icons drawn procedurally on a canvas, with no images), `game.js` (controls, UI, the overlay canvas) and `render3d.mjs` / `particles3d.mjs` (3D view).
- `shared/world3d.js` – voxel world, generated models, sun position and soft shadows (shared by client and server).
