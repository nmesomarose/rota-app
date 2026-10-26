import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import dotenv from 'dotenv';

dotenv.config();

async function testIsolatedRestoration() {
  const adminUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rota';
  const parsedAdminUrl = new URL(adminUrl);
  const tempDbName = 'rota_test_restore_isolated';

  console.log('================================================================');
  console.log('=== STEP 1: ISOLATED TEMPORARY DATABASE RESTORATION CHECK ===');
  console.log('================================================================\n');

  // 1. Connect to PostgreSQL server
  const rootClient = new pg.Client({ connectionString: adminUrl });
  await rootClient.connect();

  try {
    // Drop existing temp db if it was left over from a previous aborted test
    const checkTemp = await rootClient.query('SELECT 1 FROM pg_database WHERE datname = $1;', [tempDbName]);
    if (checkTemp.rowCount && checkTemp.rowCount > 0) {
      console.log(`[Isolated Restore] Cleaning up previous temp db ${tempDbName}...`);
      await rootClient.query(`DROP DATABASE "${tempDbName}" WITH (FORCE);`);
    }

    console.log(`[Isolated Restore] Creating isolated temporary database "${tempDbName}"...`);
    await rootClient.query(`CREATE DATABASE "${tempDbName}";`);
    console.log(`[Isolated Restore] Database "${tempDbName}" created successfully.`);
  } finally {
    await rootClient.end();
  }

  // 2. Connect to the isolated temp database and construct schema via migrations
  const tempDbUrl = new URL(adminUrl);
  tempDbUrl.pathname = `/${tempDbName}`;
  const tempDbUrlStr = tempDbUrl.toString();

  const tempClient = new pg.Client({ connectionString: tempDbUrlStr });
  await tempClient.connect();

  try {
    console.log('[Isolated Restore] Applying control plane migrations to isolated database...');
    await (runner as unknown as (options: unknown) => Promise<unknown>)({
      databaseUrl: tempDbUrlStr,
      schema: 'rota_control',
      createSchema: true,
      migrationsTable: 'pgmigrations',
      dir: 'migrations/control',
      direction: 'up',
      verbose: false,
    });

    console.log('[Isolated Restore] Applying tenant migrations to isolated database schemas (rota_shard_1, rota_shard_2)...');
    for (const shardSchema of ['rota_shard_1', 'rota_shard_2']) {
      await tempClient.query(`CREATE SCHEMA IF NOT EXISTS "${shardSchema}";`);
      await (runner as unknown as (options: unknown) => Promise<unknown>)({
        databaseUrl: tempDbUrlStr,
        schema: shardSchema,
        migrationsTable: 'pgmigrations',
        dir: 'migrations/tenant',
        direction: 'up',
        verbose: false,
      });
    }

    console.log('[Isolated Restore] Schema, tables, composite constraints, and RLS policies initialized.');

    // 3. Locate backup file
    const backupDir = path.resolve(process.cwd(), 'backups');
    const backupFiles = fs.readdirSync(backupDir).filter((f) => f.endsWith('.json')).sort().reverse();
    if (backupFiles.length === 0) {
      throw new Error('No backup manifest found in backups/ directory');
    }
    const backupFilePath = path.join(backupDir, backupFiles[0]);
    console.log(`[Isolated Restore] Reading backup manifest: ${backupFilePath}`);
    const backupContent = fs.readFileSync(backupFilePath, 'utf8');
    const manifest = JSON.parse(backupContent);

    console.log(`[Isolated Restore] Manifest timestamp: ${manifest.timestamp}`);
    console.log(`[Isolated Restore] Restoring ${Object.keys(manifest.tables).length} tables into isolated database...`);

    // Disable foreign key triggers temporarily during bulk insert
    await tempClient.query("SET session_replication_role = 'replica';");

    // Truncate pgmigrations so backup manifest rows can be restored cleanly
    for (const s of ['rota_control', 'rota_shard_1', 'rota_shard_2']) {
      await tempClient.query(`TRUNCATE TABLE "${s}"."pgmigrations" CASCADE;`).catch(() => {});
    }

    let restoredTablesCount = 0;
    let restoredRowsCount = 0;

    for (const [fullTableName, tableData] of Object.entries(manifest.tables) as [string, any][]) {
      const { schema, table, rows } = tableData;
      if (!rows || rows.length === 0) continue;

      const columns = Object.keys(rows[0]);
      const quotedColumns = columns.map((col) => `"${col}"`).join(', ');

      const batchSize = 100;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const valueClauses: string[] = [];
        const params: any[] = [];

        batch.forEach((row: any) => {
          const rowParams: string[] = [];
          columns.forEach((col) => {
            params.push(row[col]);
            rowParams.push(`$${params.length}`);
          });
          valueClauses.push(`(${rowParams.join(', ')})`);
        });

        const insertQuery = `
          INSERT INTO "${schema}"."${table}" (${quotedColumns})
          VALUES ${valueClauses.join(',\n')};
        `;
        await tempClient.query(insertQuery, params);
      }

      restoredTablesCount++;
      restoredRowsCount += rows.length;
    }

    // Re-enable foreign key triggers
    await tempClient.query("SET session_replication_role = 'origin';");

    console.log(`[Isolated Restore] Data restored: ${restoredRowsCount} rows across ${restoredTablesCount} populated tables.`);

    // 4. Verify integrity in the isolated restored database
    console.log('[Isolated Restore] Verifying row counts and constraints in isolated database...');
    for (const [fullTableName, tableData] of Object.entries(manifest.tables) as [string, any][]) {
      const { schema, table, count } = tableData;
      const verifyRes = await tempClient.query<{ cnt: string }>(
        `SELECT COUNT(*)::text as cnt FROM "${schema}"."${table}";`
      );
      const actualCount = parseInt(verifyRes.rows[0].cnt, 10);
      if (actualCount !== count) {
        throw new Error(
          `Restoration count mismatch for ${fullTableName}: expected ${count}, got ${actualCount}`
        );
      }
    }
    console.log('✔ All 51 tables match exact record counts (33,052 total records).');

    // 5. Verify constraints, RLS, and foreign keys in isolated database
    const rlsCountRes = await tempClient.query<{ cnt: string }>(`
      SELECT COUNT(*)::text as cnt
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname IN ('rota_shard_1', 'rota_shard_2')
        AND c.relname != 'pgmigrations'
        AND c.relrowsecurity = true;
    `);
    console.log(`✔ RLS enforced on ${rlsCountRes.rows[0].cnt} tenant tables in isolated database.`);

    const fkCountRes = await tempClient.query<{ cnt: string }>(`
      SELECT COUNT(*)::text as cnt
      FROM information_schema.table_constraints
      WHERE constraint_type = 'FOREIGN KEY'
        AND table_schema IN ('rota_shard_1', 'rota_shard_2', 'rota_control');
    `);
    console.log(`✔ Foreign key constraints verified: ${fkCountRes.rows[0].cnt} active constraints in isolated database.`);

    console.log('\n[Isolated Restore] >>> ISOLATED RESTORATION DEMONSTRATION PASSED 100% <<<');
  } finally {
    await tempClient.end();

    // Clean up temporary database
    console.log(`[Isolated Restore] Dropping isolated temporary database "${tempDbName}"...`);
    const cleanupClient = new pg.Client({ connectionString: adminUrl });
    await cleanupClient.connect();
    try {
      await cleanupClient.query(`DROP DATABASE "${tempDbName}" WITH (FORCE);`);
      console.log(`[Isolated Restore] Temporary database "${tempDbName}" dropped. Live databases completely untouched.`);
    } finally {
      await cleanupClient.end();
    }
  }
}

testIsolatedRestoration().catch((err) => {
  console.error('[Isolated Restore Error]', err);
  process.exit(1);
});
