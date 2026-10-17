import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import { requestIdMiddleware } from './middleware/request-id.ts';
import { healthRouter } from './routes/health.ts';
import { authRouter } from './routes/auth.ts';
import { organizationRouter } from './routes/organization.ts';
import { schedulingRouter } from './routes/scheduling.ts';
import { notificationsRouter } from './routes/notifications.ts';
import { swapsRouter } from './routes/swaps.ts';
import { attendanceRouter } from './routes/attendance.ts';
import { activityRouter } from './routes/activity.ts';
import { billingRouter } from './routes/billing.ts';
import { sendError } from './utils/errors.ts';

/**
 * Creates and configures the Express application.
 */
export function createApp(): Application {
  const app = express();

  // 1. Request ID injection (FR-OPS-001, AC-OPS-01)
  app.use(requestIdMiddleware);

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

  // 4. Catch-all 404 handler for undefined routes
  app.use((req: Request, res: Response) => {
    sendError(req, res, 404, 'NOT_FOUND', 'The requested resource was not found');
  });

  // 5. Global error handler - guarantees canonical envelope and zero stack trace leakage
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    console.error('[Internal Error]', err.message);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'An unexpected internal error occurred');
  });

  return app;
}
