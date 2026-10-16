-- Verify Schemas
SELECT schema_name 
FROM information_schema.schemata 
WHERE schema_name IN ('rota_control', 'rota_shard_1', 'rota_shard_2')
ORDER BY schema_name;

-- Verify Role & RLS Bypass Privileges
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin 
FROM pg_catalog.pg_roles 
WHERE rolname IN ('postgres', 'rota_app')
ORDER BY rolname;

-- Verify Role Switching to rota_app
SET ROLE rota_app;
SELECT current_user AS effective_user, session_user;
RESET ROLE;

