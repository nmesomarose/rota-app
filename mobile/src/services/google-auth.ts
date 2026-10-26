import type {
  GoogleSignin as GoogleSigninType,
} from '@react-native-google-signin/google-signin';
import { getGoogleClientId } from './api-config.ts';
import { api, ApiError } from './api.ts';
import {
  setAccessToken,
  setRefreshToken,
  setUserProfile,
  type StoredUser,
} from './storage.ts';
import {
  registerForPushNotificationsAsync,
  resetSessionExpiredAlertState,
} from './notifications.ts';

export const statusCodes = {
  SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED',
  IN_PROGRESS: 'IN_PROGRESS',
  PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
  SIGN_IN_REQUIRED: 'SIGN_IN_REQUIRED',
  NULL_PRESENTER: 'NULL_PRESENTER',
} as const;

let cachedGoogleSignin: typeof GoogleSigninType | null = null;

export async function getNativeGoogleSignin(): Promise<typeof GoogleSigninType> {
  if (cachedGoogleSignin) {
    return cachedGoogleSignin;
  }
  try {
    const mod = await import('@react-native-google-signin/google-signin');
    cachedGoogleSignin = mod.GoogleSignin;
    return cachedGoogleSignin;
  } catch (err: unknown) {
    throw new Error(
      'Native Google Sign-In is only available on Android and iOS devices. Google Play Services bridge is not present in this runtime.'
    );
  }
}

export interface GoogleAuthSuccess {
  type: 'success';
  user: StoredUser;
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  };
  activeBusinessId: string | null;
  businesses: Array<{
    business_id: string;
    business_name: string;
    role: string;
    status: string;
  }>;
  isNewUser: boolean;
}

export interface GoogleAuthCancel {
  type: 'cancel';
}

export interface GoogleAuthLinkingRequired {
  type: 'linking_required';
  email: string;
  idToken: string;
  message: string;
}

export interface GoogleAuthError {
  type: 'error';
  code: string;
  message: string;
}

export type GoogleSignInResult =
  | GoogleAuthSuccess
  | GoogleAuthCancel
  | GoogleAuthLinkingRequired
  | GoogleAuthError;

export interface NativeGoogleTokenResult {
  type: 'success';
  idToken: string;
  email?: string;
}

export interface NativeGoogleCancelResult {
  type: 'cancel';
}

export interface NativeGoogleErrorResult {
  type: 'error';
  code: string;
  message: string;
}

export type NativeGooglePromptResult =
  | NativeGoogleTokenResult
  | NativeGoogleCancelResult
  | NativeGoogleErrorResult;

export interface NativeGoogleSignInLauncher {
  prompt(webClientId: string): Promise<NativeGooglePromptResult>;
}

export class DefaultNativeGoogleSignInLauncher implements NativeGoogleSignInLauncher {
  private configuredClientId: string | null = null;

  async prompt(webClientId: string): Promise<NativeGooglePromptResult> {
    try {
      const GoogleSignin = await getNativeGoogleSignin();

      if (this.configuredClientId !== webClientId) {
        GoogleSignin.configure({
          webClientId,
          scopes: ['email', 'profile'],
          offlineAccess: false,
        });
        this.configuredClientId = webClientId;
      }

      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

      const response = await GoogleSignin.signIn();

      if (response.type === 'cancelled') {
        return { type: 'cancel' };
      }

      if (response.type === 'success' && response.data?.idToken) {
        return {
          type: 'success',
          idToken: response.data.idToken,
          email: response.data.user?.email,
        };
      }

      return {
        type: 'error',
        code: 'NO_TOKEN',
        message: 'Google Sign-In completed, but no ID token was returned by Google Identity Services.',
      };
    } catch (err: unknown) {
      const errorObj = err as { code?: string; message?: string };
      if (errorObj?.code === statusCodes.SIGN_IN_CANCELLED) {
        return { type: 'cancel' };
      }
      if (errorObj?.code === statusCodes.IN_PROGRESS) {
        return {
          type: 'error',
          code: 'IN_PROGRESS',
          message: 'Google Sign-In is already in progress.',
        };
      }
      if (errorObj?.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        return {
          type: 'error',
          code: 'PLAY_SERVICES_UNAVAILABLE',
          message: 'Google Play Services is not available or needs to be updated on this device.',
        };
      }

      return {
        type: 'error',
        code: errorObj?.code || 'AUTH_SESSION_FAILED',
        message: errorObj?.message || 'Failed to authenticate with Google Play Services.',
      };
    }
  }
}

let customNativeLauncher: NativeGoogleSignInLauncher | null = null;
const defaultNativeLauncher = new DefaultNativeGoogleSignInLauncher();

export function setNativeGoogleSignInLauncher(launcher: NativeGoogleSignInLauncher | null): void {
  customNativeLauncher = launcher;
}

