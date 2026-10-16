import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import { healthRouter } from './routes/health.ts';

/**
 * Creates and configures the Express application.
 */
export function createApp(): Application {
  const app = express();

  // Basic middleware
  app.use(express.json());

  // Mount health check endpoint
  app.use(healthRouter);

  // Catch-all 404 handler for undefined routes
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found',
      },
    });
  });

  // Global error handler - guarantees no stack traces leak to the client (AGENTS.md Section 7)
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[Internal Error]', err.message);
    res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal error occurred',
      },
    });
  });

  return app;
}
