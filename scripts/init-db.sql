-- Rota Database Initialization Script
-- Establishes Control Plane and Two Logical Shards with non-superuser app role

-- 1. Create Control Plane schema
CREATE SCHEMA IF NOT EXISTS rota_control;

-- 2. Create Two Simulated Tenant Shards
CREATE SCHEMA IF NOT EXISTS rota_shard_1;
CREATE SCHEMA IF NOT EXISTS rota_shard_2;

-- 3. Create Application Role (strictly NOSUPERUSER and NOBYPASSRLS for SEC-011 / C-03)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'rota_app') THEN
    CREATE ROLE rota_app WITH LOGIN PASSWORD 'rota_dev_app_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- 4. Grant schema usage and creation privileges to application role
GRANT USAGE, CREATE ON SCHEMA rota_control TO rota_app;
GRANT USAGE, CREATE ON SCHEMA rota_shard_1 TO rota_app;
GRANT USAGE, CREATE ON SCHEMA rota_shard_2 TO rota_app;

-- 5. Set default table permissions for application role
ALTER DEFAULT PRIVILEGES IN SCHEMA rota_control GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rota_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA rota_shard_1 GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rota_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA rota_shard_2 GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rota_app;

-- 6. Grant sequence privileges
ALTER DEFAULT PRIVILEGES IN SCHEMA rota_control GRANT USAGE, SELECT ON SEQUENCES TO rota_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA rota_shard_1 GRANT USAGE, SELECT ON SEQUENCES TO rota_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA rota_shard_2 GRANT USAGE, SELECT ON SEQUENCES TO rota_app;
