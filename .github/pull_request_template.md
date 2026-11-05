<!--
Read CONTRIBUTING.md first: https://github.com/marekvasko/magic-flowers/blob/dev/CONTRIBUTING.md
Every PR implements one refined issue, comes from branch issue/<n>-short-description and targets dev.
The "Kontrola PR" check fails without the issue link below.
-->

Closes #<!-- issue number -->

## What

<!-- What changed and why, in a few bullets. Mention gameplay rules agreed in the issue. -->

-

## Testing

<!-- How you verified it: npm test, local server, Playwright screenshot at 390×780 for UI, the PR preview. -->

-

## Checklist

- [ ] I followed [CONTRIBUTING.md](https://github.com/marekvasko/magic-flowers/blob/dev/CONTRIBUTING.md) and the scope agreed in the linked issue
- [ ] Branch `issue/<n>-short-description` is rebased on the latest `origin/dev` (no merge commits)
- [ ] `npm test` passes; tests added or updated in `test/` for game logic
- [ ] Player-visible text is Slovak with correct diacritics
- [ ] Save format unchanged, or `SAVE_VERSION` bumped with a `migrate()` step (no garden is lost)
- [ ] New root `.js` modules are added to the `Dockerfile` `COPY`
- [ ] `README.md` / `AGENTS.md` / `CONTRIBUTING.md` updated if gameplay or operations changed
