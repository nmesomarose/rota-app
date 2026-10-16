import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { env } from '../../src/config/env.ts';
import { withTenantContext, validateBusinessId, TenantContextError } from '../../src/db/tenant-context.ts';
import { getShardPool, closeAllPools } from '../../src/db/connection.ts';
import { getShardIdForBusiness } from '../../src/sharding/shard-router.ts';

describe('Tenant Isolation and Security Test Suite', () => {
  // Test business IDs (UUIDv4)
  const bizAId = randomUUID();
  const bizBId = randomUUID();
  let shardA: 'shard_1' | 'shard_2';
  let shardB: 'shard_1' | 'shard_2';

  let branchAId: string;
  let branchBId: string;
  let deptAId: string;

  // Admin client for test setup/teardown
  let adminClient: pg.Client;

  before(async () => {
    adminClient = new pg.Client({ connectionString: env.DATABASE_URL });
    await adminClient.connect();

    shardA = getShardIdForBusiness(bizAId);
    shardB = getShardIdForBusiness(bizBId);

    // Create businesses via withTenantContext (verifying rota_app insert permissions)
    await withTenantContext(bizAId, async (client) => {
      await client.query(
        'INSERT INTO businesses (id, name, timezone) VALUES ($1, $2, $3)',
        [bizAId, 'Tenant Alpha Ltd', 'UTC']
      );
      const branchRes = await client.query(
        'INSERT INTO branches (business_id, name) VALUES ($1, $2) RETURNING id',
        [bizAId, 'Alpha Headquarters']
      );
      branchAId = branchRes.rows[0].id;

      const deptRes = await client.query(
        'INSERT INTO departments (business_id, branch_id, name) VALUES ($1, $2, $3) RETURNING id',
        [bizAId, branchAId, 'Alpha Engineering']
      );
      deptAId = deptRes.rows[0].id;
    });

    await withTenantContext(bizBId, async (client) => {
      await client.query(
        'INSERT INTO businesses (id, name, timezone) VALUES ($1, $2, $3)',
        [bizBId, 'Tenant Beta Inc', 'Africa/Lagos']
      );
      const branchRes = await client.query(
        'INSERT INTO branches (business_id, name) VALUES ($1, $2) RETURNING id',
        [bizBId, 'Beta Branch Central']
      );
      branchBId = branchRes.rows[0].id;
    });
  });

  after(async () => {
    // Clean up test data using admin connection to cascade delete
    try {
      const schemaA = shardA === 'shard_1' ? env.SHARD_1_SCHEMA : env.SHARD_2_SCHEMA;
      const schemaB = shardB === 'shard_1' ? env.SHARD_1_SCHEMA : env.SHARD_2_SCHEMA;
      await adminClient.query(`DELETE FROM ${schemaA}.businesses WHERE id = $1`, [bizAId]);
      await adminClient.query(`DELETE FROM ${schemaB}.businesses WHERE id = $1`, [bizBId]);
    } catch (_err) {
      // Ignore teardown errors
    } finally {
      await adminClient.end();
      await closeAllPools();
    }
  });

  describe('A. Tenant Isolation and Row-Level Security', () => {
    it('Tenant A can read its own records', async () => {
      await withTenantContext(bizAId, async (client) => {
        const res = await client.query('SELECT * FROM branches');
        assert.equal(res.rows.length, 1);
        assert.equal(res.rows[0].business_id, bizAId);
        assert.equal(res.rows[0].name, 'Alpha Headquarters');
      });
    });

    it('Tenant B can read its own records', async () => {
      await withTenantContext(bizBId, async (client) => {
        const res = await client.query('SELECT * FROM branches');
        assert.equal(res.rows.length, 1);
        assert.equal(res.rows[0].business_id, bizBId);
        assert.equal(res.rows[0].name, 'Beta Branch Central');
      });
    });

    it('Tenant A cannot read Tenant B records', async () => {
      // Force query against Tenant B's shard using Tenant A context
      await withTenantContext(bizAId, async (client) => {
        const res = await client.query('SELECT * FROM branches WHERE id = $1', [branchBId]);
        assert.equal(res.rows.length, 0, 'Tenant A must receive 0 rows when attempting to select Tenant B branch');
      }, { shardId: shardB });
    });

    it('Tenant A cannot update Tenant B records', async () => {
      await withTenantContext(bizAId, async (client) => {
        const res = await client.query(
          "UPDATE branches SET name = 'Compromised' WHERE id = $1 RETURNING *",
          [branchBId]
        );
        assert.equal(res.rowCount, 0, 'Tenant A update against Tenant B branch must affect 0 rows');
      }, { shardId: shardB });
    });

    it('Tenant A cannot delete Tenant B records', async () => {
      await withTenantContext(bizAId, async (client) => {
        const res = await client.query(
          'DELETE FROM branches WHERE id = $1 RETURNING *',
          [branchBId]
        );
        assert.equal(res.rowCount, 0, 'Tenant A delete against Tenant B branch must affect 0 rows');
      }, { shardId: shardB });
    });

    it('Missing tenant context fails closed (returns 0 rows on SELECT)', async () => {
      const pool = getShardPool(shardA);
      const client = await pool.connect();
      try {
        const res = await client.query('SELECT * FROM branches');
        assert.equal(res.rows.length, 0, 'Query without tenant context must return zero rows');
      } finally {
        client.release();
      }
    });

    it('Missing tenant context fails closed on INSERT (RLS check violation)', async () => {
      const pool = getShardPool(shardA);
      const client = await pool.connect();
      try {
        await assert.rejects(
          async () => {
            await client.query(
              'INSERT INTO branches (business_id, name) VALUES ($1, $2)',
              [bizAId, 'Unauthorized Branch']
            );
          },
          /new row violates row-level security policy/i
        );
      } finally {
        client.release();
      }
    });

    it('Invalid business_id format is rejected before query execution', async () => {
      await assert.rejects(
        async () => {
          await withTenantContext('not-a-valid-uuid', async () => {});
        },
        TenantContextError
      );
    });
  });

  describe('B. Composite Foreign Key Enforcement', () => {
    it('Valid same-business relationships succeed', async () => {
      await withTenantContext(bizAId, async (client) => {
        const res = await client.query(
          'INSERT INTO departments (business_id, branch_id, name) VALUES ($1, $2, $3) RETURNING id',
          [bizAId, branchAId, 'Alpha Marketing']
        );
        assert.ok(res.rows[0].id);
      });
    });

    it('Cross-business foreign key relationship is rejected', async () => {
      // Attempt to link Tenant A's department to Tenant B's branch
      // (Even if an attacker bypassed RLS, the composite FK constraint must reject it)
      const schemaA = shardA === 'shard_1' ? env.SHARD_1_SCHEMA : env.SHARD_2_SCHEMA;
      await assert.rejects(
        async () => {
          // Run as admin to bypass RLS and test the DB-level composite FK constraint directly
          await adminClient.query(
            `INSERT INTO ${schemaA}.departments (business_id, branch_id, name) VALUES ($1, $2, $3)`,
            [bizAId, branchBId, 'Malicious Cross-Tenant Department']
          );
        },
        /violates foreign key constraint "fk_departments_branch"/i
      );
    });

    it('Duplicate department name within same branch is rejected', async () => {
      await withTenantContext(bizAId, async (client) => {
        await assert.rejects(
          async () => {
            await client.query(
              'INSERT INTO departments (business_id, branch_id, name) VALUES ($1, $2, $3)',
              [bizAId, branchAId, 'Alpha Engineering'] // Duplicate name in branchAId
            );
          },
          /violates unique constraint "uq_departments_branch_name"/i
        );
      });
    });
  });

  describe('C. Connection Pool Safety and Context Isolation', () => {
    it('Interleaved transactions on shared pool do not leak tenant context', async () => {
      // Execute 30 interleaved concurrent calls alternating between Tenant A and Tenant B
      const iterations = 30;
      const tasks = Array.from({ length: iterations }, (_, i) => {
        const isA = i % 2 === 0;
        const targetBiz = isA ? bizAId : bizBId;
        const expectedName = isA ? 'Alpha Headquarters' : 'Beta Branch Central';

        return withTenantContext(targetBiz, async (client) => {
          const res = await client.query('SELECT * FROM branches');
          assert.equal(res.rows.length, 1);
          assert.equal(res.rows[0].name, expectedName);
          assert.equal(res.rows[0].business_id, targetBiz);
        });
      });

      await Promise.all(tasks);
    });

    it('A failed transaction does not leak context or poison subsequent connections', async () => {
      // 1. Deliberately fail a transaction for Tenant A
      try {
        await withTenantContext(bizAId, async (client) => {
          await client.query('SELECT 1');
          throw new Error('Simulated application crash');
        });
      } catch (err) {
        assert.equal((err as Error).message, 'Simulated application crash');
      }

      // 2. Subsequent query for Tenant B on the pool must execute cleanly with Tenant B context
      await withTenantContext(bizBId, async (client) => {
        const res = await client.query('SELECT * FROM branches');
        assert.equal(res.rows.length, 1);
        assert.equal(res.rows[0].business_id, bizBId);
      });
    });

    it('Connections returned to pool have empty tenant setting', async () => {
      const pool = getShardPool(shardA);
      const client = await pool.connect();
      try {
        const res = await client.query("SELECT current_setting('app.current_business_id', true) AS setting");
        const settingVal = res.rows[0]?.setting;
        assert.ok(
          settingVal === null || settingVal === '',
          `Expected empty tenant setting on pooled connection, got: ${settingVal}`
        );
      } finally {
        client.release();
      }
    });
  });

  describe('D. Sharding Consistency and Routing', () => {
    it('Routing is 100% deterministic across 100 iterations', () => {
      const initialShard = getShardIdForBusiness(bizAId);
      for (let i = 0; i < 100; i++) {
        assert.equal(getShardIdForBusiness(bizAId), initialShard);
      }
    });

    it('Both logical shards have identical table structures', async () => {
      const query = `
        SELECT table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name != 'pgmigrations'
        ORDER BY table_name, column_name;
      `;

      const res1 = await adminClient.query(query, [env.SHARD_1_SCHEMA]);
      const res2 = await adminClient.query(query, [env.SHARD_2_SCHEMA]);

      assert.equal(res1.rows.length, res2.rows.length, 'Column count must match across shards');
      assert.deepEqual(res1.rows, res2.rows, 'Schema definitions must be perfectly symmetrical');
    });

    it('Both logical shards have identical RLS policies and enforcement', async () => {
      const rlsQuery = `
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname != 'pgmigrations'
        ORDER BY c.relname;
      `;

      const policyQuery = `
        SELECT tablename, policyname, roles, cmd, qual
        FROM pg_policies
        WHERE schemaname = $1
        ORDER BY tablename, policyname;
      `;

      const rls1 = await adminClient.query(rlsQuery, [env.SHARD_1_SCHEMA]);
      const rls2 = await adminClient.query(rlsQuery, [env.SHARD_2_SCHEMA]);
      const pol1 = await adminClient.query(policyQuery, [env.SHARD_1_SCHEMA]);
      const pol2 = await adminClient.query(policyQuery, [env.SHARD_2_SCHEMA]);

      assert.deepEqual(rls1.rows, rls2.rows, 'RLS enforcement flags must be identical across shards');
      assert.deepEqual(pol1.rows, pol2.rows, 'RLS policies must be identical across shards');
    });
  });
});