export function getNativeGoogleSignInLauncher(): NativeGoogleSignInLauncher {
  return customNativeLauncher || defaultNativeLauncher;
}

/**
 * Checks whether Google OAuth is configured via environment variables.
 */
export function isGoogleAuthConfigured(): boolean {
  return Boolean(getGoogleClientId());
}

/**
 * Launches the native Google Play Services sign-in prompt using the configured Web Client ID.
 */
export async function promptNativeGoogleSignIn(): Promise<NativeGooglePromptResult> {
  const webClientId = getGoogleClientId();
  if (!webClientId) {
    return {
      type: 'error',
      code: 'CONFIG_REQUIRED',
      message:
        'Google Sign-In is not yet configured. Please set EXPO_PUBLIC_GOOGLE_CLIENT_ID or EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID with your Google Cloud Web Client ID.',
    };
  }

  const launcher = getNativeGoogleSignInLauncher();
  return launcher.prompt(webClientId);
}

function decodeBase64Safe(input: string): string {
  if (typeof global.atob === 'function') {
    try {
      return global.atob(input);
    } catch {
      // fallback to manual decode
    }
  }
  if (typeof Buffer !== 'undefined') {
    try {
      return Buffer.from(input, 'base64').toString('utf8');
    } catch {
      // fallback to manual decode
    }
  }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const str = input.replace(/=+$/, '');
  let output = '';
  for (
    let bc = 0, bs = 0, buffer: number, idx = 0;
    (buffer = chars.indexOf(str.charAt(idx++)));
    ~buffer &&
    ((bs = bc % 4 ? bs * 64 + buffer : buffer),
    bc++ % 4)
      ? (output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6))))
      : 0
  ) {}
  return output;
}

export function extractEmailFromJwt(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const jsonStr = decodeBase64Safe(padded);
    const payload = JSON.parse(jsonStr);
    return typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

// In-flight concurrency lock to prevent duplicate authentication calls
let isAuthInProgress = false;

/**
 * Complete Native Google Sign-In workflow:
 * 1. Concurrency lock prevents duplicate simultaneous invocations.
 * 2. Prompts native Google Sign-In account selection (or accepts a provided idToken in tests/dev).
 * 3. Authenticates with Rota backend using genuine cryptographic verification.
 * 4. Persists session tokens and user profile to SecureStore.
 * 5. Handles ACCOUNT_LINKING_REQUIRED (HTTP 409) for safe password re-auth.
 */
export async function executeGoogleSignIn(providedIdToken?: string): Promise<GoogleSignInResult> {
  if (isAuthInProgress) {
    return {
      type: 'error',
      code: 'IN_PROGRESS',
      message: 'Authentication request is already in progress.',
    };
  }

  isAuthInProgress = true;

  try {
    let idToken: string;
    let promptEmail: string | undefined;

    if (providedIdToken) {
      idToken = providedIdToken;
    } else {
      const promptRes = await promptNativeGoogleSignIn();
      if (promptRes.type === 'cancel') {
        return { type: 'cancel' };
      }
      if (promptRes.type === 'error') {
        return {
          type: 'error',
          code: promptRes.code,
          message: promptRes.message,
        };
      }
      idToken = promptRes.idToken;
      promptEmail = promptRes.email;
    }

    try {
      const authData = await api.auth.googleSignIn(idToken);

      // Reset session expired state
      resetSessionExpiredAlertState();

      // Persist session tokens & user profile to SecureStore
      await setAccessToken(authData.tokens.accessToken);
      await setRefreshToken(authData.tokens.refreshToken);
      await setUserProfile(authData.user);

      // Proactively register push notification token
      registerForPushNotificationsAsync().catch(() => {});

      return {
        type: 'success',
        user: authData.user,
        tokens: authData.tokens,
        activeBusinessId: authData.activeBusinessId,
        businesses: authData.businesses,
        isNewUser: authData.isNewUser,
      };
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.code === 'ACCOUNT_LINKING_REQUIRED' || err.statusCode === 409) {
          // Safe account linking protection (FR-AUTH-011, AC-AUTH-04)
          const errorDetails = err.details as { email?: string } | undefined;
          const linkingEmail =
            errorDetails?.email || promptEmail || extractEmailFromJwt(idToken) || '';
          return {
            type: 'linking_required',
            email: linkingEmail,
            idToken,
            message:
              err.message ||
              'An account already exists with this email address. Please sign in with your password to link your Google identity.',
          };
        }

        return {
          type: 'error',
          code: err.code || 'AUTH_FAILED',
          message: err.message || 'Google authentication failed.',
        };
      }

      return {
        type: 'error',
        code: 'NETWORK_ERROR',
        message: 'Unable to connect to Rota servers. Please check your connection.',
      };
    }
  } finally {
    isAuthInProgress = false;
  }
}
