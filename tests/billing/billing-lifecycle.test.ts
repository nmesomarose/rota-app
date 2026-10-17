import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';
import {
  setFxFixtureState,
  resetFxFixtureState,
} from '../../src/services/fx-service.ts';
import {
  generateSimulatedWebhook,
  computeWebhookSignature,
} from '../../src/services/payment-provider.ts';
import { reconstructSubscriptionFromLedger } from '../../src/services/billing-service.ts';

describe('Milestone M6: End-to-End Billing Lifecycle, Webhooks, Ledger Immutability & Restricted Mode', () => {
  let server: Server;
  let baseUrl: string;

  let ownerToken: string;
  let staffToken: string;
  let businessId: string;
  let branchId: string;

  let biz2Token: string;
  let biz2Id: string;

  before(async () => {
    resetFxFixtureState();
    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Register Owner for Business 1
    const ownerEmail = `m6_owner_${Date.now()}@example.com`;
    const regOwnerRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: 'Password123!', name: 'Billing Owner' }),
    });
    const regOwnerData = (await regOwnerRes.json()) as any;
    ownerToken = regOwnerData.tokens.accessToken;

    const onboardRes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        name: 'M6 Billing Enterprise',
        timezone: 'UTC',
        branchName: 'Main Store',
        departments: ['Checkout', 'Inventory'],
      }),
    });
    const onboardData = (await onboardRes.json()) as any;
    businessId = onboardData.business.id;
    branchId = onboardData.branch.id;
    ownerToken = onboardData.tokens.accessToken;

    // 2. Register Staff member for Business 1
    const staffEmail = `m6_staff_${Date.now()}@example.com`;
    const regStaffRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: staffEmail, password: 'Password123!', name: 'Staff User' }),
    });
    const regStaffData = (await regStaffRes.json()) as any;
    const staffUserId = regStaffData.user.id;

    // Add Staff membership in Business 1
    await withTenantContext(businessId, async (client) => {
      await client.query(
        `INSERT INTO memberships (business_id, user_id, role, status, branch_id)
         VALUES ($1, $2, 'staff', 'active', $3)`,
        [businessId, staffUserId, branchId]
      );
    });

    // Login Staff to get business-scoped token
    const staffLoginRes = await fetch(`${baseUrl}/v1/auth/switch-business`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regStaffData.tokens.accessToken}`,
      },
      body: JSON.stringify({ businessId }),
    });
    const staffLoginData = (await staffLoginRes.json()) as any;
    staffToken = staffLoginData.tokens.accessToken;

    // 3. Register Business 2 (for tenant isolation tests)
    const biz2Email = `m6_biz2_${Date.now()}@example.com`;
    const regBiz2Res = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: biz2Email, password: 'Password123!', name: 'Biz2 Owner' }),
    });
    const regBiz2Data = (await regBiz2Res.json()) as any;
    biz2Token = regBiz2Data.tokens.accessToken;

    const onboardBiz2Res = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${biz2Token}`,
      },
      body: JSON.stringify({
        name: 'Biz2 Corp',
        timezone: 'UTC',
        branchName: 'Branch 2',
        departments: ['Dept 1'],
      }),
    });
    const onboardBiz2Data = (await onboardBiz2Res.json()) as any;
    biz2Id = onboardBiz2Data.business.id;
    biz2Token = onboardBiz2Data.tokens.accessToken;
  });

  after(async () => {
    resetFxFixtureState();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await closeAllPools();
  });

  it('1. GET /v1/billing/subscription returns seeded Starter plan with 5 seats and full details', async () => {
    const res = await fetch(`${baseUrl}/v1/billing/subscription`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.data.plan, 'starter');
    assert.equal(body.data.seatQuantity, 5);
    assert.equal(body.data.status, 'active');
    assert.equal(body.data.billingCurrency, 'USD');
    assert.equal(body.data.admissionLimit, 5);
    assert.ok(body.data.activeSeatUsage >= 1);
  });

  it('2. Staff role is forbidden from requesting quotes (BR-006: Owner only)', async () => {
    const res = await fetch(`${baseUrl}/v1/billing/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({ targetPlan: 'team', targetSeats: 15 }),
    });
    assert.equal(res.status, 403);
  });

  it('3. Stale or unavailable FX fixture rejects NGN quote creation (AC-FX-03)', async () => {
    // Set fixture to unavailable
    setFxFixtureState({ unavailable: true });

    const unavailRes = await fetch(`${baseUrl}/v1/billing/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ targetPlan: 'team', targetSeats: 15, currency: 'NGN' }),
    });
    assert.equal(unavailRes.status, 500);
    const unavailBody = (await unavailRes.json()) as any;
    assert.equal(unavailBody.error.code, 'INTERNAL_ERROR');

    // Set fixture to stale (> 30 minutes old)
    setFxFixtureState({
      unavailable: false,
      retrievedAt: new Date(Date.now() - 40 * 60 * 1000), // 40m ago
    });

    const staleRes = await fetch(`${baseUrl}/v1/billing/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ targetPlan: 'team', targetSeats: 15, currency: 'NGN' }),
    });
    assert.equal(staleRes.status, 500);

    // Reset fixture
    resetFxFixtureState();
  });

  it('4. Owner creates server quote for Starter -> Team upgrade (BILL-013, AC-FX-01)', async () => {
    const res = await fetch(`${baseUrl}/v1/billing/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ targetPlan: 'team', targetSeats: 15 }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as any;
    assert.ok(body.data.id);
    assert.equal(body.data.targetPlan, 'team');
    assert.equal(body.data.targetSeats, 15);
    assert.equal(body.data.currency, 'USD');
    assert.equal(body.data.status, 'open');
    assert.ok(body.data.amountMinor > 0);
  });

  it('5. Confirm quote creates payment intent and enforces one open intent (BILL-014, BILL-022)', async () => {
    // Create quote
    const quoteRes = await fetch(`${baseUrl}/v1/billing/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ targetPlan: 'team', targetSeats: 15 }),
    });
    const quoteData = (await quoteRes.json()) as any;
    const quoteId = quoteData.data.id;

    // Confirm quote
    const confirmRes = await fetch(`${baseUrl}/v1/billing/quotes/${quoteId}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'idempotency-key': `idem_quote_${Date.now()}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(confirmRes.status, 200);
    const confirmData = (await confirmRes.json()) as any;
    assert.ok(confirmData.data.paymentIntentId);
    assert.ok(confirmData.data.providerReference);
    assert.equal(confirmData.data.status, 'awaiting_payment');

    // Confirming again while an intent is already open returns 409 PAYMENT_PENDING (BILL-022)
    const quote2Res = await fetch(`${baseUrl}/v1/billing/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ targetPlan: 'business', targetSeats: 40 }),
    });
    const quote2Data = (await quote2Res.json()) as any;

    const confirm2Res = await fetch(`${baseUrl}/v1/billing/quotes/${quote2Data.data.id}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'idempotency-key': `idem_quote_2_${Date.now()}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(confirm2Res.status, 409);
    const confirm2Body = (await confirm2Res.json()) as any;
    assert.equal(confirm2Body.error.code, 'PAYMENT_PENDING');
  });

  it('6. Webhook raw HMAC signature verification and idempotency (AC-010, BILL-007)', async () => {
    // Fetch currently awaiting intent
    const subRes = await fetch(`${baseUrl}/v1/billing/subscription`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(subRes.status, 200);

    const intent = await withTenantContext(businessId, async (client) => {
      const res = await client.query<{ id: string; provider_reference: string; amount_minor: string; currency: string }>(
        "SELECT id, provider_reference, amount_minor, currency FROM payment_intents WHERE business_id = $1 AND status = 'awaiting_payment'",
        [businessId]
      );
      return res.rows[0];
    });
    assert.ok(intent, 'Pending intent must exist');

    const amountMinor = parseInt(intent.amount_minor, 10);
    const eventId = `test_evt_${Date.now()}`;

    // 6a: Test invalid signature rejection (BILL-007 Step 1)
    const badSigRes = await fetch(`${baseUrl}/v1/billing/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': 'invalid_signature_hex_value',
      },
      body: JSON.stringify({
        event: 'charge.success',
        data: {
          id: eventId,
          reference: intent.provider_reference,
          amount_minor: amountMinor,
          currency: intent.currency,
          status: 'success',
        },
      }),
    });
    assert.equal(badSigRes.status, 401);

    // 6b: Valid signature and successful processing (BILL-007 Step 2-5)
    const { rawBody, signature } = generateSimulatedWebhook({
      eventId,
      reference: intent.provider_reference,
      amountMinor,
      currency: intent.currency,
      outcome: 'success',
      businessId,
    });

    const validRes = await fetch(`${baseUrl}/v1/billing/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': signature,
      },
      body: rawBody,
    });
    assert.equal(validRes.status, 200);
    const validBody = (await validRes.json()) as any;
    assert.equal(validBody.status, 'processed');

    // Verify subscription upgraded to Team with 15 seats (BILL-015)
    const afterSubRes = await fetch(`${baseUrl}/v1/billing/subscription`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const afterSub = (await afterSubRes.json()) as any;
    assert.equal(afterSub.data.plan, 'team');
    assert.equal(afterSub.data.seatQuantity, 15);
    assert.equal(afterSub.data.status, 'active');

    // 6c: Duplicate webhook replay acknowledged and ignored (BILL-007 Step 2)
    const duplicateRes = await fetch(`${baseUrl}/v1/billing/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': signature,
      },
      body: rawBody,
    });
    assert.equal(duplicateRes.status, 200);
    const dupBody = (await duplicateRes.json()) as any;
    assert.equal(dupBody.status, 'ignored_duplicate');
  });

  it('7. Financial ledger is strictly append-only; UPDATE and DELETE triggers reject tampering (C-08, BR-010, AC-013)', async () => {
    // Query ledger entries via API
    const ledgerRes = await fetch(`${baseUrl}/v1/billing/ledger`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ledgerRes.status, 200);
    const ledgerData = (await ledgerRes.json()) as any;
    assert.ok(ledgerData.data.length > 0);

    const firstEntry = ledgerData.data[0];

    // Attempt direct UPDATE via database connection - MUST FAIL via trigger trg_immutable_ledger
    await assert.rejects(
      async () => {
        await withTenantContext(businessId, async (client) => {
          await client.query(
            "UPDATE ledger_entries SET amount_minor = 999999 WHERE business_id = $1 AND seq = $2",
            [businessId, firstEntry.seq]
          );
        });
      },
      (err: any) => {
        assert.match(err.message, /strictly append-only/);
        return true;
      }
    );

    // Attempt direct DELETE via database connection - MUST FAIL via trigger trg_immutable_ledger
    await assert.rejects(
      async () => {
        await withTenantContext(businessId, async (client) => {
          await client.query(
            "DELETE FROM ledger_entries WHERE business_id = $1 AND seq = $2",
            [businessId, firstEntry.seq]
          );
        });
      },
      (err: any) => {
        assert.match(err.message, /strictly append-only/);
        return true;
      }
    );
  });

  it('8. Ledger replay reconstructs plan and seat entitlements exactly (BILL-010, BILL-025)', async () => {
    const reconstructed = await reconstructSubscriptionFromLedger(businessId);
    assert.equal(reconstructed.plan, 'team');
    assert.equal(reconstructed.seatQuantity, 15);
    assert.ok(reconstructed.totalPaidMinor > 0);
  });

  it('9. Scheduled downgrade and cancellation workflow (BILL-003, BILL-018, PR-10a)', async () => {
    // Schedule downgrade to Starter (usage is 2 <= Starter limit 5)
    const schedRes = await fetch(`${baseUrl}/v1/billing/schedule-downgrade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ targetPlan: 'starter', targetSeats: 5 }),
    });
    assert.equal(schedRes.status, 200);
    const schedData = (await schedRes.json()) as any;
    assert.equal(schedData.data.scheduledPlan, 'starter');

    // Verify admission limit lowered to scheduled limit (BILL-021)
    const subRes = await fetch(`${baseUrl}/v1/billing/subscription`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const sub = (await subRes.json()) as any;
    assert.equal(sub.data.scheduledPlan, 'starter');
    assert.equal(sub.data.admissionLimit, 5);

    // Cancel scheduled downgrade (PR-10a)
    const cancelRes = await fetch(`${baseUrl}/v1/billing/schedule-downgrade`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(cancelRes.status, 200);

    // Verify scheduledPlan cleared and admission limit restored to 15
    const subAfterRes = await fetch(`${baseUrl}/v1/billing/subscription`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const subAfter = (await subAfterRes.json()) as any;
    assert.equal(subAfter.data.scheduledPlan, null);
    assert.equal(subAfter.data.admissionLimit, 15);
  });

  it('10. Subscription renewal failure enters past_due, then restricted mode blocks mutations (BILL-011, BILL-030)', async () => {
    // Simulate failed renewal at period end -> enters past_due (BILL-011)
    const failRenewRes = await fetch(`${baseUrl}/v1/billing/renew`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ outcome: 'failure' }),
    });
    assert.equal(failRenewRes.status, 200);
    const failData = (await failRenewRes.json()) as any;
    assert.equal(failData.data.status, 'past_due');

    // Simulate transition to restricted mode after day 7 grace (BILL-030)
    await withTenantContext(businessId, async (client) => {
      await client.query("UPDATE subscriptions SET status = 'restricted' WHERE business_id = $1", [businessId]);
    });

    // 10a: Mutating shift operation is blocked in restricted mode (403 SUBSCRIPTION_RESTRICTED)
    const shiftRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        branchId,
        departmentId: '00000000-0000-0000-0000-000000000001',
        startsAt: '2026-10-20T08:00:00Z',
        endsAt: '2026-10-20T16:00:00Z',
      }),
    });
    assert.equal(shiftRes.status, 403);
    const shiftBody = (await shiftRes.json()) as any;
    assert.equal(shiftBody.error.code, 'SUBSCRIPTION_RESTRICTED');

    // 10b: Staff read-only access to published schedules is PRESERVED (BILL-030)
    const scheduleRes = await fetch(`${baseUrl}/v1/scheduling/shifts?from=2026-10-01&to=2026-10-31`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert.equal(scheduleRes.status, 200);

    // 10c: Owner payment/renewal to recover subscription is ALLOWED (BILL-030)
    const recoverRes = await fetch(`${baseUrl}/v1/billing/renew`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ outcome: 'success' }),
    });
    assert.equal(recoverRes.status, 200);
    const recoverData = (await recoverRes.json()) as any;
    assert.equal(recoverData.data.status, 'active');

    // Verify mutations unblocked after renewal
    const subActiveRes = await fetch(`${baseUrl}/v1/billing/subscription`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const subActive = (await subActiveRes.json()) as any;
    assert.equal(subActive.data.status, 'active');
  });

  it('11. Tenant isolation: Tenant A cannot access or confirm Tenant B billing quotes (AC-TEN-01)', async () => {
    // Tenant B creates a quote on Tenant B's subscription
    const quoteRes = await fetch(`${baseUrl}/v1/billing/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${biz2Token}`,
      },
      body: JSON.stringify({ targetPlan: 'business', targetSeats: 40 }),
    });
    assert.equal(quoteRes.status, 201);
    const quoteData = (await quoteRes.json()) as any;
    const tenantBQuoteId = quoteData.data.id;

    // Tenant A attempts to confirm Tenant B's quote
    const confirmRes = await fetch(`${baseUrl}/v1/billing/quotes/${tenantBQuoteId}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'idempotency-key': `idem_cross_${Date.now()}`,
      },
      body: JSON.stringify({}),
    });
    // RLS and composite keys ensure Tenant A gets 404 NOT_FOUND
    assert.equal(confirmRes.status, 404);
  });
});
