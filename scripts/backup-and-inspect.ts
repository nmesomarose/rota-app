import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

interface TableData {
  schema: string;
  table: string;
  count: number;
  rows: any[];
}

interface BackupManifest {
  timestamp: string;
  database: string;
  tables: Record<string, TableData>;
}

async function runBackup() {
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rota';
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();

  try {
    console.log('[Backup] Connected to database:', connectionString);
    const dbsRes = await client.query('SELECT datname FROM pg_database WHERE datistemplate = false;');
    console.log('[Backup] Existing PostgreSQL databases:', dbsRes.rows.map((r) => r.datname));

    const schemas = ['rota_control', 'rota_shard_1', 'rota_shard_2'];
    const manifest: BackupManifest = {
      timestamp: new Date().toISOString(),
      database: 'rota',
      tables: {},
    };

    let totalRows = 0;

    for (const schema of schemas) {
      const tablesRes = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name;`,
        [schema]
      );

      for (const { table_name } of tablesRes.rows) {
        const fullTableName = `${schema}.${table_name}`;
        const dataRes = await client.query(`SELECT * FROM ${schema}.${table_name};`);
        manifest.tables[fullTableName] = {
          schema,
          table: table_name,
          count: dataRes.rowCount || 0,
          rows: dataRes.rows,
        };
        totalRows += dataRes.rowCount || 0;
        console.log(`[Backup] Table ${fullTableName}: ${dataRes.rowCount} rows`);
      }
    }

    const backupDir = path.resolve(process.cwd(), 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilePath = path.join(backupDir, `pre-shard-separation-backup-${timestampStr}.json`);
    fs.writeFileSync(backupFilePath, JSON.stringify(manifest, null, 2), 'utf8');

    console.log(`[Backup] Successfully wrote backup to: ${backupFilePath}`);
    console.log(`[Backup] Total tables backed up: ${Object.keys(manifest.tables).length}`);
    console.log(`[Backup] Total records backed up: ${totalRows}`);

    // Verification check: read back and validate JSON integrity
    const verifyContent = fs.readFileSync(backupFilePath, 'utf8');
    const parsed = JSON.parse(verifyContent);
    if (!parsed.timestamp || !parsed.tables) {
      throw new Error('Backup verification failed: malformed manifest');
    }
    console.log('[Backup] Verification PASSED: Backup file read and validated successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

runBackup().catch((err) => {
  console.error('[Backup Failed]', err);
  process.exit(1);
});
