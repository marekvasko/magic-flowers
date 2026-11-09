# AGENTS.md – rules for coding agents (and humans)

Čarovná záhrada is a multiplayer flower-growing web game (Node.js + `ws`, 3D only with Three.js at `/`).
See `README.md` for gameplay and architecture. [`CONTRIBUTING.md`](CONTRIBUTING.md) defines how issues, labels and PRs work; it applies to agents too.

## Language

- **The game is exclusively in Slovak.** All player-visible text (UI, toasts, help, item names, dialogs) must be Slovak, with correct diacritics.
- Code comments and commit messages follow the existing style (Slovak). Issues, PR descriptions and docs may be in English.

## Workflow: every change goes issue → refinement → PR → review → merge

1. **Issue.** Every feature or fix starts as a GitHub issue. Don't start coding without one. Use exactly one of the three types (bug / feature / discussion) from `.github/ISSUE_TEMPLATE/`. From the CLI, reproduce the form's `### ` headings in the body (the triage workflow infers the kind from them) and, if you have triage access, pass the kind label (`bug`, `feature` or `discussion`) and at least one category label (`gameplay`, `logic`, `ui`, `graphics`, `infra`, `docs`); see CONTRIBUTING.md, *Creating issues from the CLI*. Propose `Priority` / `Size` in the body; the maintainer confirms them.
2. **Human-guided refinement.** Before implementing, refine the issue with the maintainer: scope, gameplay rules, open questions. Write the agreed scope into the issue (body or comment). If something is ambiguous, ask; don't guess on game-design decisions.
3. **PR.** Implement on an issue branch and open a PR **into `dev`** using `.github/pull_request_template.md`; the body must reference the issue (`Closes #<n>`, same number as the branch) or the **Kontrola PR** check fails. Because `dev` is not the default branch, `Closes #<n>` alone does **not** link the PR to the issue or close it on merge; the link comes from creating the branch with `gh issue develop` (see *Worktrees*). The maintainer closes the issue by hand after merging. CI tests it and deploys a preview to `https://pr-<n>.zahrada.spis-ai.com/` (`<n>` = PR number).
4. **Review.** The maintainer reviews the code and plays the preview. Address feedback with new commits on the same branch.
5. **Merge only if OK.** Merging is the maintainer's decision; agents never merge their own PRs unless explicitly told to. Use **rebase** or **squash** merge (merge commits are disabled).

## Branches and linear history

- `main` – released code only. Production deploys from release tags on `main`.
- `dev` – integration branch, deployed to staging at `https://dev.zahrada.spis-ai.com/`. All issue PRs target `dev`.
- `issue/{issue number}-short-description-of-issue` – one branch per issue, created from the latest `origin/dev` **with `gh issue develop`** so GitHub links the branch to the issue. **Strict format**: lowercase, words separated by `-`, no other prefixes or suffixes.
  - ✅ `issue/12-sleep-through-the-night`
  - ❌ `feature/sleep`, `issue-12-sleep`, `issue/12_Sleep`, `issue/sleep-12`
- **History is linear on `main` and `dev`.** There are no merge commits, and GitHub enforces this. Keep issue branches up to date with `git rebase origin/dev`, never `git merge`. Force-push your own issue branch with `--force-with-lease` only. Never force-push `main` or `dev`.
- `main` only ever moves by **fast-forward to `dev`**, so `main` is always an ancestor of `dev`.

## Worktrees: never touch the original repository directory

- The original clone (e.g. `/mnt/backup/MagicFlowers`) is **read-only for agents**. It may only be checked out on `main` or `dev` and updated with `git pull --ff-only`. No edits, no commits, no feature branches there.
- **Always start work in a new git worktree** next to the clone. Create the branch on GitHub with `gh issue develop` first. It becomes a *linked branch* of the issue: the issue's **Development** section shows the branch, and its PR is one click away. For PRs into `dev`, GitHub shows the branch there, not the PR itself, and there's no API to link the PR. Don't create the branch with `git worktree add -b` or `git push`, because then GitHub has no link at all (closing keywords only link PRs into the default branch `main`).

  ```sh
  cd /mnt/backup/MagicFlowers
  gh issue develop 12 --base dev --name issue/12-sleep-through-the-night
  git fetch origin
  git worktree add ../MagicFlowers-worktrees/issue-12-sleep-through-the-night \
      issue/12-sleep-through-the-night
  cd ../MagicFlowers-worktrees/issue-12-sleep-through-the-night
  npm ci
  ```

  Check the link with `gh issue develop --list 12`. If a branch was created without a link, tell the maintainer in the PR so they can link it by hand in the issue's *Development* section.

- One worktree per issue. When the PR is merged or closed, remove it: `git worktree remove <path>`, then `git branch -D issue/...`.

## Environments and CI/CD (`.github/workflows/ci.yml`)

| Trigger | Environment | URL | Data |
|---|---|---|---|
| PR from a branch of this repo | preview | `https://pr-<n>.zahrada.spis-ai.com/` | fresh volume, **deleted when the PR closes** |
| push to `dev` | dev (staging) | `https://dev.zahrada.spis-ai.com/` | persistent volume `mf-dev_magicflowers-data` |
| tag `v*` on `main` (release) | production | `https://zahrada.spis-ai.com/` | volume `magicflowers_magicflowers-data` – **real players' gardens** |

