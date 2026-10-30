import './tracing.js';

import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { createApp } from './app.js';

const database = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://lab:lab@localhost:5432/platform_lab',
});
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const cacheEnabled = process.env.CACHE_ENABLED !== 'false';
const app = createApp({ database, redis, cacheEnabled });

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
