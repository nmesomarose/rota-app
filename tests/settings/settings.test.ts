import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';

describe('Settings Synchronization: PRD 6.10, FR-SET-001..005, AC-SET-01, AC-017', () => {
  let server: Server;
  let baseUrl: string;

  let userAToken: string;
  let userAId: string;
  let userBToken: string;
  let userBId: string;

  before(async () => {
    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Register User A
    const userAEmail = `settings_user_a_${Date.now()}@example.com`;
    const regARes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: userAEmail,
        password: 'Password123!',
        name: 'Settings User A',
      }),
    });
    const regAData = (await regARes.json()) as any;
    userAToken = regAData.tokens.accessToken;
    userAId = regAData.user.id;

    // 2. Register User B
    const userBEmail = `settings_user_b_${Date.now()}@example.com`;
    const regBRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: userBEmail,
        password: 'Password123!',
        name: 'Settings User B',
      }),
    });
    const regBData = (await regBRes.json()) as any;
    userBToken = regBData.tokens.accessToken;
    userBId = regBData.user.id;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await closeAllPools();
  });

  describe('1. Defaults & Initial Read (FR-SET-001, FR-SET-002)', () => {
    it('returns standard defaults on initial GET /v1/settings for a new user', async () => {
      const res = await fetch(`${baseUrl}/v1/settings`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(res.status, 200);

      const json = (await res.json()) as any;
      assert.ok(json.data, 'Expected data envelope');
      const { settings, fieldTimestamps, updatedAt } = json.data;

      // Assert default values
      assert.equal(settings.timeZone, 'UTC');
      assert.deepEqual(settings.quietHours, {
        enabled: false,
        start: '22:00',
        end: '07:00',
      });
      assert.equal(settings.language, 'en');
      assert.equal(settings.theme, 'system');
      assert.deepEqual(settings.notificationCategories, {
        shifts: true,
        swaps: true,
        approvals: true,
        attendance: true,
        billing: true,
        security: true,
      });

      // Assert field timestamps
      assert.ok(fieldTimestamps.timeZone);
      assert.ok(fieldTimestamps.quietHours);
      assert.ok(fieldTimestamps.language);
      assert.ok(fieldTimestamps.theme);
      assert.ok(fieldTimestamps.notificationCategories);
      assert.ok(updatedAt);
    });
  });

  describe('2. Authorization & Tenant/User Isolation (SEC-017, AC-AUTH-12)', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const getRes = await fetch(`${baseUrl}/v1/settings`);
      assert.equal(getRes.status, 401);

      const putRes = await fetch(`${baseUrl}/v1/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: 'dark' }),
      });
      assert.equal(putRes.status, 401);
    });

    it('guarantees User A and User B settings are strictly isolated', async () => {
      // User A updates theme to 'dark'
      const updateARes = await fetch(`${baseUrl}/v1/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({ theme: 'dark', language: 'fr' }),
      });
      assert.equal(updateARes.status, 200);

      // User B fetches their settings; must remain default 'system' and 'en'
      const getBRes = await fetch(`${baseUrl}/v1/settings`, {
        headers: { Authorization: `Bearer ${userBToken}` },
      });
      assert.equal(getBRes.status, 200);
      const bData = (await getBRes.json()) as any;
      assert.equal(bData.data.settings.theme, 'system');
      assert.equal(bData.data.settings.language, 'en');

      // User A fetches their settings; shows 'dark' and 'fr'
      const getARes = await fetch(`${baseUrl}/v1/settings`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(getARes.status, 200);
      const aData = (await getARes.json()) as any;
      assert.equal(aData.data.settings.theme, 'dark');
      assert.equal(aData.data.settings.language, 'fr');
    });
  });

  describe('3. Validation & Schema Enforcement (SEC-003, FR-SET-001)', () => {
    it('rejects invalid IANA time zone with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/v1/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({ timeZone: 'Mars/Curiosity_Rover' }),
      });
      assert.equal(res.status, 400);
      const json = (await res.json()) as any;
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(json.error.details.errors.timeZone);
    });

    it('rejects invalid quiet hours time format with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/v1/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          quietHours: { enabled: true, start: '25:99', end: 'morning' },
        }),
      });
      assert.equal(res.status, 400);
      const json = (await res.json()) as any;
      assert.equal(json.error.code, 'VALIDATION_ERROR');
    });

    it('rejects invalid theme selection with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/v1/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({ theme: 'hacker_neon_matrix' }),
      });
      assert.equal(res.status, 400);
      const json = (await res.json()) as any;
      assert.equal(json.error.code, 'VALIDATION_ERROR');
    });

    it('rejects unrecognized extra fields with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/v1/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({ unknownField: 'exploit' }),
      });
      assert.equal(res.status, 400);
      const json = (await res.json()) as any;
      assert.equal(json.error.code, 'VALIDATION_ERROR');
    });
  });

  describe('4. Persistence and Full Updates', () => {
    it('persists updates to all fields accurately', async () => {
      const payload = {
        timeZone: 'Africa/Lagos',
        quietHours: {
          enabled: true,
          start: '23:00',
          end: '06:00',
        },
        language: 'es',
        theme: 'light',
        notificationCategories: {
          shifts: true,
          swaps: false,
          approvals: true,
          attendance: false,
          billing: true,
          security: true,
        },
      };

      const putRes = await fetch(`${baseUrl}/v1/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userBToken}`,
        },
        body: JSON.stringify(payload),
      });
      assert.equal(putRes.status, 200);

      const getRes = await fetch(`${baseUrl}/v1/settings`, {
        headers: { Authorization: `Bearer ${userBToken}` },
      });
      assert.equal(getRes.status, 200);
      const json = (await getRes.json()) as any;

      assert.equal(json.data.settings.timeZone, 'Africa/Lagos');
      assert.deepEqual(json.data.settings.quietHours, {
        enabled: true,
        start: '23:00',
        end: '06:00',
      });
      assert.equal(json.data.settings.language, 'es');
      assert.equal(json.data.settings.theme, 'light');
      assert.equal(json.data.settings.notificationCategories.swaps, false);
      assert.equal(json.data.settings.notificationCategories.attendance, false);
      assert.equal(json.data.settings.notificationCategories.billing, true);
    });
  });

  describe('5. Per-Field Conflict Resolution (FR-SET-005, AC-SET-01)', () => {
    it('concurrent edits to different fields on two devices both survive (AC-SET-01 Part 1)', async () => {
      // Base state: user has theme 'dark', language 'fr', timeZone 'Africa/Lagos'
      // Device 1 (e.g. phone) edits theme -> 'light'
      const dev1Res = await fetch(`${baseUrl}/v1/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({ theme: 'light' }),
      });
      assert.equal(dev1Res.status, 200);

      // Device 2 (e.g. tablet) edits timeZone -> 'Europe/London'
      const dev2Res = await fetch(`${baseUrl}/v1/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({ timeZone: 'Europe/London' }),
      });
      assert.equal(dev2Res.status, 200);

      // Verify merged state on server: both survive!
      const verifyRes = await fetch(`${baseUrl}/v1/settings`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(verifyRes.status, 200);
      const data = (await verifyRes.json()) as any;

      assert.equal(
        data.data.settings.theme,
        'light',
        'Device 1 theme edit must survive'
      );
      assert.equal(
        data.data.settings.timeZone,
        'Europe/London',
        'Device 2 timeZone edit must survive'
      );
      assert.equal(
        data.data.settings.language,
        'fr',
        'Untouched language must be preserved'
      );
    });

    it('an older replayed edit loses to a newer server value (AC-SET-01 Part 2)', async () => {
      // 1. Current server state: fetch current timestamp
      const getInitial = await fetch(`${baseUrl}/v1/settings`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      const initialData = (await getInitial.json()) as any;
      const initialThemeTs = initialData.data.fieldTimestamps.theme;

      // 2. Device 2 updates theme to 'dark' at time T2 (NOW)
      const dev2Update = await fetch(`${baseUrl}/v1/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({ theme: 'dark' }),
      });
      assert.equal(dev2Update.status, 200);
      const dev2Data = (await dev2Update.json()) as any;
      assert.equal(dev2Data.data.settings.theme, 'dark');
      const newerThemeTs = dev2Data.data.fieldTimestamps.theme;

      // 3. Device 1 was offline since before T2. It replays an old edit for theme: 'system'
      // with a client timestamp from 1 hour ago (T1 < T2)
      const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
      const dev1Replay = await fetch(`${baseUrl}/v1/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          theme: 'system',
          clientTimestamps: {
            theme: oneHourAgo,
          },
        }),
      });
      assert.equal(dev1Replay.status, 200);
      const replayData = (await dev1Replay.json()) as any;

      // Theme must NOT be overwritten by the stale edit!
      assert.equal(
        replayData.data.settings.theme,
        'dark',
        'Older replayed edit must lose to the newer server value'
      );
    });

    it('partially stale multi-field payload applies newer fields and drops older fields', async () => {
      const staleTime = new Date(Date.now() - 3600 * 1000).toISOString();
      const freshTime = new Date(Date.now() + 1000).toISOString();

      // Device replays a batch containing:
      // - Stale theme edit (timestamp 1h ago) -> should LOSE
      // - Fresh language edit (timestamp fresh) -> should WIN
      const batchRes = await fetch(`${baseUrl}/v1/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          theme: 'light',
          language: 'de',
          clientTimestamps: {
            theme: staleTime,
            language: freshTime,
          },
        }),
      });
      assert.equal(batchRes.status, 200);
      const data = (await batchRes.json()) as any;

      // Theme stayed 'dark' (older edit dropped)
      assert.equal(data.data.settings.theme, 'dark');
      // Language updated to 'de' (fresh edit accepted)
      assert.equal(data.data.settings.language, 'de');
    });
  });
});
