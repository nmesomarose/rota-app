/**
 * Migration: 003_create_m3_scheduling_tables
 * Schemas: rota_shard_1, rota_shard_2
 * Entities: shifts, shift_assignments, staffing_requirements, availability_entries, audit_log
 * Security: Forced Row-Level Security (RLS) on all tenant tables,
 *           composite foreign keys enforcing same-business relationships,
 *           tenant isolation policy scoped to NULLIF(current_setting('app.current_business_id', true), '')::uuid
 */

export async function up(pgm) {
  pgm.sql(`
    -- 1. Shifts table
    CREATE TABLE IF NOT EXISTS shifts (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      branch_id UUID NOT NULL,
      department_id UUID NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      time_zone VARCHAR(64) NOT NULL DEFAULT 'UTC',
      status VARCHAR(50) NOT NULL DEFAULT 'draft',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_shifts_branch FOREIGN KEY (business_id, branch_id) REFERENCES branches(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_shifts_department FOREIGN KEY (business_id, department_id) REFERENCES departments(business_id, id) ON DELETE CASCADE,
      CONSTRAINT chk_shifts_duration CHECK (ends_at > starts_at),
      CONSTRAINT chk_shifts_status CHECK (status IN ('draft', 'review', 'published', 'cancelled'))
    );

    CREATE INDEX IF NOT EXISTS idx_shifts_dept_starts ON shifts(business_id, department_id, starts_at);
    CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(business_id, status);

    -- 2. Staffing requirements table
    CREATE TABLE IF NOT EXISTS staffing_requirements (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      branch_id UUID NOT NULL,
      department_id UUID NOT NULL,
      role_label VARCHAR(64) NOT NULL DEFAULT 'Staff',
      headcount INTEGER NOT NULL DEFAULT 1,
      local_start VARCHAR(5) NOT NULL,
      local_end VARCHAR(5) NOT NULL,
      weekdays INTEGER[] NOT NULL,
      time_zone VARCHAR(64) NOT NULL DEFAULT 'UTC',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_staffing_requirements_branch FOREIGN KEY (business_id, branch_id) REFERENCES branches(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_staffing_requirements_dept FOREIGN KEY (business_id, department_id) REFERENCES departments(business_id, id) ON DELETE CASCADE,
      CONSTRAINT chk_staffing_headcount CHECK (headcount > 0)
    );

    CREATE INDEX IF NOT EXISTS idx_staffing_req_dept ON staffing_requirements(business_id, department_id);

    -- 3. Shift assignments table
    CREATE TABLE IF NOT EXISTS shift_assignments (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      shift_id UUID NOT NULL,
      membership_id UUID NOT NULL,
      override_reason TEXT,
      override_by UUID,
      override_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_assignments_shift FOREIGN KEY (business_id, shift_id) REFERENCES shifts(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_assignments_membership FOREIGN KEY (business_id, membership_id) REFERENCES memberships(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_assignments_override_by FOREIGN KEY (business_id, override_by) REFERENCES memberships(business_id, id) ON DELETE SET NULL,
      CONSTRAINT uq_shift_assignment UNIQUE (business_id, shift_id, membership_id)
    );

    CREATE INDEX IF NOT EXISTS idx_assignments_member ON shift_assignments(business_id, membership_id);
    CREATE INDEX IF NOT EXISTS idx_assignments_shift ON shift_assignments(business_id, shift_id);

    -- 4. Availability entries table
    CREATE TABLE IF NOT EXISTS availability_entries (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      membership_id UUID NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time VARCHAR(5) NOT NULL,
      end_time VARCHAR(5) NOT NULL,
      preference VARCHAR(50) NOT NULL DEFAULT 'available',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_availability_membership FOREIGN KEY (business_id, membership_id) REFERENCES memberships(business_id, id) ON DELETE CASCADE,
      CONSTRAINT chk_availability_day CHECK (day_of_week BETWEEN 0 AND 6),
      CONSTRAINT chk_availability_pref CHECK (preference IN ('available', 'unavailable', 'preferred'))
    );

    CREATE INDEX IF NOT EXISTS idx_availability_member ON availability_entries(business_id, membership_id);

    -- 5. Audit log table (per FR-RBAC-004)
    CREATE TABLE IF NOT EXISTS audit_log (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      actor_membership_id UUID,
      action VARCHAR(100) NOT NULL,
      outcome VARCHAR(50) NOT NULL DEFAULT 'allowed',
      request_id VARCHAR(255) NOT NULL,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_audit_log_actor FOREIGN KEY (business_id, actor_membership_id) REFERENCES memberships(business_id, id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(business_id, action, created_at);

    -- 6. Enable and FORCE Row-Level Security on all newly created tables
    ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE shifts FORCE ROW LEVEL SECURITY;

    ALTER TABLE staffing_requirements ENABLE ROW LEVEL SECURITY;
    ALTER TABLE staffing_requirements FORCE ROW LEVEL SECURITY;

    ALTER TABLE shift_assignments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE shift_assignments FORCE ROW LEVEL SECURITY;

    ALTER TABLE availability_entries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE availability_entries FORCE ROW LEVEL SECURITY;

    ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

    -- 7. Tenant isolation policies for application role (rota_app)
    DROP POLICY IF EXISTS tenant_isolation_shifts ON shifts;
    CREATE POLICY tenant_isolation_shifts ON shifts
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_staffing_requirements ON staffing_requirements;
    CREATE POLICY tenant_isolation_staffing_requirements ON staffing_requirements
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_shift_assignments ON shift_assignments;
    CREATE POLICY tenant_isolation_shift_assignments ON shift_assignments
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_availability_entries ON availability_entries;
    CREATE POLICY tenant_isolation_availability_entries ON availability_entries
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_audit_log ON audit_log;
    CREATE POLICY tenant_isolation_audit_log ON audit_log
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    -- 8. Grant schema and table privileges to application role (rota_app)
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
    DROP TABLE IF EXISTS audit_log CASCADE;
    DROP TABLE IF EXISTS availability_entries CASCADE;
    DROP TABLE IF EXISTS shift_assignments CASCADE;
    DROP TABLE IF EXISTS staffing_requirements CASCADE;
    DROP TABLE IF EXISTS shifts CASCADE;
  `);
}
