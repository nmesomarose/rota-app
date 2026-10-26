/**
 * Migration: 005_create_password_reset_tokens
 * Schema: rota_control
 * Entities: password_reset_tokens
 * PRD Reference: 8.6, 9.2 (Control-plane entities)
 * Security: Cryptographically secure single-use expiring password reset tokens
 */

export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(255) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expiry ON password_reset_tokens(expires_at) WHERE used_at IS NULL;

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
    DROP TABLE IF EXISTS password_reset_tokens CASCADE;
  `);
}
