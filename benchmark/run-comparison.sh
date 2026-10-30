#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required; install Docker Desktop or Docker Engine first." >&2
  exit 1
fi
if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 is required; install it using the instructions in README.md." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to check the API and capture metrics." >&2
  exit 1
fi
if [ ! -d api/node_modules ]; then
  echo "API dependencies are missing; run npm ci in the api directory." >&2
  exit 1
fi

RUNS="${RUNS:-2}"
if ! [[ "$RUNS" =~ ^[1-9][0-9]*$ ]]; then
  echo "RUNS must be a positive integer." >&2
  exit 1
fi

RESULTS_DIR="$ROOT_DIR/benchmark/results"
mkdir -p "$RESULTS_DIR"
API_LOG="$(mktemp)"
API_PID=""

stop_api() {
  if [ -n "$API_PID" ]; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
    API_PID=""
  fi
}

cleanup() {
  stop_api
  rm -f "$API_LOG"
}
trap cleanup EXIT

docker compose -f infra/docker-compose.yml up -d
services_ready=false
for _ in $(seq 1 60); do
  if docker compose -f infra/docker-compose.yml exec -T postgres \
    pg_isready -U lab -d platform_lab >/dev/null 2>&1 &&
    docker compose -f infra/docker-compose.yml exec -T redis \
      redis-cli ping >/dev/null 2>&1; then
    services_ready=true
    break
  fi
  sleep 1
done
if [ "$services_ready" != true ]; then
  echo "PostgreSQL and Redis did not become ready." >&2
  exit 1
fi
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U lab -d platform_lab < benchmark/seed.sql

start_api() {
  local cache_mode="$1"
  (
    cd api
    exec env \
      CACHE_ENABLED="$cache_mode" \
      DATABASE_URL="${DATABASE_URL:-postgres://lab:lab@localhost:5432/platform_lab}" \
      REDIS_URL="${REDIS_URL:-redis://localhost:6379}" \
      node --import tsx src/server.ts
  ) >"$API_LOG" 2>&1 &
  API_PID=$!

  for _ in $(seq 1 60); do
    if curl --fail --silent http://localhost:3001/health/ready >/dev/null; then
      return
    fi
    if ! kill -0 "$API_PID" 2>/dev/null; then
      cat "$API_LOG" >&2
      echo "API failed to start with CACHE_ENABLED=$cache_mode." >&2
      return 1
    fi
    sleep 1
  done

  cat "$API_LOG" >&2
  echo "API did not become ready with CACHE_ENABLED=$cache_mode." >&2
  return 1
}

run_mode() {
  local mode="$1"
  local iteration="$2"
  local output="$RESULTS_DIR/cache-$mode-run$iteration"

  if [ "$mode" = true ]; then
    docker compose -f infra/docker-compose.yml exec -T redis \
      redis-cli DEL items >/dev/null
  fi
  start_api "$mode"
  curl --fail --silent http://localhost:3001/items >/dev/null
  BASE_URL="${BASE_URL:-http://localhost:3001}" \
    VUS="${VUS:-10}" \
    DURATION="${DURATION:-60s}" \
    k6 run --summary-export "$output.json" benchmark/items.js
  curl --fail --silent http://localhost:3001/metrics >"$output.metrics"
  stop_api
}

for iteration in $(seq 1 "$RUNS"); do
  if (( iteration % 2 == 1 )); then
    run_mode false "$iteration"
    run_mode true "$iteration"
  else
    run_mode true "$iteration"
    run_mode false "$iteration"
  fi
done

echo
echo "Comparison outputs:"
for iteration in $(seq 1 "$RUNS"); do
  echo "  $RESULTS_DIR/cache-false-run$iteration.json"
  echo "  $RESULTS_DIR/cache-false-run$iteration.metrics"
  echo "  $RESULTS_DIR/cache-true-run$iteration.json"
  echo "  $RESULTS_DIR/cache-true-run$iteration.metrics"
done
