import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { createApp } from '../../src/app.ts';
import { closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';
import { getRedisClient } from '../../src/services/redis-client.ts';
import {
  setPaystackMockMode,
  registerMockPaystackTransaction,
  clearPaystackMocks,
  computePaystackSignature,
  getPaystackConfig,
} from '../../src/services/paystack-service.ts';

describe('Paystack Subscription Payments Integration & Security (Test Mode)', () => {
  let server: Server;
  let baseUrl: string;

  let ownerToken: string;
  let staffToken: string;
  let businessId: string;
  let branchId: string;

  let biz2Token: string;
  let biz2Id: string;

  const testSecret = 'sk_test_paystack_automated_test_secret_key';

  before(async () => {
    setPaystackMockMode(true);
    process.env.PAYSTACK_SECRET_KEY = testSecret;

    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const timestamp = Date.now();

    // 1. Register Owner for Business 1
    const ownerEmail = `paystack_owner_${timestamp}@example.com`;
    const regOwnerRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: 'Password123!', name: 'Paystack Owner' }),
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
        name: 'Paystack Test Market',
        timezone: 'UTC',
        branchName: 'Downtown Branch',
        departments: ['Sales'],
      }),
    });
    const onboardData = (await onboardRes.json()) as any;
    businessId = onboardData.business.id;
    branchId = onboardData.branch.id;
    ownerToken = onboardData.tokens.accessToken;

    // 2. Register Staff for Business 1
    const staffEmail = `paystack_staff_${timestamp}@example.com`;
    const regStaffRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: staffEmail, password: 'Password123!', name: 'Paystack Staff' }),
    });
    const regStaffData = (await regStaffRes.json()) as any;
    const staffUserId = regStaffData.user.id;

    await withTenantContext(businessId, async (client) => {
      await client.query(
        `INSERT INTO memberships (business_id, user_id, role, status, branch_id)
         VALUES ($1, $2, 'staff', 'active', $3)`,
        [businessId, staffUserId, branchId]
      );
    });

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

    // 3. Register Business 2 (Tenant B)
    const biz2Email = `paystack_biz2_${timestamp}@example.com`;
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
        name: 'Tenant B Supermarket',
        timezone: 'UTC',
        branchName: 'Branch B',
        departments: ['Main'],
      }),
    });
    const onboardBiz2Data = (await onboardBiz2Res.json()) as any;
    biz2Id = onboardBiz2Data.business.id;
    biz2Token = onboardBiz2Data.tokens.accessToken;
  });

  beforeEach(async () => {
    const redis = getRedisClient();
    const keys = await redis.keys('ratelimit:payment:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  after(async () => {
    clearPaystackMocks();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await closeAllPools();
  });

  it('1. Successful verified test payment via Paystack checkout & verification (Scenario 1 & 12)', async () => {
    // 1. Initial state check: Business 1 has Starter plan (5 seats), zero ledger entries
    const initialSubRes = await fetch(`${baseUrl}/v1/billing/subscription`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const initialSub = (await initialSubRes.json()) as any;
    assert.equal(initialSub.data.plan, 'starter');
    assert.equal(initialSub.data.seatQuantity, 5);

    // 2. Create quote for Team plan ($50 / 5000 cents, 15 seats)
    const quoteRes = await fetch(`${baseUrl}/v1/billing/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ targetPlan: 'team', targetSeats: 15, currency: 'USD' }),
    });
    assert.equal(quoteRes.status, 201);
    const quoteData = (await quoteRes.json()) as any;
    const quoteId = quoteData.data.id;
    const expectedAmount = quoteData.data.amountMinor;

    // 3. Confirm quote: creates persistent payment intent record BEFORE customer redirect
    const confirmRes = await fetch(`${baseUrl}/v1/billing/quotes/${quoteId}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'idempotency-key': `paystack_confirm_${Date.now()}`,
      },
      body: JSON.stringify({ provider: 'paystack' }),
    });
    assert.equal(confirmRes.status, 200);
    const confirmData = (await confirmRes.json()) as any;
    const { providerReference, checkoutUrl, status: intentStatus } = confirmData.data;

    assert.ok(providerReference.startsWith('rotapay_'), 'Paystack reference must have rotapay_ prefix');
    assert.ok(checkoutUrl.includes('checkout.paystack.com'), 'Must return Paystack hosted checkout URL');
    assert.equal(intentStatus, 'awaiting_payment');

    // Scenario 12: Verify NO entitlement granted before payment verification
    const midSubRes = await fetch(`${baseUrl}/v1/billing/subscription`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const midSub = (await midSubRes.json()) as any;
    assert.equal(midSub.data.plan, 'starter', 'Must NOT grant entitlement before verified payment');

    // 4. Register mock Paystack transaction as verified success
    registerMockPaystackTransaction({
      status: 'success',
      reference: providerReference,
      amountMinor: expectedAmount,
      currency: 'USD',
      paidAt: new Date().toISOString(),
      gatewayResponse: 'Successful',
      channel: 'card',
      id: 9918231,
    });

    // 5. Server-side verification return flow (POST /v1/billing/verify)
    const verifyRes = await fetch(`${baseUrl}/v1/billing/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ reference: providerReference }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyData = (await verifyRes.json()) as any;
    assert.equal(verifyData.data.status, 'succeeded');

    // 6. Verify subscription is now active with Team plan (15 seats) and ledger entry is written
    const finalSubRes = await fetch(`${baseUrl}/v1/billing/subscription`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const finalSub = (await finalSubRes.json()) as any;
    assert.equal(finalSub.data.plan, 'team');
    assert.equal(finalSub.data.seatQuantity, 15);
    assert.equal(finalSub.data.status, 'active');
    assert.ok(finalSub.data.lastPaymentAt);

    // Verify immutable ledger
    const ledgerRes = await fetch(`${baseUrl}/v1/billing/ledger`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ledgerRes.status, 200);
    const ledgerData = (await ledgerRes.json()) as any;
    const entry = ledgerData.data.find((e: any) => e.plan === 'team');
    assert.ok(entry, 'Ledger entry must be recorded for verified Paystack charge');
    assert.equal(entry.amountMinor, expectedAmount);
    assert.equal(entry.currency, 'USD');
  });

  it('2. Failed, pending, and abandoned Paystack checkout states (Scenario 2)', async () => {
    // 1. Create and confirm a quote
    const quoteRes = await fetch(`${baseUrl}/v1/billing/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ targetPlan: 'business', targetSeats: 40, currency: 'USD' }),
    });
    const quoteData = (await quoteRes.json()) as any;
    const quoteId = quoteData.data.id;

    const confirmRes = await fetch(`${baseUrl}/v1/billing/quotes/${quoteId}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'idempotency-key': `paystack_state_${Date.now()}`,
      },
      body: JSON.stringify({ provider: 'paystack' }),
    });
    const confirmData = (await confirmRes.json()) as any;
    const reference = confirmData.data.providerReference;

    // 2. Pending payment: Paystack reports 'pending'
    registerMockPaystackTransaction({
      status: 'pending',
      reference,
      amountMinor: confirmData.data.amountMinor,
      currency: 'USD',
    });

    const verifyPending = await fetch(`${baseUrl}/v1/billing/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ reference }),
    });
    const pendingBody = (await verifyPending.json()) as any;
    assert.equal(pendingBody.data.status, 'pending');

    // 3. Abandoned / Failed payment: Paystack reports 'abandoned'
    registerMockPaystackTransaction({
      status: 'abandoned',
      reference,
      amountMinor: confirmData.data.amountMinor,
      currency: 'USD',
      gatewayResponse: 'Customer abandoned transaction',
    });

    const verifyFailed = await fetch(`${baseUrl}/v1/billing/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ reference }),
    });
    const failedBody = (await verifyFailed.json()) as any;
    assert.equal(failedBody.data.status, 'failed');

    // Verify entitlement was NOT upgraded to business
    const subRes = await fetch(`${baseUrl}/v1/billing/subscription`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const sub = (await subRes.json()) as any;
    assert.equal(sub.data.plan, 'team', 'Subscription must not upgrade on failed checkout');
  });

  it('3. Incorrect amount, currency, or unknown provider reference (Scenario 3)', async () => {
    // 1. Create and confirm quote
    const quoteRes = await fetch(`${baseUrl}/v1/billing/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ targetPlan: 'business', targetSeats: 40, currency: 'USD' }),
    });
    const quoteData = (await quoteRes.json()) as any;

    const confirmRes = await fetch(`${baseUrl}/v1/billing/quotes/${quoteData.data.id}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'idempotency-key': `paystack_mismatch_${Date.now()}`,
      },
      body: JSON.stringify({ provider: 'paystack' }),
    });
    const confirmData = (await confirmRes.json()) as any;
    const reference = confirmData.data.providerReference;

    // Register Paystack mock with TAMPERED amount (1000 instead of real amount)
    registerMockPaystackTransaction({
      status: 'success',
      reference,
      amountMinor: 1000, // Mismatched!
      currency: 'USD',
    });

    const verifyRes = await fetch(`${baseUrl}/v1/billing/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ reference }),
    });
    const verifyBody = (await verifyRes.json()) as any;
    assert.equal(verifyBody.data.status, 'failed');
    assert.ok(verifyBody.data.message.includes('mismatch'));

    // Unknown provider reference returns 404
    const unknownRes = await fetch(`${baseUrl}/v1/billing/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ reference: 'rotapay_non_existent_reference_xyz' }),
    });
    assert.equal(unknownRes.status, 404);
  });

  it('4. Paystack webhook HMAC-SHA512 raw-body signature verification (Scenario 4)', async () => {
    const payload = {
      event: 'charge.success',
      data: {
        id: 8829102,
        reference: 'rotapay_webhook_test_ref',
        amount: 5000,
        currency: 'USD',
        status: 'success',
      },
    };
    const rawBody = JSON.stringify(payload);

    // 4a. Invalid signature rejected with 401
    const badRes = await fetch(`${baseUrl}/v1/billing/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': 'invalid_signature_hex_512',
      },
      body: rawBody,
    });
    assert.equal(badRes.status, 401);
    const badBody = (await badRes.json()) as any;
    assert.equal(badBody.error.code, 'INVALID_SIGNATURE');

    // 4b. Missing signature rejected with 401
    const missingRes = await fetch(`${baseUrl}/v1/billing/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: rawBody,
    });
    assert.equal(missingRes.status, 401);
    const missingBody = (await missingRes.json()) as any;
    assert.equal(missingBody.error.code, 'MISSING_SIGNATURE');
  });

  it('5. Duplicate webhook delivery and duplicate verification idempotency (Scenario 5)', async () => {
    // 1. Create a quote and intent
    const quoteRes = await fetch(`${baseUrl}/v1/billing/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ targetPlan: 'business', targetSeats: 40, currency: 'USD' }),
    });
    const quoteData = (await quoteRes.json()) as any;

    const confirmRes = await fetch(`${baseUrl}/v1/billing/quotes/${quoteData.data.id}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'idempotency-key': `paystack_dup_${Date.now()}`,
      },
      body: JSON.stringify({ provider: 'paystack' }),
    });
    const confirmData = (await confirmRes.json()) as any;
    const reference = confirmData.data.providerReference;
    const amount = confirmData.data.amountMinor;

    const eventId = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 900 + 100);
    const webhookPayload = {
      event: 'charge.success',
      data: {
        id: eventId,
        reference,
        amount,
        currency: 'USD',
        status: 'success',
        metadata: { business_id: businessId },
      },
    };
    const rawBody = JSON.stringify(webhookPayload);
    const signature = computePaystackSignature(rawBody, testSecret);

    // First delivery -> processed
    const res1 = await fetch(`${baseUrl}/v1/billing/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': signature,
      },
      body: rawBody,
    });
    assert.equal(res1.status, 200);
    const body1 = (await res1.json()) as any;
    assert.equal(body1.status, 'processed');

    // Duplicate delivery -> ignored_duplicate
    const res2 = await fetch(`${baseUrl}/v1/billing/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': signature,
      },
      body: rawBody,
    });
    assert.equal(res2.status, 200);
    const body2 = (await res2.json()) as any;
    assert.equal(body2.status, 'ignored_duplicate');

    // Duplicate client verification call -> returns succeeded without creating duplicate entries
    const verifyDup = await fetch(`${baseUrl}/v1/billing/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ reference }),
    });
    assert.equal(verifyDup.status, 200);
    const verifyDupBody = (await verifyDup.json()) as any;
    assert.equal(verifyDupBody.data.status, 'succeeded');
  });

  it('6. Concurrent webhook processing safety (Scenario 6)', async () => {
    // Create new quote and intent
    const quoteRes = await fetch(`${baseUrl}/v1/billing/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ targetPlan: 'business', targetSeats: 45, currency: 'USD' }),
    });
    const quoteData = (await quoteRes.json()) as any;

    const confirmRes = await fetch(`${baseUrl}/v1/billing/quotes/${quoteData.data.id}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'idempotency-key': `paystack_concurrent_${Date.now()}`,
      },
      body: JSON.stringify({ provider: 'paystack' }),
    });
    const confirmData = (await confirmRes.json()) as any;
    const reference = confirmData.data.providerReference;
    const amount = confirmData.data.amountMinor;

    const webhookPayload = {
      event: 'charge.success',
      data: {
        id: Math.floor(Math.random() * 99999999),
        reference,
        amount,
        currency: 'USD',
        status: 'success',
        metadata: { business_id: businessId },
      },
    };
    const rawBody = JSON.stringify(webhookPayload);
    const signature = computePaystackSignature(rawBody, testSecret);

    // Fire 3 simultaneous webhooks
    const [w1, w2, w3] = await Promise.all([
      fetch(`${baseUrl}/v1/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
        body: rawBody,
      }),
      fetch(`${baseUrl}/v1/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
        body: rawBody,
      }),
      fetch(`${baseUrl}/v1/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
        body: rawBody,
      }),
    ]);

    assert.equal(w1.status, 200);
    assert.equal(w2.status, 200);
    assert.equal(w3.status, 200);

    const results = [
      ((await w1.json()) as any).status,
      ((await w2.json()) as any).status,
      ((await w3.json()) as any).status,
    ];

    // Exactly one is 'processed', others are 'ignored_duplicate'
    const processedCount = results.filter((s) => s === 'processed').length;
    const duplicateCount = results.filter((s) => s === 'ignored_duplicate').length;
    assert.equal(processedCount, 1, 'Exactly one concurrent webhook must win and be processed');
    assert.equal(duplicateCount, 2, 'Duplicate concurrent webhooks must be deduplicated');
  });

  it('7. Forged success redirect without successful provider verification rejected (Scenario 7)', async () => {
    // Create quote and confirm
    const quoteRes = await fetch(`${baseUrl}/v1/billing/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ targetPlan: 'business', targetSeats: 40, currency: 'USD' }),
    });
    const quoteData = (await quoteRes.json()) as any;

    const confirmRes = await fetch(`${baseUrl}/v1/billing/quotes/${quoteData.data.id}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'idempotency-key': `paystack_forged_${Date.now()}`,
      },
      body: JSON.stringify({ provider: 'paystack' }),
    });
    const confirmData = (await confirmRes.json()) as any;
    const reference = confirmData.data.providerReference;

    // Attacker forged redirect: calls /verify claiming success, but Paystack API returns failed/declined
    registerMockPaystackTransaction({
      status: 'failed',
      reference,
      amountMinor: confirmData.data.amountMinor,
      currency: 'USD',
      gatewayResponse: 'Declined - Insufficient funds',
    });

    const verifyRes = await fetch(`${baseUrl}/v1/billing/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ reference }),
    });
    const verifyBody = (await verifyRes.json()) as any;
    assert.equal(verifyBody.data.status, 'failed');
    assert.ok(verifyBody.data.message.includes('Declined'));
  });

  it('8. Quote expiry and idempotency enforcement (Scenario 8)', async () => {
    // 8a. Idempotency test: Same key returns same intent
    const idempotencyKey = `idem_test_${Date.now()}`;
    const quoteRes = await fetch(`${baseUrl}/v1/billing/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ targetPlan: 'team', targetSeats: 15, currency: 'USD' }),
    });
    const quoteData = (await quoteRes.json()) as any;

    const resA = await fetch(`${baseUrl}/v1/billing/quotes/${quoteData.data.id}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ provider: 'paystack' }),
    });
    const dataA = (await resA.json()) as any;

    const resB = await fetch(`${baseUrl}/v1/billing/quotes/${quoteData.data.id}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ provider: 'paystack' }),
    });
    const dataB = (await resB.json()) as any;

    assert.equal(dataA.data.paymentIntentId, dataB.data.paymentIntentId);
    assert.equal(dataA.data.providerReference, dataB.data.providerReference);

    // 8b. Idempotency mismatch test
    const resC = await fetch(`${baseUrl}/v1/billing/quotes/${quoteData.data.id}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ provider: 'paystack', differentPayloadField: true }),
    });
    assert.equal(resC.status, 422);
    const errC = (await resC.json()) as any;
    assert.equal(errC.error.code, 'IDEMPOTENCY_MISMATCH');
  });

  it('9. Tenant isolation and role authorization (Scenario 11)', async () => {
    // Staff cannot confirm quotes or verify payments
    const staffVerify = await fetch(`${baseUrl}/v1/billing/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({ reference: 'any_ref' }),
    });
    assert.equal(staffVerify.status, 403, 'Staff must be forbidden from verifying payments');

    // Tenant B owner cannot verify Tenant A reference
    const crossVerify = await fetch(`${baseUrl}/v1/billing/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${biz2Token}`,
      },
      body: JSON.stringify({ reference: 'rotapay_some_tenant_a_ref' }),
    });
    assert.equal(crossVerify.status, 404, 'Cross-tenant reference lookup must fail with 404');
  });
});
