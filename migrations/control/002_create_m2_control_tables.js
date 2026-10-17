/**
 * Migration: 002_create_m2_control_tables
 * Schema: rota_control
 * Entities: refresh_tokens, membership_directory, users alterations, sessions alterations
 */

export async function up(pgm) {
  pgm.sql(`
    -- 1. Alter users table to support status, name, and email verification
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'active';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

    -- 2. Alter sessions table to support device_id and revoked_reason
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_id VARCHAR(255);
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_reason VARCHAR(255);

    -- 3. refresh_tokens table (per PRD 9.2, DR-05)
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      family_id UUID NOT NULL,
      token_hash VARCHAR(255) NOT NULL UNIQUE,
      parent_id UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      replaced_by UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session ON refresh_tokens(session_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

    -- 4. membership_directory table (control-plane read-copy per PRD 9.2, D-01, AC-TEN-07)
    CREATE TABLE IF NOT EXISTS membership_directory (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_id UUID NOT NULL,
      business_name VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, business_id)
    );

    CREATE INDEX IF NOT EXISTS idx_membership_dir_user ON membership_directory(user_id);
    CREATE INDEX IF NOT EXISTS idx_membership_dir_business ON membership_directory(business_id);

    -- 5. Grant permissions to application role (rota_app)
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
    DROP TABLE IF EXISTS membership_directory CASCADE;
    DROP TABLE IF EXISTS refresh_tokens CASCADE;
    ALTER TABLE sessions DROP COLUMN IF EXISTS revoked_reason;
    ALTER TABLE sessions DROP COLUMN IF EXISTS device_id;
    ALTER TABLE users DROP COLUMN IF EXISTS email_verified_at;
    ALTER TABLE users DROP COLUMN IF EXISTS status;
    ALTER TABLE users DROP COLUMN IF EXISTS name;
  `);
}
