import argon2 from 'argon2';

/**
 * Argon2id parameters per DR-05 and SEC-008:
 * - type: Argon2id (2)
 * - memoryCost: 64MB (65536 KB)
 * - timeCost: 3 iterations
 * - parallelism: 4 threads
 */
const ARGON2_OPTIONS = {
  type: 2 as const, // argon2.argon2id
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  raw: false as const,
};

/**
 * Hashes a plaintext password using Argon2id.
 * Plaintext passwords and generated hashes are never logged.
 */
export async function hashPassword(plainText: string): Promise<string> {
  return argon2.hash(plainText, ARGON2_OPTIONS);
}

/**
 * Verifies a plaintext password against a stored Argon2id hash.
 * Returns true if valid, false otherwise.
 */
export async function verifyPassword(hash: string, plainText: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plainText);
  } catch (_err) {
    return false;
  }
}
