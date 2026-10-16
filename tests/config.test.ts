import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnv } from '../src/config/env.ts';

describe('Environment Variable Validation (Zod Config)', () => {
  it('applies default configuration values when variables are empty', () => {
    const config = validateEnv({});
    assert.strictEqual(config.NODE_ENV, 'development');
    assert.strictEqual(config.PORT, 3000);
    assert.strictEqual(config.CONTROL_SCHEMA, 'rota_control');
    assert.strictEqual(config.SHARD_1_SCHEMA, 'rota_shard_1');
    assert.strictEqual(config.SHARD_2_SCHEMA, 'rota_shard_2');
    assert.ok(config.DATABASE_URL.includes('postgresql://'));
    assert.ok(config.APP_DATABASE_URL.includes('postgresql://'));
  });

  it('correctly parses custom PORT and NODE_ENV', () => {
    const config = validateEnv({
      PORT: '8080',
      NODE_ENV: 'test',
    });
    assert.strictEqual(config.PORT, 8080);
    assert.strictEqual(config.NODE_ENV, 'test');
  });

  it('rejects invalid NODE_ENV values', () => {
    assert.throws(() => {
      validateEnv({
        NODE_ENV: 'invalid_mode' as unknown as 'development',
      });
    });
  });

  it('rejects invalid non-numeric PORT values', () => {
    assert.throws(() => {
      validateEnv({
        PORT: 'not-a-port',
      });
    });
  });
});
