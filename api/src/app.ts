import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import Fastify from 'fastify';
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
}

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

export function createApp({ database, redis, cacheEnabled }: AppDependencies) {
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
      const checks: Promise<unknown>[] = [database.query('SELECT 1')];
      if (cacheEnabled) {
        checks.push(withRedisSpan('PING', () => redis.ping()));
      }
      await Promise.all(checks);
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
        await withRedisSpan('DEL', () => redis.del('items'));
        cacheInvalidations.inc();
      }
      return reply.code(201).send(result.rows[0]);
    },
  );

  app.get('/items', async () => {
    if (cacheEnabled) {
      const cachedItems = await withRedisSpan('GET', () => redis.get('items'));
      if (cachedItems !== null) {
        cacheOperations.inc({ result: 'hit' });
        return JSON.parse(cachedItems) as Item[];
      }
      cacheOperations.inc({ result: 'miss' });
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

    if (cacheEnabled) {
      await withRedisSpan('SET', () =>
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
