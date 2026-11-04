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

The branching model, worktrees and the release procedure are described in [AGENTS.md](AGENTS.md).

## Time and world settings

- Game time is **discrete**: every day has exactly 288 steps (1 step = 5 game minutes). Day, hour and season are always derived from a single integer counter, so there is no drift, and a delayed timer catches up the missed steps.
- Everything that should happen in the future (dawn, end of potion effects, …) is an **event in a scheduler** (`engine.js`). The queue, the step counter and the random generator's state are saved with the world, so they survive a server restart.
- One game day lasts **20 minutes** of real time (fixed: `BASE_DAY_SECONDS` in `shared/data.js`; the `DAY_SECONDS` env variable is only for testing). A season is 4 days (~80 min), a year ~5.3 hours.
- **World setting** (Menu → ⚙️, per garden): whether the world keeps running when nobody is playing.
- A running world catches up the time the server was down (at most `MAX_CATCHUP_DAYS` game days, default 30).
- New worlds use `DEFAULT_MODE` (`running` by default). Gardens saved in the old format are migrated automatically and keep the paused behaviour; switch them in the menu.
- **Shared storage** in the house: items are shared by everyone in the garden, money is per player.
- `npm test` runs the engine tests (`test/`).

## Economy

All of it lives in `economy.js` and runs on the event scheduler; its state (`room.market`, `room.contracts`) is saved with the world.

- **Poor start:** 30 coins, 4 seeds of the cheapest in-season flower, a watering can for 5 pours, a permit for 8 plots. Players from older versions keep what they had (can 25, 28 plots).
- **Upgrades** (Market → Upgrade): bigger watering can, bigger field, composter (compost every morning). Higher tiers need reputation.
- **Living market:** limited seed stock; seed price depends on stock and season (in season they are expensive and scarce). The flower buy-back price drops as the market fills up, recovers overnight, is higher off-season and during festivals. Prices are recorded every morning and shown as small charts.
- **Wholesaler** delivers every 2 days at 7:00 – mostly seeds for the *next* season.
- **NPC traders:** gardener Jano buys the seeds with the best expected profit per day, grows them and later floods the market with flowers; speculator Fero hoards cheap seeds before the season and sells them when they are expensive; florist Zuzka buys flowers from the market. Everything shows up in Market → News.
- **Festivals** (Mother's Day, wedding season, All Souls' Day, Christmas), announced 2 days ahead, with higher buy-back prices for specific flowers.
- **Flowers wilt** (`items.js`): every cut flower has a vase life per species (poppy 2 days, tulip 4, chrysanthemum 7, lavender 8, edelweiss 12, fern flower 1). Flowers are kept in batches with an age; the oldest go first. Freshness lowers the buy-back price down to 50 %. When the life runs out (checked every game hour, for offline players too) they turn into *wilted flowers*; 4 of them make 1 compost in the storage. In the cool shared storage flowers age 2× slower. A blooming plant left in the field fades after the same time – annuals die, perennials (rose, lavender) bloom again later.
- **Contract board** at Babka's hut: short contracts, contracts for the next season (posted in advance so you can plan) and big contracts from reputation 2. Reserve a contract, the deadline is fixed, you can deliver in parts. Completion gives coins and reputation; a missed deadline costs 5 reputation. Reputation level = how many contracts you may hold at once.

## How much of the world you see (same on every device)

The game always fills the whole screen, on a phone and on a computer, in portrait and in landscape. So that no device shows more of the world than another, the zoom is set so that the **screen diagonal always spans exactly `VIEW_DIAG` = 22 blocks** (`shared/data.js`, the same rule in 2D and 3D):

- A screen of `pxW × pxH` pixels shows `22·pxW/√(pxW²+pxH²)` × `22·pxH/√(pxW²+pxH²)` blocks (`GameData.viewSize`). For example, a phone held upright (390 × 844) shows 9.2 × 20.0 blocks and a 1440 × 900 monitor shows 18.7 × 11.7 blocks.
- The player is in the centre of the screen. Near the edge of the world the view stops moving, so it never shows anything outside the world.
- In 3D, the orthographic camera's view plane has the same 22-block diagonal.

## Gameplay

