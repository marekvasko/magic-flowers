#!/usr/bin/env bash
# Synchronizácia štítkov (labels) repozitára podľa CONTRIBUTING.md.
# Idempotentné: chýbajúce štítky vytvorí, existujúcim nastaví farbu a popis.
# Nič nepremenuje ani nemaže (staré „enhancement“, „question“, „documentation“ ostávajú).
#   scripts/labels.sh            # aktuálny repozitár (gh repo view)
#   REPO=owner/name scripts/labels.sh
#   DRY_RUN=1 scripts/labels.sh  # len vypíše, čo by urobil
set -euo pipefail

REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*" >&2; else "$@"; fi; }

# názov|farba|popis
LABELS=(
  # druh (práve jeden, pridá ho šablóna)
  "bug|d73a4a|Something isn't working"
  "feature|a2eeef|New feature or improvement"
  "discussion|d876e3|Open question or idea to discuss before deciding"

  # kategória (aspoň jedna, povinná vo formulári)
  "gameplay|0e8a16|Game rules, economy, flowers, magic"
  "logic|006b75|Server, engine, saves, game state"
  "ui|1d76db|Controls, menus, overlay, texts"
  "graphics|5319e7|3D view, models, particles"
  "infra|000000|CI/CD, Docker, deploys"
  "docs|0075ca|README, AGENTS.md, CONTRIBUTING.md"

  # priorita
  "critical|b60205|Priority: breaks the game or players' gardens; fix now"
  "high|d93f0b|Priority: important; next in line"
  "medium|fbca04|Priority: normal"
  "low|c2e0c6|Priority: nice to have"

  # veľkosť
  "XS|ededed|Size: trivial, under an hour"
  "S|d4c5f9|Size: a few hours"
  "M|bfa8f0|Size: about a day"
  "L|9e7fe0|Size: several days"
  "XL|7b52d1|Size: too big; split into smaller issues"

  "triage|e99695|Missing kind or category; fix the labels"

  "good first issue|7057ff|Good for newcomers"
  "help wanted|008672|Extra attention is needed"
  "accessibility|f143ab|Barrier affecting people with disabilities"
  "duplicate|cfd3d7|This issue or pull request already exists"
  "invalid|e4e669|This doesn't seem right"
  "wontfix|ffffff|This will not be worked on"
)

for l in "${LABELS[@]}"; do
  IFS='|' read -r name color desc <<<"$l"
  [ -n "$name" ] || continue
  echo "štítok: $name"
  run gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force >/dev/null
done
