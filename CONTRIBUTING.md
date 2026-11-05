# Contributing to Čarovná záhrada

Thanks for helping! These rules apply to **everyone: people and coding agents alike**. Agents additionally follow [`AGENTS.md`](AGENTS.md) (worktrees, deploys, persistence).

- The game is **exclusively in Slovak**. Every player-visible text has correct Slovak diacritics.
- Issues, PR descriptions and docs may be written in Slovak or English. Code comments and commit messages follow the existing Slovak style.
- By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

## Workflow

Every change goes **issue → refinement → PR → review → merge**:

1. **Issue.** Open an issue with one of the templates below. No code without an issue.
2. **Refinement.** The maintainer and the author agree on the scope, the gameplay rules and the answers to the open questions. The agreed scope is written into the issue (body or comment). The maintainer then confirms the category, priority and size labels. Don't guess game-design decisions; ask in the issue.
3. **PR.** Implement on branch `issue/<n>-short-description` created from the latest `origin/dev` and open a PR **into `dev`** using the PR template. CI tests it and deploys a preview to `https://pr-<PR number>.zahrada.spis-ai.com/`.
4. **Review.** The maintainer reviews the code and plays the preview. Address feedback with new commits on the same branch.
5. **Merge.** Only the maintainer merges, with **rebase** or **squash** (history is linear, merge commits are disabled).

## Reporting issues

[Open a new issue](https://github.com/marekvasko/magic-flowers/issues/new/choose) and pick **exactly one** template. Blank issues are disabled.

| Template | Use it for | Kind label |
|---|---|---|
| 🐞 **Bug** | Something doesn't work as it should (game, server, CI/CD). | `bug` |
| ✨ **Feature** | A new feature or an improvement with a clear goal. | `feature` |
| 💬 **Discussion** | An idea or an open question that needs a decision first. It ends closed or split into Bug / Feature issues that link back to it. | `discussion` |

Rules:

- **Every issue has exactly one kind and at least one category** (see [Labels](#labels)). The template adds the kind; the required *Category* field adds the category. An issue that is missing either gets the `triage` label from the [triage workflow](.github/workflows/triage.yml) until it's fixed.
- **One problem per issue.** Split big things up; `XL` means "split me".
- Search existing issues first; close duplicates with `duplicate` and a link.
- Quote in-game chat verbatim and add a translation if it isn't Slovak or English.
- Point to code with `file:line` when you know where the problem lives.

### Why labels and not GitHub issue types

GitHub's built-in *Issue Types* only exist for repositories owned by an organisation. This repo is owned by a user, so the kind (`bug` / `feature` / `discussion`) and the category are labels, and the triage workflow makes them mandatory.

### Creating issues from the CLI (agents)

`gh issue create` can't fill in issue forms, so agents (and anyone using the API) **must reproduce the form by hand**: use the same `### ` headings as the template, in the same order, and pass the kind and category labels explicitly. The triage workflow reads the `### Category`, `### Priority` and `### Size` answers, so a body written this way is labelled the same as one from the web form.

```sh
gh issue create --title "Planting water flowers" \
  --label feature --label gameplay --label graphics \
  --body-file issue.md
```

Headings per template (see [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/)):

- **Bug:** `What happened`, `Steps to reproduce`, `Expected behaviour`, `Where`, `Device and browser`, `Category`, `Priority`, `Additional context`
- **Feature:** `Problem / motivation`, `Proposed solution`, `Open questions`, `Acceptance criteria`, `Category`, `Size`, `Priority`
- **Discussion:** `Topic`, `Category`, `Context`, `Options`, `Questions to decide`

Answers start with the label name, several choices separated by `, `: e.g. `gameplay, graphics`, `high — next in line`, `M — about a day`. Use `not sure` for priority or size when you can't tell.

## Labels

All labels are single words, defined in [`scripts/labels.sh`](scripts/labels.sh) (run it to sync the repo; `DRY_RUN=1` previews). Don't create ad-hoc labels; add them to the script in a PR.

| Group | Labels | Rule | Who sets it |
|---|---|---|---|
| Kind | `bug`, `feature`, `discussion` | exactly one | the template |
| Category | `gameplay`, `logic`, `ui`, `graphics`, `infra`, `docs` | at least one | the form, then anyone |
| Priority | `critical`, `high`, `medium`, `low` | at most one (bug, feature) | proposed in the form, confirmed by the maintainer |
| Size | `XS`, `S`, `M`, `L`, `XL` | at most one (feature, optionally bug) | proposed in the form, confirmed by the maintainer |
| Triage | `triage` | missing kind or category | triage workflow |
| Other | `good first issue`, `help wanted`, `accessibility`, `duplicate`, `invalid`, `wontfix` | | maintainer |

The older `enhancement`, `question` and `documentation` labels remain on past issues; new issues use `feature`, `discussion` and `docs`.

The triage workflow only adds a category / priority / size label from the form when the issue has no label from that group yet, so the maintainer's decision is never overwritten.

### Categories

| Label | Covers |
|---|---|
| `gameplay` | Game rules, economy, flowers, magic, balance. |
| `logic` | Server, engine, event scheduler, saves and migrations, game state. |
| `ui` | Controls, menus, overlay, toasts, Slovak texts. |
| `graphics` | 3D view, models, particles, lighting. |
| `infra` | CI/CD, Docker, deploys, repo tooling. |
| `docs` | README, AGENTS.md, CONTRIBUTING.md. |

### Priority

| Label | Meaning |
|---|---|
| `critical` | The game is unplayable, or players' gardens are at risk. Fix now; may jump the queue. |
| `high` | A core feature is broken without workaround, or an important feature. Next in line. |
| `medium` | Normal work. A workaround exists, or a regular improvement. |
| `low` | Cosmetic or nice to have. |

### Size

A rough estimate of the effort, including tests, docs and review rounds.

| Label | Effort |
|---|---|
| `XS` | Trivial, under an hour (typo, constant tweak). |
| `S` | A few hours, one area. |
| `M` | About a day, maybe several files / client + server. |
| `L` | Several days. Consider splitting. |
| `XL` | Too big for one PR. Split into smaller issues before starting. |

## Pull requests

- **One PR per issue**, from branch `issue/<n>-short-description` (lowercase, words separated by `-`), targeting `dev`.
  - ✅ `issue/12-sleep-through-the-night` &nbsp; ❌ `feature/sleep`, `issue-12-sleep`, `issue/12_Sleep`
- Use the [PR template](.github/pull_request_template.md). The body **must** link the issue with `Closes #<n>` (or `Fixes` / `Resolves`), with the same number as the branch.
- The **Kontrola PR** check enforces the issue link, the branch name and the `dev` target. Release PRs `dev` → `main` are exempt.
- **Testy** and **Docker image** checks must pass.
- Keep the branch up to date with `git rebase origin/dev`, never `git merge`. Force-push only your own issue branch with `--force-with-lease`.
- Add or extend tests in `test/` for game logic (`npm test`). For UI changes include a screenshot at a mobile portrait viewport (390×780).
- Save-format changes need a migration (`migrate()` and `SAVE_VERSION` in `server.js`). Existing gardens must never be lost.
- Update `README.md` when gameplay or operations change.

## Development

See [`README.md`](README.md) for running the game and [`AGENTS.md`](AGENTS.md) for environments, CI/CD and releases.

```sh
npm ci
npm test
npm run dev      # http://localhost:3000, 1 day = 60 s
```
