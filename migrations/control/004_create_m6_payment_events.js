/**
 * Migration: 004_create_m6_payment_events
 * Schema: rota_control
 * Entities: payment_events
 * PRD Reference: 8.6 (BILL-006, BILL-007, AC-010), 9.2 (Control-plane entities)
 */

export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS payment_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider VARCHAR(50) NOT NULL,
      provider_event_id VARCHAR(255) NOT NULL,
      payload JSONB NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'received',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      CONSTRAINT uq_payment_events_provider_event UNIQUE (provider, provider_event_id),
      CONSTRAINT chk_payment_events_status CHECK (status IN ('received', 'processed', 'ignored_duplicate', 'rejected_mismatch'))
    );

    CREATE INDEX IF NOT EXISTS idx_payment_events_status ON payment_events(status);
    CREATE INDEX IF NOT EXISTS idx_payment_events_provider_event ON payment_events(provider, provider_event_id);

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
    DROP TABLE IF EXISTS payment_events CASCADE;
  `);
}
