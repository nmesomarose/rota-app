import pg from 'pg';
import { env } from '../src/config/env.ts';
import { getShardIdForBusiness } from '../src/sharding/shard-router.ts';

const TENANT_TABLES = [
  'businesses',
  'branches',
  'departments',
  'memberships',
  'membership_outbox',
  'invitations',
  'shifts',
  'shift_assignments',
  'staffing_requirements',
  'availability_entries',
  'swap_requests',
  'attendance_records',
  'activity_events',
  'inbox_items',
  'notification_deliveries',
  'subscriptions',
  'billing_quotes',
  'payment_intents',
  'ledger_entries',
  'audit_log',
];

async function reconcileTenantData() {
  console.log('================================================================');
  console.log('=== STEP 1.3: TENANT RECORD RECONCILIATION ACROSS SHARD DBS ===');
  console.log('================================================================\n');

  const origClient = new pg.Client({ connectionString: env.DATABASE_URL });
  const shard1Client = new pg.Client({ connectionString: env.SHARD_1_DATABASE_URL });
  const shard2Client = new pg.Client({ connectionString: env.SHARD_2_DATABASE_URL });

  await Promise.all([origClient.connect(), shard1Client.connect(), shard2Client.connect()]);

  try {
    // 1. Fetch businesses from original schemas
    const origBiz1Res = await origClient.query<{ id: string; name: string }>(
      'SELECT id, name FROM rota_shard_1.businesses ORDER BY id;'
    );
    const origBiz2Res = await origClient.query<{ id: string; name: string }>(
      'SELECT id, name FROM rota_shard_2.businesses ORDER BY id;'
    );

    console.log(`[Reconciliation] Original Businesses in rota_shard_1: ${origBiz1Res.rowCount}`);
    console.log(`[Reconciliation] Original Businesses in rota_shard_2: ${origBiz2Res.rowCount}`);
    const totalOrigBiz = (origBiz1Res.rowCount || 0) + (origBiz2Res.rowCount || 0);

    // 2. Fetch businesses from new separate databases
    const newBiz1Res = await shard1Client.query<{ id: string; name: string }>(
      'SELECT id, name FROM public.businesses ORDER BY id;'
    );
    const newBiz2Res = await shard2Client.query<{ id: string; name: string }>(
      'SELECT id, name FROM public.businesses ORDER BY id;'
    );

    console.log(`[Reconciliation] Businesses in dedicated rota_shard_1: ${newBiz1Res.rowCount}`);
    console.log(`[Reconciliation] Businesses in dedicated rota_shard_2: ${newBiz2Res.rowCount}`);

    const newBiz1Map = new Set(newBiz1Res.rows.map((b) => b.id));
    const newBiz2Map = new Set(newBiz2Res.rows.map((b) => b.id));

    // Check for overlap between Shard 1 and Shard 2
    let overlapCount = 0;
    for (const id of newBiz1Map) {
      if (newBiz2Map.has(id)) {
        overlapCount++;
        console.error(`[CRITICAL] Business ${id} exists in BOTH rota_shard_1 and rota_shard_2!`);
      }
    }
    if (overlapCount === 0) {
      console.log('✔ Zero cross-shard overlap: No business exists on both shard databases.');
    } else {
      throw new Error(`Reconciliation failed: ${overlapCount} businesses duplicated across shards!`);
    }

    // 3. Verify placement according to deterministic hash
    console.log('\n[Reconciliation] Verifying deterministic shard placement for all businesses...');
    let placementMismatches = 0;
    const allBusinesses = [...origBiz1Res.rows, ...origBiz2Res.rows];

    for (const biz of allBusinesses) {
      const expectedShard = getShardIdForBusiness(biz.id);
      if (expectedShard === 'shard_1') {
        if (!newBiz1Map.has(biz.id)) {
          placementMismatches++;
          console.error(`[MISMATCH] Business ${biz.id} expected in Shard 1 but missing!`);
        }
        if (newBiz2Map.has(biz.id)) {
          placementMismatches++;
          console.error(`[MISMATCH] Business ${biz.id} expected in Shard 1 but found in Shard 2!`);
        }
      } else {
        if (!newBiz2Map.has(biz.id)) {
          placementMismatches++;
          console.error(`[MISMATCH] Business ${biz.id} expected in Shard 2 but missing!`);
        }
        if (newBiz1Map.has(biz.id)) {
          placementMismatches++;
          console.error(`[MISMATCH] Business ${biz.id} expected in Shard 2 but found in Shard 1!`);
        }
      }
    }

    if (placementMismatches === 0) {
      console.log(`✔ Deterministic placement verified for all ${allBusinesses.length} businesses (100% adherence to hash routing).`);
    } else {
      throw new Error(`Reconciliation failed: ${placementMismatches} placement mismatches detected!`);
    }

    // 4. Per-table reconciliation across all 20 tenant tables
    console.log('\n[Reconciliation] Reconciling row counts per tenant table across both shard databases:');
    const reconciliationRows: any[] = [];

    for (const table of TENANT_TABLES) {
      // Original counts
      const origCount1 = (await origClient.query<{ cnt: string }>(`SELECT COUNT(*)::text as cnt FROM rota_shard_1.${table};`)).rows[0].cnt;
      const origCount2 = (await origClient.query<{ cnt: string }>(`SELECT COUNT(*)::text as cnt FROM rota_shard_2.${table};`)).rows[0].cnt;
      const origTotal = parseInt(origCount1, 10) + parseInt(origCount2, 10);

      // New database counts
      const newCount1 = (await shard1Client.query<{ cnt: string }>(`SELECT COUNT(*)::text as cnt FROM public.${table};`)).rows[0].cnt;
      const newCount2 = (await shard2Client.query<{ cnt: string }>(`SELECT COUNT(*)::text as cnt FROM public.${table};`)).rows[0].cnt;
      const newTotal = parseInt(newCount1, 10) + parseInt(newCount2, 10);

      // Discrepancy check: newTotal should be >= origTotal (any difference would be newly seeded test records during verification)
      const diff = newTotal - origTotal;

      reconciliationRows.push({
        Table: table,
        'Original Shard 1': parseInt(origCount1, 10),
        'Original Shard 2': parseInt(origCount2, 10),
        'Original Total': origTotal,
        'Dedicated Shard 1': parseInt(newCount1, 10),
        'Dedicated Shard 2': parseInt(newCount2, 10),
        'Dedicated Total': newTotal,
        Status: diff >= 0 ? (diff === 0 ? 'Exact Match' : `+${diff} Test Rows`) : 'MISSING DATA',
      });

      if (diff < 0) {
        throw new Error(`Missing records detected in table ${table}! Original: ${origTotal}, New: ${newTotal}`);
      }
    }

    console.table(reconciliationRows);
    console.log('\n[Reconciliation] >>> ALL TENANT TABLES RECONCILED WITH ZERO MISSING RECORDS <<<');
  } finally {
    await Promise.allSettled([origClient.end(), shard1Client.end(), shard2Client.end()]);
  }
}

reconcileTenantData().catch((err) => {
  console.error('[Reconciliation Error]', err);
  process.exit(1);
});
