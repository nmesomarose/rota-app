import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import { getShardIdForBusiness } from '../src/sharding/shard-router.ts';

dotenv.config();

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

async function runDeepVerification() {
  console.log('========================================================================');
  console.log('=== STEP 1: PRIMARY KEY & TENANT-ID RECORD RECONCILIATION AUDIT ===');
  console.log('========================================================================\n');

  // Load backup manifest
  const backupDir = path.resolve(process.cwd(), 'backups');
  const backupFiles = fs.readdirSync(backupDir).filter((f) => f.endsWith('.json')).sort().reverse();
  if (backupFiles.length === 0) {
    throw new Error('No backup manifest found');
  }
  const backupPath = path.join(backupDir, backupFiles[0]);
  console.log(`[Audit] Reading backup manifest: ${backupPath}`);
  const manifest = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

  const shard1Url = process.env.SHARD_1_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rota_shard_1';
  const shard2Url = process.env.SHARD_2_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rota_shard_2';
  const controlUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rota';

  const client1 = new pg.Client({ connectionString: shard1Url });
  const client2 = new pg.Client({ connectionString: shard2Url });
  const controlClient = new pg.Client({ connectionString: controlUrl });

  await Promise.all([client1.connect(), client2.connect(), controlClient.connect()]);

  try {
    let totalOriginalRecordsChecked = 0;
    let totalVerifiedOnCorrectShard = 0;
    let totalMissing = 0;
    let totalWrongShard = 0;
    let totalDuplicateAcrossShards = 0;

    const tableSummary: any[] = [];

    // For each tenant table, check every single row in the backup
    for (const tableName of TENANT_TABLES) {
      // Find PK columns for this table from database schema
      const pkRes = await client1.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = 'public'
          AND tc.table_name = $1
        ORDER BY kcu.ordinal_position;
      `, [tableName]);

      const pkCols = pkRes.rows.map((r) => r.column_name);
      const isBusinessTable = tableName === 'businesses';
      const tenantCol = isBusinessTable ? 'id' : 'business_id';

      // Extract backup rows for this table across rota_shard_1 and rota_shard_2 in backup
      const origRows1 = manifest.tables[`rota_shard_1.${tableName}`]?.rows || [];
      const origRows2 = manifest.tables[`rota_shard_2.${tableName}`]?.rows || [];
      const allOrigRows = [...origRows1, ...origRows2];

      const getPkComposite = (row: any) => pkCols.map((c) => String(row[c])).join('::');

      const backupPkMap = new Map<string, any>();
      for (const row of allOrigRows) {
        backupPkMap.set(getPkComposite(row), row);
      }

      // Fetch all PKs and tenant IDs currently in dedicated shard 1
      const selectCols = Array.from(new Set([...pkCols, tenantCol])).map((c) => `"${c}"`).join(', ');
      const shard1RowsRes = await client1.query(`SELECT ${selectCols} FROM "${tableName}"`);
      const shard1PkMap = new Map<string, string>();
      for (const r of shard1RowsRes.rows) {
        shard1PkMap.set(getPkComposite(r), r[tenantCol]);
      }

      // Fetch all PKs and tenant IDs currently in dedicated shard 2
      const shard2RowsRes = await client2.query(`SELECT ${selectCols} FROM "${tableName}"`);
      const shard2PkMap = new Map<string, string>();
      for (const r of shard2RowsRes.rows) {
        shard2PkMap.set(getPkComposite(r), r[tenantCol]);
      }

      let tableOriginalCount = allOrigRows.length;
      let tableCorrectShardMatches = 0;
      let tableMissing = 0;
      let tableWrongShard = 0;
      let tableCrossShardDupes = 0;

      for (const origRow of allOrigRows) {
        const pkKey = getPkComposite(origRow);
        const bizId = origRow[tenantCol];
        const expectedShard = getShardIdForBusiness(bizId);

        const inShard1 = shard1PkMap.has(pkKey);
        const inShard2 = shard2PkMap.has(pkKey);

        if (inShard1 && inShard2) {
          tableCrossShardDupes++;
        }

        if (expectedShard === 'shard_1') {
          if (inShard1) {
            tableCorrectShardMatches++;
          } else {
            tableMissing++;
          }
          if (inShard2 && !inShard1) {
            tableWrongShard++;
          }
        } else {
          // expected shard_2
          if (inShard2) {
            tableCorrectShardMatches++;
          } else {
            tableMissing++;
          }
          if (inShard1 && !inShard2) {
            tableWrongShard++;
          }
        }
      }

      totalOriginalRecordsChecked += tableOriginalCount;
      totalVerifiedOnCorrectShard += tableCorrectShardMatches;
      totalMissing += tableMissing;
      totalWrongShard += tableWrongShard;
      totalDuplicateAcrossShards += tableCrossShardDupes;

      // Identify extra records (present in live shard DB but not in backup)
      const extraShard1 = shard1RowsRes.rows.filter((r) => !backupPkMap.has(getPkComposite(r)));
      const extraShard2 = shard2RowsRes.rows.filter((r) => !backupPkMap.has(getPkComposite(r)));
      const extraTotal = extraShard1.length + extraShard2.length;

      tableSummary.push({
        Table: tableName,
        'PK Definition': pkCols.join(', '),
        'Backup Rows': tableOriginalCount,
        'Correct Shard Matches': tableCorrectShardMatches,
        'Missing': tableMissing,
        'Wrong Shard': tableWrongShard,
        'Cross-Shard Dupes': tableCrossShardDupes,
        'Extra (Tests)': extraTotal,
      });
    }

    console.table(tableSummary);
    console.log(`\n------------------------------------------------------------`);
    console.log(`Total Original Tenant Records Checked by PK : ${totalOriginalRecordsChecked}`);
    console.log(`Total PK Matches on Deterministic Shards    : ${totalVerifiedOnCorrectShard}`);
    console.log(`Total Missing Original Records              : ${totalMissing}`);
    console.log(`Total Wrong Shard Records                   : ${totalWrongShard}`);
    console.log(`Total Cross-Shard Duplicate Records         : ${totalDuplicateAcrossShards}`);
    console.log(`------------------------------------------------------------\n`);

    // STEP 2: Detail the 159 Extra Records and inspect their origin
    console.log('========================================================================');
    console.log('=== STEP 2: AUDITING THE 159 POST-BACKUP ADDITIONAL RECORDS ===');
    console.log('========================================================================\n');

    // Check businesses created post-backup
    const origBizIds = new Set([
      ...(manifest.tables['rota_shard_1.businesses']?.rows || []).map((r: any) => r.id),
      ...(manifest.tables['rota_shard_2.businesses']?.rows || []).map((r: any) => r.id),
    ]);

    const newBiz1 = (await client1.query('SELECT id, name, created_at FROM businesses')).rows.filter((b) => !origBizIds.has(b.id));
    const newBiz2 = (await client2.query('SELECT id, name, created_at FROM businesses')).rows.filter((b) => !origBizIds.has(b.id));
    const allNewBiz = [...newBiz1, ...newBiz2];

    console.log(`[Audit] Post-backup businesses created in shard databases (${allNewBiz.length} total):`);
    for (const b of allNewBiz) {
      console.log(`  - Business: "${b.name}" (ID: ${b.id}, CreatedAt: ${b.created_at})`);
    }

    // Detail breakdown of extra rows across all tables
    console.log('\n[Audit] Breakdown of Extra Records by Table and Tenant:');
    let grandExtraCount = 0;
    for (const tableName of TENANT_TABLES) {
      const isBusinessTable = tableName === 'businesses';
      const tenantCol = isBusinessTable ? 'id' : 'business_id';
      const pkRes = await client1.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = 'public'
          AND tc.table_name = $1
        ORDER BY kcu.ordinal_position;
      `, [tableName]);
      const pkCols = pkRes.rows.map((r) => r.column_name);
      const getPkComposite = (row: any) => pkCols.map((c) => String(row[c])).join('::');

      const origRows = [
        ...(manifest.tables[`rota_shard_1.${tableName}`]?.rows || []),
        ...(manifest.tables[`rota_shard_2.${tableName}`]?.rows || []),
      ];
      const backupPkSet = new Set(origRows.map(getPkComposite));

      const shard1Extra = (await client1.query(`SELECT * FROM "${tableName}"`)).rows.filter((r) => !backupPkSet.has(getPkComposite(r)));
      const shard2Extra = (await client2.query(`SELECT * FROM "${tableName}"`)).rows.filter((r) => !backupPkSet.has(getPkComposite(r)));
      const extraRows = [...shard1Extra, ...shard2Extra];

      if (extraRows.length > 0) {
        grandExtraCount += extraRows.length;
        const tenantOwners = new Set(extraRows.map((r) => r[tenantCol]));
        console.log(`  Table "${tableName}": +${extraRows.length} rows (belonging to ${tenantOwners.size} test tenant IDs: ${Array.from(tenantOwners).slice(0, 3).join(', ')}${tenantOwners.size > 3 ? '...' : ''})`);
      }
    }
    console.log(`Total Extra Tenant Records Audited: ${grandExtraCount}`);

    // STEP 3: Investigate pre-migration schema counts vs backup counts in control database
    console.log('\n========================================================================');
    console.log('=== STEP 3: EXPLAINING PRE-MIGRATION SCHEMA COUNTS IN rota DB ===');
    console.log('========================================================================\n');

    console.log('Comparison of Backup Snapshot vs Current rota_shard_1 / rota_shard_2 in "rota" DB:');
    for (const schema of ['rota_shard_1', 'rota_shard_2']) {
      let schemaLiveTotal = 0;
      let schemaBackupTotal = 0;
      for (const t of TENANT_TABLES) {
        const liveCnt = (await controlClient.query<{ cnt: string }>(`SELECT COUNT(*)::text as cnt FROM "${schema}"."${t}";`)).rows[0].cnt;
        const backupCnt = manifest.tables[`${schema}.${t}`]?.count || 0;
        schemaLiveTotal += parseInt(liveCnt, 10);
        schemaBackupTotal += backupCnt;
      }
      console.log(`  Schema "${schema}": Backup Snapshot = ${schemaBackupTotal} rows, Current in "rota" DB = ${schemaLiveTotal} rows (Diff: ${schemaLiveTotal - schemaBackupTotal})`);
    }

  } finally {
    await Promise.allSettled([client1.end(), client2.end(), controlClient.end()]);
  }
}

runDeepVerification().catch((err) => {
  console.error('[Verification Failed]', err);
  process.exit(1);
});
