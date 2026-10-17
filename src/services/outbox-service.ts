import type pg from 'pg';
import { controlPool } from '../db/connection.ts';
import { withTenantContext } from '../db/tenant-context.ts';

export interface OutboxEntry {
  id: string;
  business_id: string;
  user_id: string;
  business_name: string;
  role: string;
  status: string;
  action: string;
}

/**
 * Inserts a record into membership_outbox within the active tenant transaction.
 */
export async function recordMembershipOutbox(
  client: pg.PoolClient,
  businessId: string,
  userId: string,
  businessName: string,
  role: string,
  status: string = 'active',
  action: string = 'upsert'
): Promise<string> {
  const res = await client.query(
    `INSERT INTO membership_outbox (business_id, user_id, business_name, role, status, action)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [businessId, userId, businessName, role, status, action]
  );
  return res.rows[0].id;
}

/**
 * Upserts a single directory entry into the control-plane membership_directory.
 */
export async function syncEntryToDirectory(
  userId: string,
  businessId: string,
  businessName: string,
  role: string,
  status: string
): Promise<void> {
  await controlPool.query(
    `INSERT INTO membership_directory (user_id, business_id, business_name, role, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id, business_id)
     DO UPDATE SET
       business_name = EXCLUDED.business_name,
       role = EXCLUDED.role,
       status = EXCLUDED.status,
       updated_at = NOW()`,
    [userId, businessId, businessName, role, status]
  );
}

/**
 * Sweeps unprocessed entries from membership_outbox for a given business and syncs to control plane.
 */
export async function sweepTenantOutbox(businessId: string): Promise<number> {
  return withTenantContext(businessId, async (client) => {
    const res = await client.query<OutboxEntry>(
      `SELECT id, business_id, user_id, business_name, role, status, action
       FROM membership_outbox
       WHERE processed_at IS NULL
       ORDER BY created_at ASC`
    );

    let processedCount = 0;
    for (const entry of res.rows) {
      if (entry.action === 'upsert') {
        await syncEntryToDirectory(
          entry.user_id,
          entry.business_id,
          entry.business_name,
          entry.role,
          entry.status
        );
      } else if (entry.action === 'delete') {
        await controlPool.query(
          `DELETE FROM membership_directory WHERE user_id = $1 AND business_id = $2`,
          [entry.user_id, entry.business_id]
        );
      }

      await client.query(
        `UPDATE membership_outbox
         SET processed_at = NOW(), attempts = attempts + 1
         WHERE business_id = $1 AND id = $2`,
        [entry.business_id, entry.id]
      );
      processedCount++;
    }

    return processedCount;
  });
}

/**
 * Deep authoritative reconciliation between tenant shard memberships and control plane directory.
 * Repairs directory drift following simulated network partitions or crashes (verifies AC-TEN-07).
 */
export async function reconcileDirectoryForBusiness(businessId: string): Promise<number> {
  return withTenantContext(businessId, async (client) => {
    // 1. Get business name
    const bizRes = await client.query<{ name: string }>(
      'SELECT name FROM businesses WHERE id = $1',
      [businessId]
    );
    if (bizRes.rowCount === 0) {
      return 0;
    }
    const businessName = bizRes.rows[0].name;

    // 2. Fetch authoritative tenant memberships
    const memRes = await client.query<{ user_id: string; role: string; status: string }>(
      'SELECT user_id, role, status FROM memberships WHERE business_id = $1',
      [businessId]
    );

    // 3. Upsert into control plane membership_directory
    for (const mem of memRes.rows) {
      await syncEntryToDirectory(
        mem.user_id,
        businessId,
        businessName,
        mem.role,
        mem.status
      );
    }

    // 4. Mark all pending outbox entries as processed
    await client.query(
      `UPDATE membership_outbox
       SET processed_at = NOW(), attempts = attempts + 1
       WHERE business_id = $1 AND processed_at IS NULL`,
      [businessId]
    );

    return memRes.rows.length;
  });
}
