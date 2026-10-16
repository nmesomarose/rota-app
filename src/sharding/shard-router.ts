import { createHash } from 'node:crypto';

/**
 * Valid logical tenant shard identifiers.
 * In development, mapped to PostgreSQL schemas 'rota_shard_1' and 'rota_shard_2'.
 */
export type ShardId = 'shard_1' | 'shard_2';

/**
 * Mapping of logical shard ID to PostgreSQL schema name.
 */
export const SHARD_SCHEMAS: Readonly<Record<ShardId, string>> = Object.freeze({
  shard_1: 'rota_shard_1',
  shard_2: 'rota_shard_2',
});

/**
 * Unsharded control-plane schema name.
 */
export const CONTROL_SCHEMA = 'rota_control';

/**
 * RFC 4122 compliant UUID regex (v1-v5).
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Error thrown when a business_id fails format or presence validation.
 */
export class InvalidBusinessIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBusinessIdError';
    Object.setPrototypeOf(this, InvalidBusinessIdError.prototype);
  }
}

/**
 * Validates that the provided business_id is a non-empty, valid UUIDv4 string.
 * Rejects undefined, null, non-strings, empty strings, and malformed identifiers.
 *
 * @param businessId The candidate business ID to validate.
 * @throws {InvalidBusinessIdError} if validation fails.
 */
export function validateBusinessId(businessId: string): asserts businessId is string {
  if (typeof businessId !== 'string') {
    throw new InvalidBusinessIdError(
      `business_id must be a string, received ${businessId === null ? 'null' : typeof businessId}`
    );
  }

  const trimmed = businessId.trim();
  if (trimmed.length === 0) {
    throw new InvalidBusinessIdError('business_id must not be empty or whitespace-only');
  }

  if (!UUID_REGEX.test(trimmed)) {
    throw new InvalidBusinessIdError(
      `business_id '${trimmed}' is malformed; must be a valid RFC 4122 UUID`
    );
  }
}

/**
 * Deterministically routes a business UUID to one of two logical tenant shards.
 * Follows PRD 9.1, D-30, and DR-04 using SHA-256 hash % 2.
 *
 * Invariant: The same business_id always resolves to the exact same shard across
 * application lifecycles and process restarts (verifies AC-SH-01).
 *
 * @param businessId Authoritative business UUID.
 * @returns Logical shard identifier ('shard_1' | 'shard_2').
 * @throws {InvalidBusinessIdError} if businessId is invalid or malformed.
 */
export function getShardIdForBusiness(businessId: string): ShardId {
  validateBusinessId(businessId);

  // Normalize to lowercase trimmed string to guarantee hash stability
  const normalized = businessId.trim().toLowerCase();

  // Compute SHA-256 digest and convert first 4 bytes to 32-bit unsigned integer
  const digest = createHash('sha256').update(normalized).digest();
  const numericValue = digest.readUInt32BE(0);

  const shardIndex = numericValue % 2;
  return shardIndex === 0 ? 'shard_1' : 'shard_2';
}

/**
 * Resolves the target PostgreSQL schema for a given business_id.
 *
 * @param businessId Authoritative business UUID.
 * @returns Database schema name ('rota_shard_1' | 'rota_shard_2').
 * @throws {InvalidBusinessIdError} if businessId is invalid or malformed.
 */
export function getSchemaForBusiness(businessId: string): string {
  const shardId = getShardIdForBusiness(businessId);
  return SHARD_SCHEMAS[shardId];
}
