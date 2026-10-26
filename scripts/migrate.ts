import { runner } from 'node-pg-migrate';
import { env } from '../src/config/env.ts';
import pg from 'pg';

const target = process.argv[2] || 'all';

async function isDatabaseReady(url: string): Promise<boolean> {
  const pool = new pg.Pool({
    connectionString: url,
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

async function ensureApplicationRolePermissions(databaseUrl: string, schemaName: string) {
  try {
    const appUrl = new URL(env.APP_DATABASE_URL);
    const appUser = decodeURIComponent(appUrl.username || 'rota_app');
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5000,
    });
    const client = await pool.connect();
    try {
      const escSchema = client.escapeIdentifier(schemaName);
      const escUser = client.escapeIdentifier(appUser);
      // Ensure application role has usage and DML permissions on newly migrated tables and sequences
      await client.query(`GRANT USAGE ON SCHEMA ${escSchema} TO ${escUser};`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${escSchema} TO ${escUser};`);
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${escSchema} TO ${escUser};`);
      console.log(`[Migrations] Preserved least-privilege permissions for non-superuser role '${appUser}' on '${schemaName}'.`);
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err: any) {
    console.warn(`[Migrations Warning] Could not ensure application role permissions for schema '${schemaName}': ${err.message}`);
  }
}

async function runDatabaseMigration(databaseUrl: string, schemaName: string, dir: string) {
  console.log(`[Migrations] Applying migrations from '${dir}' (schema '${schemaName}')...`);
  await (runner as unknown as (options: unknown) => Promise<unknown>)({
    databaseUrl,
    schema: schemaName,
    migrationsTable: 'pgmigrations',
    dir,
    direction: 'up',
    verbose: true,
  });
  await ensureApplicationRolePermissions(databaseUrl, schemaName);
  console.log(`[Migrations] Finished schema '${schemaName}'.`);
}

async function main() {
  console.log(`[Migrations] Target: ${target}`);

  const controlReady = await isDatabaseReady(env.DATABASE_URL);
  if (!controlReady) {
    console.warn(`[Migrations WARNING] Could not connect to PostgreSQL at ${env.DATABASE_URL}.`);
    console.warn('[Migrations WARNING] Ensure PostgreSQL is running and accessible.');
    process.exit(1);
  }

  // 1. Control Plane Migrations
  if (target === 'control' || target === 'all') {
    await runDatabaseMigration(env.DATABASE_URL, env.CONTROL_SCHEMA, 'migrations/control');
  }

  // 2. Separate Shard Databases Migrations (PRD 9.1, DR-04, Phase 2)
  if (target === 'shards' || target === 'all') {
    console.log('[Migrations] Applying migrations to dedicated shard databases...');
    
    // Dedicated Shard 1 Database (rota_shard_1)
    if (await isDatabaseReady(env.SHARD_1_DATABASE_URL)) {
      await runDatabaseMigration(env.SHARD_1_DATABASE_URL, 'public', 'migrations/tenant');
    }

    // Dedicated Shard 2 Database (rota_shard_2)
    if (await isDatabaseReady(env.SHARD_2_DATABASE_URL)) {
      await runDatabaseMigration(env.SHARD_2_DATABASE_URL, 'public', 'migrations/tenant');
    }

    // Also migrate single-db schemas for backward compatibility
    await runDatabaseMigration(env.DATABASE_URL, env.SHARD_1_SCHEMA, 'migrations/tenant');
    await runDatabaseMigration(env.DATABASE_URL, env.SHARD_2_SCHEMA, 'migrations/tenant');
  }

  console.log('[Migrations] All migration targets executed successfully.');
}

main().catch((err) => {
  console.error('[Migrations Error]', err.message);
  process.exit(1);
});
