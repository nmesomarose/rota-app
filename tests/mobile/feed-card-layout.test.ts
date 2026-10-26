import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Activity Feed Card Layout & Readability', () => {
  const feedScreenPath = path.resolve(process.cwd(), 'mobile/src/screens/FeedScreen.tsx');
  const feedContent = fs.readFileSync(feedScreenPath, 'utf8');

  describe('1. Responsive Flex Constraints & Overflow Prevention', () => {
    it('restricts header badge group and timestamp to prevent horizontal overflow', () => {
      // badgeGroup must shrink to give space to timeText
      assert.match(feedContent, /badgeGroup:\s*\{[\s\S]*?flexShrink:\s*1/);
      // timeText must not shrink or get clipped
      assert.match(feedContent, /timeText:\s*\{[\s\S]*?flexShrink:\s*0/);
    });

    it('enforces multi-line wrapping and limits on card headline', () => {
      // eventHeadline must have numberOfLines={2} and flexShrink: 1
      assert.match(feedContent, /eventHeadline[\s\S]*?numberOfLines=\{2\}/);
      assert.match(feedContent, /eventHeadline:\s*\{[\s\S]*?flexShrink:\s*1/);
    });

    it('wraps metadata rows and handles long employee names safely', () => {
      // metaRow wraps to next line if screen width is narrow
      assert.match(feedContent, /metaRow:\s*\{[\s\S]*?flexWrap:\s*['"]wrap['"]/);
      // eventMembers has numberOfLines={1} and ellipsizeMode="tail"
      assert.match(feedContent, /eventMembers[\s\S]*?numberOfLines=\{1\}[\s\S]*?ellipsizeMode="tail"/);
    });

    it('constrains inbox notification titles and allows full readable bodies', () => {
      assert.match(feedContent, /itemTitle[\s\S]*?numberOfLines=\{2\}/);
      assert.ok(feedContent.includes('<Text style={styles.itemBody}>{item.body}</Text>'), 'allows natural full text wrapping without premature clipping');
    });
  });

  describe('2. Human-Readable Copy & Event Type Normalization', () => {
    it('maps raw backend event types to clean, concise natural titles', () => {
      // Assert that formatEventType function is defined and covers core lifecycle events
      assert.ok(feedContent.includes("case 'schedule.shift_assigned':"), 'handles schedule.shift_assigned');
      assert.ok(feedContent.includes("return 'Shift Assigned';"), 'returns clean Shift Assigned');

      assert.ok(feedContent.includes("case 'swap.peer_accepted':"), 'handles swap.peer_accepted');
      assert.ok(feedContent.includes("return 'Swap Awaiting Approval';"), 'returns clean Swap Awaiting Approval');

      assert.ok(feedContent.includes("case 'swap.peer_rejected':"), 'handles swap.peer_rejected');
      assert.ok(feedContent.includes("return 'Swap Declined by Peer';"), 'returns clean Swap Declined by Peer');

      assert.ok(feedContent.includes("case 'attendance.recorded':"), 'handles attendance.recorded');
      assert.ok(feedContent.includes("return 'Attendance Logged';"), 'returns clean Attendance Logged');

      assert.ok(feedContent.includes("case 'billing.subscription_updated':"), 'handles billing.subscription_updated');
      assert.ok(feedContent.includes("return 'Plan Updated';"), 'returns clean Plan Updated');
    });

    it('provides clear category badge pills without raw dot-separated strings', () => {
      assert.ok(feedContent.includes("formatCategoryBadge"));
      assert.ok(feedContent.includes("if (raw === 'SCHEDULE') return 'SCHEDULE';"));
      assert.ok(feedContent.includes("if (raw === 'SWAP') return 'SWAP';"));
      assert.ok(feedContent.includes("if (raw === 'MEMBERSHIP') return 'TEAM';"));
    });

    it('contains zero em dashes or en dashes in user-facing copy', () => {
      // Prohibit em dash (—) and en dash (–)
      const hasEmDash = /[—–]/.test(feedContent);
      assert.strictEqual(hasEmDash, false, 'FeedScreen must not contain em dashes (—) or en dashes (–)');
    });
  });

  describe('3. Visual Hierarchy & Theme Tokens', () => {
    it('uses semantic status badge styling for approved, pending, and rejected states', () => {
      assert.ok(feedContent.includes("getStatusBadgeStyle"));
      assert.ok(feedContent.includes("colors.successLight"));
      assert.ok(feedContent.includes("colors.warningLight"));
      assert.ok(feedContent.includes("colors.errorLight"));
    });

    it('separates top metadata header from headline for responsive clarity', () => {
      // Top header contains badgeGroup and timeText, followed by eventHeadline
      const headerIndex = feedContent.indexOf('style={styles.cardHeader}');
      const headlineIndex = feedContent.indexOf('style={styles.eventHeadline}');
      assert.ok(headerIndex > 0 && headlineIndex > headerIndex, 'cardHeader comes before eventHeadline');

      const headerSlice = feedContent.slice(headerIndex, headlineIndex);
      assert.ok(headerSlice.includes('styles.badgeGroup'), 'badgeGroup is inside cardHeader');
      assert.ok(headerSlice.includes('styles.timeText'), 'timeText is inside cardHeader');
      assert.ok(feedContent.includes('<Text style={styles.eventHeadline}'));
    });
  });
});
