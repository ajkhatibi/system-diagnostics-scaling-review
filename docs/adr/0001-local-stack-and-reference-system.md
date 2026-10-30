# ADR-001: Local Stack and Reference System

- Status: Accepted
- Date: 2026-10-30

## Context

Project 1 is a standalone reference system for exploring API performance,
caching, and observability in a local development environment. The lab needs a
repeatable way to run its infrastructure and inspect request metrics and
distributed traces without putting the API itself in a container.

The service needs a relational source of truth, a cache-aside read path, and
tools to observe service health and performance. It also needs a controlled
comparison that demonstrates the difference between bypassing the cache and
using it.

## Decision

Use Docker Compose to orchestrate PostgreSQL, Redis, Prometheus, Grafana, and
Jaeger locally. Compose gives the lab a single, reproducible way to start its
infrastructure and configure service networking and persistent local data.
Keep the Fastify API running on the host by design; Prometheus reaches it
through the host gateway.

Implement the API in TypeScript with Fastify. TypeScript provides compile-time
checks for the service and its integrations, while Fastify provides a small,
structured HTTP server for the reference API.

The reference system consists of:

- A Fastify API running on the host.
- PostgreSQL as the source of truth.
- Redis as a cache-aside layer for item reads; the API consults the cache and
  queries PostgreSQL on a miss.
- Prometheus for API metrics, Grafana for metric dashboards, and Jaeger for
  distributed traces across the API, Redis, and PostgreSQL.

Compare cache-bypassed and cache-enabled modes with the same k6 item-read
workload. Run each mode twice, alternating execution order between repetitions
to reduce ordering bias. Compare the median across each mode's two runs for
request rate, p95 latency, failed-request rate, and database item-list queries
during load. Do not select only the fastest run.

The PostgreSQL credentials `lab` / `lab` and Grafana credentials `admin` /
`admin` are local-only lab credentials. They must never be reused outside this
environment.

## Consequences

The infrastructure can be started and inspected consistently without
containerizing the API, preserving the intended host-based development and
benchmark setup. The API can be tested independently while the Compose-managed
services provide realistic dependencies and observability.

The cache comparison is repeatable and produces per-run output that supports a
median-based analysis. Results remain sensitive to local machine load and
should be treated as demonstration data, not production capacity guarantees.
The local credentials are intentionally simple for the lab and are not suitable
for any shared or deployed environment.
