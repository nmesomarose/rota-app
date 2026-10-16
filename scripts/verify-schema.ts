import pg from 'pg';
import { env } from '../src/config/env.ts';

async function verify() {
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  console.log('=== 1. SCHEMAS ===');
  const schemasRes = await client.query(`
    SELECT schema_name 
    FROM information_schema.schemata 
    WHERE schema_name IN ('rota_control', 'rota_shard_1', 'rota_shard_2')
    ORDER BY schema_name;
  `);
  console.table(schemasRes.rows);

  console.log('=== 2. ROLES & RLS BYPASS ===');
  const rolesRes = await client.query(`
    SELECT rolname, rolsuper, rolbypassrls, rolcanlogin 
    FROM pg_catalog.pg_roles 
    WHERE rolname IN ('postgres', 'rota_app')
    ORDER BY rolname;
  `);
  console.table(rolesRes.rows);

  console.log('=== 3. BASE TABLES ===');
  const tablesRes = await client.query(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema IN ('rota_control', 'rota_shard_1', 'rota_shard_2')
      AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name;
  `);
  console.table(tablesRes.rows);

  console.log('=== 4. ROW LEVEL SECURITY ENFORCEMENT ===');
  const rlsRes = await client.query(`
    SELECT n.nspname AS schemaname, c.relname AS tablename, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname IN ('rota_shard_1', 'rota_shard_2')
      AND c.relname != 'pgmigrations'
    ORDER BY n.nspname, c.relname;
  `);
  console.table(rlsRes.rows);

  console.log('=== 5. RLS POLICIES ===');
  const policiesRes = await client.query(`
    SELECT schemaname, tablename, policyname, roles, cmd, qual
    FROM pg_policies
    WHERE schemaname IN ('rota_shard_1', 'rota_shard_2')
    ORDER BY schemaname, tablename;
  `);
  console.table(policiesRes.rows);

  console.log('=== 6. FOREIGN KEY CONSTRAINTS ===');
  const fkRes = await client.query(`
    SELECT
      tc.table_schema,
      tc.table_name,
      tc.constraint_name,
      ccu.table_name AS foreign_table_name
    FROM 
      information_schema.table_constraints AS tc 
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema IN ('rota_shard_1', 'rota_shard_2', 'rota_control')
    ORDER BY tc.table_schema, tc.table_name, tc.constraint_name;
  `);
  console.table(fkRes.rows);

  await client.end();
}

verify().catch((err) => {
  console.error('[Verification Error]', err);
  process.exit(1);
});
