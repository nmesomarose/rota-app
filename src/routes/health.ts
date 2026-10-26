import { Router, type Request, type Response } from 'express';
import { checkDatabaseConnection } from '../db/connection.ts';
import { getRedisClient } from '../services/redis-client.ts';
import { getQueueMetrics } from '../queue/job-queue.ts';
import { env } from '../config/env.ts';

export const healthRouter = Router();

export interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptimeSeconds: number;
  environment: string;
  version: string;
  checks: {
    server: 'healthy';
    database: 'connected' | 'disconnected';
    redis: 'connected' | 'disconnected';
    queues?: {
      ready: number;
      processing: number;
      delayed: number;
      deadLetter: number;
    };
  };
}

/**
 * Lightweight liveness check for container orchestration and uptime probes.
 * Does NOT query PostgreSQL or Redis to ensure serverless databases (e.g. Neon)
 * can scale down to zero when the application is idle.
 */
healthRouter.get('/health/live', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    service: 'rota-backend',
  });
});

healthRouter.get('/health', async (_req: Request, res: Response) => {
  const dbConnected = await checkDatabaseConnection();

  let redisStatus: 'connected' | 'disconnected' = 'disconnected';
  let queueMetrics = undefined;

  try {
    const redis = getRedisClient();
    const pingPromise = redis.ping();
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500));
    const ping = await Promise.race([pingPromise, timeoutPromise]);

    if (ping === 'PONG') {
      redisStatus = 'connected';
      queueMetrics = await getQueueMetrics();
    }
  } catch {
    redisStatus = 'disconnected';
  }

  // System is healthy if database is connected and Redis is connected
  const isHealthy = dbConnected && (redisStatus === 'connected');

  const payload: HealthResponse = {
    status: isHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    environment: env.NODE_ENV,
    version: '0.1.0',
    checks: {
      server: 'healthy',
      database: dbConnected ? 'connected' : 'disconnected',
      redis: redisStatus,
      ...(queueMetrics ? { queues: queueMetrics } : {}),
    },
  };

  res.status(isHealthy ? 200 : 503).json(payload);
});