- **Movement:** put a finger anywhere on the screen and drag – a joystick appears right there and stays anchored at that spot until you lift your finger. Or tap the spot you want to walk to (the character finds a path around obstacles). On a computer use WASD / arrow keys or drag with the mouse, E / Enter for the action and 1–9 for the toolbar.
- **Jump and crawl** (just for fun, other players see it): Space = jump, hold Shift = crawl (slower, low to the ground). On touch devices there are two thumb buttons at the bottom right above the toolbar (⤴ jump, 🐛 crawl on/off); while steering with the joystick, a tap with a second finger anywhere also jumps.
- **Tap an object** (market, Babka, cauldron, well, blooming flower, another player) to use it right away – if it's far away, the character walks there first. Ground actions (digging, watering, planting) need you to be close: the first tap walks there, the second one acts.
- **Ground actions** (dig, water, plant, pick): tap a tile next to you; what happens depends on the item selected in the toolbar.
- **Time and seasons:** a new day starts at 6:00, and plants grow at that moment. Each season lasts 4 days. In winter, frost kills everything except winter flowers. When the season changes, out-of-season plants get 2 days of grace (growing at half speed), and flowers that are already blooming survive.
- **Sleeping:** from 18:00 you can go to bed in the house (tap the house → 🛏️). When every player in the garden is asleep, the server fast-forwards the night (5 steps per 100 ms, ~3 s) up to 6:00, so dawn, growth and all scheduled events run normally; the skipped time is not caught up afterwards. While someone is waiting for the others they can get up again; the others see 💤 above them. Night-only magic (fern flower, fairies) is skipped.
- **Weather:** rain waters the whole garden.
- **What each flower needs:** season, light (sun / shade near the forest), soil (normal, **sand** by the pond, **rock garden** in the south-east, **compost** = rich soil) and water. A happy plant gives 3 flowers, and compost adds one more.
- **Market:** buy seeds and compost, sell flowers and elixirs, buy upgrades, read market news (see Economy).
- **Babka bylinkárka (the herb grandma):** her hut has the contract board (see Economy) and she gives tips.
- **Gifts:** select an item and tap another player.
- **Emotes:** 👋 ❤️ 💃 and chat 💬 (key **T**). Messages appear as speech bubbles above the player (wrapped, up to 4 lines) and briefly in the corner; opening the chat shows the history of the last 50 messages.

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

## 3D view (beta) – `/3d`

The same game, server and gardens, rendered with Three.js (`public/render3d.mjs`). Switch in Menu → "🧊 3D (beta)", or open `/3d?room=<code>`.

