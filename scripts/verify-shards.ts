import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function inspectShards() {
  const adminUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rota';
  console.log('[Verify Shards] Starting verification of physical databases...');

  for (const dbName of ['rota_shard_1', 'rota_shard_2']) {
    const url = new URL(adminUrl);
    url.pathname = '/' + dbName;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();

    const dbRes = await client.query('SELECT current_database() as db');
    const rlsRes = await client.query(`
      SELECT tablename, rowsecurity 
      FROM pg_tables 
      WHERE schemaname = 'public' 
      ORDER BY tablename
    `);
    
    console.log(`\n================== Database: ${dbRes.rows[0].db} ==================`);
    console.log(`Total public tables: ${rlsRes.rowCount}`);
    const rlsEnabled = rlsRes.rows.filter(r => r.rowsecurity).map(r => r.tablename);
    console.log(`Tables with Row-Level Security enabled (${rlsEnabled.length}/${rlsRes.rowCount}):`);
    console.log(rlsEnabled.join(', '));

    const counts = await client.query(`
      SELECT 'businesses' as tbl, count(*)::int as cnt FROM businesses
      UNION ALL SELECT 'shifts', count(*)::int FROM shifts
      UNION ALL SELECT 'activity_events', count(*)::int FROM activity_events
      UNION ALL SELECT 'subscriptions', count(*)::int FROM subscriptions
      UNION ALL SELECT 'ledger_entries', count(*)::int FROM ledger_entries;
    `);
    console.log('Sample table row counts:');
    for (const row of counts.rows) {
      console.log(`  - ${row.tbl}: ${row.cnt}`);
    }

    await client.end();
  }
  console.log('\n[Verify Shards] Physical shard inspection complete.');
}

inspectShards().catch((err) => {
  console.error('[Verify Shards Error]', err);
  process.exit(1);
});
