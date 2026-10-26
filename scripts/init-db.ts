import pg from 'pg';
import { env } from '../src/config/env.ts';

async function initDb(): Promise<void> {
  console.log('[DB Init] Connecting with admin credentials to initialize database roles and schemas...');
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });

  const client = await pool.connect();
  try {
    // 1. Create Control Plane schema
    console.log(`[DB Init] Ensuring control schema '${env.CONTROL_SCHEMA}' exists...`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${client.escapeIdentifier(env.CONTROL_SCHEMA)};`);

    // 2. Create Logical Shards
    console.log(`[DB Init] Ensuring shard schemas '${env.SHARD_1_SCHEMA}' and '${env.SHARD_2_SCHEMA}' exist...`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${client.escapeIdentifier(env.SHARD_1_SCHEMA)};`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${client.escapeIdentifier(env.SHARD_2_SCHEMA)};`);

    // 3. Parse non-superuser app credentials from APP_DATABASE_URL
    const appUrl = new URL(env.APP_DATABASE_URL);
    const appUser = decodeURIComponent(appUrl.username || 'rota_app');
    const appPass = decodeURIComponent(appUrl.password || 'rota_dev_app_password');

    let adminUser = 'postgres';
    try {
      const adminUrl = new URL(env.DATABASE_URL);
      adminUser = decodeURIComponent(adminUrl.username || 'postgres');
    } catch {
      // safe fallback
    }

    if (appUser.toLowerCase() === adminUser.toLowerCase()) {
      console.log(`[DB Init] Admin user '${adminUser}' and application user '${appUser}' are identical. Skipping separate role creation.`);
    } else {
      try {
        console.log(`[DB Init] Ensuring application role '${appUser}' exists (NOSUPERUSER, NOBYPASSRLS)...`);
        const roleCheck = await client.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [appUser]);
        if (roleCheck.rowCount === 0) {
          await client.query(
            `CREATE ROLE ${client.escapeIdentifier(appUser)} WITH LOGIN PASSWORD ${client.escapeLiteral(appPass)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`
          );
        } else {
          await client.query(
            `ALTER ROLE ${client.escapeIdentifier(appUser)} WITH PASSWORD ${client.escapeLiteral(appPass)};`
          );
        }

        // 4. Grant schema usage and creation privileges to application role
        for (const schema of [env.CONTROL_SCHEMA, env.SHARD_1_SCHEMA, env.SHARD_2_SCHEMA]) {
          const escSchema = client.escapeIdentifier(schema);
          const escUser = client.escapeIdentifier(appUser);
          await client.query(`GRANT USAGE, CREATE ON SCHEMA ${escSchema} TO ${escUser};`);
          await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${escSchema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${escUser};`);
          await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${escSchema} GRANT USAGE, SELECT ON SEQUENCES TO ${escUser};`);
        }
      } catch (roleErr: any) {
        console.warn(`[DB Init Warning] Could not configure separate application role '${appUser}': ${roleErr.message}`);
        console.warn('[DB Init Warning] Continuing with schema initialization. Ensure APP_DATABASE_URL has appropriate schema access.');
      }
    }

    console.log('[DB Init] Database schemas and application role configured successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

initDb().catch((err: Error) => {
  console.error('[DB Init Error]', err.message);
  process.exit(1);
});
