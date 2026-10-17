/**
 * Migration: 003_create_m4_push_tokens
 * Schema: rota_control
 * Entities: push_tokens
 * PRD Reference: 9.2 (Control-plane entities), FR-NOT-002, AC-NOT-09, C-10
 */

export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id VARCHAR(255) NOT NULL,
      token VARCHAR(255) NOT NULL UNIQUE,
      platform VARCHAR(50) NOT NULL DEFAULT 'expo',
      invalidated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_push_tokens_device ON push_tokens(device_id);

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
    DROP TABLE IF EXISTS push_tokens CASCADE;
  `);
}
