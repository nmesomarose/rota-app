-- Rota Database Verification Script
-- Verifies schemas, roles, tables, RLS enforcement, and policies across shards

-- 1. Verify Schemas
SELECT schema_name 
FROM information_schema.schemata 
WHERE schema_name IN ('rota_control', 'rota_shard_1', 'rota_shard_2')
ORDER BY schema_name;

-- 2. Verify Role & RLS Bypass Privileges
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin 
FROM pg_catalog.pg_roles 
WHERE rolname IN ('postgres', 'rota_app')
ORDER BY rolname;

-- 3. Verify Tables per Schema
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema IN ('rota_control', 'rota_shard_1', 'rota_shard_2')
  AND table_type = 'BASE TABLE'
ORDER BY table_schema, table_name;

-- 4. Verify RLS and FORCE RLS status on tenant tables
SELECT schemaname, tablename, rowsecurity, forcerowsecurity
FROM pg_tables
WHERE schemaname IN ('rota_shard_1', 'rota_shard_2')
  AND tablename != 'pgmigrations'
ORDER BY schemaname, tablename;

-- 5. Verify RLS Policies
SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname IN ('rota_shard_1', 'rota_shard_2')
ORDER BY schemaname, tablename;

-- 6. Verify Foreign Key Constraints
SELECT
    tc.table_schema,
    tc.table_name,
    tc.constraint_name,
    ccu.table_schema AS foreign_table_schema,
    ccu.table_name AS foreign_table_name
FROM 
    information_schema.table_constraints AS tc 
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema IN ('rota_shard_1', 'rota_shard_2', 'rota_control')
ORDER BY tc.table_schema, tc.table_name, tc.constraint_name;
