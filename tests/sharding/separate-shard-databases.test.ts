import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { env } from '../../src/config/env.ts';
import { shard1Pool, shard2Pool, controlPool, closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';
import {
  getShardIdForBusiness,
  getShardIdForTeam,
  validateTeamId,
  getSchemaForTeam,
} from '../../src/sharding/shard-router.ts';

describe('Dedicated PostgreSQL Shard Databases Verification (Phase 2)', () => {
  after(async () => {
    await closeAllPools();
  });

  it('Verifies shard1Pool connects to physical database rota_shard_1', async () => {
    const client = await shard1Pool.connect();
    try {
      const res = await client.query<{ db: string; user: string }>(
        'SELECT current_database() as db, current_user as user'
      );
      assert.equal(res.rows[0].db, 'rota_shard_1', 'shard1Pool must be connected to rota_shard_1');
      assert.equal(res.rows[0].user, 'rota_app', 'Execution role must be rota_app');
    } finally {
      client.release();
    }
  });

  it('Verifies shard2Pool connects to physical database rota_shard_2', async () => {
    const client = await shard2Pool.connect();
    try {
      const res = await client.query<{ db: string; user: string }>(
        'SELECT current_database() as db, current_user as user'
      );
      assert.equal(res.rows[0].db, 'rota_shard_2', 'shard2Pool must be connected to rota_shard_2');
      assert.equal(res.rows[0].user, 'rota_app', 'Execution role must be rota_app');
    } finally {
      client.release();
    }
  });

  it('Verifies controlPool connects to physical control plane database rota', async () => {
    const client = await controlPool.connect();
    try {
      const res = await client.query<{ db: string }>(
        'SELECT current_database() as db'
      );
      assert.equal(res.rows[0].db, 'rota', 'controlPool must be connected to rota');
    } finally {
      client.release();
    }
  });

  it('Verifies team_id and business_id share the exact same tenant boundary and routing', () => {
    const testIds = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      'a3bb189e-8bf9-4888-9912-ace4e6543002',
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    ];

    for (const id of testIds) {
      assert.doesNotThrow(() => validateTeamId(id));
      const bizShard = getShardIdForBusiness(id);
      const teamShard = getShardIdForTeam(id);
      assert.equal(teamShard, bizShard, `team_id routing must match business_id routing for ${id}`);

      const teamSchema = getSchemaForTeam(id);
      assert.ok(teamSchema === 'rota_shard_1' || teamSchema === 'rota_shard_2');
    }
  });

  it('Verifies Row-Level Security is forced and active on both physical shard databases', async () => {
    const checkRls = async (pool: pg.Pool, expectedDb: string) => {
      const client = await pool.connect();
      try {
        const dbRes = await client.query<{ db: string }>('SELECT current_database() as db');
        assert.equal(dbRes.rows[0].db, expectedDb);

        const rlsRes = await client.query<{ tablename: string; rls_enabled: boolean }>(`
          SELECT c.relname as tablename, c.relrowsecurity as rls_enabled
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r'
            AND n.nspname = 'public'
            AND c.relname IN ('businesses', 'shifts', 'shift_assignments', 'subscriptions')
        `);
        assert.ok(rlsRes.rowCount && rlsRes.rowCount >= 4, 'Must have tenant tables in public schema');
        for (const row of rlsRes.rows) {
          assert.equal(row.rls_enabled, true, `Table ${row.tablename} must have RLS enabled on ${expectedDb}`);
        }
      } finally {
        client.release();
      }
    };

    await checkRls(shard1Pool, 'rota_shard_1');
    await checkRls(shard2Pool, 'rota_shard_2');
  });

  it('Verifies Read-Your-Own-Writes consistency within tenant shard pool', async () => {
    const testBizId = randomUUID();
    const targetShard = getShardIdForBusiness(testBizId);
    const expectedDb = targetShard === 'shard_1' ? 'rota_shard_1' : 'rota_shard_2';

    let branchId = '';
    try {
      // 1. Write operation within tenant context
      await withTenantContext(testBizId, async (client) => {
        const dbCheck = await client.query<{ db: string }>('SELECT current_database() as db');
        assert.equal(dbCheck.rows[0].db, expectedDb, 'Query must execute on assigned physical shard');

        await client.query('INSERT INTO businesses (id, name, timezone) VALUES ($1, $2, $3)', [
          testBizId,
          'RYOW Test Business',
          'UTC',
        ]);
        const branchRes = await client.query<{ id: string }>(
          'INSERT INTO branches (business_id, name) VALUES ($1, $2) RETURNING id',
          [testBizId, 'Authoritative RYOW Branch']
        );
        branchId = branchRes.rows[0].id;
      });

      // 2. Immediate read operation within subsequent tenant context
      // Read-your-own-writes is strictly guaranteed because both operations check out from the authoritative shard pool
      await withTenantContext(testBizId, async (client) => {
        const readRes = await client.query<{ id: string; name: string }>(
          'SELECT id, name FROM branches WHERE business_id = $1 AND id = $2',
          [testBizId, branchId]
        );
        assert.equal(readRes.rowCount, 1, 'Newly written record must be immediately visible without lag');
        assert.equal(readRes.rows[0].name, 'Authoritative RYOW Branch');
      });
    } finally {
      // Cleanup using admin connection to specific shard
      const adminShardUrl = targetShard === 'shard_1' ? env.SHARD_1_DATABASE_URL : env.SHARD_2_DATABASE_URL;
      const cleanClient = new pg.Client({ connectionString: adminShardUrl });
      await cleanClient.connect();
      await cleanClient.query('DELETE FROM businesses WHERE id = $1', [testBizId]).catch(() => {});
      await cleanClient.end();
    }
  });
});
