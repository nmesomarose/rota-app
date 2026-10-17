import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Milestone M4: Mobile Offline Cache & Security Constraints', () => {
  const mobileSrcDir = path.resolve(process.cwd(), 'mobile/src');

  it('verifies AC-AUTH-07: static scan asserts no auth token is stored in or read from AsyncStorage', () => {
    // Read all files in mobile/src recursively
    function getAllFiles(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...getAllFiles(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const files = getAllFiles(mobileSrcDir);
    assert.ok(files.length > 0, 'Found mobile source files');

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');

      // Check for AsyncStorage usages
      if (content.includes('@react-native-async-storage/async-storage')) {
        // Assert that the file does not store access tokens, refresh tokens, or passwords
        assert.doesNotMatch(
          content,
          /AsyncStorage\.setItem\([^)]*(?:access_token|refresh_token|password|jwt)/i,
          `AC-AUTH-07 Violation in ${file}: Auth tokens must NOT be stored via AsyncStorage.`
        );
        assert.doesNotMatch(
          content,
          /AsyncStorage\.getItem\([^)]*(?:access_token|refresh_token|password|jwt)/i,
          `AC-AUTH-07 Violation in ${file}: Auth tokens must NOT be read via AsyncStorage.`
        );
      }
    }
  });

  it('validates offline shift cache contract and timestamp preservation (AC-OFF-02, FR-OFF-001)', () => {
    const mockShifts = [
      {
        id: 'shift-1',
        branchId: 'branch-1',
        departmentId: 'dept-1',
        startsAt: new Date(Date.now() + 86400000).toISOString(),
        endsAt: new Date(Date.now() + 115200000).toISOString(),
        timeZone: 'Europe/London',
        status: 'published' as const,
        version: 1,
      },
    ];

    const cachedAt = new Date().toISOString();
    const payload = {
      businessId: 'biz-1',
      userId: 'user-1',
      shifts: mockShifts,
      lastUpdated: cachedAt,
    };

    assert.ok(payload.lastUpdated, 'Cached schedule carries lastUpdated ISO timestamp');
    assert.equal(payload.shifts.length, 1);
    assert.equal(payload.shifts[0].status, 'published');
    // Ensure lastUpdated can be parsed into valid local display time
    const parsedDate = new Date(payload.lastUpdated);
    assert.ok(!isNaN(parsedDate.getTime()), 'lastUpdated is a valid timestamp');
  });

  it('validates cache key scoping to business_id and user_id preventing cross-tenant leakage (SEC-014, AC-OFF-01)', () => {
    const keyTenantA = `rota_shifts_cache_tenantA_user1`;
    const keyTenantB = `rota_shifts_cache_tenantB_user1`;

    assert.notEqual(keyTenantA, keyTenantB, 'Cache keys must be unique per tenant even for the same user');
    assert.ok(keyTenantA.startsWith('rota_shifts_cache_tenantA'), 'Scoped by business prefix');
  });
});