- **Orthographic camera** at 45° with an isometric tilt (~35°); the ⟲ ⟳ buttons in the top corners (or `[` `]`) rotate the view by 90°.
- **World of cubes** (`shared/world3d.js`): 1 block = 2×2×2 sub-cubes. Low terrain heights (the pond is lower, the rock garden higher) and procedurally generated low-poly models: trees by season (spring blossom, autumn colours, bare winter branches with snow), spruces, rocks, Babka's hut, the house, the market stall, the well, the cauldron. Only visible faces are meshed.
- **Fine models from mini-cubes (1 block = 8×8×8):** the player's house is a detailed Čičmany-style log house – log walls with grooves and protruding corner logs, white Čičmany ornaments, recessed windows with mullions, shutters and flower boxes, a door with frame and handle, a shingle roof with overhang and a recessed gable with a round window, a chimney and a lantern that glows at night; snow on the roof in winter. A fine model is also stamped into the coarse grid as an invisible stand-in, so it casts sun shadows, darkens corners next to it and can be tapped like any other object. Babka's hut (whitewashed log house with a blue base, thick hipped straw roof, small windows with geraniums, bundles of drying herbs under the eaves, a bench), the cauldron (cast-iron pot on a tripod with a chain over a fire pit with flames that glow at night, glowing brew with bubbles, a ladle), the market stall (plank counter with crates of flowers, seed sacks, a sloped striped awning with a scalloped edge, a sign with "TRH" written in mini-cubes, a lantern) and the well (round stone curb with water, a windlass with crank, rope and bucket, a small shingle roof) are built the same way.
- **Trees from mini-cubes**, 6 kinds: beech, oak, birch, apple tree, spruce and pine. Deciduous trees have their own colours for every season (birch turns yellow, beech orange-red, oak brown) and bare branches with snow in winter (the branch skeleton is there all year, hidden in the leaves). The apple trees around Babka's hut form an orchard that blossoms in spring and has apples in summer and autumn; conifers keep their needles and get snow on every tier. Each tree is randomly rotated by a multiple of 90°. Trees cast sun shadows through their invisible coarse stand-in, so the gameplay sun-hours calculation sees them too.
- **Rocks from mini-cubes:** the boulders in the rock garden come in 3 shapes (a big boulder, a pile of smaller stones, a flat slab with a stone on top) with several shades of stone, moss and lichen outside winter and snow in winter; each is randomly rotated.
- **Walking behind objects:** when a building or tree stands between the camera and your character, it smoothly fades to a faint see-through version (~30 %) with a subtle outline around its shape, so you can see your character and still recognise the object. Only the front surface of the faded object is drawn, so its inner faces don't show through. Occluders are found 10× per second by marching rays from the character towards the camera through the coarse grid, where every cell remembers which fine model it belongs to (no triangle tests), the outline is drawn with the stencil buffer in the same frame (the object is marked, then drawn shifted by ~1.5 px around it) – no render-target switching, which caused the whole screen to flicker on mobile GPUs. An object stays faded ~0.4 s after the last hit, so it doesn't flicker when you stand right at its edge. Taps go through faded objects to the ground behind them.
- Faded objects are cheap to draw: the depth pre-pass uses an empty fragment shader, the see-through surface uses 4 shadow-map taps instead of 16, and the outline needs 4 offset passes. `window.MF_NOFADE = true` disables fading (for measuring).
- Debug: `window.MF_TIME = { season: 0–3, min: 0–1439 }` in the browser console overrides the displayed season and time (local rendering only).
- **Textures:** the top of the terrain reuses the 2D game's drawings (grass, path, soil, snow); flowers, mushrooms, Babka and players are 2D sprites from the same art. Characters have 8 directions (diagonals included) and a blob shadow; they show through buildings and trees as a translucent silhouette.
- **Shading:** flat, no diffuse falloff, no reflections (except on the pond, see below). Fixed brightness per face side (like Minecraft), ambient occlusion in block corners, and a **sun shadow from a GPU shadow map**: the world is rendered from the sun's point of view into a 2048×2048 depth texture (real geometry, so shutters, branches and gaps in tree crowns cast shadows) and sampled with a 16-tap rotated Poisson-disk kernel (PCF) for soft edges. The map is re-rendered once per game tick (5 game minutes) or when the world changes, always at the start of a frame. The sun moves with the time of day (east → south → west) and is lower in winter, so shadows get longer. At night, light comes from windows, the cauldron, lanterns, players, fairies and glowing flowers. Every light flickers like a flame: the cauldron fire and the market lantern the most, the house lantern less, windows and the rest only gently.
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
- **Particles** (`public/particles3d.mjs`, 3D only – the 2D view is unchanged). They live in world space, so they move with the camera and are hidden behind buildings:
  - **Rain:** camera-facing streaks in a box around the player, slanted by the wind. Drops make small splashes on the ground and ripples on the pond.
  - **Fire under the cauldron:** glowing mini-cube flames that lick around the pot, rising embers and a little smoke, plus a pulsing glow. A large point sprite has one depth, so fire particles are shifted towards the orthographic camera, which changes only their depth and not their place on screen; otherwise the ground and pot would hide them.
  - **Market lantern:** a small two-cube flame flickers inside it with a glow and an occasional spark; its light flickers as strongly as the cauldron fire.
  - **Fairies** (the fairy visit and the fairy potion): a glow with a white core, fluttering wings and a sparkle trail. At night each fairy is also a moving point light.
  - **Falling leaves** from deciduous trees in their seasonal colours: many in autumn, a few in summer, apple blossom petals in spring, none in winter. Leaves flip as they fall and rest on the ground for a moment.
  - **Fireflies** at night around trees, the pond and the mushroom ring: many in summer, fewer in spring and autumn, none in winter or in rain. They drift slowly at knee-to-head height and blink (a short flash, then a faint glow). They fade in at dusk and fade out at dawn.
  - Snow is still drawn on the 2D overlay.
  - **Menu → "✨ Častice"** (per device, `localStorage.mfParticles`): *menej* (default on touch devices) or *viac*.
- **Gameplay hook:** `World3D.sunHours(grid, x, y, season)` returns how many hours of direct sun a tile gets per day. Leafless deciduous trees let more sun through in winter. In 3D, tapping a plant already shows it; later it can replace the simple "shade = next to a tree" rule on the server.
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

## Technical details

- `server.js` – Node.js HTTP + WebSocket server (`ws`). The game state lives on the server: time, weather, growth, inventory and magic.
- `shared/data.js` – data shared by the server and the client (flowers, recipes, map).
- `public/` – client: `index.html`, `style.css`, `art.js` (all graphics are drawn procedurally on a canvas, with no images), `game.js` (controls, 2D rendering, UI) and `render3d.mjs` (3D view).
- `shared/world3d.js` – voxel world, generated models, sun position and soft shadows (shared by client and server).
