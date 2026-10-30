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

test('reports Redis failure in readiness and item reads when caching is enabled', async () => {
  const dependencies = createDependencies();
  dependencies.redis.ping = async () => {
    throw new Error('Redis unavailable');
  };
  dependencies.redis.get = async () => {
    throw new Error('Redis unavailable');
  };
  const app = createApp({ ...dependencies, cacheEnabled: true });

  try {
    const readiness = await app.inject('/health/ready');
    const items = await app.inject('/items');

    assert.equal(readiness.statusCode, 503);
    assert.equal(items.statusCode, 500);
  } finally {
    await app.close();
  }
});
