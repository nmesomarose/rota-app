/**
 * Migration: 007_create_invitations
 * Schemas: rota_shard_1, rota_shard_2
 * Entities: invitations
 * PRD Reference: 4.3, 8.6, 9.3 (Tenant-plane entities), FR-AUTH-007, AC-INV-01..06
 * Security: Forced Row-Level Security (RLS) on all tenant tables,
 *           composite foreign keys enforcing same-business relationships,
 *           tenant isolation policy scoped to NULLIF(current_setting('app.current_business_id', true), '')::uuid
 */

export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS invitations (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      branch_id UUID,
      department_id UUID,
      invited_by_membership_id UUID NOT NULL,
      token_hash VARCHAR(255) NOT NULL UNIQUE,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_invitations_branch FOREIGN KEY (business_id, branch_id) REFERENCES branches(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_invitations_department FOREIGN KEY (business_id, department_id) REFERENCES departments(business_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_invitations_inviter FOREIGN KEY (business_id, invited_by_membership_id) REFERENCES memberships(business_id, id) ON DELETE CASCADE,
      CONSTRAINT chk_invitations_status CHECK (status IN ('pending', 'accepted', 'revoked', 'expired'))
    );

    CREATE INDEX IF NOT EXISTS idx_invitations_business ON invitations(business_id);
    CREATE INDEX IF NOT EXISTS idx_invitations_token_hash ON invitations(token_hash);
    CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(business_id, email);
    CREATE INDEX IF NOT EXISTS idx_invitations_pending ON invitations(business_id, status) WHERE status = 'pending';

    -- Enable and FORCE Row-Level Security
    ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS tenant_isolation_invitations ON invitations;
    CREATE POLICY tenant_isolation_invitations ON invitations
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    -- Privileges
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
    DROP TABLE IF EXISTS invitations CASCADE;
  `);
}
