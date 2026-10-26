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

  // Admin clients for test setup/teardown and cross-shard validation
  let adminClient: pg.Client;
  let adminClient1: pg.Client;
  let adminClient2: pg.Client;

  before(async () => {
    adminClient = new pg.Client({ connectionString: env.DATABASE_URL });
    adminClient1 = new pg.Client({ connectionString: env.SHARD_1_DATABASE_URL });
    adminClient2 = new pg.Client({ connectionString: env.SHARD_2_DATABASE_URL });
    await Promise.all([adminClient.connect(), adminClient1.connect(), adminClient2.connect()]);

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
      const clientA = shardA === 'shard_1' ? adminClient1 : adminClient2;
      const clientB = shardB === 'shard_1' ? adminClient1 : adminClient2;
      await clientA.query('DELETE FROM businesses WHERE id = $1', [bizAId]).catch(() => {});
      await clientB.query('DELETE FROM businesses WHERE id = $1', [bizBId]).catch(() => {});

      const schemaA = shardA === 'shard_1' ? env.SHARD_1_SCHEMA : env.SHARD_2_SCHEMA;
      const schemaB = shardB === 'shard_1' ? env.SHARD_1_SCHEMA : env.SHARD_2_SCHEMA;
      await adminClient.query(`DELETE FROM ${schemaA}.businesses WHERE id = $1`, [bizAId]).catch(() => {});
      await adminClient.query(`DELETE FROM ${schemaB}.businesses WHERE id = $1`, [bizBId]).catch(() => {});
    } catch (_err) {
      // Ignore teardown errors
    } finally {
      await Promise.allSettled([adminClient.end(), adminClient1.end(), adminClient2.end()]);
      await closeAllPools();
    }
  });

  describe('A. Tenant Isolation and Row-Level Security', () => {
    it('Verified runtime execution role is strictly rota_app (non-superuser, NOBYPASSRLS)', async () => {
      await withTenantContext(bizAId, async (client) => {
        const userRes = await client.query('SELECT CURRENT_USER AS current_user, SESSION_USER AS session_user');
        assert.equal(userRes.rows[0].current_user, 'rota_app', 'Execution must run as rota_app');
        assert.equal(userRes.rows[0].session_user, 'rota_app', 'Session user must be rota_app');

        const roleRes = await client.query(
          'SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER'
        );
        assert.equal(roleRes.rows[0].rolsuper, false, 'Application role must NOT be a superuser');
        assert.equal(roleRes.rows[0].rolbypassrls, false, 'Application role must NOT have BYPASSRLS privilege');
      });
    });

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

    it('Tenant A cannot read Tenant B records even if querying explicitly by Tenant B business_id', async () => {
      await withTenantContext(bizAId, async (client) => {
        const res = await client.query('SELECT * FROM branches WHERE business_id = $1', [bizBId]);
        assert.equal(res.rows.length, 0, 'Tenant A must receive 0 rows when filtering by Tenant B business_id');
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

    it('Tenant A context cannot insert record with Tenant B business_id (spoofed business_id blocked by WITH CHECK)', async () => {
      await withTenantContext(bizAId, async (client) => {
        await assert.rejects(
          async () => {
            await client.query(
              'INSERT INTO branches (business_id, name) VALUES ($1, $2)',
              [bizBId, 'Malicious Branch Spoofing Tenant B']
            );
          },
          /new row violates row-level security policy/i,
          'Inserting a record with another tenant business_id must be rejected by RLS WITH CHECK'
        );
      });
    });

    it('Tenant A context cannot insert department claiming Tenant B business_id', async () => {
      await withTenantContext(bizAId, async (client) => {
        await assert.rejects(
          async () => {
            await client.query(
              'INSERT INTO departments (business_id, branch_id, name) VALUES ($1, $2, $3)',
              [bizBId, branchAId, 'Malicious Spoofed Department']
            );
          },
          /new row violates row-level security policy/i
        );
      });
    });

    it('Missing tenant context fails closed for reads (returns 0 rows on SELECT)', async () => {
      const pool = getShardPool(shardA);
      const client = await pool.connect();
      try {
        const res = await client.query('SELECT * FROM branches');
        assert.equal(res.rows.length, 0, 'Query without tenant context must return zero rows');
      } finally {
        client.release();
      }
    });

    it('Missing tenant context fails closed on INSERT across all tenant tables', async () => {
      const pool = getShardPool(shardA);
      const client = await pool.connect();
      try {
        // 1. businesses
        await assert.rejects(
          async () => {
            await client.query(
              'INSERT INTO businesses (id, name) VALUES ($1, $2)',
              [randomUUID(), 'Unauthorized Biz']
            );
          },
          /new row violates row-level security policy/i
        );

        // 2. branches
        await assert.rejects(
          async () => {
            await client.query(
              'INSERT INTO branches (business_id, name) VALUES ($1, $2)',
              [bizAId, 'Unauthorized Branch']
            );
          },
          /new row violates row-level security policy/i
        );

        // 3. departments
        await assert.rejects(
          async () => {
            await client.query(
              'INSERT INTO departments (business_id, branch_id, name) VALUES ($1, $2, $3)',
              [bizAId, branchAId, 'Unauthorized Dept']
            );
          },
          /new row violates row-level security policy/i
        );

        // 4. memberships
        await assert.rejects(
          async () => {
            await client.query(
              'INSERT INTO memberships (business_id, user_id, role) VALUES ($1, $2, $3)',
              [bizAId, randomUUID(), 'staff']
            );
          },
          /new row violates row-level security policy/i
        );
      } finally {
        client.release();
      }
    });

    it('Invalid business_id format and SQL injection payloads are rejected before execution', async () => {
      const malformedPayloads = [
        'not-a-valid-uuid',
        "00000000-0000-0000-0000-000000000000'; DROP TABLE branches; --",
        "' OR '1'='1",
        '00000000-0000-0000-0000-000000000000; SELECT 1',
        '',
        '   ',
      ];

      for (const payload of malformedPayloads) {
        await assert.rejects(
          async () => {
            await withTenantContext(payload, async () => {});
          },
          TenantContextError,
          `Payload '${payload}' must be rejected by validateBusinessId`
        );
      }
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
      const clientA = shardA === 'shard_1' ? adminClient1 : adminClient2;
      await assert.rejects(
        async () => {
          // Run as admin to bypass RLS and test the DB-level composite FK constraint directly
          await clientA.query(
            `INSERT INTO departments (business_id, branch_id, name) VALUES ($1, $2, $3)`,
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

      const res1 = await adminClient1.query(query, ['public']);
      const res2 = await adminClient2.query(query, ['public']);

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

      const rls1 = await adminClient1.query(rlsQuery, ['public']);
      const rls2 = await adminClient2.query(rlsQuery, ['public']);
      const pol1 = await adminClient1.query(policyQuery, ['public']);
      const pol2 = await adminClient2.query(policyQuery, ['public']);

      assert.deepEqual(rls1.rows, rls2.rows, 'RLS enforcement flags must be identical across shards');
      assert.deepEqual(pol1.rows, pol2.rows, 'RLS policies must be identical across shards');
    });
  });

  describe('E. Privilege Escalation and Security Boundary Defense', () => {
    it('Application role (rota_app) cannot disable RLS on tenant tables', async () => {
      await withTenantContext(bizAId, async (client) => {
        await assert.rejects(
          async () => {
            await client.query('ALTER TABLE branches DISABLE ROW LEVEL SECURITY');
          },
          /must be owner of table/i,
          'Non-owner application role must be blocked from disabling RLS'
        );
      });
    });

    it('Application role (rota_app) cannot drop tenant RLS policies', async () => {
      await withTenantContext(bizAId, async (client) => {
        await assert.rejects(
          async () => {
            await client.query('DROP POLICY tenant_isolation_branches ON branches');
          },
          /must be owner of (relation|table)/i,
          'Non-owner application role must be blocked from dropping policies'
        );
      });
    });

    it('Application role (rota_app) cannot grant itself superuser or bypassrls', async () => {
      await withTenantContext(bizAId, async (client) => {
        await assert.rejects(
          async () => {
            await client.query('ALTER ROLE rota_app WITH SUPERUSER');
          },
          /permission denied/i,
          'Application role must not be able to escalate its own role privileges'
        );
      });
    });

    it('Unregistered business UUID yields zero rows on SELECT and foreign key error on child insert', async () => {
      const nonExistentBizId = randomUUID();
      await withTenantContext(nonExistentBizId, async (client) => {
        const res = await client.query('SELECT * FROM branches');
        assert.equal(res.rows.length, 0, 'Unregistered business must receive zero rows');

        await assert.rejects(
          async () => {
            await client.query(
              'INSERT INTO branches (business_id, name) VALUES ($1, $2)',
              [nonExistentBizId, 'Orphan Branch']
            );
          },
          /violates foreign key constraint "branches_business_id_fkey"/i,
          'Inserting child resource without parent business must fail foreign key constraint'
        );
      });
    });
  });
});

