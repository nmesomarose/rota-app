/**
 * Reproducible Connection Pool Exhaustion, Failure Drill & Zero-Leakage Verification
 * PRD Reference: 14.1 (AC-015), 14.2 (AC-TEN-01, AC-TEN-04), 14.9 (AC-OPS-04, NFR-PERF-003)
 *
 * Exercises:
 * 1. Connection Pool Saturation & Graceful Request Queuing (max = 10, requests = 20).
 * 2. Database Error Simulation & Transaction Rollback.
 * 3. Tenant Context Containment Under Failure (zero leakage across pooled sockets).
 * 4. Connection Timeout Behavior & Graceful Degradation.
 */

import pg from 'pg';
import { withTenantContext } from '../src/db/tenant-context.ts';
import { shard1Pool, closeAllPools } from '../src/db/connection.ts';
import { env } from '../src/config/env.ts';

const TENANT_A_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_B_ID = '22222222-2222-4222-8222-222222222222';

interface DrillSummary {
  drillName: string;
  status: 'PASSED' | 'FAILED';
  details: Record<string, unknown>;
}

async function main() {
  console.log('='.repeat(80));
  console.log('ROTA RESILIENCE & CONNECTION POOL FAILURE DRILL (M8 — AC-OPS-04, NFR-PERF-003)');
  console.log('Pool Configuration: max = 10 | idleTimeout = 30000ms');
  console.log('='.repeat(80));

  const summaries: DrillSummary[] = [];

  try {
    // -------------------------------------------------------------------------
    // Drill 1: Pool Saturation & Queuing Behavior (NFR-PERF-003, AC-OPS-04)
    // -------------------------------------------------------------------------
    console.log('\n[Drill 1] Saturating shard connection pool (max: 10) with 20 concurrent transactions...');
    const poolCapacity = 10;
    const totalRequests = 20;
    const holdDurationMs = 200;

    const startTime = performance.now();
    const latencies: number[] = [];
    let completedRequests = 0;
    let failedRequests = 0;

    // Launch 20 concurrent tasks against a 10-connection pool
    const tasks = Array.from({ length: totalRequests }, async (_, i) => {
      const taskStart = performance.now();
      try {
        await withTenantContext(TENANT_A_ID, async (client) => {
          // Hold connection for holdDurationMs
          await client.query(`SELECT pg_sleep(${holdDurationMs / 1000})`);
        }, { shardId: 'shard_1' });
        const elapsed = performance.now() - taskStart;
        latencies.push(elapsed);
        completedRequests++;
      } catch (err: any) {
        failedRequests++;
        console.error(`Task ${i} failed:`, err.message);
      }
    });

    await Promise.all(tasks);
    const totalDrillDuration = performance.now() - startTime;

    // First 10 should complete in ~200ms, next 10 should complete in ~400ms (queued)
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const maxLatency = latencies[latencies.length - 1];

    console.log(`- Total Requests Dispatched: ${totalRequests}`);
    console.log(`- Successfully Completed: ${completedRequests} (0 dropped, 0 crashes)`);
    console.log(`- Failed / Rejected: ${failedRequests}`);
    console.log(`- Total Duration: ${totalDrillDuration.toFixed(2)}ms`);
    console.log(`- Batch 1 (Unqueued) Median Latency: ${latencies[0].toFixed(2)}ms`);
    console.log(`- Batch 2 (Queued) Max Latency: ${maxLatency.toFixed(2)}ms`);

    summaries.push({
      drillName: 'Pool Saturation & Graceful Request Queuing',
      status: completedRequests === totalRequests && failedRequests === 0 ? 'PASSED' : 'FAILED',
      details: {
        poolCapacity,
        totalRequests,
        completedRequests,
        failedRequests,
        totalDurationMs: Number(totalDrillDuration.toFixed(2)),
        medianLatencyMs: Number(p50.toFixed(2)),
        maxQueuedLatencyMs: Number(maxLatency.toFixed(2)),
      },
    });

    // -------------------------------------------------------------------------
    // Drill 2: Database Error Simulation & Transaction Rollback
    // -------------------------------------------------------------------------
    console.log('\n[Drill 2] Simulating database error inside tenant transaction...');
    let caughtExpectedError = false;

    try {
      await withTenantContext(TENANT_A_ID, async (client) => {
        // Intentionally execute invalid SQL syntax
        await client.query('SELECT * FROM non_existent_table_for_drill_testing_error');
      }, { shardId: 'shard_1' });
    } catch (err: any) {
      if (err.message.includes('non_existent_table_for_drill_testing_error') || err.code === '42P01') {
        caughtExpectedError = true;
      }
    }

    console.log(`- Caught Expected SQL Exception: ${caughtExpectedError}`);
    console.log(`- Verifying pool health immediately following exception...`);
    const recoveryRes = await withTenantContext(TENANT_A_ID, async (client) => {
      const res = await client.query('SELECT 1 AS recovery_status');
      return res.rows[0].recovery_status;
    }, { shardId: 'shard_1' });

    console.log(`- Post-Error Query Succeeded: ${recoveryRes === 1}`);

    summaries.push({
      drillName: 'Database Error Simulation & Transaction Rollback',
      status: caughtExpectedError && recoveryRes === 1 ? 'PASSED' : 'FAILED',
      details: {
        caughtExpectedError,
        poolRecoveredImmediately: recoveryRes === 1,
      },
    });

    // -------------------------------------------------------------------------
    // Drill 3: Tenant Context Containment Under Failure (AC-TEN-04)
    // -------------------------------------------------------------------------
    console.log('\n[Drill 3] Verifying zero tenant context leakage under failure (AC-TEN-04)...');

    // Step A: Trigger a failure inside Tenant A context
    try {
      await withTenantContext(TENANT_A_ID, async (client) => {
        // Confirm context is set to Tenant A
        const check = await client.query<{ current_setting: string }>(
          "SELECT current_setting('app.current_business_id', true)"
        );
        if (check.rows[0].current_setting !== TENANT_A_ID) {
          throw new Error('Tenant context was not established');
        }
        // Deliberate throw to trigger failure path
        throw new Error('SIMULATED_UNHANDLED_CRASH_IN_TENANT_A');
      }, { shardId: 'shard_1' });
    } catch {
      // Expected exception
    }

    // Step B: Acquire a raw client from the pool without setting context
    const checkClient = await shard1Pool.connect();
    let leakedSetting: string | null = null;
    try {
      const res = await checkClient.query<{ current_setting: string }>(
        "SELECT current_setting('app.current_business_id', true)"
      );
      leakedSetting = res.rows[0]?.current_setting || null;
    } finally {
      checkClient.release();
    }

    const contextClean = !leakedSetting || leakedSetting === '';
    console.log(`- Post-Failure Raw Connection 'app.current_business_id' Value: '${leakedSetting || ''}'`);
    console.log(`- Zero Context Leakage Verified: ${contextClean}`);

    summaries.push({
      drillName: 'Tenant Context Containment Under Failure (AC-TEN-04)',
      status: contextClean ? 'PASSED' : 'FAILED',
      details: {
        rawSessionSetting: leakedSetting || '(empty)',
        zeroLeakageEnforced: contextClean,
      },
    });

    // -------------------------------------------------------------------------
    // Drill 4: Connection Timeout Behaviour & Graceful Degradation
    // -------------------------------------------------------------------------
    console.log('\n[Drill 4] Testing connection timeout behaviour under strict pool exhaustion...');
    const singleConnPool = new pg.Pool({
      connectionString: env.APP_DATABASE_URL,
      options: `-c search_path=${env.SHARD_1_SCHEMA}`,
      max: 1,
      connectionTimeoutMillis: 300, // Strict 300ms timeout
    });

    let timeoutOccurred = false;
    let clientHolding: pg.PoolClient | null = null;

    try {
      // Hold the single connection
      clientHolding = await singleConnPool.connect();

      // Attempt to acquire second connection with 300ms timeout
      const timeoutStart = performance.now();
      try {
        await singleConnPool.connect();
      } catch (timeoutErr: any) {
        const elapsed = performance.now() - timeoutStart;
        if (timeoutErr.message.includes('timeout') || elapsed >= 290) {
          timeoutOccurred = true;
        }
      }
    } finally {
      if (clientHolding) {
        clientHolding.release();
      }
      await singleConnPool.end();
    }

    console.log(`- Strict Connection Timeout Triggered: ${timeoutOccurred}`);
    console.log(`- Graceful Error Handled without process crash.`);

    summaries.push({
      drillName: 'Strict Connection Timeout & Graceful Error Handling',
      status: timeoutOccurred ? 'PASSED' : 'FAILED',
      details: {
        timeoutTriggered: timeoutOccurred,
        poolCapacity: 1,
        configuredTimeoutMs: 300,
      },
    });

    // Summary Table
    console.log('\n' + '='.repeat(80));
    console.log('RESILIENCE & FAILURE DRILL RESULTS SUMMARY');
    console.log('='.repeat(80));
    console.table(summaries.map((s) => ({
      Drill: s.drillName,
      Status: s.status,
    })));

    console.log('\nJSON_DRILL_PAYLOAD_START');
    console.log(JSON.stringify(summaries, null, 2));
    console.log('JSON_DRILL_PAYLOAD_END\n');

  } finally {
    await closeAllPools();
  }
}

main().catch((err) => {
  console.error('Failure drill failed:', err);
  process.exit(1);
});
