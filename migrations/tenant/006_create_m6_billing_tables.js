/**
 * Migration: 006_create_m6_billing_tables
 * Schemas: rota_shard_1, rota_shard_2
 * Entities: subscriptions alterations, billing_quotes, payment_intents, ledger_entries
 * PRD Reference: 8.1..8.10, 9.3 (Tenant-plane entities), C-08, BR-010, AC-013, AC-BILL-01..12
 * Security: Forced Row-Level Security (RLS) on all tenant tables,
 *           composite foreign keys enforcing same-business relationships,
 *           immutable ledger trigger preventing UPDATE and DELETE on ledger_entries
 */

export async function up(pgm) {
  pgm.sql(`
    -- 1. Alter subscriptions table to support complete lifecycle
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS period_start_date DATE NOT NULL DEFAULT CURRENT_DATE;
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS period_end_date DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '30 days')::date;
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS anchor_day INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS scheduled_plan VARCHAR(50);
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS scheduled_seat_quantity INTEGER;
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_payment_at TIMESTAMPTZ;
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMPTZ;

    -- 2. billing_quotes table (PRD 8.3, 9.3, BILL-013, BILL-014, AC-FX-01)
    CREATE TABLE IF NOT EXISTS billing_quotes (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      currency VARCHAR(10) NOT NULL DEFAULT 'USD',
      amount_minor BIGINT NOT NULL,
      base_usd_amount_minor BIGINT NOT NULL,
      fx_rate NUMERIC(12, 4),
      fx_source VARCHAR(100),
      fx_retrieved_at TIMESTAMPTZ,
      subscription_version INTEGER NOT NULL,
      target_plan VARCHAR(50) NOT NULL,
      target_seat_quantity INTEGER NOT NULL,
      effective_local_date DATE NOT NULL,
      period_days INTEGER NOT NULL,
      remaining_days INTEGER NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'open',
      expires_at TIMESTAMPTZ NOT NULL,
      created_by UUID NOT NULL,
      confirmed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_billing_quotes_user FOREIGN KEY (business_id, created_by) REFERENCES memberships(business_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_billing_quotes_status CHECK (status IN ('open', 'confirmed', 'expired', 'stale'))
    );

    CREATE INDEX IF NOT EXISTS idx_billing_quotes_status ON billing_quotes(business_id, status);
    CREATE INDEX IF NOT EXISTS idx_billing_quotes_expires ON billing_quotes(business_id, expires_at);

    -- 3. payment_intents table (PRD 8.3, 9.3, BILL-014, BILL-022)
    CREATE TABLE IF NOT EXISTS payment_intents (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      quote_id UUID NOT NULL,
      provider VARCHAR(50) NOT NULL DEFAULT 'simulated',
      provider_reference VARCHAR(255) NOT NULL,
      amount_minor BIGINT NOT NULL,
      currency VARCHAR(10) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'awaiting_payment',
      idempotency_key VARCHAR(255) NOT NULL,
      request_hash VARCHAR(255),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_payment_intents_quote FOREIGN KEY (business_id, quote_id) REFERENCES billing_quotes(business_id, id) ON DELETE CASCADE,
      CONSTRAINT uq_payment_intents_idempotency UNIQUE (business_id, idempotency_key),
      CONSTRAINT uq_payment_intents_reference UNIQUE (business_id, provider_reference),
      CONSTRAINT chk_payment_intents_status CHECK (status IN ('awaiting_payment', 'succeeded', 'failed', 'expired'))
    );

    CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON payment_intents(business_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_intent ON payment_intents(business_id) WHERE status = 'awaiting_payment';

    -- 4. ledger_entries table (PRD 8.6, 9.3, C-08, BR-010, BILL-010, BILL-028, AC-013)
    CREATE TABLE IF NOT EXISTS ledger_entries (
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      seq BIGSERIAL,
      type VARCHAR(50) NOT NULL,
      amount_minor BIGINT NOT NULL,
      currency VARCHAR(10) NOT NULL,
      quote_id UUID,
      payment_intent_id UUID,
      provider_event_id VARCHAR(255),
      description TEXT NOT NULL,
      plan VARCHAR(50) NOT NULL,
      seat_quantity INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, id),
      CONSTRAINT fk_ledger_quote FOREIGN KEY (business_id, quote_id) REFERENCES billing_quotes(business_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_ledger_intent FOREIGN KEY (business_id, payment_intent_id) REFERENCES payment_intents(business_id, id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_seq ON ledger_entries(business_id, seq);
    CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger_entries(business_id, type);

    -- 5. Strict Ledger Immutability Trigger (AC-013, C-08, BR-010)
    CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Ledger entries are strictly append-only and cannot be updated or deleted (C-08, BR-010, AC-013)';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_immutable_ledger ON ledger_entries;
    CREATE TRIGGER trg_immutable_ledger
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW
    EXECUTE FUNCTION prevent_ledger_mutation();

    -- 6. Enable and FORCE Row-Level Security
    ALTER TABLE billing_quotes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE billing_quotes FORCE ROW LEVEL SECURITY;

    ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE payment_intents FORCE ROW LEVEL SECURITY;

    ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;

    -- 7. Tenant isolation policies for application role (rota_app)
    DROP POLICY IF EXISTS tenant_isolation_billing_quotes ON billing_quotes;
    CREATE POLICY tenant_isolation_billing_quotes ON billing_quotes
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_payment_intents ON payment_intents;
    CREATE POLICY tenant_isolation_payment_intents ON payment_intents
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_ledger_entries ON ledger_entries;
    CREATE POLICY tenant_isolation_ledger_entries ON ledger_entries
      FOR ALL
      TO rota_app
      USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
      WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

    -- 8. Grant schema, table, and sequence privileges to application role (rota_app)
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
    DROP TABLE IF EXISTS ledger_entries CASCADE;
    DROP TABLE IF EXISTS payment_intents CASCADE;
    DROP TABLE IF EXISTS billing_quotes CASCADE;
    ALTER TABLE subscriptions DROP COLUMN IF EXISTS past_due_since;
    ALTER TABLE subscriptions DROP COLUMN IF EXISTS last_payment_at;
    ALTER TABLE subscriptions DROP COLUMN IF EXISTS scheduled_seat_quantity;
    ALTER TABLE subscriptions DROP COLUMN IF EXISTS scheduled_plan;
    ALTER TABLE subscriptions DROP COLUMN IF EXISTS anchor_day;
    ALTER TABLE subscriptions DROP COLUMN IF EXISTS period_end_date;
    ALTER TABLE subscriptions DROP COLUMN IF EXISTS period_start_date;
  `);
}
