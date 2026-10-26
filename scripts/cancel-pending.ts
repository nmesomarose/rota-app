import pg from 'pg';
import { env } from '../src/config/env.ts';

const client = new pg.Client({ connectionString: env.DATABASE_URL });

async function main() {
  await client.connect();
  for (const schema of ['rota_shard_1', 'rota_shard_2']) {
    const res = await client.query(
      `SELECT id, business_id, provider_reference, status, expires_at, created_at 
       FROM ${schema}.payment_intents 
       WHERE status = 'awaiting_payment'`
    );
    console.log(`[${schema}] Found ${res.rows.length} awaiting_payment intents:`, res.rows);
    if (res.rows.length > 0) {
      await client.query(`UPDATE ${schema}.payment_intents SET status = 'failed' WHERE status = 'awaiting_payment'`);
      console.log(`[${schema}] Successfully cancelled open payment intents.`);
    }
  }
  await client.end();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
