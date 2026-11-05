#!/usr/bin/env bash
# Synchronizácia štítkov (labels) repozitára podľa CONTRIBUTING.md.
# Idempotentné: chýbajúce štítky vytvorí, existujúcim nastaví farbu a popis,
# staré názvy premenuje (priradenia k issues/PR sa zachovajú). Nič nemaže.
#   scripts/labels.sh            # aktuálny repozitár (gh repo view)
#   REPO=owner/name scripts/labels.sh
#   DRY_RUN=1 scripts/labels.sh  # len vypíše, čo by urobil
set -euo pipefail

REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }

# premenovanie starých štítkov: starý|nový
RENAMES=(
  "bug|type: bug"
  "enhancement|type: feature"
  "question|type: discussion"
  "documentation|area: docs"
)

# názov|farba|popis
LABELS=(
  "type: bug|d73a4a|Something isn't working"
  "type: feature|a2eeef|New feature or improvement"
  "type: discussion|d876e3|Open question or idea to discuss before deciding"

  "priority: critical|b60205|Breaks the game or players' gardens; fix now"
  "priority: high|d93f0b|Important; next in line"
  "priority: medium|fbca04|Normal priority"
  "priority: low|c2e0c6|Nice to have"

  "size: XS|ededed|Trivial, under an hour"
  "size: S|d4c5f9|Small, a few hours"
  "size: M|bfa8f0|About a day"
  "size: L|9e7fe0|Several days"
  "size: XL|7b52d1|Too big; split into smaller issues"

  "area: gameplay|0e8a16|Game rules, economy, flowers, magic"
  "area: ui|1d76db|Controls, menus, overlay, texts"
  "area: 3d|5319e7|Three.js rendering and world"
  "area: server|006b75|Server, engine, persistence, saves"
  "area: ci-cd|000000|Workflows, Docker, deploys"
  "area: docs|0075ca|README, AGENTS.md, CONTRIBUTING.md"

  "status: needs triage|e99695|Missing type or required info"
  "status: needs refinement|f9d0c4|Scope must be agreed with the maintainer"
  "status: ready|0e8a16|Refined; ready to implement"
  "status: blocked|b60205|Waiting on something else"

  "good first issue|7057ff|Good for newcomers"
  "help wanted|008672|Extra attention is needed"
  "accessibility|f143ab|Barrier affecting people with disabilities"
  "duplicate|cfd3d7|This issue or pull request already exists"
  "invalid|e4e669|This doesn't seem right"
  "wontfix|ffffff|This will not be worked on"
)

existing="$(gh label list --repo "$REPO" --limit 500 --json name -q '.[].name')"
has() { grep -Fxq -- "$1" <<<"$existing"; }

for r in "${RENAMES[@]}"; do
  old="${r%%|*}" new="${r#*|}"
  if has "$old" && ! has "$new"; then
    echo "premenovanie: $old → $new"
    run gh label edit "$old" --repo "$REPO" --name "$new"
    existing+=$'\n'"$new"
  fi
done

for l in "${LABELS[@]}"; do
  IFS='|' read -r name color desc <<<"$l"
  [ -n "$name" ] || continue
  echo "štítok: $name"
  run gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force >/dev/null
done
