/**
 * Migration: 007_google_oauth_support
 * Schema: rota_control
 * Entities: users alteration for Google OAuth (FR-AUTH-002, FR-AUTH-011)
 */

export async function up(pgm) {
  pgm.sql(`
    -- 1. Allow password_hash to be NULL for Google-only users (PRD 517)
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

    -- 2. Add google_id and auth_provider columns
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(50) NOT NULL DEFAULT 'local';

    CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

    -- 3. Grant permissions to application role (rota_app)
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
    DROP INDEX IF EXISTS idx_users_google_id;
    ALTER TABLE users DROP COLUMN IF EXISTS auth_provider;
    ALTER TABLE users DROP COLUMN IF EXISTS google_id;
  `);
}
