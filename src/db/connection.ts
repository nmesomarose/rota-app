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

// Shard 1 connection pool
export const shard1Pool = new Pool({
  connectionString: env.APP_DATABASE_URL,
  options: `-c search_path=${env.SHARD_1_SCHEMA}`,
  max: 10,
  idleTimeoutMillis: 30000,
});

// Shard 2 connection pool
export const shard2Pool = new Pool({
  connectionString: env.APP_DATABASE_URL,
  options: `-c search_path=${env.SHARD_2_SCHEMA}`,
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

/**
 * Safely tests whether the database is accessible.
 * Returns true if connection succeeds, false otherwise (e.g. Docker container is offline).
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  let client: pg.PoolClient | null = null;
  try {
    client = await controlPool.connect();
    const result = await client.query('SELECT 1 AS ready');
    return result.rows[0]?.ready === 1;
  } catch (_err) {
    return false;
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Closes all connection pools. Useful during graceful shutdown and tests.
 */
export async function closeAllPools(): Promise<void> {
  await Promise.allSettled([
    controlPool.end(),
    shard1Pool.end(),
    shard2Pool.end(),
  ]);
}
