#!/usr/bin/env bash
#
# Bring up Prometheus, Loki, Promtail and Grafana, then open the dashboard.
#
# Wrapped in a script rather than inlined into package.json because of the
# daemon: `docker compose up` against a stopped Docker Desktop fails with a
# socket error that reads like a config problem. This starts the daemon first
# and waits for it, so `npm run prom:grafana` works from cold.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.observability.yml"
GRAFANA_URL="http://localhost:3002"

log() { printf '\033[2m[obs]\033[0m %s\n' "$1"; }
die() { printf '\033[31m[obs]\033[0m %s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not installed."

if ! docker info >/dev/null 2>&1; then
  case "$(uname -s)" in
    Darwin)
      log "Docker daemon is not running — starting Docker Desktop."
      open -a Docker || die "Could not launch Docker Desktop."
      ;;
    *)
      die "Docker daemon is not running. Start it and try again."
      ;;
  esac

  log "Waiting for the daemon (up to 3 min)."
  for _ in $(seq 1 36); do
    docker info >/dev/null 2>&1 && break
    sleep 5
  done

  # Docker Desktop can sit with its UI up and no daemon behind it, which is not
  # something this script can clear on its own — it needs a human at the app.
  docker info >/dev/null 2>&1 || die \
    "Docker Desktop is running but its daemon never came up. Open the app and
     check for a sign-in or update prompt, then re-run. If it stays wedged:
     pkill -9 -f com.docker.backend && open -a Docker"
fi

log "Starting the observability stack."
docker compose -f "$COMPOSE_FILE" up -d

log "Waiting for Grafana."
for _ in $(seq 1 40); do
  if curl -fsS "$GRAFANA_URL/api/health" >/dev/null 2>&1; then
    log "Grafana is up."
    break
  fi
  sleep 3
done

curl -fsS "$GRAFANA_URL/api/health" >/dev/null 2>&1 \
  || die "Grafana did not become healthy. Try: docker compose -f $COMPOSE_FILE logs grafana"

# Scrape health is worth saying out loud: the backend target being down is the
# single most common reason the dashboard looks empty, and it is not Grafana's
# fault, so Grafana does not mention it.
if curl -fsS 'http://localhost:9090/api/v1/query?query=up{job="fuelsense-backend"}' 2>/dev/null \
   | grep -q '"value"'; then
  if ! curl -fsS 'http://localhost:9090/api/v1/query?query=max(up{job="fuelsense-backend"})' 2>/dev/null \
     | grep -q '"1"'; then
    log "Warning: no backend is being scraped. Start it with 'npm run dev' in backend/."
  fi
fi

log "Grafana    $GRAFANA_URL"
log "Prometheus http://localhost:9090"
log "Logs need the backend started with 'npm run dev:logs' rather than 'npm run dev'."

case "$(uname -s)" in
  Darwin) open "$GRAFANA_URL" ;;
  Linux) command -v xdg-open >/dev/null 2>&1 && xdg-open "$GRAFANA_URL" >/dev/null 2>&1 || true ;;
esac
