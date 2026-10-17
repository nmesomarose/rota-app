/**
 * Migration: 002_create_m2_tenant_tables
 * Schemas: rota_shard_1, rota_shard_2
 * Entities: subscriptions, membership_outbox
 * Security: Forced Row-Level Security (RLS) on all tenant tables,
 *           tenant isolation policy scoped to NULLIF(current_setting('app.current_business_id', true), '')::uuid
 */

export async function up(pgm) {
  pgm.sql(`
    -- 1. Subscriptions table (per PRD 9.3, D-09, D-20)
    CREATE TABLE IF NOT EXISTS subscriptions (
      business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
      plan VARCHAR(50) NOT NULL DEFAULT 'starter',
      billing_currency VARCHAR(10) NOT NULL DEFAULT 'USD',
      seat_quantity INTEGER NOT NULL DEFAULT 5,
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- 2. Membership outbox table (for directory sync per PRD 9.1, DR-03, AC-TEN-07)
    CREATE TABLE IF NOT EXISTS membership_outbox (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      business_name VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      action VARCHAR(50) NOT NULL DEFAULT 'upsert',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      PRIMARY KEY (business_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_unprocessed ON membership_outbox(business_id, processed_at) WHERE processed_at IS NULL;

    -- 3. Enable and FORCE Row-Level Security on tenant tables
    ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;

    ALTER TABLE membership_outbox ENABLE ROW LEVEL SECURITY;
    ALTER TABLE membership_outbox FORCE ROW LEVEL SECURITY;

    -- 4. Tenant isolation policies for application role (rota_app)
    DROP POLICY IF EXISTS tenant_isolation_subscriptions ON subscriptions;
    CREATE POLICY tenant_isolation_subscriptions ON subscriptions
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_membership_outbox ON membership_outbox;
    CREATE POLICY tenant_isolation_membership_outbox ON membership_outbox
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    -- 5. Grant schema and table privileges to application role (rota_app)
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
    DROP TABLE IF EXISTS membership_outbox CASCADE;
    DROP TABLE IF EXISTS subscriptions CASCADE;
  `);
}
