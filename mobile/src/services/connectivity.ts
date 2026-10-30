import { AppState, type AppStateStatus } from 'react-native';

export interface ConnectivityState {
  isOnline: boolean;
  isNetworkConnected: boolean;
  isBackendReachable: boolean;
  isChecking: boolean;
  lastCheckedAt: number | null;
  errorMessage: string | null;
}

export type ConnectivityListener = (state: ConnectivityState) => void;

class ConnectivityManager {
  private state: ConnectivityState = {
    isOnline: true,
    isNetworkConnected: true,
    isBackendReachable: true,
    isChecking: false,
    lastCheckedAt: null,
    errorMessage: null,
  };

  private listeners: Set<ConnectivityListener> = new Set();
  private inFlightProbe: Promise<boolean> | null = null;
  private apiBaseUrl: string = '';
  private appStateSubscription: { remove: () => void } | null = null;
  private throttleMs: number = 3000;

  constructor() {
    this.setupAppStateListener();
  }

  public setApiBaseUrl(url: string): void {
    this.apiBaseUrl = url.trim().replace(/\/+$/, '');
  }

  public getApiBaseUrl(): string {
    return this.apiBaseUrl;
  }

  public getState(): ConnectivityState {
    return { ...this.state };
  }

  /**
   * Subscribes a listener to connectivity changes.
   * Immediately dispatches current state to ensure the caller does not start in a stale state.
   */
  public addListener(listener: ConnectivityListener): () => void {
    this.listeners.add(listener);
    // Dispatch initial state immediately
    try {
      listener(this.getState());
    } catch (err) {
      console.warn('[ConnectivityManager] Initial listener dispatch error:', err);
    }

    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Broadcasts updated state to all registered listeners.
   */
  private notifyListeners(): void {
    const snapshot = this.getState();
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (err) {
        console.warn('[ConnectivityManager] Listener notification error:', err);
      }
    });
  }

  /**
   * Reports a successful API response from normal app activity.
   * This immediately marks the backend as reachable without generating an extra health ping.
   */
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

  /**
   * Reports a network or request timeout failure from normal app activity.
   */
  public reportApiFailure(errorType: 'NETWORK_ERROR' | 'REQUEST_TIMEOUT' | 'UNKNOWN', message?: string): void {
    const isNetwork = errorType === 'NETWORK_ERROR';
    this.state = {
      ...this.state,
      isOnline: false,
      isBackendReachable: false,
      isNetworkConnected: isNetwork ? false : this.state.isNetworkConnected,
      isChecking: false,
      lastCheckedAt: Date.now(),
      errorMessage: message || (isNetwork ? 'Network connection unavailable' : 'Backend request timed out'),
    };
    this.notifyListeners();
  }

  /**
   * Performs an authoritative backend reachability check.
   * - Deduplicates concurrent calls.
   * - Throttles consecutive checks within throttleMs unless `force` is true.
   * - Distinguishes general network reachability from backend server reachability.
   */
  public async checkBackendHealth(force = false): Promise<boolean> {
    if (!this.apiBaseUrl) {
      this.state = {
        ...this.state,
        isOnline: false,
        isBackendReachable: false,
        isChecking: false,
        lastCheckedAt: Date.now(),
        errorMessage: 'Backend API URL is not configured',
      };
      this.notifyListeners();
      return false;
    }

    const now = Date.now();

    // Prevent spam: if checked recently and not forced, return current cached state
    if (!force && this.state.lastCheckedAt && now - this.state.lastCheckedAt < this.throttleMs) {
      return this.state.isBackendReachable;
    }

    // Reuse in-flight probe if already executing
    if (this.inFlightProbe) {
      return this.inFlightProbe;
    }

    this.state = {
      ...this.state,
      isChecking: true,
    };
    this.notifyListeners();

    this.inFlightProbe = (async (): Promise<boolean> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      try {
        const res = await fetch(`${this.apiBaseUrl}/health`, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'Cache-Control': 'no-cache, no-store',
            Pragma: 'no-cache',
          },
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          this.state = {
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
          // Network is alive, but backend is responding with non-200 (e.g. 502/503)
          this.state = {
            isOnline: false,
            isNetworkConnected: true,
            isBackendReachable: false,
            isChecking: false,
            lastCheckedAt: Date.now(),
            errorMessage: `Server returned HTTP ${res.status}`,
          };
          this.notifyListeners();
          return false;
        }
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        const isAbort = (err as any)?.name === 'AbortError';
        const msg = isAbort
          ? 'Backend health check timed out (8.0s)'
          : 'Unable to reach backend server';

        this.state = {
          isOnline: false,
          isNetworkConnected: !isAbort ? false : true,
          isBackendReachable: false,
          isChecking: false,
          lastCheckedAt: Date.now(),
          errorMessage: msg,
        };
        this.notifyListeners();
        return false;
      } finally {
        this.inFlightProbe = null;
      }
    })();

    return this.inFlightProbe;
  }

  /**
   * Forces an immediate connectivity check (visible retry action).
   */
  public async retry(): Promise<boolean> {
    return this.checkBackendHealth(true);
  }

  /**
   * Automatically re-tests connectivity when the app returns from background to foreground.
   */
  private setupAppStateListener(): void {
    if (typeof AppState?.addEventListener === 'function') {
      try {
        const sub = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
          if (nextAppState === 'active') {
            // App was brought to foreground: verify backend connectivity immediately
            this.checkBackendHealth(false).catch(() => {});
          }
        });
        this.appStateSubscription = sub;
      } catch {
        // AppState mock/fallback in test environments
      }
    }
  }

  public cleanup(): void {
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
    this.listeners.clear();
  }
}

export const connectivityManager = new ConnectivityManager();
