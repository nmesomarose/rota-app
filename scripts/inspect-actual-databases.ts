import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function inspectDatabases() {
  const dbs = [
    { name: 'rota (Control)', url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rota' },
    { name: 'rota_shard_1 (Shard 1)', url: process.env.SHARD_1_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rota_shard_1' },
    { name: 'rota_shard_2 (Shard 2)', url: process.env.SHARD_2_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rota_shard_2' },
  ];

  for (const db of dbs) {
    console.log(`\n======================================================`);
    console.log(`DATABASE: ${db.name}`);
    console.log(`======================================================`);
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();

    try {
      const schemasRes = await client.query<{ nspname: string }>(`
        SELECT nspname FROM pg_namespace 
        WHERE nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
          AND nspname NOT LIKE 'pg_temp%'
          AND nspname NOT LIKE 'pg_toast_temp%'
        ORDER BY nspname;
      `);

      for (const { nspname } of schemasRes.rows) {
        console.log(`\n--- Schema: "${nspname}" ---`);
        const tablesRes = await client.query<{ table_name: string }>(`
          SELECT table_name FROM information_schema.tables 
          WHERE table_schema = $1 AND table_type = 'BASE TABLE'
          ORDER BY table_name;
        `, [nspname]);

        if (tablesRes.rows.length === 0) {
          console.log('  (no base tables)');
          continue;
        }

        let schemaTotal = 0;
        for (const { table_name } of tablesRes.rows) {
          const countRes = await client.query<{ cnt: string }>(`SELECT COUNT(*)::text as cnt FROM "${nspname}"."${table_name}";`);
          const count = parseInt(countRes.rows[0].cnt, 10);
          schemaTotal += count;
          console.log(`  ${table_name.padEnd(28)} : ${count} rows`);
        }
        console.log(`  --> Total in ${nspname}: ${schemaTotal} rows across ${tablesRes.rows.length} tables`);
      }
    } finally {
      await client.end();
    }
  }
}

inspectDatabases().catch((err) => {
  console.error('[Inspect Error]', err);
  process.exit(1);
});
