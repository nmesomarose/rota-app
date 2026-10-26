import pg from 'pg';
import assert from 'node:assert/strict';
import { env } from '../src/config/env.ts';
import { randomUUID } from 'node:crypto';

async function verifyPrivilegesAndRls() {
  console.log('================================================================');
  console.log('=== STEP 1.4: LEAST-PRIVILEGE PERMISSIONS & FORCED RLS CHECK ===');
  console.log('================================================================\n');

  // 1. Inspect PostgreSQL role definitions
  const adminClient = new pg.Client({ connectionString: env.DATABASE_URL });
  await adminClient.connect();

  try {
    const rolesRes = await adminClient.query(`
      SELECT rolname, rolsuper, rolbypassrls, rolcanlogin 
      FROM pg_catalog.pg_roles 
      WHERE rolname IN ('postgres', 'rota_app')
      ORDER BY rolname;
    `);
    console.log('PostgreSQL Role Security Flags:');
    console.table(rolesRes.rows);

    const appRole = rolesRes.rows.find((r) => r.rolname === 'rota_app');
    assert.ok(appRole, 'rota_app role must exist');
    assert.equal(appRole.rolsuper, false, 'rota_app must NOT be superuser');
    assert.equal(appRole.rolbypassrls, false, 'rota_app must NOT have BYPASSRLS');
    assert.equal(appRole.rolcanlogin, true, 'rota_app must be able to log in');
    console.log('✔ Verified: rota_app is an unprivileged role with NOBYPASSRLS.');
  } finally {
    await adminClient.end();
  }

  // 2. Test forced Row-Level Security on both physical shard databases
  const shardDbs = [
    { name: 'rota_shard_1', url: env.APP_SHARD_1_DATABASE_URL },
    { name: 'rota_shard_2', url: env.APP_SHARD_2_DATABASE_URL },
  ];

  for (const shard of shardDbs) {
    console.log(`\n[Checking ${shard.name}] Testing runtime least-privilege & RLS enforcement...`);
    const appClient = new pg.Client({ connectionString: shard.url });
    await appClient.connect();

    try {
      const userRes = await appClient.query('SELECT current_user, current_database();');
      console.log(`  Connected as: ${userRes.rows[0].current_user} on database ${userRes.rows[0].current_database}`);
      assert.equal(userRes.rows[0].current_user, 'rota_app');
      assert.equal(userRes.rows[0].current_database, shard.name);

      // Verify forced RLS on all tenant tables
      const rlsRes = await appClient.query(`
        SELECT c.relname as tablename, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r'
          AND n.nspname = 'public'
          AND c.relname != 'pgmigrations'
        ORDER BY c.relname;
      `);
      console.log(`  Tenant tables verified with forced RLS: ${rlsRes.rowCount} tables`);
      for (const row of rlsRes.rows) {
        assert.equal(row.rls_enabled, true, `${row.tablename} must have rls_enabled = true`);
        assert.equal(row.rls_forced, true, `${row.tablename} must have rls_forced = true`);
      }
      console.log(`  ✔ All ${rlsRes.rowCount} tenant tables have FORCE ROW LEVEL SECURITY active.`);

      // Test 1: Missing context fails closed on SELECT (returns 0 rows)
      const selectRes = await appClient.query('SELECT * FROM businesses;');
      assert.equal(selectRes.rows.length, 0, 'Unscoped SELECT must return 0 rows under RLS');
      console.log('  ✔ Fail-closed read: Unscoped SELECT returns 0 rows.');

      // Test 2: Missing context fails closed on INSERT (throws RLS violation)
      let insertBlocked = false;
      try {
        await appClient.query(
          "INSERT INTO businesses (id, name, timezone) VALUES ($1, 'Hacker Corp', 'UTC');",
          [randomUUID()]
        );
      } catch (err: any) {
        insertBlocked = true;
        assert.match(err.message, /violates row-level security policy/i);
      }
      assert.equal(insertBlocked, true, 'Unscoped INSERT must be rejected by RLS');
      console.log('  ✔ Fail-closed write: Unscoped INSERT rejected by RLS policy.');
    } finally {
      await appClient.end();
    }
  }

  console.log('\n[Security Check] >>> LEAST PRIVILEGE AND FORCED RLS VERIFIED ON ALL SHARDS <<<');
}

verifyPrivilegesAndRls().catch((err) => {
  console.error('[Verification Error]', err);
  process.exit(1);
});