- Pipeline: `Testy` (syntax check, `npm run typecheck`, `npm run build`, `npm run lint`, `npm test`) → `Docker image` (build, smoke test, push to `ghcr.io/marekvasko/magic-flowers`) → deploy.
- The deploy jobs run on a **self-hosted runner on the host** (label `magicflowers`) and call `scripts/deploy.sh`. One `docker-compose.yml` serves all environments via `NAME`, `DOMAIN` and `IMAGE`.
- PRs from forks are tested but **never deployed**. Fork workflow runs need maintainer approval. Never approve one without reading its workflow changes, because the runner has Docker access on the host.
- The `Testy` and `Docker image` checks must pass before merging into `dev` or `main`.
- **Missed GitHub events** (outages) can leave staging stale or a merged PR's preview running. To recover:
  - **dev**: Actions → CI → *Run workflow* on `dev` rebuilds and redeploys staging (`gh workflow run CI --ref dev`).
  - **previews**: the `Upratanie PR náhľadov` job (`scripts/deploy.sh prune <open PR numbers…>`) removes every `mf-pr-<n>` whose PR is no longer open. It runs after each dev deploy, daily, and on *Run workflow*.
- **GitHub Deployments page:** only the currently running deployment stays active. After each deploy, `scripts/deployments.sh supersede <env> [<branch>]` marks the older deployments of that environment (for previews: of that PR's branch) `inactive`; closing a PR runs `retire preview <branch>`. The `Upratanie PR náhľadov` job also runs `scripts/deployments.sh prune <open PR branches…>` as a safety net. Deployments are never deleted, only marked inactive. `DRY_RUN=1` prints what would change.

### Releases (maintainer, or an agent when explicitly asked)

1. Open a PR `dev` → `main` titled `Release vX.Y.Z` and let the maintainer review it.
2. Fast-forward `main`; GitHub then marks the PR as merged:

   ```sh
   git fetch origin
   git push origin origin/dev:main
   ```

3. Create the release, which pushes the tag and deploys production:

   ```sh
   gh release create vX.Y.Z --target main --generate-notes
   ```

## Persistence: don't lose players' gardens

- Existing gardens must never be deleted or reset. World saves live in `data/room-*.json` inside the volume. Save-format changes need a migration (see `migrate()` in `server.ts`, `SAVE_VERSION`).
- Never run `docker compose down -v`, `docker volume rm` or anything similar against production (project `magicflowers`). `scripts/deploy.sh down` refuses everything except `pr-*`.
- Don't deploy production by hand. Make a release.

## Development

```sh
npm ci
npm test                      # node:test, test/*.test.{js,ts}
npm run typecheck             # tsc, strict (noEmit)
npm run lint                  # ESLint: no any / object / {} / Function / Record<string, unknown>
npm run build                 # esbuild: shared TS modules for the browser → build/shared/ (start and dev run it first)
npm run dev                   # http://localhost:3000, 1 day = 60 s
PORT=8099 DATA_DIR=/tmp/mf npm start   # isolated local server with its own data
```

- Server-authoritative game state with discrete time (`src/server/engine.ts`: ticks, event scheduler, seeded RNG). Economy is in `src/server/economy.ts`, inventories in `src/server/items.ts`, data shared with the client in `src/shared/data.ts`. The save file format is typed in `src/shared/save.ts` (checked against the real save in `test/save-v11.fixture.ts`), WebSocket messages in `src/shared/protocol.ts`, journal lines in `JournalLine` (`src/server/engine.ts`, checked against a real journal in `test/journal.fixture.ts`); keep them in sync when the format or a message changes.
- **TypeScript rewrite in progress (#122).** New and converted code is `.ts`, run directly by Node 24 (type stripping: only erasable syntax, no `enum` / `namespace` / parameter properties, `.ts` in import paths). Strict `tsconfig.json` plus ESLint ban `any`, `object`, `{}`, `Function` and `Record<string, unknown>`; an exception needs `// eslint-disable-next-line <rule> -- <reason>`. Tests are ported 1:1 (same cases, same names).
- **Proposers read and write slices through `sl()` / `put()` / `maybe()` (`src/server/game.ts`),** never `s['save:' + key]`: the key's template decides the slice type (`save:<key>` → `PlayerSave`, `tile:<area>:<i>` → `Tile | undefined`, …). A new kind of slice key gets its entry in `KeyedSlice`; a new world property that proposers declare goes into `GameSlices`. Keys in `keys()` read the world through `savesOf` / `redeemOf` / `gardenOf`, because test worlds are partial.
- **Documented exceptions to the strict types:** `JsonObject` in the engine (it copies and diffs any slice), `JsonRecord` + `isRecord` (`src/shared/util.ts`) for untrusted JSON (client messages, files on disk). In tests, `partial<T>()` / `testWorld()` (`test/helpers.ts`) are the only casts for partial fixtures, plus `readJson` / `parseJson` / `parseMsg` for what the server wrote; anything else needs a comment saying why.
- **The package is ES modules** (`"type": "module"`, `tsconfig`: `module` / `moduleResolution` `nodenext`): use `import`, never `require`, and `import.meta.dirname` instead of `__dirname`. The browser can't run `.ts`: every shared module (`src/shared/*.ts`) is bundled by `scripts/build.mjs` into `build/shared/<name>.js` with the same global as before (`GameData`, `World3D`, `Webs`, `SpiderModel`, `Mesher`, `Players`), and the server serves `/shared/<name>.js` from `build/shared/` first. A new shared module needs its entry in `scripts/build.mjs`. Run `npm run build` after changing a shared module (`npm start` / `npm run dev` do it).
- The Dockerfile copies `src/`, `public/` and `debug/` as whole directories (a new top-level directory must be added there) and builds `build/` in a builder stage.
- A feature usually touches `public/game.js` (controls, UI, overlay) and `public/render3d.mjs` / `src/shared/world3d.ts` (3D).
- Add or extend tests in `test/` for game logic. For UI, take a quick Playwright screenshot at a mobile portrait viewport (390×780).
- When running local servers or containers, stop them by PID or exact name. Never `pkill node` or similar, because this host runs production and other projects.
- Keep `README.md` up to date when gameplay or operations change.
