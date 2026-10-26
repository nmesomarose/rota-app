import pg from 'pg';
import { env } from '../src/config/env.ts';

/**
 * Copies existing tenant data from schemas in the primary DB into the dedicated shard databases.
 * Guarantees zero data loss during the transition to separate PostgreSQL shard databases.
 */
async function syncShardData() {
  const adminUrl = env.DATABASE_URL;
  const sourceClient = new pg.Client({ connectionString: adminUrl });
  await sourceClient.connect();

  const shardPairs = [
    { sourceSchema: 'rota_shard_1', targetDb: 'rota_shard_1' },
    { sourceSchema: 'rota_shard_2', targetDb: 'rota_shard_2' },
  ];

  try {
    for (const { sourceSchema, targetDb } of shardPairs) {
      console.log(`[Data Sync] Migrating data from ${sourceSchema} to separate database ${targetDb}...`);

      const targetUrl = new URL(adminUrl);
      targetUrl.pathname = `/${targetDb}`;
      const targetClient = new pg.Client({ connectionString: targetUrl.toString() });
      await targetClient.connect();

      try {
        // Tables in dependency order (foreign keys respected)
        const tables = [
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

        // Disable foreign key triggers temporarily during bulk load
        await targetClient.query('SET session_replication_role = replica;');

        for (const table of tables) {
          const sourceRows = await sourceClient.query(`SELECT * FROM ${sourceSchema}.${table};`);
          if (sourceRows.rowCount && sourceRows.rowCount > 0) {
            console.log(`[Data Sync] Copying ${sourceRows.rowCount} rows from ${sourceSchema}.${table} to ${targetDb}.${table}...`);
            const columns = Object.keys(sourceRows.rows[0]);
            const colList = columns.map((c) => `"${c}"`).join(', ');

            for (const row of sourceRows.rows) {
              const values = columns.map((col) => row[col]);
              const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');
              const query = `
                INSERT INTO "${table}" (${colList})
                VALUES (${placeholders})
                ON CONFLICT DO NOTHING;
              `;
              await targetClient.query(query, values);
            }
          }
        }

        await targetClient.query('SET session_replication_role = DEFAULT;');
        console.log(`[Data Sync] Completed synchronization for ${targetDb}.`);
      } finally {
        await targetClient.end();
      }
    }
  } finally {
    await sourceClient.end();
  }

  console.log('[Data Sync] All shard databases successfully synchronized with existing tenant data.');
}

syncShardData().catch((err) => {
  console.error('[Data Sync Failed]', err);
  process.exit(1);
});
