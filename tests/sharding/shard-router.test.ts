import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  getShardIdForBusiness,
  getSchemaForBusiness,
  validateBusinessId,
  InvalidBusinessIdError,
  SHARD_SCHEMAS,
  type ShardId,
} from '../../src/sharding/shard-router.ts';

describe('Deterministic Shard Router (PRD 9.1, D-30, SEC-013)', () => {
  const sampleUuidA = 'a3bb189e-8bf9-4888-9912-ace4e6543002';
  const sampleUuidB = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

  describe('Validation & Malformed Input Handling', () => {
    it('rejects undefined, null, and non-string inputs', () => {
      // @ts-expect-error testing runtime validation of invalid types
      assert.throws(() => validateBusinessId(undefined), InvalidBusinessIdError);
      // @ts-expect-error testing runtime validation of invalid types
      assert.throws(() => validateBusinessId(null), InvalidBusinessIdError);
      // @ts-expect-error testing runtime validation of invalid types
      assert.throws(() => validateBusinessId(12345), InvalidBusinessIdError);
      // @ts-expect-error testing runtime validation of invalid types
      assert.throws(() => validateBusinessId({}), InvalidBusinessIdError);
    });

    it('rejects empty and whitespace-only strings', () => {
      assert.throws(() => validateBusinessId(''), InvalidBusinessIdError);
      assert.throws(() => validateBusinessId('   '), InvalidBusinessIdError);
      assert.throws(() => validateBusinessId('\t\n'), InvalidBusinessIdError);
    });

    it('rejects non-UUID and malformed strings', () => {
      assert.throws(() => validateBusinessId('not-a-uuid'), InvalidBusinessIdError);
      assert.throws(() => validateBusinessId('12345'), InvalidBusinessIdError);
      assert.throws(() => validateBusinessId("'; DROP TABLE businesses; --"), InvalidBusinessIdError);
      assert.throws(() => validateBusinessId('a3bb189e-8bf9-4888-9912'), InvalidBusinessIdError);
      // Invalid hex character 'z'
      assert.throws(
        () => validateBusinessId('z3bb189e-8bf9-4888-9912-ace4e6543002'),
        InvalidBusinessIdError
      );
    });

    it('accepts valid UUIDv4 strings regardless of casing', () => {
      assert.doesNotThrow(() => validateBusinessId(sampleUuidA));
      assert.doesNotThrow(() => validateBusinessId(sampleUuidA.toUpperCase()));
      assert.doesNotThrow(() => validateBusinessId(`  ${sampleUuidA}  `));
    });

    it('getShardIdForBusiness and getSchemaForBusiness throw on malformed inputs', () => {
      assert.throws(() => getShardIdForBusiness('invalid'), InvalidBusinessIdError);
      assert.throws(() => getSchemaForBusiness('invalid'), InvalidBusinessIdError);
    });
  });

  describe('Routing Output Correctness', () => {
    it('returns only valid shard IDs (shard_1 or shard_2)', () => {
      for (let i = 0; i < 50; i++) {
        const id = randomUUID();
        const shard = getShardIdForBusiness(id);
        assert.ok(shard === 'shard_1' || shard === 'shard_2');
      }
    });

    it('resolves correct PostgreSQL schema mapping', () => {
      const shardA = getShardIdForBusiness(sampleUuidA);
      const schemaA = getSchemaForBusiness(sampleUuidA);
      assert.strictEqual(schemaA, SHARD_SCHEMAS[shardA]);

      const shardB = getShardIdForBusiness(sampleUuidB);
      const schemaB = getSchemaForBusiness(sampleUuidB);
      assert.strictEqual(schemaB, SHARD_SCHEMAS[shardB]);
    });

    it('is case-insensitive and trims surrounding whitespace', () => {
      const lower = getShardIdForBusiness(sampleUuidA.toLowerCase());
      const upper = getShardIdForBusiness(sampleUuidA.toUpperCase());
      const padded = getShardIdForBusiness(`  ${sampleUuidA}  `);

      assert.strictEqual(lower, upper);
      assert.strictEqual(lower, padded);
    });
  });

  describe('AC-SH-01: 1,000 Iteration Route Stability Invariant', () => {
    it('routes the exact same business_id to the exact same shard across 1,000 calls', () => {
      const targetUuid = randomUUID();
      const initialShard = getShardIdForBusiness(targetUuid);

      for (let i = 0; i < 1000; i++) {
        const resolvedShard = getShardIdForBusiness(targetUuid);
        assert.strictEqual(
          resolvedShard,
          initialShard,
          `Routing instability detected at iteration ${i}: expected ${initialShard}, got ${resolvedShard}`
        );
      }
    });
  });

  describe('AC-SH-02: Distribution Balance Invariant', () => {
    it('allocates at least 40% of 1,000 randomly generated business UUIDs to each shard', () => {
      const iterations = 1000;
      const counts: Record<ShardId, number> = {
        shard_1: 0,
        shard_2: 0,
      };

      for (let i = 0; i < iterations; i++) {
        const id = randomUUID();
        const shard = getShardIdForBusiness(id);
        counts[shard]++;
      }

      const shard1Pct = (counts.shard_1 / iterations) * 100;
      const shard2Pct = (counts.shard_2 / iterations) * 100;

      // Report distribution as required by AC-SH-02
      console.log(
        `[AC-SH-02 Report] Over ${iterations} UUIDs: Shard 1 = ${counts.shard_1} (${shard1Pct.toFixed(1)}%), Shard 2 = ${counts.shard_2} (${shard2Pct.toFixed(1)}%)`
      );

      assert.ok(
        counts.shard_1 >= 400,
        `Shard 1 distribution below 40% threshold: ${counts.shard_1} / ${iterations} (${shard1Pct}%)`
      );
      assert.ok(
        counts.shard_2 >= 400,
        `Shard 2 distribution below 40% threshold: ${counts.shard_2} / ${iterations} (${shard2Pct}%)`
      );
    });
  });
});
