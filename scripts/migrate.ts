import { runner } from 'node-pg-migrate';
import { env } from '../src/config/env.ts';
import pg from 'pg';

const target = process.argv[2] || 'all';

async function isDatabaseReady(): Promise<boolean> {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 2000,
  });
  try {
    const client = await pool.connect();
    client.release();
    await pool.end();
    return true;
  } catch {
    await pool.end();
    return false;
  }
}

async function runSchemaMigration(schemaName: string, dir: string) {
  console.log(`[Migrations] Applying migrations for schema '${schemaName}' from '${dir}'...`);
  await (runner as unknown as (options: unknown) => Promise<unknown>)({
    databaseUrl: env.DATABASE_URL,
    schema: schemaName,
    migrationsTable: 'pgmigrations',
    dir,
    direction: 'up',
    verbose: true,
  });
  console.log(`[Migrations] Finished schema '${schemaName}'.`);
}

async function main() {
  console.log(`[Migrations] Target: ${target}`);

  const ready = await isDatabaseReady();
  if (!ready) {
    console.warn(`[Migrations WARNING] Could not connect to PostgreSQL at ${env.DATABASE_URL}.`);
    console.warn('[Migrations WARNING] Ensure Docker Desktop is running and execute: docker compose up -d');
    process.exit(1);
  }

  if (target === 'control' || target === 'all') {
    await runSchemaMigration(env.CONTROL_SCHEMA, 'migrations/control');
  }

  if (target === 'shards' || target === 'all') {
    await runSchemaMigration(env.SHARD_1_SCHEMA, 'migrations/tenant');
    await runSchemaMigration(env.SHARD_2_SCHEMA, 'migrations/tenant');
  }

  console.log('[Migrations] All migration targets executed successfully.');
}

main().catch((err) => {
  console.error('[Migrations Error]', err.message);
  process.exit(1);
});
