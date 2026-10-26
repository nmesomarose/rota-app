/**
 * Migration: 006_create_user_settings
 * Schema: rota_control
 * Entities: user_settings
 * PRD Reference: 6.10 (FR-SET-001..005), 9.2 (Control plane entities), 12.3, 14.7 (AC-SET-01, AC-SET-02, AC-017)
 * Purpose: Cross-device persistent user settings with per-field updated_at tracking for conflict resolution.
 */

export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      time_zone VARCHAR(64) NOT NULL DEFAULT 'UTC',
      time_zone_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      quiet_hours_enabled BOOLEAN NOT NULL DEFAULT false,
      quiet_hours_start VARCHAR(5) NOT NULL DEFAULT '22:00',
      quiet_hours_end VARCHAR(5) NOT NULL DEFAULT '07:00',
      quiet_hours_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      language VARCHAR(10) NOT NULL DEFAULT 'en',
      language_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      theme VARCHAR(16) NOT NULL DEFAULT 'system',
      theme_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notification_categories JSONB NOT NULL DEFAULT '{"shifts": true, "swaps": true, "approvals": true, "attendance": true, "billing": true, "security": true}'::jsonb,
      notification_categories_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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
    DROP TABLE IF EXISTS user_settings CASCADE;
  `);
}
