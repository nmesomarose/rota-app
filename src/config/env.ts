import { z } from 'zod';
import dotenv from 'dotenv';

// Load .env if present
dotenv.config();

export const KNOWN_DEV_SECRETS = new Set([
  'development_jwt_secret_minimum_16_characters_long',
  'development_refresh_secret_minimum_16_characters_long',
  'replace_with_a_secure_random_string_at_least_32_chars',
  'REPLACE_WITH_CRYPTOGRAPHICALLY_SECURE_RANDOM_STRING_AT_LEAST_32_CHARS',
].map((s) => s.toLowerCase()));

function isKnownDevSecret(secret: string): boolean {
  return KNOWN_DEV_SECRETS.has(secret.toLowerCase().trim());
}

function deriveDatabaseUrl(baseUrl: string | undefined, defaultDb: string): string {
  if (!baseUrl) return `postgresql://postgres:postgres@localhost:5432/${defaultDb}`;
  try {
    const parsed = new URL(baseUrl);
    parsed.pathname = `/${defaultDb}`;
    return parsed.toString();
  } catch {
    return baseUrl;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  // Database Connection Strings
  DATABASE_URL: z
    .string()
    .url()
    .default('postgresql://postgres:postgres@localhost:5432/rota'),
  APP_DATABASE_URL: z
    .string()
    .url()
    .default('postgresql://rota_app:rota_dev_app_password@localhost:5432/rota'),

  // Dedicated Shard Database Connection Strings (PRD 9.1, DR-04, Phase 2)
  SHARD_1_DATABASE_URL: z
    .string()
    .url()
    .default(deriveDatabaseUrl(process.env.DATABASE_URL, 'rota_shard_1')),
  APP_SHARD_1_DATABASE_URL: z
    .string()
    .url()
    .default(deriveDatabaseUrl(process.env.APP_DATABASE_URL || process.env.DATABASE_URL, 'rota_shard_1')),
  SHARD_2_DATABASE_URL: z
    .string()
    .url()
    .default(deriveDatabaseUrl(process.env.DATABASE_URL, 'rota_shard_2')),
  APP_SHARD_2_DATABASE_URL: z
    .string()
    .url()
    .default(deriveDatabaseUrl(process.env.APP_DATABASE_URL || process.env.DATABASE_URL, 'rota_shard_2')),

  // Schema Names
  CONTROL_SCHEMA: z.string().min(1).default('rota_control'),
  SHARD_1_SCHEMA: z.string().min(1).default('rota_shard_1'),
  SHARD_2_SCHEMA: z.string().min(1).default('rota_shard_2'),

  // Redis Configuration
  REDIS_URL: z.string().url().optional(),

  // Proxy Configuration (controls Express trust proxy)
  TRUST_PROXY: z.string().default('false'),

  // Security Secrets (Placeholders / Configurable)
  JWT_SECRET: z.string().min(16).default('development_jwt_secret_minimum_16_characters_long'),
  REFRESH_TOKEN_SECRET: z.string().min(16).default('development_refresh_secret_minimum_16_characters_long'),

  // Paystack Payment Provider Configuration
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),
  APP_BASE_URL: z.string().optional(),
  PAYSTACK_CALLBACK_URL: z.string().optional(),

  // Background Queue & Worker Configuration
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  QUEUE_BACKOFF_MS: z.coerce.number().int().positive().default(1000),
  QUEUE_VISIBILITY_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  SWEEPER_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  ASYNC_WEBHOOK_PROCESSING: z.string().default('false'),

  // Transactional Email Providers (Resend & Mailjet)
  RESEND_API_KEY: z.string().optional(),
  MAILJET_API_KEY: z.string().optional(),
  MAILJET_SECRET_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Rota <onboarding@resend.dev>'),
  EMAIL_PROVIDER: z.enum(['resend', 'mailjet', 'simulated']).optional(),

  // Push Notification Provider (Expo)
  EXPO_ACCESS_TOKEN: z.string().optional(),
  PUSH_PROVIDER: z.enum(['expo', 'simulated']).optional(),

  // Google OAuth Provider (Gate G-02, FR-AUTH-002)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === 'production') {
    if (!data.REDIS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'REDIS_URL is required in production environment',
        path: ['REDIS_URL'],
      });
    }

    if (!data.JWT_SECRET || isKnownDevSecret(data.JWT_SECRET) || data.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'JWT_SECRET must be explicitly provided in production, contain at least 32 characters, and cannot use development fallback values',
        path: ['JWT_SECRET'],
      });
    }

    if (!data.REFRESH_TOKEN_SECRET || isKnownDevSecret(data.REFRESH_TOKEN_SECRET) || data.REFRESH_TOKEN_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'REFRESH_TOKEN_SECRET must be explicitly provided in production, contain at least 32 characters, and cannot use development fallback values',
        path: ['REFRESH_TOKEN_SECRET'],
      });
    }
  }
});

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Validates and parses environment variables.
 * @param env Custom environment object (defaults to process.env)
 * @returns Validated environment configuration
 */
export function validateEnv(env: Record<string, string | undefined> = process.env): EnvConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const formatted = result.error.format();
    throw new Error(`Environment validation failed: ${JSON.stringify(formatted, null, 2)}`);
  }
  return result.data;
}

export const env = validateEnv();
