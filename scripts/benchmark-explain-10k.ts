/**
 * Benchmark & Query Plan Analysis: Activity Feed 10,000 Records
 * PRD Reference: AC-014, AC-015, AC-ACT-05, NFR-PERF-001
 *
 * Measures PostgreSQL EXPLAIN (ANALYZE, BUFFERS, VERBOSE) query execution plans
 * before and after the composite index (business_id, created_at DESC, id DESC)
 * on a verified dataset of exactly 10,000 activity events in a safe, disposable table.
 *
 * Zero modification to existing production or shard database schemas.
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { env } from '../src/config/env.ts';

const { Pool } = pg;

interface ExplainPlanSummary {
  planningTimeMs: number;
  executionTimeMs: number;
  planLines: string[];
  scanMethod: string;
  buffersHit: number;
  buffersRead: number;
}

function parsePlan(lines: string[]): ExplainPlanSummary {
  let planningTimeMs = 0;
  let executionTimeMs = 0;
  let scanMethod = 'Unknown';
  let buffersHit = 0;
  let buffersRead = 0;

  for (const line of lines) {
    if (line.includes('Execution Time:')) {
      const match = line.match(/Execution Time:\s+([\d.]+)\s+ms/);
      if (match) executionTimeMs = parseFloat(match[1]);
    }
    if (line.includes('Planning Time:')) {
      const match = line.match(/Planning Time:\s+([\d.]+)\s+ms/);
      if (match) planningTimeMs = parseFloat(match[1]);
    }
    if (line.includes('Index Scan')) {
      scanMethod = line.trim();
    } else if (line.includes('Seq Scan') && scanMethod === 'Unknown') {
      scanMethod = line.trim();
    }
    if (line.includes('Buffers:')) {
      const hitMatch = line.match(/shared hit=(\d+)/);
      if (hitMatch) buffersHit += parseInt(hitMatch[1], 10);
      const readMatch = line.match(/shared read=(\d+)/);
      if (readMatch) buffersRead += parseInt(readMatch[1], 10);
    }
  }

  return {
    planningTimeMs,
    executionTimeMs,
    planLines: lines,
    scanMethod,
    buffersHit,
    buffersRead,
  };
}

async function runBenchmark() {
  console.log('='.repeat(80));
  console.log('ROTA 10,000-RECORD ACTIVITY FEED EXPLAIN ANALYZE BENCHMARK');
  console.log('Target: Measuring Index Scan vs. Seq Scan on 10,000 Seeded Records');
  console.log('='.repeat(80));

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
  });

  const client = await pool.connect();

  const businessId = randomUUID();
  const branchId = randomUUID();
  const deptId = randomUUID();
  const actorId = randomUUID();

  try {
    console.log('\n[1/6] Provisioning disposable test table: temp_activity_events_bench...');
    await client.query(`
      CREATE TEMP TABLE temp_activity_events_bench (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        type VARCHAR(100) NOT NULL,
        branch_id UUID,
        department_id UUID,
        actor_membership_id UUID,
        subject_membership_id UUID,
        visibility_class VARCHAR(50) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'
      );
    `);

    console.log('[2/6] Seeding 10,000 activity event records for business:', businessId);
    const seedStart = Date.now();
    await client.query(
      `
      INSERT INTO temp_activity_events_bench (
        business_id, created_at, type, branch_id, department_id,
        actor_membership_id, visibility_class, payload
      )
      SELECT
        $1,
        NOW() - (n || ' seconds')::interval,
        CASE (n % 4)
          WHEN 0 THEN 'schedule.shift_created'
          WHEN 1 THEN 'swaps.requested'
          WHEN 2 THEN 'attendance.clock_in'
          ELSE 'membership.invited'
        END,
        $2,
        $3,
        $4,
        CASE (n % 4)
          WHEN 0 THEN 'schedule'
          WHEN 1 THEN 'swap'
          WHEN 2 THEN 'attendance'
          ELSE 'public'
        END,
        jsonb_build_object('eventIndex', n, 'importance', 'normal')
      FROM generate_series(1, 10000) AS n
    `,
      [businessId, branchId, deptId, actorId]
    );

    // Also seed 2,000 records from other businesses to evaluate multi-tenant selectivity
    await client.query(`
      INSERT INTO temp_activity_events_bench (
        business_id, created_at, type, visibility_class, payload
      )
      SELECT
        gen_random_uuid(),
        NOW() - (n || ' seconds')::interval,
        'schedule.shift_created',
        'public',
        '{}'::jsonb
      FROM generate_series(1, 2000) AS n
    `);

    await client.query('ANALYZE temp_activity_events_bench;');
    console.log(`[2/6] Seeding complete in ${Date.now() - seedStart} ms. Total rows: 12,000 (10,000 target business).`);

    const querySql = `
      SELECT id, created_at, type, branch_id, department_id, visibility_class, payload
      FROM temp_activity_events_bench
      WHERE business_id = $1
        AND visibility_class IN ('schedule', 'public')
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    `;

    console.log('\n[3/6] Running EXPLAIN (ANALYZE, BUFFERS, VERBOSE) BEFORE INDEX (Seq Scan baseline)...');
    const beforeRes = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE) ${querySql}`,
      [businessId]
    );
    const beforeSummary = parsePlan(beforeRes.rows.map((r) => r['QUERY PLAN']));

    console.log(` -> Planning Time: ${beforeSummary.planningTimeMs} ms`);
    console.log(` -> Execution Time: ${beforeSummary.executionTimeMs} ms`);
    console.log(` -> Scan Method: ${beforeSummary.scanMethod}`);

    console.log('\n[4/6] Creating composite index: idx_activity_bench_feed ON (business_id, created_at DESC, id DESC)...');
    const indexStart = Date.now();
    await client.query(`
      CREATE INDEX idx_activity_bench_feed
      ON temp_activity_events_bench (business_id, created_at DESC, id DESC);
    `);
    await client.query('ANALYZE temp_activity_events_bench;');
    console.log(` -> Index created in ${Date.now() - indexStart} ms`);

    console.log('\n[5/6] Running EXPLAIN (ANALYZE, BUFFERS, VERBOSE) AFTER INDEX (Index Scan optimized)...');
    const afterRes = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE) ${querySql}`,
      [businessId]
    );
    const afterSummary = parsePlan(afterRes.rows.map((r) => r['QUERY PLAN']));

    console.log(` -> Planning Time: ${afterSummary.planningTimeMs} ms`);
    console.log(` -> Execution Time: ${afterSummary.executionTimeMs} ms`);
    console.log(` -> Scan Method: ${afterSummary.scanMethod}`);

    const speedup = (beforeSummary.executionTimeMs / Math.max(0.001, afterSummary.executionTimeMs)).toFixed(2);
    console.log(`\n -> Empirical Speedup: ${speedup}x`);

    console.log('\n[6/6] Testing Keyset Cursor Pagination Query (created_at < cursor)...');
    // Fetch an event around the 50th position for a realistic cursor
    const sampleEvent = await client.query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM temp_activity_events_bench WHERE business_id = $1 ORDER BY created_at DESC, id DESC OFFSET 50 LIMIT 1`,
      [businessId]
    );
    const cursor = sampleEvent.rows[0];

    const cursorQuerySql = `
      SELECT id, created_at, type, branch_id, department_id, visibility_class, payload
      FROM temp_activity_events_bench
      WHERE business_id = $1
        AND visibility_class IN ('schedule', 'public')
        AND (created_at < $2 OR (created_at = $2 AND id < $3))
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    `;

    const cursorExplain = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE) ${cursorQuerySql}`,
      [businessId, cursor.created_at, cursor.id]
    );
    const cursorSummary = parsePlan(cursorExplain.rows.map((r) => r['QUERY PLAN']));

    console.log(` -> Keyset Cursor Execution Time: ${cursorSummary.executionTimeMs} ms`);
    console.log(` -> Keyset Scan Method: ${cursorSummary.scanMethod}`);

    // Output complete JSON report for evidence embedding
    console.log('\n' + '='.repeat(80));
    console.log('EXPLAIN ANALYZE BEFORE INDEX PLAN:');
    console.log('='.repeat(80));
    console.log(beforeSummary.planLines.join('\n'));

    console.log('\n' + '='.repeat(80));
    console.log('EXPLAIN ANALYZE AFTER INDEX PLAN:');
    console.log('='.repeat(80));
    console.log(afterSummary.planLines.join('\n'));

    console.log('\n' + '='.repeat(80));
    console.log('EXPLAIN ANALYZE KEYSET CURSOR PLAN:');
    console.log('='.repeat(80));
    console.log(cursorSummary.planLines.join('\n'));

    return {
      beforeSummary,
      afterSummary,
      cursorSummary,
      speedup,
    };
  } finally {
    // Drop temporary table and release client
    await client.query('DROP TABLE IF EXISTS temp_activity_events_bench;');
    client.release();
    await pool.end();
  }
}

runBenchmark()
  .then(() => {
    console.log('\nBenchmark completed successfully.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
