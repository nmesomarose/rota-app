import pg from 'pg';
import { getShardPool } from './connection.ts';
import { getShardIdForBusiness, type ShardId } from '../sharding/shard-router.ts';

// UUIDv4 validation regex (case-insensitive)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/**
 * Validates that an identifier is a well-formed UUID.
 */
export function validateBusinessId(businessId: string): string {
  if (!businessId || typeof businessId !== 'string') {
    throw new TenantContextError('business_id is required and must be a string');
  }
  const trimmed = businessId.trim();
  if (!UUID_REGEX.test(trimmed)) {
    throw new TenantContextError(`Invalid business_id format: expected UUID, got '${businessId}'`);
  }
  return trimmed;
}

export interface TenantContextOptions {
  shardId?: ShardId;
}

/**
 * Executes a callback within a transaction-scoped tenant context on the appropriate shard pool.
 *
 * Guarantees:
 * 1. Checks out a connection from the designated shard pool.
 * 2. Starts a transaction (BEGIN).
 * 3. Applies SET LOCAL app.current_business_id = '<business_id>' to enforce RLS.
 * 4. SET LOCAL automatically lapses upon COMMIT or ROLLBACK.
 * 5. Re-verifies or explicitly resets context before returning connection to the pool.
 * 6. Always releases the client back to the pool in a finally block.
 *
 * @param businessId Validated UUID of the active business (derived from server-side token)
 * @param callback Async function receiving the scoped pg.PoolClient
 * @param options Optional explicit shardId override
 */
export async function withTenantContext<T>(
  businessId: string,
  callback: (client: pg.PoolClient) => Promise<T>,
  options?: TenantContextOptions
): Promise<T> {
  const validBusinessId = validateBusinessId(businessId);
  const targetShard = options?.shardId ?? getShardIdForBusiness(validBusinessId);
  const pool = getShardPool(targetShard);

  const client = await pool.connect();
  let inTransaction = false;

  try {
    await client.query('BEGIN');
    inTransaction = true;

    // Use parameterized query to set transaction-local variable safely
    await client.query('SELECT set_config($1, $2, true)', [
      'app.current_business_id',
      validBusinessId,
    ]);

    const result = await callback(client);

    await client.query('COMMIT');
    inTransaction = false;
    return result;
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackErr) {
        // Suppress secondary rollback error to preserve original exception
      }
    }
    throw error;
  } finally {
    // Defense-in-depth: Ensure session state cannot retain the tenant setting on pooled connections
    try {
      await client.query("SELECT set_config('app.current_business_id', '', false)");
      client.release();
    } catch (_resetErr) {
      // If client cannot reset or is in an error state, discard the broken socket
      client.release(true);
    }
  }
}
