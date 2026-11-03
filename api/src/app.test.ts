import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app.js';

const item = {
  id: 1,
  name: 'sample',
  created_at: '2026-01-01T00:00:00.000Z',
};

function createDependencies() {
  const rows = [item];
  const cache = new Map<string, string>();
  const calls = { database: 0, redisGet: 0, redisSet: 0, redisDel: 0, redisPing: 0 };
  const database = {
    query: async (sql: string, _values?: unknown[]) => {
      if (sql.includes('INSERT INTO')) {
        return { rows: [item] };
      }
      if (sql.includes('FROM items')) {
        calls.database += 1;
        return { rows };
      }
      return { rows: [] };
    },
  };
  const redis = {
    get: async (key: string) => {
      calls.redisGet += 1;
      return cache.get(key) ?? null;
    },
    set: async (key: string, value: string) => {
      calls.redisSet += 1;
      cache.set(key, value);
      return 'OK' as const;
    },
    del: async (key: string) => {
      calls.redisDel += 1;
      return Number(cache.delete(key));
    },
    ping: async () => {
      calls.redisPing += 1;
      return 'PONG';
    },
  };

  return { database, redis, calls };
}

test('caches a database result and serves the next request from cache', async () => {
  const dependencies = createDependencies();
  const app = createApp({ ...dependencies, cacheEnabled: true });

  try {
    const first = await app.inject('/items');
    const second = await app.inject('/items');

    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), [item]);
    assert.deepEqual(second.json(), [item]);
    assert.equal(dependencies.calls.database, 1);
    assert.equal(dependencies.calls.redisGet, 2);
    assert.equal(dependencies.calls.redisSet, 1);
  } finally {
    await app.close();
  }
});

test('bypasses Redis and reads the database when caching is disabled', async () => {
  const dependencies = createDependencies();
  const app = createApp({ ...dependencies, cacheEnabled: false });

  try {
    const response = await app.inject('/items');
    const metrics = await app.inject('/metrics');
    const readiness = await app.inject('/health/ready');

    assert.equal(response.statusCode, 200);
    assert.equal(dependencies.calls.database, 1);
    assert.equal(dependencies.calls.redisGet, 0);
    assert.equal(dependencies.calls.redisSet, 0);
    assert.equal(dependencies.calls.redisPing, 0);
    assert.match(metrics.body, /api_cache_operations_total\{result="bypass"\} 1/);
    assert.match(metrics.body, /api_cache_enabled 0/);
    assert.equal(readiness.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('invalidates the cached item list after creating an item', async () => {
  const dependencies = createDependencies();
  const app = createApp({ ...dependencies, cacheEnabled: true });

  try {
    await app.inject('/items');
    const response = await app.inject({
      method: 'POST',
      url: '/items',
      payload: { name: 'new item' },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(dependencies.calls.redisDel, 1);
    assert.deepEqual(response.json(), item);

    await app.inject('/items');
    assert.equal(dependencies.calls.database, 2);
  } finally {
    await app.close();
  }
});

test('rejects invalid item input', async () => {
  const dependencies = createDependencies();
  const app = createApp({ ...dependencies, cacheEnabled: false });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/items',
      payload: { name: '' },
    });

    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
  }
});

function breakRedis(redis: ReturnType<typeof createDependencies>['redis']) {
  const healthy = { ...redis };
  const fail = async () => {
    throw new Error('Redis unavailable');
  };
  redis.get = fail;
  redis.set = fail;
  redis.del = fail;
  redis.ping = fail;
  return () => Object.assign(redis, healthy);
}

test('falls back to the database when Redis fails and skips Redis until the retry interval', async () => {
  const dependencies = createDependencies();
  breakRedis(dependencies.redis);
  const app = createApp({
    ...dependencies,
    cacheEnabled: true,
    redisRetryIntervalMs: 60_000,
  });

  try {
    const first = await app.inject('/items');
    const second = await app.inject('/items');
    const metrics = await app.inject('/metrics');

    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), [item]);
    assert.deepEqual(second.json(), [item]);
    assert.equal(dependencies.calls.database, 2);
    assert.match(metrics.body, /api_cache_operations_total\{result="fallback"\} 2/);
    assert.match(metrics.body, /api_redis_errors_total\{command="GET"\} 1/);
  } finally {
    await app.close();
  }
});

test('falls back to the database when Redis hangs', async () => {
  const dependencies = createDependencies();
  dependencies.redis.get = () => new Promise<string | null>(() => {});
  const app = createApp({ ...dependencies, cacheEnabled: true, redisTimeoutMs: 20 });

  try {
    const response = await app.inject('/items');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), [item]);
    assert.equal(dependencies.calls.database, 1);
  } finally {
    await app.close();
  }
});

test('keeps creating items and reports degraded readiness while Redis is down', async () => {
  const dependencies = createDependencies();
  breakRedis(dependencies.redis);
  const app = createApp({ ...dependencies, cacheEnabled: true });

  try {
    const created = await app.inject({
      method: 'POST',
      url: '/items',
      payload: { name: 'new item' },
    });
    const readiness = await app.inject('/health/ready');

    assert.equal(created.statusCode, 201);
    assert.equal(readiness.statusCode, 200);
    assert.deepEqual(readiness.json(), { status: 'degraded', cache: 'unavailable' });
  } finally {
    await app.close();
  }
});

test('still fails readiness when the database is down', async () => {
  const dependencies = createDependencies();
  dependencies.database.query = async () => {
    throw new Error('Database unavailable');
  };
  const app = createApp({ ...dependencies, cacheEnabled: true });

  try {
    const readiness = await app.inject('/health/ready');

    assert.equal(readiness.statusCode, 503);
  } finally {
    await app.close();
  }
});

test('does not serve a stale cache when an invalidation was missed during an outage', async () => {
  const dependencies = createDependencies();
  const app = createApp({
    ...dependencies,
    cacheEnabled: true,
    redisRetryIntervalMs: 60_000,
  });

  try {
    await app.inject('/items');
    assert.equal(dependencies.calls.database, 1);

    const restoreRedis = breakRedis(dependencies.redis);
    await app.inject({ method: 'POST', url: '/items', payload: { name: 'new item' } });
    restoreRedis();

    // Readiness probes Redis directly, so it closes the circuit once Redis is back.
    const readiness = await app.inject('/health/ready');
    assert.deepEqual(readiness.json(), { status: 'ok' });

    const items = await app.inject('/items');
    assert.equal(items.statusCode, 200);
    assert.equal(dependencies.calls.database, 2);
  } finally {
    await app.close();
  }
});

test('resumes using Redis after it recovers', async () => {
  const dependencies = createDependencies();
  const restoreRedis = breakRedis(dependencies.redis);
  const app = createApp({
    ...dependencies,
    cacheEnabled: true,
    redisRetryIntervalMs: 60_000,
  });

  try {
    await app.inject('/items');
    restoreRedis();
    await app.inject('/health/ready');
    await app.inject('/items');
    await app.inject('/items');

    assert.equal(dependencies.calls.database, 2);
    assert.equal(dependencies.calls.redisSet, 1);
  } finally {
    await app.close();
  }
});
