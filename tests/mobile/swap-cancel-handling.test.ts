import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

describe('Shift Swap Cancel & Dismissal Handling (Schedule & Team Screens)', () => {
  const scheduleScreenPath = path.resolve('mobile/src/screens/ScheduleScreen.tsx');
  const teamScreenPath = path.resolve('mobile/src/screens/TeamScreen.tsx');
  const scheduleScreenContent = fs.readFileSync(scheduleScreenPath, 'utf8');
  const teamScreenContent = fs.readFileSync(teamScreenPath, 'utf8');

  it('1. ScheduleScreen has dedicated testID and reliable handler on Shift Swap close X button', () => {
    assert.ok(
      scheduleScreenContent.includes('testID="close-swap-modal-btn"'),
      'Shift swap modal close button must have testID="close-swap-modal-btn"'
    );
    assert.ok(
      scheduleScreenContent.includes('accessibilityLabel="Close shift swap dialog"'),
      'Close button must have proper accessibility label'
    );
    assert.ok(
      scheduleScreenContent.includes('onPress={handleCloseSwapModal}'),
      'Close button must directly invoke handleCloseSwapModal'
    );
  });

  it('2. handleCloseSwapModal completely clears swap state', () => {
    assert.ok(
      scheduleScreenContent.includes('setShowSwapModal(false);') &&
      scheduleScreenContent.includes('setSwapShift(null);') &&
      scheduleScreenContent.includes('setSelectedCounterpartShiftId(null);') &&
      scheduleScreenContent.includes('setSelectedCounterpartMembershipId(null);') &&
      scheduleScreenContent.includes("setSwapNotes('');"),
      'handleCloseSwapModal must synchronously reset all modal and selection state'
    );
  });

  it('3. Candidate colleague shift allows toggle/deselection when clicked again', () => {
    assert.ok(
      scheduleScreenContent.includes('if (isSelected) {') &&
      scheduleScreenContent.includes('setSelectedCounterpartShiftId(null);'),
      'Clicking an already-selected candidate shift must toggle it off / unselect it'
    );
    assert.ok(
      scheduleScreenContent.includes("name={isSelected ? 'close-circle' : 'radio-button-off'}"),
      'Selected candidate shift must display close-circle cancellation icon'
    );
  });

  it('4. Colleague badge allows toggle/deselection when clicked again', () => {
    assert.ok(
      scheduleScreenContent.includes('if (isSelected) {') &&
      scheduleScreenContent.includes('setSelectedCounterpartMembershipId(null);'),
      'Clicking an already-selected colleague badge must toggle it off'
    );
  });

  it('5. Modal card and close button have explicit zIndex and pointerEvents to prevent touch cancellation', () => {
    assert.ok(
      scheduleScreenContent.includes('<View style={styles.modalCard} pointerEvents="auto">'),
      'Modal card must specify pointerEvents="auto" so backdrop touches do not swallow card touches'
    );
    assert.ok(
      scheduleScreenContent.includes('zIndex: 10') && scheduleScreenContent.includes('zIndex: 30'),
      'Modal card (zIndex: 10) and close button (zIndex: 30) must be layered above the backdrop'
    );
    assert.ok(
      scheduleScreenContent.includes('keyboardShouldPersistTaps="handled"'),
      'ScrollView inside swap modal must specify keyboardShouldPersistTaps="handled"'
    );
  });

  it('6. TeamScreen provides cancel action for pending and peer_accepted swap requests', () => {
    assert.ok(
      teamScreenContent.includes('handleCancelSwap'),
      'TeamScreen must define handleCancelSwap handler'
    );
    assert.ok(
      teamScreenContent.includes('api.swaps.cancelSwap(swapId)'),
      'TeamScreen handleCancelSwap must invoke api.swaps.cancelSwap'
    );
    assert.ok(
      teamScreenContent.includes('btnCancel'),
      'TeamScreen must render Cancel button on swap request cards'
    );
  });
});
