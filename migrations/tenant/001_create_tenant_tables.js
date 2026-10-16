/**
 * Migration: 001_create_tenant_tables
 * Schemas: rota_shard_1, rota_shard_2
 * Entities: businesses, branches, departments, memberships
 * Security: Forced Row-Level Security (RLS) on all tenant tables,
 *           composite foreign keys enforcing same-business relationships,
 *           tenant isolation policy scoped to NULLIF(current_setting('app.current_business_id', true), '')::uuid
 */

export async function up(pgm) {
  pgm.sql(`
    -- 1. Businesses table
    CREATE TABLE IF NOT EXISTS businesses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- 2. Branches table (Composite Primary Key: business_id, id)
    CREATE TABLE IF NOT EXISTS branches (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id)
    );

    -- 3. Departments table (Composite Primary Key + Composite FK referencing branches)
    CREATE TABLE IF NOT EXISTS departments (
      business_id UUID NOT NULL,
      branch_id UUID NOT NULL,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_departments_branch FOREIGN KEY (business_id, branch_id) REFERENCES branches(business_id, id) ON DELETE CASCADE,
      CONSTRAINT uq_departments_branch_name UNIQUE (business_id, branch_id, name)
    );

    -- 4. Memberships table (Composite Primary Key + Composite FKs referencing branches and departments)
    CREATE TABLE IF NOT EXISTS memberships (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      role VARCHAR(50) NOT NULL,
      branch_id UUID,
      department_id UUID,
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_memberships_branch FOREIGN KEY (business_id, branch_id) REFERENCES branches(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_memberships_department FOREIGN KEY (business_id, department_id) REFERENCES departments(business_id, id) ON DELETE CASCADE,
      CONSTRAINT uq_memberships_user_business UNIQUE (business_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

    -- 5. Enable and FORCE Row-Level Security on all tenant tables
    ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
    ALTER TABLE businesses FORCE ROW LEVEL SECURITY;

    ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
    ALTER TABLE branches FORCE ROW LEVEL SECURITY;

    ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE departments FORCE ROW LEVEL SECURITY;

    ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
    ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

    -- 6. Tenant isolation policies for application role (rota_app)
    DROP POLICY IF EXISTS tenant_isolation_businesses ON businesses;
    CREATE POLICY tenant_isolation_businesses ON businesses
      FOR ALL
      TO rota_app
      USING (id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_branches ON branches;
    CREATE POLICY tenant_isolation_branches ON branches
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_departments ON departments;
    CREATE POLICY tenant_isolation_departments ON departments
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_memberships ON memberships;
    CREATE POLICY tenant_isolation_memberships ON memberships
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    -- 7. Grant schema and table privileges to application role (rota_app)
    DO $$
    DECLARE
      s text := current_schema();
    BEGIN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO rota_app', s);
      EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO rota_app', s);
    END
    $$;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS memberships CASCADE;
    DROP TABLE IF EXISTS departments CASCADE;
    DROP TABLE IF EXISTS branches CASCADE;
    DROP TABLE IF EXISTS businesses CASCADE;
  `);
}
