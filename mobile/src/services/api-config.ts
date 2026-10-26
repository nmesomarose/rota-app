/**
 * Mobile API Configuration and Environment Resolution
 */

// Default local development address (used only when not in a production release)
export const DEV_DEFAULT_API_URL = 'http://172.20.10.13:3000';

/**
 * Resolves the initial API base URL based on build environment:
 * 1. Explicit EXPO_PUBLIC_API_URL environment variable (highest priority for all environments).
 * 2. In development mode (__DEV__ === true or NODE_ENV !== 'production'), falls back to local dev URL.
 * 3. In production builds, returns empty string so unconfigured builds fail fast rather than
 *    silently attempting network requests against a private local development IP.
 */
export function resolveInitialApiBaseUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_API_URL?.trim().replace(/\/+$/, '');
  if (envUrl) {
    return envUrl;
  }

  // React Native bundler sets global __DEV__ to true in development, false in production builds
  const isDev =
    typeof (globalThis as unknown as { __DEV__?: boolean }).__DEV__ !== 'undefined'
      ? Boolean((globalThis as unknown as { __DEV__?: boolean }).__DEV__)
      : process.env.NODE_ENV !== 'production';

  if (isDev) {
    return DEV_DEFAULT_API_URL;
  }

  return '';
}

export let API_BASE_URL = resolveInitialApiBaseUrl();

export function setCustomApiUrl(url: string): void {
  API_BASE_URL = url.trim().replace(/\/+$/, '');
}

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

/**
 * Resolves the Google OAuth Client ID (Web Client ID) used for ID token audience validation.
 * Must match the backend GOOGLE_CLIENT_ID environment configuration.
 */
export function getGoogleClientId(): string {
  return (
    process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ||
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ||
    ''
  ).trim();
}

/**
 * Resolves the OAuth redirect URI for mobile authentication.
 * Defaults to the custom scheme registered in app.json ("rota://auth/google").
 */
export function getGoogleRedirectUri(): string {
  return (
    process.env.EXPO_PUBLIC_GOOGLE_REDIRECT_URI ||
    'rota://auth/google'
  ).trim();
}

export const getGoogleWebClientId = getGoogleClientId;

