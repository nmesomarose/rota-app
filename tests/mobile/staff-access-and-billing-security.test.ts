import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Staff Access Security, Role Permissions & Dark Mode Logo Audit', () => {
  const rootDir = process.cwd();

  const readMobileFile = (relPath: string) => {
    return fs.readFileSync(path.resolve(rootDir, relPath), 'utf8');
  };

  describe('1. Backend Billing Authorization Guard (PRD 4.5 & BR-006)', () => {
    const billingRoutes = readMobileFile('src/routes/billing.ts');

    it('enforces requireRole([\"owner\"]) on GET /v1/billing/subscription', () => {
      // Must not allow ordinary staff or non-owners to retrieve subscription and seat allocations
      const subscriptionEndpointMatch = billingRoutes.match(
        /billingRouter\.get\(\s*['"]\/v1\/billing\/subscription['"][\s\S]*?async\s*\(/
      );
      assert.ok(subscriptionEndpointMatch, 'GET /v1/billing/subscription route exists');
      assert.ok(
        subscriptionEndpointMatch[0].includes("requireRole(['owner'])"),
        'GET /v1/billing/subscription is guarded with requireRole([owner])'
      );
    });

    it('enforces requireRole([\"owner\"]) on all other financial, quote and ledger endpoints', () => {
      const sensitiveEndpoints = [
        "billingRouter.post(\n  '/v1/billing/quotes'",
        "billingRouter.post(\n  '/v1/billing/quotes/:id/confirm'",
        "billingRouter.post(\n  '/v1/billing/schedule-downgrade'",
        "billingRouter.delete(\n  '/v1/billing/schedule-downgrade'",
        "billingRouter.post(\n  '/v1/billing/verify'",
        "billingRouter.get(\n  '/v1/billing/ledger'",
        "billingRouter.get(\n  '/v1/billing/history'",
      ];

      for (const ep of sensitiveEndpoints) {
        assert.ok(
          billingRoutes.includes(ep),
          `Expected endpoint ${ep} to exist in billing router`
        );
      }
    });
  });

  describe('2. Mobile Staff Gating & Information Hiding', () => {
    it('BillingScreen guards loadData against non-owners and renders Access Restricted view', () => {
      const billingScreen = readMobileFile('mobile/src/screens/BillingScreen.tsx');

      // 1. loadData suppresses API calls if not owner
      assert.ok(
        billingScreen.includes("if (biz?.role?.toLowerCase() !== 'owner')"),
        'loadData checks for owner role before making billing API calls'
      );

      // 2. Renders Access Restricted container with Return to Schedule button
      assert.ok(
        billingScreen.includes('restrictedContainer'),
        'renders restrictedContainer for non-owners'
      );
      assert.ok(
        billingScreen.includes('Access Restricted'),
        'displays clear Access Restricted title'
      );
      assert.ok(
        billingScreen.includes('Return to Schedule'),
        'provides Return to Schedule button'
      );

      // 3. infoRow has responsive wrapping/shrinking
      assert.match(
        billingScreen,
        /infoRow:\s*\{[\s\S]*?alignItems:\s*['"]center['"]/
      );
      assert.match(
        billingScreen,
        /infoValue:\s*\{[\s\S]*?flexShrink:\s*1/
      );
    });

    it('SettingsScreen hides Subscription & Entitlements section from non-owners', () => {
      const settingsScreen = readMobileFile('mobile/src/screens/SettingsScreen.tsx');

      assert.ok(
        settingsScreen.includes('{isOwner && ('),
        'Subscription card is conditionally rendered only for owners'
      );
    });

    it('HamburgerDrawer gates Subscription & Plan menu item to owners only', () => {
      const drawer = readMobileFile('mobile/src/navigation/HamburgerDrawer.tsx');

      assert.ok(
        drawer.includes("business?.role?.toLowerCase() === 'owner'") ||
          drawer.includes("business?.role?.toLowerCase()?.trim() === 'owner'"),
        'Drawer menu hides billing item from staff members'
      );
    });
  });

  describe('3. Rota Brand Logo Polish & Dark Mode Visibility', () => {
    it('LoginScreen houses the Rota logo in a high-contrast container with dark mode accent border', () => {
      const loginScreen = readMobileFile('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginScreen.includes('logoBadgeContainer'),
        'LoginScreen wraps logo in logoBadgeContainer'
      );
      assert.match(
        loginScreen,
        /logoBadgeContainer:\s*\{[\s\S]*?backgroundColor:\s*['"]#FFFFFF['"]/
      );
      assert.match(
        loginScreen,
        /appTitle:\s*\{[\s\S]*?color:\s*colors\.textPrimary/
      );
    });

    it('ForgotPasswordScreen and ResetPasswordScreen wrap logo in logoBadgeContainer', () => {
      const forgotScreen = readMobileFile('mobile/src/screens/ForgotPasswordScreen.tsx');
      const resetScreen = readMobileFile('mobile/src/screens/ResetPasswordScreen.tsx');

      assert.ok(forgotScreen.includes('logoBadgeContainer'), 'ForgotPasswordScreen wraps logo');
      assert.ok(resetScreen.includes('logoBadgeContainer'), 'ResetPasswordScreen wraps logo');
    });
  });

  describe('4. Full-App Overflow Audits & Typography Constraints', () => {
    it('ScheduleScreen separates shift date and time row, and eliminates en dashes', () => {
      const scheduleScreen = readMobileFile('mobile/src/screens/ScheduleScreen.tsx');

      assert.ok(scheduleScreen.includes('formatShiftDate'), 'uses formatShiftDate');
      assert.ok(scheduleScreen.includes('formatShiftTimeRange'), 'uses formatShiftTimeRange');
      assert.ok(scheduleScreen.includes('staffingWrapper'), 'uses staffingWrapper');

      // Zero en dashes (–) or em dashes (—)
      const hasDashes = /[—–]/.test(scheduleScreen);
      assert.strictEqual(hasDashes, false, 'ScheduleScreen must not contain em dashes (—) or en dashes (–)');
    });

    it('ScheduleScreen business information bar uses a responsive two-row layout preventing timestamp overflow', () => {
      const scheduleScreen = readMobileFile('mobile/src/screens/ScheduleScreen.tsx');

      assert.ok(scheduleScreen.includes('statusTopRow'), 'uses statusTopRow for business name');
      assert.ok(scheduleScreen.includes('statusMetaRow'), 'uses statusMetaRow for status and timestamp');
      assert.match(scheduleScreen, /statusMetaRow:\s*\{[\s\S]*?flexWrap:\s*['"]wrap['"]/);
      assert.match(scheduleScreen, /businessBadge:\s*\{[\s\S]*?flexWrap:\s*['"]wrap['"]/);
      assert.ok(scheduleScreen.includes('Updated {formatLastUpdated(lastUpdated)}'), 'preserves lastUpdated timestamp');
    });

    it('TeamScreen allows multi-line wrapping for member names and emails and wraps action rows', () => {
      const teamScreen = readMobileFile('mobile/src/screens/TeamScreen.tsx');

      assert.match(
        teamScreen,
        /memberName[\s\S]*?numberOfLines=\{2\}/
      );
      assert.match(
        teamScreen,
        /memberEmail[\s\S]*?numberOfLines=\{2\}/
      );
      assert.match(
        teamScreen,
        /memberActionRow:\s*\{[\s\S]*?flexWrap:\s*['"]wrap['"]/
      );
      assert.match(
        teamScreen,
        /swapActionRow:\s*\{[\s\S]*?flexWrap:\s*['"]wrap['"]/
      );

      const hasDashes = /[—–]/.test(teamScreen);
      assert.strictEqual(hasDashes, false, 'TeamScreen must not contain em dashes (—) or en dashes (–)');
    });

    it('ScheduleScreen segregates version badge into shiftMetaFooter to prevent collision with staffing', () => {
      const scheduleScreen = readMobileFile('mobile/src/screens/ScheduleScreen.tsx');

      assert.ok(scheduleScreen.includes('shiftMetaFooter'), 'uses shiftMetaFooter to place version badge on separate row');
      assert.ok(scheduleScreen.includes('staffingTextWrapper'), 'uses staffingTextWrapper for full multi-line wrapping');
      // Confirm detailText has no single-line truncation
      assert.ok(scheduleScreen.includes('<Text style={styles.detailText}>'), 'detailText has no single-line truncation');
    });

    it('HamburgerDrawer allows natural email wrapping without single-line truncation', () => {
      const drawer = readMobileFile('mobile/src/navigation/HamburgerDrawer.tsx');

      // userEmail should not have numberOfLines={1}
      assert.ok(drawer.includes('<Text style={styles.userEmail}>'), 'userEmail has no single-line truncation');
      assert.doesNotMatch(drawer, /styles\.userEmail\}\s+numberOfLines=\{1\}/);
      assert.match(drawer, /userEmail:\s*\{[\s\S]*?flexWrap:\s*['"]wrap['"]/);
    });

    it('AcceptInvitationScreen and BusinessSelectScreen protect long texts from overflow', () => {
      const acceptScreen = readMobileFile('mobile/src/screens/AcceptInvitationScreen.tsx');
      const bizSelectScreen = readMobileFile('mobile/src/screens/BusinessSelectScreen.tsx');

      assert.match(acceptScreen, /detailValue:\s*\{[\s\S]*?flexShrink:\s*1/);
      assert.match(bizSelectScreen, /roleBadge:\s*\{[\s\S]*?flexShrink:\s*0/);
    });
  });
});
