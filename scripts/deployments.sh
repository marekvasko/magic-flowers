#!/usr/bin/env bash
# Deaktivácia starých GitHub deploymentov – na stránke Deployments ostane aktívny len ten, ktorý naozaj beží.
# Deploymenty sa nemažú, len dostanú stav „inactive“ (história ostáva).
#   scripts/deployments.sh supersede dev|production|preview [<vetva>]   # ponechá najnovší, staršie deaktivuje
#   scripts/deployments.sh retire preview <vetva>                       # deaktivuje všetky (zatvorený PR)
#   scripts/deployments.sh prune [<vetva otvoreného PR> ...]            # poistka: dev/production ponechá najnovší,
#                                                                       # preview najnovší pre každý otvorený PR
# DRY_RUN=1 len vypíše, čo by deaktivoval.
# Potrebuje GH_TOKEN s právom deployments: write a GITHUB_REPOSITORY (v CI sú nastavené).
set -euo pipefail

repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY}
action=${1:?supersede|retire|prune}

# Deploymenty prostredia (voliteľne len pre vetvu), od najnovšieho: „<id> <vetva>“
list() {
  local q="environment=$1&per_page=100"
  [[ -n "${2:-}" ]] && q+="&ref=$2"
  gh api --paginate "repos/$repo/deployments?$q" --jq '.[] | "\(.id) \(.ref)"'
}

deactivate() {
  local id=$1 state
  state=$(gh api "repos/$repo/deployments/$id/statuses?per_page=1" --jq '.[0].state // ""')
  [[ "$state" == inactive ]] && return 0
  echo "Deaktivujem deployment $id ($2, $3, stav ${state:-žiadny})"
  [[ -n "${DRY_RUN:-}" ]] && return 0
  gh api -X POST "repos/$repo/deployments/$id/statuses" -f state=inactive --silent
}

# Ponechá najnovší deployment (aktuálne nasadenie), všetky staršie deaktivuje.
supersede() {
  local env=$1 ref=${2:-} first=1 id r
  while read -r id r; do
    [[ -z "$id" ]] && continue
    if (( first )); then first=0; continue; fi
    deactivate "$id" "$env" "$r"
  done < <(list "$env" "$ref")
}

case "$action" in
  supersede)
    supersede "${2:?prostredie}" "${3:-}"
    ;;
  retire)
    [[ "${2:-}" == preview ]] || { echo "retire je len pre preview" >&2; exit 2; }
    ref=${3:?vetva}
    while read -r id r; do
      [[ -n "$id" ]] && deactivate "$id" preview "$r"
    done < <(list preview "$ref")
    ;;
  prune)
    shift
    open=" $* "
    supersede dev
    supersede production
    # preview: pre otvorený PR ponechá najnovší deployment jeho vetvy, ostatné deaktivuje
    declare -A seen=()
    while read -r id r; do
      [[ -z "$id" ]] && continue
      if [[ "$open" == *" $r "* && -z "${seen[$r]:-}" ]]; then seen[$r]=1; continue; fi
      deactivate "$id" preview "$r"
    done < <(list preview)
    ;;
  *)
    echo "Neznáma akcia: $action" >&2; exit 2
    ;;
esac
