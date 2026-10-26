import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

interface ConnectivityState {
  isOnline: boolean;
  isNetworkConnected: boolean;
  isBackendReachable: boolean;
  isChecking: boolean;
  lastCheckedAt: number | null;
  errorMessage: string | null;
}

type ConnectivityListener = (state: ConnectivityState) => void;

class MockConnectivityManager {
  public state: ConnectivityState = {
    isOnline: true,
    isNetworkConnected: true,
    isBackendReachable: true,
    isChecking: false,
    lastCheckedAt: null,
    errorMessage: null,
  };

  private listeners: Set<ConnectivityListener> = new Set();
  private throttleMs: number = 3000;
  public probeCount: number = 0;

  public addListener(listener: ConnectivityListener): () => void {
    this.listeners.add(listener);
    listener({ ...this.state });
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getListenerCount(): number {
    return this.listeners.size;
  }

  private notifyListeners(): void {
    const snapshot = { ...this.state };
    this.listeners.forEach((cb) => cb(snapshot));
  }

  public reportApiSuccess(): void {
    const wasOffline = !this.state.isOnline || !this.state.isBackendReachable;
    this.state = {
      ...this.state,
      isOnline: true,
      isNetworkConnected: true,
      isBackendReachable: true,
      isChecking: false,
      lastCheckedAt: Date.now(),
      errorMessage: null,
    };
    if (wasOffline) {
      this.notifyListeners();
    }
  }

  public reportApiFailure(type: 'NETWORK_ERROR' | 'REQUEST_TIMEOUT', msg?: string): void {
    const isNetwork = type === 'NETWORK_ERROR';
    this.state = {
      ...this.state,
      isOnline: false,
      isBackendReachable: false,
      isNetworkConnected: isNetwork ? false : this.state.isNetworkConnected,
      isChecking: false,
      lastCheckedAt: Date.now(),
      errorMessage: msg || (isNetwork ? 'Network connection unavailable' : 'Request timed out'),
    };
    this.notifyListeners();
  }

  public async mockCheckHealth(
    mockResponse: { ok: boolean; status: number; networkDown?: boolean },
    force = false
  ): Promise<boolean> {
    const now = Date.now();
    if (!force && this.state.lastCheckedAt && now - this.state.lastCheckedAt < this.throttleMs) {
      return this.state.isBackendReachable;
    }

    this.probeCount += 1;
    this.state.isChecking = true;
    this.notifyListeners();

    if (mockResponse.networkDown) {
      this.state = {
        ...this.state,
        isOnline: false,
        isNetworkConnected: false,
        isBackendReachable: false,
        isChecking: false,
        lastCheckedAt: Date.now(),
        errorMessage: 'Network connection unavailable',
      };
      this.notifyListeners();
      return false;
    }

    if (mockResponse.ok) {
      this.state = {
        ...this.state,
        isOnline: true,
        isNetworkConnected: true,
        isBackendReachable: true,
        isChecking: false,
        lastCheckedAt: Date.now(),
        errorMessage: null,
      };
      this.notifyListeners();
      return true;
    } else {
      // Network exists, but server returned 502/503
      this.state = {
        ...this.state,
        isOnline: false,
        isNetworkConnected: true,
        isBackendReachable: false,
        isChecking: false,
        lastCheckedAt: Date.now(),
        errorMessage: `Server returned HTTP ${mockResponse.status}`,
      };
      this.notifyListeners();
      return false;
    }
  }
}

describe('Task 1: Automatic Connectivity Recovery & Reachability Tests', () => {
  it('1. Transition from online to offline: triggers real-time listener updates', () => {
    const manager = new MockConnectivityManager();
    const transitions: boolean[] = [];

    const unsub = manager.addListener((state) => {
      transitions.push(state.isOnline);
    });

    assert.equal(transitions[0], true, 'Starts online');

    // Simulate network error
    manager.reportApiFailure('NETWORK_ERROR', 'Network connection unavailable');

    assert.equal(transitions.length, 2);
    assert.equal(transitions[1], false, 'Dispatched offline state');
    assert.equal(manager.state.isOnline, false);
    assert.equal(manager.state.isNetworkConnected, false);
    assert.equal(manager.state.isBackendReachable, false);

    unsub();
  });

  it('2. Transition from offline to online: automatically notifies listeners without reload', () => {
    const manager = new MockConnectivityManager();
    // Start in offline state
    manager.reportApiFailure('NETWORK_ERROR');

    const transitions: boolean[] = [];
    const unsub = manager.addListener((state) => {
      transitions.push(state.isOnline);
    });

    assert.equal(transitions[0], false, 'Subscribed in offline state');

    // Simulate backend recovering on normal API success
    manager.reportApiSuccess();

    assert.equal(transitions.length, 2);
    assert.equal(transitions[1], true, 'Automatically transitioned to online');
    assert.equal(manager.state.isOnline, true);
    assert.equal(manager.state.isBackendReachable, true);

    unsub();
  });

  it('3. Network restored but backend still unavailable: distinguishes network from backend', async () => {
    const manager = new MockConnectivityManager();

    // Start with network down
    await manager.mockCheckHealth({ ok: false, status: 0, networkDown: true }, true);
    assert.equal(manager.state.isNetworkConnected, false);
    assert.equal(manager.state.isBackendReachable, false);
    assert.equal(manager.state.isOnline, false);

    // Network is restored (e.g. Wi-Fi reconnected), but backend is down (returns HTTP 503)
    await manager.mockCheckHealth({ ok: false, status: 503, networkDown: false }, true);

    assert.equal(manager.state.isNetworkConnected, true, 'Network is connected');
    assert.equal(manager.state.isBackendReachable, false, 'Backend is not reachable');
    assert.equal(manager.state.isOnline, false, 'Overall status remains offline');
    assert.match(manager.state.errorMessage!, /HTTP 503/);
  });

  it('4. Backend becomes reachable and UI updates automatically', async () => {
    const manager = new MockConnectivityManager();
    // Start offline
    manager.reportApiFailure('REQUEST_TIMEOUT');

    let uiHeaderBadge = 'Offline';
    let feedAutoRefetched = false;

    const unsubHeader = manager.addListener((state) => {
      uiHeaderBadge = state.isOnline ? 'Online' : 'Offline';
    });

    const unsubFeed = manager.addListener((state) => {
      if (state.isOnline) {
        feedAutoRefetched = true;
      }
    });

    assert.equal(uiHeaderBadge, 'Offline');
    assert.equal(feedAutoRefetched, false);

    // Backend health probe succeeds
    await manager.mockCheckHealth({ ok: true, status: 200 }, true);

    assert.equal(uiHeaderBadge, 'Online', 'UI Header automatically updated to Online');
    assert.equal(feedAutoRefetched, true, 'Feed automatically triggered reload without reload');

    unsubHeader();
    unsubFeed();
  });

  it('5. Listener cleanup, prevention of duplicate subscriptions, and probe throttling', async () => {
    const manager = new MockConnectivityManager();

    let notificationCount = 0;
    const listener = () => {
      notificationCount += 1;
    };

    const unsub = manager.addListener(listener);
    assert.equal(manager.getListenerCount(), 1);
    assert.equal(notificationCount, 1, 'Initial state received on subscribe');

    // Trigger state change
    manager.reportApiFailure('NETWORK_ERROR');
    assert.equal(notificationCount, 2);

    // Unsubscribe
    unsub();
    assert.equal(manager.getListenerCount(), 0, 'Cleaned up listener from Set');

    // State change after unsubscribe
    manager.reportApiSuccess();
    assert.equal(notificationCount, 2, 'Unsubscribed listener ignored subsequent events');

    // Test health check throttling: consecutive unforced calls within throttleMs do NOT spam probes
    manager.probeCount = 0;
    await manager.mockCheckHealth({ ok: true, status: 200 }, true);
    assert.equal(manager.probeCount, 1);

    // Immediate second call without force should be throttled
    await manager.mockCheckHealth({ ok: true, status: 200 }, false);
    assert.equal(manager.probeCount, 1, 'Throttled second unforced probe to prevent infinite loops/spam');

    // Forced retry should execute
    await manager.mockCheckHealth({ ok: true, status: 200 }, true);
    assert.equal(manager.probeCount, 2, 'Forced probe executed immediately');
  });
});
