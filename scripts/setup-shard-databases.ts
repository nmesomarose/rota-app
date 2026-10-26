import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { env } from '../src/config/env.ts';

const adminUrl = env.DATABASE_URL;

async function setupShardDatabases() {
  console.log('[Shard DB Setup] Connecting to PostgreSQL with admin URL:', adminUrl);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();

  const shardDbs = ['rota_shard_1', 'rota_shard_2'];

  try {
    for (const dbName of shardDbs) {
      const checkRes = await client.query('SELECT 1 FROM pg_database WHERE datname = $1;', [dbName]);
      if (checkRes.rowCount === 0) {
        console.log(`[Shard DB Setup] Creating database: ${dbName}...`);
        await client.query(`CREATE DATABASE "${dbName}";`);
        console.log(`[Shard DB Setup] Database ${dbName} created successfully.`);
      } else {
        console.log(`[Shard DB Setup] Database ${dbName} already exists.`);
      }
    }
  } finally {
    await client.end();
  }

  // Configure role permissions and migrations on each shard database
  const parsedAdminUrl = new URL(adminUrl);
  const appUrl = new URL(env.APP_DATABASE_URL);
  const appUser = decodeURIComponent(appUrl.username || 'rota_app');
  const appPass = decodeURIComponent(appUrl.password || 'rota_dev_app_password');

  for (const dbName of shardDbs) {
    const dbAdminUrl = new URL(adminUrl);
    dbAdminUrl.pathname = `/${dbName}`;
    const dbUrlStr = dbAdminUrl.toString();

    console.log(`[Shard DB Setup] Connecting to ${dbName} to ensure role and schema permissions...`);
    const shardClient = new pg.Client({ connectionString: dbUrlStr });
    await shardClient.connect();

    try {
      // Ensure application role exists in this database cluster
      const roleCheck = await shardClient.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1;', [appUser]);
      if (roleCheck.rowCount === 0) {
        await shardClient.query(
          `CREATE ROLE "${appUser}" WITH LOGIN PASSWORD ${shardClient.escapeLiteral(appPass)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`
        );
      }

      // Grant permissions on public and shard schema
      await shardClient.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${appUser}";`);
      await shardClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${appUser}";`);
      await shardClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${appUser}";`);

      // Also ensure named schema exists for backward compatibility if searched
      await shardClient.query(`CREATE SCHEMA IF NOT EXISTS "${dbName}";`);
      await shardClient.query(`GRANT USAGE, CREATE ON SCHEMA "${dbName}" TO "${appUser}";`);
      await shardClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${dbName}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${appUser}";`);
      await shardClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${dbName}" GRANT USAGE, SELECT ON SEQUENCES TO "${appUser}";`);

      console.log(`[Shard DB Setup] Applying tenant migrations to ${dbName}...`);
      await (runner as unknown as (options: unknown) => Promise<unknown>)({
        databaseUrl: dbUrlStr,
        schema: 'public',
        migrationsTable: 'pgmigrations',
        dir: 'migrations/tenant',
        direction: 'up',
        verbose: true,
      });

      // Ensure grants on newly created tables
      await shardClient.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${appUser}";`);
      await shardClient.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${appUser}";`);
      console.log(`[Shard DB Setup] Tenant migrations and permissions applied to ${dbName}.`);
    } finally {
      await shardClient.end();
    }
  }

  console.log('[Shard DB Setup] All shard databases configured and migrated successfully.');
}

setupShardDatabases().catch((err) => {
  console.error('[Shard DB Setup Failed]', err);
  process.exit(1);
});
