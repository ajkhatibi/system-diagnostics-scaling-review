# System diagnostics and scaling review

A reproducible performance case study for a small Fastify API. The project compares the same read-heavy workload with a Redis cache bypassed and enabled, then uses request metrics, database/cache metrics, and traces to explain the result.

The goal is not to claim that caching is always faster. It is to form a hypothesis, measure both modes under the same conditions, and report what the evidence says.

## What this demonstrates

- A PostgreSQL-backed API with request validation and Redis cache-aside reads.
- A controlled cache-off/cache-on comparison against the same seeded dataset.
- Prometheus metrics for request latency, errors, cache outcomes, and database list-query cost.
- A provisioned Grafana dashboard for comparing the service during a run, including saturation panels (event-loop lag, CPU, memory).
- A saturation analysis that identifies the first bottleneck under load and what would change at 10x.
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

- `http_reqs.rate`, `http_req_duration["p(95)"]`, and `http_req_failed.value` in each k6 JSON summary.
- `api_database_item_list_queries_total` and `api_database_item_list_query_duration_seconds` in the matching metrics snapshot.
- `api_cache_operations_total{result="hit"}`, `{result="miss"}`, `{result="bypass"}`, and `{result="fallback"}` (Redis unavailable; expected to be 0 in a healthy run) in the matching metrics snapshot.

Each run makes one warm-up request before k6 starts, so subtract that one request from the database query counter if reporting only load-test queries. Cache-operation counters include the warm-up request. Compare the median across repetitions, not just one fastest run. Check both the k6 error rate and the endpoint's 5xx ratio; faster responses are not an improvement if they come with more failures.

## Interpreting the results

The hypothesis is that, for repeated reads of the same list, enabling the cache will reduce PostgreSQL list queries. Whether it also improves end-to-end p95 latency depends on the machine, data size, serialization cost, Redis overhead, and response size.

Measured on a local Mac with two repetitions per mode, a 10,000-row dataset, and 10 VUs for 60 seconds per run. Values below are medians across the two repetitions:

| Mode | Environment / dataset | VUs / duration | Request rate | p95 latency | Failed-request rate | DB list queries during load | Cache hits / misses (bypasses) |
|---|---|---|---:|---:|---:|---:|---:|
| Cache bypassed | Local Mac; 10,000 rows | 10 / 60s | 47.68 req/s | 296.35 ms | 0.00% | 2,869 | 0 / 0 (2,870 bypasses) |
| Cache enabled | Local Mac; 10,000 rows | 10 / 60s | 176.04 req/s | 65.01 ms | 0.00% | 0 | 10,571 / 1 (0 bypasses) |

Database query counts exclude the warm-up request; cache hit/miss/bypass counts include it. The cache-enabled miss is the pre-load warm-up. These local measurements are not a production capacity guarantee.

The dashboard shows request rate, p95 latency, cache mode and hit ratio, PostgreSQL list-query rate and p95, 5xx ratio, and API saturation: Node.js event-loop lag (mean and p99), CPU usage in cores, and resident memory (RSS). Use Jaeger to inspect representative traces and see time spent in the request and Redis operations. The metrics let you observe the system; the load test creates the workload; traces help explain where time went.

## Bottleneck

To find which resource runs out first, the cache-enabled API was loaded with 10 VUs for 180 seconds on the same local Mac and 10,000-row dataset, with the cache already warm:

```sh
BASE_URL=http://localhost:3001 VUS=10 DURATION=180s k6 run benchmark/items.js
```

The saturation panels were watched during the run. The values below come from the same PromQL queries, evaluated in Prometheus over the run window.

| Signal | Idle, before the run | During the run |
|---|---:|---:|
| Request rate (k6) | – | 176.38 req/s |
| p95 latency (k6) | – | 66.93 ms |
| Failed requests (k6) | – | 0.00% (0 of 31,759) |
| API CPU, `rate(process_cpu_seconds_total[1m])` | 0.004 cores | 1.11 cores average (1.09–1.14 once the 1-minute window filled) |
| Event-loop lag, mean | 11.27 ms | 14.64 ms average, 16.03 ms highest |
| Event-loop lag, p99 | 17.40 ms | 24.13 ms average, 38.21 ms highest |
| API resident memory (RSS) | 46.7 MB | 336.2 MB average (272.7–425.7 MB) |
| Redis container CPU (`docker stats`) | 0.7% of one core | 7–11% of one core |
| PostgreSQL item-list queries | – | 0 (every request was a cache hit) |

Each `GET /items` response was 807,862 bytes; k6 received 26 GB in total (143 MB/s).

**The first resource to saturate is CPU in the API's single Node.js process.**

- API CPU rose to about 1.1 cores in the first minute and stayed flat while throughput held at about 176 req/s. Node.js runs request handling on one main JavaScript thread, so one process cannot apply much more than one core to requests; the small excess above 1.0 is work on Node's background threads.
- Nothing else was near a limit. Redis used 7–11% of one core, PostgreSQL served no list queries, k6 used about 11% of one core, and the machine has 10 CPU cores.
- Each request cost about 6.3 ms of CPU (1.11 cores ÷ 176.38 req/s), yet requests averaged 56.58 ms in k6. With 10 VUs sharing one busy thread, requests spend most of their time waiting their turn.
- The likely source of that CPU is the cache-hit path in [api/src/app.ts](api/src/app.ts): it parses the cached ~808 KB JSON string into about 10,000 row objects, then Fastify serializes them back to JSON for the response. Both are synchronous work on the main thread for every request. This has not been profiled; a CPU profile (`node --cpu-prof`) would confirm how the 6.3 ms splits.

