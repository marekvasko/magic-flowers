#!/usr/bin/env bash
# Nasadenie prostredia na tomto hostiteľovi (spúšťa ho self-hosted runner z CI).
#   scripts/deploy.sh up   prod|dev|pr-<n> <image>
#   scripts/deploy.sh down pr-<n>              # zmaže PR náhľad aj s jeho údajmi
#   scripts/deploy.sh prune [<n> ...]          # zmaže PR náhľady okrem otvorených PR <n> (zmeškané udalosti „closed“)
# Produkcia používa projekt "magicflowers" a jeho zväzok s existujúcimi záhradami – ten sa nikdy nemaže.
set -euo pipefail
cd "$(dirname "$0")/.."

action=${1:?up|down|prune}

if [[ "$action" == prune ]]; then
  shift
  for n in "$@"; do [[ "$n" =~ ^[0-9]+$ ]] || { echo "Zlé číslo PR: $n" >&2; exit 2; }; done
  open=" $* "
  # Len kontajnery mf-pr-<číslo> – dev a produkcia sa sem nikdy nedostanú.
  for c in $(docker ps -a --format '{{.Names}}' | grep -E '^mf-pr-[0-9]+$' || true); do
    n=${c#mf-pr-}
    [[ "$open" == *" $n "* ]] && continue
    echo "PR #$n už nie je otvorený – mažem náhľad $c"
    scripts/deploy.sh down "pr-$n"
  done
  exit 0
fi

env=${2:?prod|dev|pr-<n>}
image=${3:-}
base=${BASE_DOMAIN:-zahrada.spis-ai.com}

case "$env" in
  prod)    project=magicflowers; name=magicflowers;  domain=$base ;;
  dev)     project=mf-dev;       name=mf-dev;        domain=dev.$base ;;
  pr-[0-9]*)
    [[ "$env" =~ ^pr-[0-9]+$ ]] || { echo "Zlé prostredie: $env" >&2; exit 2; }
    project=mf-$env; name=mf-$env; domain=$env.$base ;;
  *) echo "Neznáme prostredie: $env" >&2; exit 2 ;;
esac

export NAME=$name DOMAIN=$domain
# Testovacie prostredia: nový hráč začína s 5000 🪙 a reputáciou úrovne 3. Produkcia má chudobný začiatok.
if [[ "$env" == prod ]]; then export START_COINS= START_REP=; else export START_COINS=5000 START_REP=3; fi
dc() { docker compose -p "$project" -f docker-compose.yml "$@"; }

if [[ "$action" == down ]]; then
  [[ "$env" == pr-* ]] || { echo "down je povolené len pre PR náhľady" >&2; exit 2; }
  export IMAGE=none
  dc down -v --remove-orphans
  exit 0
fi

[[ "$action" == up ]] || { echo "Neznáma akcia: $action" >&2; exit 2; }
export IMAGE=${image:?chýba obraz}
dc pull
dc up -d --no-build --remove-orphans

# Počkáme, kým je kontajner zdravý (HEALTHCHECK v Dockerfile).
for _ in $(seq 1 60); do
  st=$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || echo missing)
  [[ "$st" == healthy ]] && break
  sleep 2
done
if [[ "$st" != healthy ]]; then
  echo "Kontajner $name nie je zdravý ($st)" >&2; docker logs --tail 50 "$name" >&2; exit 1
fi

# Verejná adresa (certifikát môže pri novej doméne chvíľu trvať – len upozornenie).
for _ in $(seq 1 30); do
  curl -fsS -o /dev/null "https://$domain/" && { echo "Nasadené: https://$domain/ ($IMAGE)"; exit 0; }
  sleep 3
done
echo "::warning::Kontajner beží, ale https://$domain/ zatiaľ neodpovedá (certifikát?)"
