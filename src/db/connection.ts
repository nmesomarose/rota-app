import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { env } from '../config/env.ts';
import { type ShardId } from '../sharding/shard-router.ts';

const { Pool } = pg;

// Control plane connection pool (runs under APP_DATABASE_URL with schema search_path set)
export const controlPool = new Pool({
  connectionString: env.APP_DATABASE_URL,
  options: `-c search_path=${env.CONTROL_SCHEMA}`,
  max: 10,
  idleTimeoutMillis: 30000,
});

// Shard 1 connection pool (Dedicated physical database rota_shard_1)
export const shard1Pool = new Pool({
  connectionString: env.APP_SHARD_1_DATABASE_URL,
  options: `-c search_path=public,${env.SHARD_1_SCHEMA}`,
  max: 10,
  idleTimeoutMillis: 30000,
});

// Shard 2 connection pool (Dedicated physical database rota_shard_2)
export const shard2Pool = new Pool({
  connectionString: env.APP_SHARD_2_DATABASE_URL,
  options: `-c search_path=public,${env.SHARD_2_SCHEMA}`,
  max: 10,
  idleTimeoutMillis: 30000,
});

/**
 * Returns the connection pool corresponding to the given logical shard.
 */
export function getShardPool(shardId: ShardId): pg.Pool {
  return shardId === 'shard_1' ? shard1Pool : shard2Pool;
}

/**
 * Empty schema interface for type-safe Kysely instances.
 * Concrete table schemas will be populated in Milestone M1/M2.
 */
export interface DatabaseSchema {
  [tableName: string]: unknown;
}

export const controlDb = new Kysely<DatabaseSchema>({
  dialect: new PostgresDialect({
    pool: controlPool,
  }),
});

export const shard1Db = new Kysely<DatabaseSchema>({
  dialect: new PostgresDialect({
    pool: shard1Pool,
  }),
});

export const shard2Db = new Kysely<DatabaseSchema>({
  dialect: new PostgresDialect({
    pool: shard2Pool,
  }),
});

let dbCheckerOverride: (() => Promise<boolean>) | null = null;

/**
 * Test hook to override database health check status without modifying connection pools.
 */
export function setDatabaseCheckerForTesting(checker: (() => Promise<boolean>) | null): void {
  dbCheckerOverride = checker;
}

async function checkPool(pool: pg.Pool, timeoutMs: number = 2000): Promise<boolean> {
  let client: pg.PoolClient | null = null;
  let timer: NodeJS.Timeout | null = null;
  try {
    const connectPromise = pool.connect();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Connection timeout')), timeoutMs);
    });
    client = await Promise.race([connectPromise, timeoutPromise]);
    const queryPromise = client.query('SELECT 1 AS ready');
    const result = await Promise.race([queryPromise, timeoutPromise]);
    return result.rows[0]?.ready === 1;
  } catch (_err) {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    if (client) {
      client.release();
    }
  }
}

/**
 * Safely tests whether all database pools (control plane and all tenant shards) are accessible.
 * Returns true if all connection pools succeed, false otherwise.
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  if (dbCheckerOverride) {
    return dbCheckerOverride();
  }
  const results = await Promise.all([
    checkPool(controlPool),
    checkPool(shard1Pool),
    checkPool(shard2Pool),
  ]);
  return results.every(Boolean);
}

import { closeRedisClient } from '../services/redis-client.ts';

/**
 * Closes all connection pools and cache connections. Useful during graceful shutdown and tests.
 */
export async function closeAllPools(): Promise<void> {
  await Promise.allSettled([
    controlPool.end(),
    shard1Pool.end(),
    shard2Pool.end(),
    closeRedisClient(),
  ]);
}
