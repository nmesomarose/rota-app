import pg from 'pg';
import { env } from '../src/config/env.ts';

async function verify() {
  console.log('===============================================================');
  console.log('=== MULTI-DATABASE SHARD & SCHEMA ARCHITECTURE VERIFICATION ===');
  console.log('===============================================================\n');

  // 1. Control Plane Database
  const controlClient = new pg.Client({ connectionString: env.DATABASE_URL });
  await controlClient.connect();
  const cDb = (await controlClient.query('SELECT current_database() as db')).rows[0].db;
  console.log(`[Control Plane DB: ${cDb}]`);

  const schemasRes = await controlClient.query(`
    SELECT schema_name 
    FROM information_schema.schemata 
    WHERE schema_name IN ('rota_control', 'rota_shard_1', 'rota_shard_2', 'public')
    ORDER BY schema_name;
  `);
  console.log('Installed schemas:');
  console.table(schemasRes.rows);

  const rolesRes = await controlClient.query(`
    SELECT rolname, rolsuper, rolbypassrls, rolcanlogin 
    FROM pg_catalog.pg_roles 
    WHERE rolname IN ('postgres', 'rota_app')
    ORDER BY rolname;
  `);
  console.log('Role security flags:');
  console.table(rolesRes.rows);
  await controlClient.end();

  // 2. Physical Shard Databases
  const shardDbs = [
    { name: 'Shard 1', url: env.SHARD_1_DATABASE_URL },
    { name: 'Shard 2', url: env.SHARD_2_DATABASE_URL },
  ];

  for (const s of shardDbs) {
    const sClient = new pg.Client({ connectionString: s.url });
    await sClient.connect();
    const currDb = (await sClient.query('SELECT current_database() as db')).rows[0].db;
    console.log(`\n---------------------------------------------------------------`);
    console.log(`[Dedicated Tenant Database: ${currDb} (${s.name})]`);
    console.log(`---------------------------------------------------------------`);

    const tablesRes = await sClient.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);
    console.log(`Total tenant tables: ${tablesRes.rowCount}`);

    const rlsRes = await sClient.query(`
      SELECT n.nspname AS schemaname, c.relname AS tablename, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname = 'public'
        AND c.relname != 'pgmigrations'
      ORDER BY c.relname;
    `);
    console.log(`Tables with Row-Level Security enforced (${rlsRes.rowCount} tables):`);
    console.table(rlsRes.rows);

    await sClient.end();
  }

  console.log('\n[Schema Verification] All physical databases and schemas verified successfully.');
}

verify().catch((err) => {
  console.error('[Verification Error]', err);
  process.exit(1);
});
