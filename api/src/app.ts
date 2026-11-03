import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

interface Item {
  id: number;
  name: string;
  created_at: Date | string;
}

interface DatabaseClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Item[] }>;
}

interface RedisClient {
  del(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  ping(): Promise<string>;
  set(key: string, value: string): Promise<'OK' | null>;
}

interface AppDependencies {
  database: DatabaseClient;
  redis: RedisClient;
  cacheEnabled: boolean;
  /** Maximum time to wait for a Redis command before treating Redis as down. */
  redisTimeoutMs?: number;
  /** How long to skip Redis after a failure before trying it again. */
  redisRetryIntervalMs?: number;
}

type RedisResult<T> = { ok: true; value: T } | { ok: false };

declare module 'fastify' {
  interface FastifyRequest {
    startTime: bigint;
  }
}

const tracer = trace.getTracer('production-platform-lab-api');

async function withRedisSpan<T>(
  command: string,
  operation: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    `redis ${command}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'db.system.name': 'redis',
        'db.operation.name': command,
      },
    },
    async (span) => {
      try {
        return await operation();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Redis command timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createApp({
  database,
  redis,
  cacheEnabled,
  redisTimeoutMs = 250,
  redisRetryIntervalMs = 5000,
}: AppDependencies) {
  const app = Fastify({ logger: true });
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests.',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });
  const httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });
  const cacheEnabledGauge = new Gauge({
    name: 'api_cache_enabled',
    help: 'Whether the API is configured to use the Redis item cache.',
    registers: [registry],
  });
  cacheEnabledGauge.set(cacheEnabled ? 1 : 0);

  const cacheOperations = new Counter({
    name: 'api_cache_operations_total',
    help: 'Item cache lookup outcomes.',
    labelNames: ['result'],
    registers: [registry],
  });
  const cacheInvalidations = new Counter({
    name: 'api_cache_invalidations_total',
    help: 'Successful item cache invalidations.',
    registers: [registry],
  });
  const redisErrors = new Counter({
    name: 'api_redis_errors_total',
    help: 'Redis commands that failed or timed out, causing a PostgreSQL fallback.',
    labelNames: ['command'],
    registers: [registry],
  });
  const databaseItemListQueries = new Counter({
    name: 'api_database_item_list_queries_total',
    help: 'Number of item-list queries issued to PostgreSQL.',
    registers: [registry],
  });
  const databaseItemListQueryDuration = new Histogram({
    name: 'api_database_item_list_query_duration_seconds',
    help: 'Duration of item-list queries to PostgreSQL in seconds.',
    registers: [registry],
  });

  let redisUnavailableUntil = 0;
  let invalidationsRequested = 0;
  let invalidationsCompleted = 0;

  async function tryRedis<T>(
    command: string,
    log: FastifyBaseLogger,
    operation: () => Promise<T>,
    { probe = false }: { probe?: boolean } = {},
  ): Promise<RedisResult<T>> {
    if (!probe && Date.now() < redisUnavailableUntil) {
      return { ok: false };
    }
    try {
      const value = await withRedisSpan(command, () =>
        withTimeout(operation(), redisTimeoutMs),
      );
      redisUnavailableUntil = 0;
      return { ok: true, value };
    } catch (error) {
      redisUnavailableUntil = Date.now() + redisRetryIntervalMs;
      redisErrors.inc({ command });
      log.warn({ err: error, command }, 'Redis unavailable; falling back to PostgreSQL');
      return { ok: false };
    }
  }

  async function invalidateItemCache(log: FastifyBaseLogger): Promise<boolean> {
    const requested = invalidationsRequested;
    const result = await tryRedis('DEL', log, () => redis.del('items'));
    if (result.ok) {
      invalidationsCompleted = Math.max(invalidationsCompleted, requested);
      cacheInvalidations.inc();
    }
    return result.ok;
  }

  app.addHook('onRequest', async (request) => {
    request.startTime = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (request, reply) => {
    const duration = Number(process.hrtime.bigint() - request.startTime) / 1e9;
    const labels = {
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status_code: String(reply.statusCode),
    };

    httpRequests.inc(labels);
    httpRequestDuration.observe(labels, duration);
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (request, reply) => {
    try {
      const [, ping] = await Promise.all([
        database.query('SELECT 1'),
        cacheEnabled
          ? tryRedis('PING', request.log, () => redis.ping(), { probe: true })
          : undefined,
      ]);
      if (ping && !ping.ok) {
        return { status: 'degraded', cache: 'unavailable' };
      }
      return { status: 'ok' };
    } catch (error) {
      request.log.warn({ err: error }, 'Readiness check failed');
      return reply.code(503).send({ status: 'error' });
    }
  });

  app.post<{ Body: { name: string } }>(
    '/items',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await database.query(
        'INSERT INTO items (name) VALUES ($1) RETURNING id, name, created_at',
        [request.body.name],
      );
      if (cacheEnabled) {
        invalidationsRequested += 1;
        await invalidateItemCache(request.log);
      }
      return reply.code(201).send(result.rows[0]);
    },
  );

  app.get('/items', async (request) => {
    let cacheAvailable = false;
    if (cacheEnabled) {
      cacheAvailable =
        invalidationsCompleted >= invalidationsRequested ||
        (await invalidateItemCache(request.log));

      if (cacheAvailable) {
        const cached = await tryRedis('GET', request.log, () => redis.get('items'));
        if (cached.ok && cached.value !== null) {
          cacheOperations.inc({ result: 'hit' });
          return JSON.parse(cached.value) as Item[];
        }
        cacheAvailable = cached.ok;
        cacheOperations.inc({ result: cached.ok ? 'miss' : 'fallback' });
      } else {
        cacheOperations.inc({ result: 'fallback' });
      }
    } else {
      cacheOperations.inc({ result: 'bypass' });
    }

    const startTime = process.hrtime.bigint();
    databaseItemListQueries.inc();
    let rows: Item[];
    try {
      const result = await database.query(
        'SELECT id, name, created_at FROM items ORDER BY id',
      );
      rows = result.rows;
    } finally {
      databaseItemListQueryDuration.observe(
        Number(process.hrtime.bigint() - startTime) / 1e9,
      );
    }

    if (cacheAvailable) {
      await tryRedis('SET', request.log, () =>
        redis.set('items', JSON.stringify(rows)),
      );
    }
    return rows;
  });

  app.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  return app;
}
