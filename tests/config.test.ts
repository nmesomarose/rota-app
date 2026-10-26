import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnv } from '../src/config/env.ts';

describe('Environment Variable Validation (Zod Config)', () => {
  it('applies default configuration values when variables are empty', () => {
    const config = validateEnv({});
    assert.strictEqual(config.NODE_ENV, 'development');
    assert.strictEqual(config.PORT, 3000);
    assert.strictEqual(config.HOST, '0.0.0.0');
    assert.strictEqual(config.CONTROL_SCHEMA, 'rota_control');
    assert.strictEqual(config.SHARD_1_SCHEMA, 'rota_shard_1');
    assert.strictEqual(config.SHARD_2_SCHEMA, 'rota_shard_2');
    assert.strictEqual(config.TRUST_PROXY, 'false');
    assert.strictEqual(config.QUEUE_MAX_ATTEMPTS, 3);
    assert.strictEqual(config.QUEUE_BACKOFF_MS, 1000);
    assert.strictEqual(config.QUEUE_VISIBILITY_TIMEOUT_MS, 30000);
    assert.strictEqual(config.SWEEPER_INTERVAL_MS, 60000);
    assert.strictEqual(config.ASYNC_WEBHOOK_PROCESSING, 'false');
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

  it('requires REDIS_URL when NODE_ENV is production (SEC-004, NFR-REL-002)', () => {
    assert.throws(() => {
      validateEnv({
        NODE_ENV: 'production',
      });
    }, /REDIS_URL is required in production environment/);

    const prodConfig = validateEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://prod-redis.internal:6379',
      JWT_SECRET: 'prod_jwt_secret_satisfying_minimum_32_chars_requirement',
      REFRESH_TOKEN_SECRET: 'prod_refresh_secret_satisfying_minimum_32_chars_req',
    });
    assert.strictEqual(prodConfig.REDIS_URL, 'redis://prod-redis.internal:6379');
  });

  it('development defaults work outside production without explicitly providing secrets', () => {
    const devConfig = validateEnv({ NODE_ENV: 'development' });
    assert.strictEqual(devConfig.JWT_SECRET, 'development_jwt_secret_minimum_16_characters_long');
    assert.strictEqual(devConfig.REFRESH_TOKEN_SECRET, 'development_refresh_secret_minimum_16_characters_long');

    const testConfig = validateEnv({ NODE_ENV: 'test' });
    assert.strictEqual(testConfig.JWT_SECRET, 'development_jwt_secret_minimum_16_characters_long');
    assert.strictEqual(testConfig.REFRESH_TOKEN_SECRET, 'development_refresh_secret_minimum_16_characters_long');
  });

  it('production rejects missing JWT_SECRET', () => {
    assert.throws(() => {
      validateEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.internal:6379',
        REFRESH_TOKEN_SECRET: 'prod_refresh_secret_satisfying_minimum_32_chars_req',
      });
    }, /JWT_SECRET must be explicitly provided in production/);
  });

  it('production rejects missing REFRESH_TOKEN_SECRET', () => {
    assert.throws(() => {
      validateEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.internal:6379',
        JWT_SECRET: 'prod_jwt_secret_satisfying_minimum_32_chars_requirement',
      });
    }, /REFRESH_TOKEN_SECRET must be explicitly provided in production/);
  });

  it('production rejects known development fallback values and placeholders', () => {
    // Development fallback values
    assert.throws(() => {
      validateEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.internal:6379',
        JWT_SECRET: 'development_jwt_secret_minimum_16_characters_long',
        REFRESH_TOKEN_SECRET: 'prod_refresh_secret_satisfying_minimum_32_chars_req',
      });
    }, /JWT_SECRET must be explicitly provided in production/);

    assert.throws(() => {
      validateEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.internal:6379',
        JWT_SECRET: 'prod_jwt_secret_satisfying_minimum_32_chars_requirement',
        REFRESH_TOKEN_SECRET: 'development_refresh_secret_minimum_16_characters_long',
      });
    }, /REFRESH_TOKEN_SECRET must be explicitly provided in production/);

    // .env.example template placeholders
    assert.throws(() => {
      validateEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.internal:6379',
        JWT_SECRET: 'replace_with_a_secure_random_string_at_least_32_chars',
        REFRESH_TOKEN_SECRET: 'prod_refresh_secret_satisfying_minimum_32_chars_req',
      });
    }, /JWT_SECRET must be explicitly provided in production/);
  });

  it('production rejects secrets with fewer than 32 characters', () => {
    assert.throws(() => {
      validateEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.internal:6379',
        JWT_SECRET: 'too_short_only_24_characters!',
        REFRESH_TOKEN_SECRET: 'prod_refresh_secret_satisfying_minimum_32_chars_req',
      });
    }, /JWT_SECRET must be explicitly provided in production/);

    assert.throws(() => {
      validateEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.internal:6379',
        JWT_SECRET: 'prod_jwt_secret_satisfying_minimum_32_chars_requirement',
        REFRESH_TOKEN_SECRET: 'too_short_only_24_characters!',
      });
    }, /REFRESH_TOKEN_SECRET must be explicitly provided in production/);
  });

  it('production accepts explicitly supplied sufficiently long secrets (>= 32 characters)', () => {
    const validProdConfig = validateEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://prod-redis.internal:6379',
      JWT_SECRET: 'a_very_secure_and_unique_production_jwt_signing_key_32+',
      REFRESH_TOKEN_SECRET: 'a_very_secure_and_unique_production_refresh_key_32+',
    });

    assert.strictEqual(validProdConfig.JWT_SECRET, 'a_very_secure_and_unique_production_jwt_signing_key_32+');
    assert.strictEqual(validProdConfig.REFRESH_TOKEN_SECRET, 'a_very_secure_and_unique_production_refresh_key_32+');
    assert.strictEqual(validProdConfig.NODE_ENV, 'production');
    assert.strictEqual(validProdConfig.REDIS_URL, 'redis://prod-redis.internal:6379');
  });

  it('parses explicit TRUST_PROXY configuration', () => {
    const config1 = validateEnv({ TRUST_PROXY: 'loopback' });
    assert.strictEqual(config1.TRUST_PROXY, 'loopback');

    const config2 = validateEnv({ TRUST_PROXY: '1' });
    assert.strictEqual(config2.TRUST_PROXY, '1');
  });
});
