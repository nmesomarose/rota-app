import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env.ts';

let redisInstance: Redis | null = null;
let testClientOverride: Redis | null = null;

/**
 * Resolves the Redis connection URL based on environment.
 * In development and test, defaults to local Redis (redis://localhost:6379).
 * In production, strictly requires env.REDIS_URL.
 */
export function getRedisUrl(): string {
  if (testClientOverride) {
    return 'redis://test-override';
  }
  if (env.REDIS_URL) {
    return env.REDIS_URL;
  }
  if (process.env.REDIS_URL) {
    return process.env.REDIS_URL;
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('REDIS_URL must be specified in production environment');
  }
  return 'redis://localhost:6379';
}

/**
 * Returns or initializes the shared Redis client singleton.
 * Configured with fast failure on disconnects (enableOfflineQueue: false)
 * to prevent API thread starvation during Redis outages (NFR-REL-002).
 */
export function getRedisClient(): Redis {
  if (testClientOverride) {
    return testClientOverride;
  }

  if (!redisInstance) {
    const url = getRedisUrl();
    const options: RedisOptions = {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
      commandTimeout: 3000,
      connectTimeout: 3000,
      lazyConnect: false,
      retryStrategy(times) {
        // Linear backoff with 2s ceiling
        return Math.min(times * 100, 2000);
      },
    };

    redisInstance = new Redis(url, options);

    redisInstance.on('error', (err) => {
      // Suppress unhandled error crash, log structured message
      console.error('[Redis Client Error]', err.message);
    });

    redisInstance.on('connect', () => {
      if (process.env.NODE_ENV !== 'test') {
        console.log('[Redis Client] Connected to Redis instance successfully');
      }
    });

    redisInstance.on('ready', () => {
      if (process.env.NODE_ENV === 'test' || process.env.npm_lifecycle_event === 'test') {
        try {
          (redisInstance as any)?.stream?.unref?.();
        } catch {
          // ignore
        }
      }
    });
  }

  return redisInstance;
}

/**
 * Ensures the Redis client is fully connected and ready before proceeding.
 */
export async function ensureRedisConnected(): Promise<Redis> {
  const client = getRedisClient();
  if (client.status === 'ready') {
    return client;
  }
  await new Promise<void>((resolve, reject) => {
    if (client.status === 'ready') return resolve();
    const onReady = () => {
      client.removeListener('error', onError);
      resolve();
    };
    const onError = (err: Error) => {
      client.removeListener('ready', onReady);
      reject(err);
    };
    client.once('ready', onReady);
    client.once('error', onError);
  });
  return client;
}

/**
 * Allows injecting a test or mock Redis client in automated test suites.
 */
export function setRedisClientForTesting(client: Redis | null): void {
  testClientOverride = client;
}

/**
 * Returns whether Redis is connected and in a usable state.
 */
export function isRedisConnected(): boolean {
  if (testClientOverride) {
    return testClientOverride.status === 'ready' || testClientOverride.status === 'connect';
  }
  return !!redisInstance && (redisInstance.status === 'ready' || redisInstance.status === 'connect');
}

/**
 * Gracefully disconnects and resets the Redis client.
 */
export async function closeRedisClient(): Promise<void> {
  if (redisInstance) {
    try {
      await redisInstance.quit();
    } catch {
      redisInstance.disconnect();
    } finally {
      redisInstance = null;
    }
  }
  testClientOverride = null;
}
