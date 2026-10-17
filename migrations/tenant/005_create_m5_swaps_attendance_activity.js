/**
 * Migration: 005_create_m5_swaps_attendance_activity
 * Schemas: rota_shard_1, rota_shard_2
 * Entities: swap_requests, attendance_records, activity_events
 * PRD Reference: 6.6 (FR-SWP-001..007, BR-003, BR-004), 6.7 (FR-ATT-001..003),
 *                6.8 (FR-ACT-001..007, AC-014, AC-ACT-01..05), 9.3 (Tenant-plane entities)
 * Security: Forced Row-Level Security (RLS) on all tenant tables,
 *           composite foreign keys enforcing same-business relationships,
 *           tenant isolation policy scoped to NULLIF(current_setting('app.current_business_id', true), '')::uuid
 */

export async function up(pgm) {
  pgm.sql(`
    -- 1. swap_requests table
    CREATE TABLE IF NOT EXISTS swap_requests (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      branch_id UUID NOT NULL,
      department_id UUID NOT NULL,
      requester_membership_id UUID NOT NULL,
      requester_shift_id UUID NOT NULL,
      requester_shift_version INTEGER NOT NULL,
      counterpart_membership_id UUID NOT NULL,
      counterpart_shift_id UUID NOT NULL,
      counterpart_shift_version INTEGER NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      peer_responded_at TIMESTAMPTZ,
      approved_by UUID,
      approved_at TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_swap_branch FOREIGN KEY (business_id, branch_id) REFERENCES branches(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_swap_department FOREIGN KEY (business_id, department_id) REFERENCES departments(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_swap_requester_membership FOREIGN KEY (business_id, requester_membership_id) REFERENCES memberships(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_swap_requester_shift FOREIGN KEY (business_id, requester_shift_id) REFERENCES shifts(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_swap_counterpart_membership FOREIGN KEY (business_id, counterpart_membership_id) REFERENCES memberships(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_swap_counterpart_shift FOREIGN KEY (business_id, counterpart_shift_id) REFERENCES shifts(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_swap_approved_by FOREIGN KEY (business_id, approved_by) REFERENCES memberships(business_id, id) ON DELETE SET NULL,
      CONSTRAINT chk_swap_status CHECK (status IN ('pending', 'peer_accepted', 'peer_rejected', 'approved', 'cancelled', 'stale')),
      CONSTRAINT chk_swap_memberships CHECK (requester_membership_id <> counterpart_membership_id),
      CONSTRAINT chk_swap_shifts CHECK (requester_shift_id <> counterpart_shift_id)
    );

    CREATE INDEX IF NOT EXISTS idx_swap_req_requester ON swap_requests(business_id, requester_membership_id);
    CREATE INDEX IF NOT EXISTS idx_swap_req_counterpart ON swap_requests(business_id, counterpart_membership_id);
    CREATE INDEX IF NOT EXISTS idx_swap_req_status ON swap_requests(business_id, status);
    CREATE INDEX IF NOT EXISTS idx_swap_req_dept ON swap_requests(business_id, department_id);

    -- 2. attendance_records table
    CREATE TABLE IF NOT EXISTS attendance_records (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      shift_id UUID NOT NULL,
      shift_assignment_id UUID NOT NULL,
      membership_id UUID NOT NULL,
      department_id UUID NOT NULL,
      state VARCHAR(20) NOT NULL,
      recorded_by UUID NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_attendance_shift FOREIGN KEY (business_id, shift_id) REFERENCES shifts(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_attendance_assignment FOREIGN KEY (business_id, shift_assignment_id) REFERENCES shift_assignments(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_attendance_membership FOREIGN KEY (business_id, membership_id) REFERENCES memberships(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_attendance_department FOREIGN KEY (business_id, department_id) REFERENCES departments(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_attendance_recorded_by FOREIGN KEY (business_id, recorded_by) REFERENCES memberships(business_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_attendance_state CHECK (state IN ('present', 'late', 'absent')),
      CONSTRAINT uq_attendance_assignment UNIQUE (business_id, shift_assignment_id)
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_shift ON attendance_records(business_id, shift_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_membership ON attendance_records(business_id, membership_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_attendance_department ON attendance_records(business_id, department_id, recorded_at);

    -- 3. activity_events table
    CREATE TABLE IF NOT EXISTS activity_events (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      type VARCHAR(100) NOT NULL,
      branch_id UUID,
      department_id UUID,
      actor_membership_id UUID,
      subject_membership_id UUID,
      visibility_class VARCHAR(50) NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_activity_branch FOREIGN KEY (business_id, branch_id) REFERENCES branches(business_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_activity_department FOREIGN KEY (business_id, department_id) REFERENCES departments(business_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_activity_actor FOREIGN KEY (business_id, actor_membership_id) REFERENCES memberships(business_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_activity_subject FOREIGN KEY (business_id, subject_membership_id) REFERENCES memberships(business_id, id) ON DELETE SET NULL,
      CONSTRAINT chk_activity_visibility CHECK (visibility_class IN ('schedule', 'swap', 'attendance', 'membership', 'override', 'billing', 'security', 'public'))
    );

    CREATE INDEX IF NOT EXISTS idx_activity_events_feed ON activity_events(business_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_events_dept ON activity_events(business_id, department_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_events_subject ON activity_events(business_id, subject_membership_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_events_actor ON activity_events(business_id, actor_membership_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_events_vis ON activity_events(business_id, visibility_class, created_at DESC, id DESC);

    -- 4. Enable and FORCE Row-Level Security on all newly created tables
    ALTER TABLE swap_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE swap_requests FORCE ROW LEVEL SECURITY;

    ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
    ALTER TABLE attendance_records FORCE ROW LEVEL SECURITY;

    ALTER TABLE activity_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE activity_events FORCE ROW LEVEL SECURITY;

    -- 5. Tenant isolation policies for application role (rota_app)
    DROP POLICY IF EXISTS tenant_isolation_swap_requests ON swap_requests;
    CREATE POLICY tenant_isolation_swap_requests ON swap_requests
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_attendance_records ON attendance_records;
    CREATE POLICY tenant_isolation_attendance_records ON attendance_records
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_activity_events ON activity_events;
    CREATE POLICY tenant_isolation_activity_events ON activity_events
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    -- 6. Grant schema and table privileges to application role (rota_app)
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
    DROP TABLE IF EXISTS activity_events CASCADE;
    DROP TABLE IF EXISTS attendance_records CASCADE;
    DROP TABLE IF EXISTS swap_requests CASCADE;
  `);
}
