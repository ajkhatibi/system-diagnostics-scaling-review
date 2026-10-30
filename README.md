# System diagnostics and scaling review

A reproducible performance case study for a small Fastify API. The project compares the same read-heavy workload with a Redis cache bypassed and enabled, then uses request metrics, database/cache metrics, and traces to explain the result.

The goal is not to claim that caching is always faster. It is to form a hypothesis, measure both modes under the same conditions, and report what the evidence says.

## What this demonstrates

- A PostgreSQL-backed API with request validation and Redis cache-aside reads.
- A controlled cache-off/cache-on comparison against the same seeded dataset.
- Prometheus metrics for request latency, errors, cache outcomes, and database list-query cost.
- A provisioned Grafana dashboard for comparing the service during a run.
- OpenTelemetry traces exported to Jaeger, including explicit Redis command spans.
- Fastify route tests and a TypeScript typecheck.

## Architecture

```text
k6 ──HTTP──> Fastify API ──> PostgreSQL
                   │
                   ├────────> Redis
                   ├── /metrics ──> Prometheus ──> Grafana
                   └── OTLP traces ──────────────> Jaeger
```

PostgreSQL is the source of truth. With caching enabled, `GET /items` checks Redis first, loads all rows from PostgreSQL on a miss, and stores the result in Redis. `POST /items` inserts into PostgreSQL and invalidates the list cache. Set `CACHE_ENABLED=false` to bypass Redis for the comparison. The API exports a gauge showing the active mode.

The list endpoint deliberately returns all 10,000 seeded rows. That makes this a focused cache experiment, not a recommended design for a large production collection: pagination and bounded cache entries are natural follow-up improvements.

## Prerequisites

- Node.js 20 or newer and npm.
- Docker with the Compose plugin.
- k6 installed on the host. See [k6 installation instructions](https://grafana.com/docs/k6/latest/set-up/install-k6/).

## Run locally

From the repository root, start the databases and observability tools:

```sh
docker compose -f infra/docker-compose.yml up -d
```

Install dependencies and run the automated checks:

```sh
cd api
npm ci
npm run typecheck
npm test
```

Start the API in a second terminal:

```sh
cd api
npm start
```

The API listens on port `3001`. It creates the `items` table at startup. Its default database and Redis URLs match the local Compose services; override them with `DATABASE_URL` and `REDIS_URL` if needed.

Open the tools:

| Tool | URL | Local credentials |
|---|---|---|
| Grafana dashboard | <http://localhost:3000/d/service-performance/service-performance> | `admin` / `admin` |
| Prometheus | <http://localhost:9090> | none |
| Jaeger | <http://localhost:16686> | none |
| API health | <http://localhost:3001/health/ready> | none |
| API metrics | <http://localhost:3001/metrics> | none |

Grafana provisions its Prometheus data source and the Service performance dashboard from files in `infra/grafana/`. Prometheus scrapes the host API every five seconds. The API sends traces to the local Jaeger collector.

## Run the cache comparison

From the repository root:

```sh
./benchmark/run-comparison.sh
```

The script:

1. Starts all PostgreSQL, Redis, Prometheus, Grafana, and Jaeger services if they are not running.
2. Adds a deterministic set of 10,000 `benchmark-item-*` rows. It removes only prior rows with that prefix; it does not truncate other item data.
3. Starts the API with caching disabled, warms the endpoint once, runs the k6 workload, and captures both k6 output and API metrics.
4. Repeats with caching enabled using the same data and workload.
5. Stops the API it started. Supporting Compose services remain running.

By default, each mode runs twice, alternating which mode goes first to reduce order bias. Each run uses 10 virtual users for 60 seconds. Adjust the test from the environment, for example:

```sh
RUNS=3 VUS=20 DURATION=90s ./benchmark/run-comparison.sh
```

Do not run another API on port `3001` while this script is running. Generated results are saved under `benchmark/results/` (for example, `cache-false-run1.json`) and are intentionally git-ignored; review them and copy any final, verified numbers into your project write-up.

The k6 JSON files contain request rate, latency percentiles, and failed-request rate. The adjacent `.metrics` files are raw Prometheus exposition snapshots. Compare:

- `http_req_duration.values.p95` and `http_req_failed.values.rate` in each k6 JSON summary.
- `api_database_item_list_queries_total` and `api_database_item_list_query_duration_seconds` in the matching metrics snapshot.
- `api_cache_operations_total{result="hit"}` and `{result="miss"}` in the cache-enabled snapshot.

Each run makes one warm-up request before k6 starts, so subtract that one request from the database query counter if reporting only load-test queries. Compare the median across repetitions, not just one fastest run. Check both the k6 error rate and the endpoint's 5xx ratio; faster responses are not an improvement if they come with more failures.

## Interpreting the results

The hypothesis is that, for repeated reads of the same list, enabling the cache will reduce PostgreSQL list queries. Whether it also improves end-to-end p95 latency depends on the machine, data size, serialization cost, Redis overhead, and response size.

Record the actual environment and results. A useful report table is:

| Mode | Dataset | VUs / duration | Request rate | p95 latency | Failed requests | DB list queries during load |
|---|---:|---|---:|---:|---:|---:|
| Cache bypassed | 10,000 rows | 10 / 60s | _measure_ | _measure_ | _measure_ | _measure_ |
| Cache enabled | 10,000 rows | 10 / 60s | _measure_ | _measure_ | _measure_ | _measure_ |

Don't fill in estimated numbers. Repeat each run if results are noisy, keep the setup unchanged, and state that a local benchmark is not a production capacity guarantee.

The dashboard shows request rate, p95 latency, cache mode and hit ratio, PostgreSQL list-query rate and p95, and 5xx ratio. Use Jaeger to inspect representative traces and see time spent in the request and Redis operations. The metrics let you observe the system; the load test creates the workload; traces help explain where time went.

## Failure behavior and limitations

- With cache bypassed, readiness checks require PostgreSQL but do not require Redis. With cache enabled, readiness checks both dependencies.
- With cache enabled, Redis errors currently fail the request rather than silently falling back to PostgreSQL. That makes the failure visible in this lab; deciding whether to fail open, and how to keep stale data bounded, is a separate reliability trade-off.
- The entire item list is cached under one key, with no TTL or pagination. This is intentionally simple and can become memory-, serialization-, and response-size-heavy.
- The API runs on the host while its dependencies run in Compose. Prometheus reaches it through `host.docker.internal`; this local setup is not a production deployment.
- The demo Grafana password is `admin`; do not reuse these settings outside a local environment.

## Useful commands

```sh
cd api && npm test
cd api && npm run typecheck
docker compose -f infra/docker-compose.yml down
```
