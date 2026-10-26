import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import { requestIdMiddleware } from './middleware/request-id.ts';
import { requestLoggerMiddleware } from './middleware/request-logger.ts';
import { errorTracker } from './utils/error-tracker.ts';
import { healthRouter } from './routes/health.ts';
import { authRouter } from './routes/auth.ts';
import { organizationRouter } from './routes/organization.ts';
import { schedulingRouter } from './routes/scheduling.ts';
import { notificationsRouter } from './routes/notifications.ts';
import { swapsRouter } from './routes/swaps.ts';
import { attendanceRouter } from './routes/attendance.ts';
import { activityRouter } from './routes/activity.ts';
import { billingRouter } from './routes/billing.ts';
import { settingsRouter } from './routes/settings.ts';
import { env } from './config/env.ts';
import { sendError } from './utils/errors.ts';

/**
 * Creates and configures the Express application.
 */
export function createApp(): Application {
  const app = express();

  // Configure trust proxy explicitly according to secure proxy configuration (SEC-004)
  if (env.TRUST_PROXY === 'true') {
    app.set('trust proxy', true);
  } else if (env.TRUST_PROXY === 'false') {
    app.set('trust proxy', false);
  } else if (/^\d+$/.test(env.TRUST_PROXY)) {
    app.set('trust proxy', parseInt(env.TRUST_PROXY, 10));
  } else {
    app.set('trust proxy', env.TRUST_PROXY);
  }

  // 1. Request ID injection (FR-OPS-001, AC-OPS-01)
  app.use(requestIdMiddleware);

  // 2. Structured request-completion logging (FR-OPS-002, AUDIT-001)
  app.use(requestLoggerMiddleware);

  // CORS and preflight handling for mobile / web clients
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-ID, X-Business-ID');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // 2. Body parsing with rawBody retention for webhook HMAC signature verification (BILL-007)
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  // 3. Mount routers
  app.use(healthRouter);
  app.use(authRouter);
  app.use(organizationRouter);
  app.use(schedulingRouter);
  app.use(notificationsRouter);
  app.use(swapsRouter);
  app.use(attendanceRouter);
  app.use(activityRouter);
  app.use(billingRouter);
  app.use(settingsRouter);

  // 4. Catch-all 404 handler for undefined routes
  app.use((req: Request, res: Response) => {
    sendError(req, res, 404, 'NOT_FOUND', 'The requested resource was not found');
  });

  // 5. Global error handler - guarantees canonical envelope and zero stack trace leakage
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    errorTracker.captureException(err, {
      requestId: req.id,
      userId: (req as any).user?.id || null,
      businessId: (req as any).user?.businessId || (req.header('x-business-id') as string) || null,
      route: req.originalUrl || req.url,
      method: req.method,
      statusCode: 500,
    });
    console.error('[Internal Error]', err.message);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'An unexpected internal error occurred');
  });

  return app;
}
