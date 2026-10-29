import './tracing.js';

import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { Pool } from 'pg';

interface Item {
  id: number;
  name: string;
  created_at: Date | string;
}

const database = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://lab:lab@localhost:5432/platform_lab',
});
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const app = Fastify({ logger: true });
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

declare module 'fastify' {
  interface FastifyRequest {
    startTime: bigint;
  }
}

app.get('/health', async () => ({ status: 'ok' }));

app.get('/health/ready', async (request, reply) => {
  try {
    await Promise.all([
      database.query('SELECT 1'),
      withRedisSpan('PING', () => redis.ping()),
    ]);
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
    const result = await database.query<Item>(
      'INSERT INTO items (name) VALUES ($1) RETURNING id, name, created_at',
      [request.body.name],
    );
    await withRedisSpan('DEL', () => redis.del('items'));
    return reply.code(201).send(result.rows[0]);
  },
);

app.get('/items', async () => {
  const cachedItems = await withRedisSpan('GET', () => redis.get('items'));
  if (cachedItems !== null) {
    return JSON.parse(cachedItems) as Item[];
  }

  const result = await database.query<Item>(
    'SELECT id, name, created_at FROM items ORDER BY id',
  );
  await withRedisSpan('SET', () =>
    redis.set('items', JSON.stringify(result.rows)),
  );
  return result.rows;
});

app.get('/metrics', async (_request, reply) => {
  reply.header('Content-Type', registry.contentType);
  return registry.metrics();
});

async function start(): Promise<void> {
  try {
    await database.query(`
      CREATE TABLE IF NOT EXISTS items (
        id SERIAL PRIMARY KEY,
        name TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    await app.listen({ host: '0.0.0.0', port: 3001 });
  } catch (error) {
    app.log.error({ err: error }, 'Failed to start API');
    await Promise.allSettled([app.close(), database.end(), redis.quit()]);
    process.exitCode = 1;
  }
}

await start();
