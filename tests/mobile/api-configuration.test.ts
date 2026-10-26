import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveInitialApiBaseUrl,
  setCustomApiUrl,
  getApiBaseUrl,
  DEV_DEFAULT_API_URL,
} from '../../mobile/src/services/api-config.ts';

describe('Mobile API URL Configuration & Production Guardrails', () => {
  const originalEnvUrl = process.env.EXPO_PUBLIC_API_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalEnvUrl !== undefined) {
      process.env.EXPO_PUBLIC_API_URL = originalEnvUrl;
    } else {
      delete process.env.EXPO_PUBLIC_API_URL;
    }
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('1. Uses EXPO_PUBLIC_API_URL when provided and strips trailing slashes', () => {
    process.env.EXPO_PUBLIC_API_URL = 'https://api.rota-workforce.example.com///';
    const resolved = resolveInitialApiBaseUrl();
    assert.strictEqual(resolved, 'https://api.rota-workforce.example.com');
  });

  it('2. Falls back to development local address when in development mode', () => {
    delete process.env.EXPO_PUBLIC_API_URL;
    process.env.NODE_ENV = 'development';
    const resolved = resolveInitialApiBaseUrl();
    assert.strictEqual(resolved, 'http://172.20.10.13:3000');
  });

  it('3. Refuses silent fallback to private local IP in production build when EXPO_PUBLIC_API_URL is missing', () => {
    delete process.env.EXPO_PUBLIC_API_URL;
    process.env.NODE_ENV = 'production';
    const resolved = resolveInitialApiBaseUrl();
    assert.strictEqual(resolved, '', 'Production build must not fall back to private LAN/Wi-Fi IP');
  });

  it('4. static inspection verifies api.ts throws CONFIGURATION_ERROR when unconfigured in production', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const candidate1 = path.resolve(process.cwd(), 'mobile/src/services/api.ts');
    const candidate2 = path.resolve(process.cwd(), 'src/services/api.ts');
    const apiFile = fs.existsSync(candidate1) ? candidate1 : candidate2;
    const content = fs.readFileSync(apiFile, 'utf8');

    assert.ok(
      content.includes('CONFIGURATION_ERROR'),
      'api.ts must throw CONFIGURATION_ERROR if API URL is unconfigured'
    );
    assert.ok(
      content.includes('Production API URL is not configured'),
      'api.ts must provide actionable message guidance for EXPO_PUBLIC_API_URL'
    );
    assert.doesNotMatch(
      content,
      /const DEFAULT_API_URL = 'http:\/\/172\.20\.10\.13:3000';\s*export let API_BASE_URL = process\.env\.EXPO_PUBLIC_API_URL \|\| DEFAULT_API_URL;/,
      'api.ts must not unconditionally fallback to private IP'
    );
  });

  it('5. setCustomApiUrl allows dynamic runtime override for debugging or staging', () => {
    setCustomApiUrl('https://staging-api.example.com/');
    assert.strictEqual(getApiBaseUrl(), 'https://staging-api.example.com');
  });
});
