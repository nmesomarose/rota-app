/**
 * Migration: 004_create_m4_notifications
 * Schemas: rota_shard_1, rota_shard_2
 * Entities: notification_deliveries, inbox_items
 * PRD Reference: 9.3 (Tenant-plane entities), FR-NOT-009, FR-NOT-010, FR-NOT-014, AC-006, AC-NOT-01..09
 * Security: Forced Row-Level Security (RLS) on all tenant tables,
 *           composite foreign keys enforcing same-business relationships,
 *           tenant isolation policy scoped to NULLIF(current_setting('app.current_business_id', true), '')::uuid
 */

export async function up(pgm) {
  pgm.sql(`
    -- 1. notification_deliveries table
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      event_id VARCHAR(255) NOT NULL,
      recipient_user_id UUID NOT NULL,
      device_id VARCHAR(255),
      channel VARCHAR(50) NOT NULL DEFAULT 'push',
      dedupe_key VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      ticket_id VARCHAR(255),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT unq_notification_dedupe UNIQUE (business_id, dedupe_key)
    );

    CREATE INDEX IF NOT EXISTS idx_notif_deliveries_recipient ON notification_deliveries(business_id, recipient_user_id);
    CREATE INDEX IF NOT EXISTS idx_notif_deliveries_status ON notification_deliveries(business_id, status);

    -- 2. inbox_items table (in-app notification fallback per PRD 9.3, FR-NOT-014)
    CREATE TABLE IF NOT EXISTS inbox_items (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      recipient_membership_id UUID NOT NULL,
      recipient_user_id UUID NOT NULL,
      category VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      payload JSONB DEFAULT '{}'::jsonb,
      mandatory BOOLEAN NOT NULL DEFAULT false,
      urgent BOOLEAN NOT NULL DEFAULT false,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_inbox_membership FOREIGN KEY (business_id, recipient_membership_id) REFERENCES memberships(business_id, id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_inbox_items_recipient ON inbox_items(business_id, recipient_membership_id, read_at);
    CREATE INDEX IF NOT EXISTS idx_inbox_items_user ON inbox_items(business_id, recipient_user_id);

    -- 3. Row-Level Security (RLS) enforcement
    ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;

    CREATE POLICY tenant_isolation_notification_deliveries ON notification_deliveries
      FOR ALL
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    ALTER TABLE inbox_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE inbox_items FORCE ROW LEVEL SECURITY;

    CREATE POLICY tenant_isolation_inbox_items ON inbox_items
      FOR ALL
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    -- 4. Grant permissions to application role (rota_app)
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
    DROP TABLE IF EXISTS inbox_items CASCADE;
    DROP TABLE IF EXISTS notification_deliveries CASCADE;
  `);
}
