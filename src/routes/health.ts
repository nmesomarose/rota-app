import { Router, type Request, type Response } from 'express';
import { checkDatabaseConnection } from '../db/connection.ts';
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
  };
}

healthRouter.get('/health', async (_req: Request, res: Response) => {
  const dbConnected = await checkDatabaseConnection();

  const payload: HealthResponse = {
    status: dbConnected ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    environment: env.NODE_ENV,
    version: '0.1.0',
    checks: {
      server: 'healthy',
      database: dbConnected ? 'connected' : 'disconnected',
    },
  };

  res.status(dbConnected ? 200 : 503).json(payload);
});
