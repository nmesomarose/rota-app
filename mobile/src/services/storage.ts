import * as SecureStore from 'expo-secure-store';

/**
 * Secure token and session storage using expo-secure-store.
 * PRD Reference: 12.6, AC-AUTH-07.
 * Non-negotiable constraint: AC-AUTH-07 requires that NO auth tokens
 * are stored or read via AsyncStorage. All tokens are isolated here.
 */

const ACCESS_TOKEN_KEY = 'rota_access_token';
const REFRESH_TOKEN_KEY = 'rota_refresh_token';
const USER_PROFILE_KEY = 'rota_user_profile';
const ACTIVE_BUSINESS_KEY = 'rota_active_business';

export interface StoredUser {
  id: string;
  email: string;
  name?: string;
}

export interface StoredBusiness {
  id: string;
  name: string;
  role: string;
  branchId?: string;
  departmentId?: string;
}

// In environments where SecureStore native module is unavailable (e.g. tests/node), fallback gracefully
const memoryStore: Record<string, string> = {};

async function secureGet(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return memoryStore[key] || null;
  }
}

async function secureSet(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    memoryStore[key] = value;
  }
}

async function secureDelete(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    delete memoryStore[key];
  }
}

export async function getAccessToken(): Promise<string | null> {
  return secureGet(ACCESS_TOKEN_KEY);
}

export async function setAccessToken(token: string): Promise<void> {
  await secureSet(ACCESS_TOKEN_KEY, token);
}

export async function getRefreshToken(): Promise<string | null> {
  return secureGet(REFRESH_TOKEN_KEY);
}

export async function setRefreshToken(token: string): Promise<void> {
  await secureSet(REFRESH_TOKEN_KEY, token);
}

export async function getUserProfile(): Promise<StoredUser | null> {
  const json = await secureGet(USER_PROFILE_KEY);
  if (!json) return null;
  try {
    return JSON.parse(json) as StoredUser;
  } catch {
    return null;
  }
}

export async function setUserProfile(user: StoredUser): Promise<void> {
  await secureSet(USER_PROFILE_KEY, JSON.stringify(user));
}

export async function getActiveBusiness(): Promise<StoredBusiness | null> {
  const json = await secureGet(ACTIVE_BUSINESS_KEY);
  if (!json) return null;
  try {
    return JSON.parse(json) as StoredBusiness;
  } catch {
    return null;
  }
}

export async function setActiveBusiness(business: StoredBusiness): Promise<void> {
  await secureSet(ACTIVE_BUSINESS_KEY, JSON.stringify(business));
}

export async function clearActiveBusiness(): Promise<void> {
  await secureDelete(ACTIVE_BUSINESS_KEY);
}

/**
 * Clears all user tokens and credentials on logout or revocation (AC-AUTH-02, AC-OFF-01).
 */
export async function clearSession(): Promise<void> {
  await secureDelete(ACCESS_TOKEN_KEY);
  await secureDelete(REFRESH_TOKEN_KEY);
  await secureDelete(USER_PROFILE_KEY);
  await secureDelete(ACTIVE_BUSINESS_KEY);
}
