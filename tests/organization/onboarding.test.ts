import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';
import { getShardIdForBusiness } from '../../src/sharding/shard-router.ts';
import { reconcileDirectoryForBusiness } from '../../src/services/outbox-service.ts';

describe('Milestone M2: Organization Onboarding and Directory Sync', () => {
  let server: Server;
  let baseUrl: string;
  let ownerToken: string;
  let ownerId: string;
  const ownerEmail = `org_owner_${Date.now()}@example.com`;

  before(async () => {
    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Register a test owner user
    const regRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: ownerEmail,
        password: 'Password123!',
        name: 'Ada Owner',
      }),
    });
    const regBody = (await regRes.json()) as any;
    ownerToken = regBody.tokens.accessToken;
    ownerId = regBody.user.id;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await closeAllPools();
  });

  let createdBusinessId: string;

  it('1. Onboards a new business, creating business, default branch, departments, owner membership, starter subscription (5 seats)', async () => {
    const res = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        name: 'Supermarket Central',
        timezone: 'UTC',
        branchName: 'Main Supermarket Branch',
        departments: ['Checkout', 'Stock/Inventory', 'Customer Service'],
      }),
    });

    assert.strictEqual(res.status, 201);
    const body = (await res.json()) as any;

    assert.ok(body.business.id);
    assert.strictEqual(body.business.name, 'Supermarket Central');
    assert.strictEqual(body.branch.name, 'Main Supermarket Branch');
    assert.strictEqual(body.departments.length, 3);
    assert.strictEqual(body.membership.role, 'owner');
    assert.strictEqual(body.membership.status, 'active');
    assert.strictEqual(body.subscription.plan, 'starter');
    assert.strictEqual(body.subscription.seatQuantity, 5);
    assert.ok(body.tokens.accessToken);

    createdBusinessId = body.business.id;
    // Update ownerToken with the newly scoped token
    ownerToken = body.tokens.accessToken;

    // 2. Verify shard persistence via withTenantContext
    const assignedShard = getShardIdForBusiness(createdBusinessId);
    assert.ok(assignedShard === 'shard_1' || assignedShard === 'shard_2');

    await withTenantContext(createdBusinessId, async (client) => {
      // Check business
      const bRes = await client.query('SELECT * FROM businesses WHERE id = $1', [createdBusinessId]);
      assert.strictEqual(bRes.rows.length, 1);

      // Check branches
      const brRes = await client.query('SELECT * FROM branches WHERE business_id = $1', [createdBusinessId]);
      assert.strictEqual(brRes.rows.length, 1);

      // Check departments
      const dRes = await client.query('SELECT * FROM departments WHERE business_id = $1', [createdBusinessId]);
      assert.strictEqual(dRes.rows.length, 3);

      // Check subscription
      const subRes = await client.query('SELECT * FROM subscriptions WHERE business_id = $1', [createdBusinessId]);
      assert.strictEqual(subRes.rows.length, 1);
      assert.strictEqual(subRes.rows[0].seat_quantity, 5);
    });

    // 3. Verify control plane directory contains the new business
    const dirRes = await controlPool.query(
      'SELECT * FROM membership_directory WHERE user_id = $1 AND business_id = $2',
      [ownerId, createdBusinessId]
    );
    assert.strictEqual(dirRes.rows.length, 1);
    assert.strictEqual(dirRes.rows[0].role, 'owner');
    assert.strictEqual(dirRes.rows[0].status, 'active');
  });

  it('2. GET /v1/organizations lists the newly onboarded business', async () => {
    const res = await fetch(`${baseUrl}/v1/organizations`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.organizations));
    const found = body.organizations.find((o: any) => o.business_id === createdBusinessId);
    assert.ok(found, 'Created business must appear in user organizations list');
    assert.strictEqual(found.business_name, 'Supermarket Central');
    assert.strictEqual(found.role, 'owner');
  });

  it('3. GET /v1/organizations/:id retrieves organization data when accessed with matching business token', async () => {
    const res = await fetch(`${baseUrl}/v1/organizations/${createdBusinessId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;
    assert.strictEqual(body.business.id, createdBusinessId);
    assert.strictEqual(body.branches.length, 1);
    assert.strictEqual(body.departments.length, 3);
    assert.strictEqual(body.subscription.seat_quantity, 5);
  });

  it('4. AC-TEN-07: Crash reconciliation repairs directory copy and makes business appear at login', async () => {
    // 1. Manually simulate an outbox drift: Delete the directory row from control plane
    await controlPool.query(
      'DELETE FROM membership_directory WHERE user_id = $1 AND business_id = $2',
      [ownerId, createdBusinessId]
    );

    // Verify it is missing from control plane
    const beforeCheck = await controlPool.query(
      'SELECT * FROM membership_directory WHERE user_id = $1 AND business_id = $2',
      [ownerId, createdBusinessId]
    );
    assert.strictEqual(beforeCheck.rows.length, 0);

    // 2. Execute reconciliation job
    const repairedCount = await reconcileDirectoryForBusiness(createdBusinessId);
    assert.ok(repairedCount >= 1, 'Reconciliation should restore at least 1 membership');

    // 3. Verify directory row is restored
    const afterCheck = await controlPool.query(
      'SELECT * FROM membership_directory WHERE user_id = $1 AND business_id = $2',
      [ownerId, createdBusinessId]
    );
    assert.strictEqual(afterCheck.rows.length, 1);
    assert.strictEqual(afterCheck.rows[0].business_name, 'Supermarket Central');
    assert.strictEqual(afterCheck.rows[0].role, 'owner');

    // 4. Verify login listing now returns the repaired business
    const loginRes = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: 'Password123!' }),
    });
    assert.strictEqual(loginRes.status, 200);
    const loginBody = (await loginRes.json()) as any;
    const restoredBiz = loginBody.businesses.find((b: any) => b.business_id === createdBusinessId);
    assert.ok(restoredBiz, 'Repaired business must appear in login listings');
  });
});
