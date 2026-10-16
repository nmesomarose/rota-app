import { z } from 'zod';
import dotenv from 'dotenv';

// Load .env if present
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // Database Connection Strings
  DATABASE_URL: z
    .string()
    .url()
    .default('postgresql://postgres:postgres@localhost:5432/rota'),
  APP_DATABASE_URL: z
    .string()
    .url()
    .default('postgresql://rota_app:rota_dev_app_password@localhost:5432/rota'),

  // Schema Names
  CONTROL_SCHEMA: z.string().min(1).default('rota_control'),
  SHARD_1_SCHEMA: z.string().min(1).default('rota_shard_1'),
  SHARD_2_SCHEMA: z.string().min(1).default('rota_shard_2'),

  // Security Secrets (Placeholders / Configurable)
  JWT_SECRET: z.string().min(16).default('development_jwt_secret_minimum_16_characters_long'),
  REFRESH_TOKEN_SECRET: z.string().min(16).default('development_refresh_secret_minimum_16_characters_long'),
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