How to read the other panels:

- **Event-loop lag rose only a few milliseconds even though the thread was busy.** Lag measures how late a timer fires, so it reflects the longest single stretch of synchronous work, not overall utilization; each request's work is a few milliseconds long. The idle value is about 11 ms because prom-client samples with a 10 ms timer by default and the reading includes that interval. Compare against the idle value rather than zero.
- **Memory is not the limit at this load.** RSS moved up and down between 272.7 and 425.7 MB rather than climbing, and fell to 113 MB within 30 seconds after the run. That pattern fits short-lived garbage from building and discarding the 808 KB list on every request. Garbage collection took about 4.1% of wall-clock time.
- **The dashboard's p95 (about 49 ms) is lower than k6's (66.93 ms).** The server histogram has bucket boundaries at 25, 50, and 100 ms, so its p95 is interpolated: 97.0% of requests finished within 50 ms on the server. The gap is time outside the route handler, such as waiting for the busy event loop to pick up the request and transferring 808 KB to the client. Use the k6 figure as the user-facing latency.

The cache-bypassed mode was not re-measured with these panels, so its bottleneck may differ.

## 10x scaling

The target is about 1,760 req/s, ten times the cache-enabled rate of 176.04 req/s in the comparison table. The projections below scale the measured per-request costs linearly; they have not been load-tested.

**What breaks first: API CPU.** At about 6.3 ms of CPU per request, 1,760 req/s needs about 11 cores of request handling (10 × 1.11 cores). One Node.js process supplies about one core of request handling, so a single instance stays near 176 req/s; more load would be expected to add queueing (higher latency at the same throughput) rather than throughput. That is also more CPU than this 10-core Mac has, before counting k6 and Redis, so 10x cannot be demonstrated on this machine.

**The next limits once CPU is scaled out:**

- **Response bytes.** k6 received 143 MB/s at 176 req/s. Ten times that is about 1.4 GB/s (about 11 Gbit/s), almost all of it the same list repeated.
- **Redis.** Every request reads the whole 808 KB value from one key. Redis used 7–11% of one core at 176 req/s; scaled linearly, that is about 70–110% of one core. Redis runs commands on a single thread, so one hot key on one Redis instance would be at or near its limit.
- **PostgreSQL on cache misses.** While the cache is warm, PostgreSQL serves no list queries. But the cache-bypassed mode handled 47.68 req/s in the comparison table, and 1,760 req/s is about 37 times that. A Redis outage or a cache invalidation (every `POST /items`) would send that traffic to the database path, and every instance would reload the full list at once because concurrent misses are not coalesced.
- **Memory.** Each instance peaked at 425.7 MB RSS at 176 req/s. Reaching 10x by adding instances multiplies total memory accordingly.

**What would change, in order:**

1. **Cut CPU per request first, because it is the measured bottleneck.** On cache hits, send the cached JSON string as-is instead of parsing and re-serializing it. Re-run this test and compare CPU per request.
2. **Paginate `GET /items`** with a bounded page size (for example, keyset pagination on `id`) and cache pages. Smaller responses reduce CPU, garbage, Redis traffic, and network bytes together.
3. **Run multiple API processes**, using the Node.js cluster module or several containers behind a load balancer. At today's cost that is about 10 processes, each needing a little over one core; steps 1 and 2 reduce the count.
4. **Protect Redis and PostgreSQL.** Coalesce concurrent misses so one request reloads the list. Add a TTL. Consider a short-lived in-process copy of the hot list so instances don't each pull 808 KB from Redis per request. Replace the in-process invalidation tracking with shared, versioned cache keys so multiple instances cannot serve stale data (see below).
5. **Measure 10x on separate machines,** with the load generator off the API host, using the same signals: k6 p95, API CPU, event-loop lag, RSS, and Redis CPU.

## Failure behavior and limitations

- With cache bypassed, readiness checks require PostgreSQL but do not require Redis. With cache enabled, readiness also probes Redis, but a Redis failure only reports `{"status":"degraded","cache":"unavailable"}` (HTTP 200) because the API can still serve from PostgreSQL. A PostgreSQL failure returns 503.
- With cache enabled, if Redis errors or does not respond within 250 ms, `GET /items` falls back to PostgreSQL and `POST /items` still succeeds. Redis is then skipped for 5 seconds before being retried, so an outage costs one timeout per interval rather than one per request. Failures are visible as `api_cache_operations_total{result="fallback"}`, `api_redis_errors_total{command=...}`, and warning logs. This makes cache-enabled runs look like cache-bypassed runs for the duration of an outage.
- If the cache invalidation after `POST /items` fails, the process refuses to read the cache until it has successfully deleted the stale list, so it does not serve stale data after Redis recovers. This is tracked in memory only: stale data can still be served if the API restarts during an outage, or if multiple API instances are running. A TTL on the cached list would bound this.
- The entire item list is cached under one key, with no TTL or pagination. This is intentionally simple and can become memory-, serialization-, and response-size-heavy.
- The API runs on the host while its dependencies run in Compose. Prometheus reaches it through `host.docker.internal`; this local setup is not a production deployment.
- The demo Grafana password is `admin`; do not reuse these settings outside a local environment.

## Useful commands

```sh
cd api && npm test
cd api && npm run typecheck
docker compose -f infra/docker-compose.yml down
```
