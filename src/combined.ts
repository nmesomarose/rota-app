import { createApp } from './app.ts';
import { env } from './config/env.ts';
import { closeAllPools } from './db/connection.ts';
import { createDefaultWorker, type JobWorker } from './queue/job-worker.ts';
import { ensureRedisConnected, getRedisClient } from './services/redis-client.ts';
import type { Server } from 'node:http';

/**
 * Combined API Server and Background Job Worker
 * 
 * Optimized for resource-constrained single-container deployments (e.g. 0.5 vCPU / 1 GB RAM).
 * Combines HTTP API handling and background queue processing into a single Node.js runtime,
 * saving ~70-100 MB of process overhead, halving idle database connections, and sharing
 * the singleton Redis connection.
 */
async function bootstrap() {
  console.log('[Combined] Initializing Rota unified API and Queue Worker runtime...');

  // 1. Initialize Redis connection
  try {
    await ensureRedisConnected();
    console.log('[Combined] Connected to Redis instance.');
  } catch (err: any) {
    console.error('[Combined] Fatal: Could not connect to Redis:', err.message);
    process.exit(1);
  }

  // 2. Start HTTP API Server
  const app = createApp();
  const server: Server = app.listen(env.PORT, env.HOST, () => {
    console.log(`[Combined] HTTP Server running in ${env.NODE_ENV} mode on ${env.HOST}:${env.PORT}`);
    console.log(`[Combined] Health readiness endpoint: http://${env.HOST}:${env.PORT}/health`);
    console.log(`[Combined] Container liveness endpoint: http://${env.HOST}:${env.PORT}/health/live`);
  });

  // 3. Start Background Job Worker
  // Polling intervals tuned for low-overhead operation on 0.5 vCPU
  const worker: JobWorker = createDefaultWorker({
    pollIntervalMs: 500,
    delayedCheckIntervalMs: 1500,
    staleCheckIntervalMs: 10000,
    enableSweeper: true,
  });

  worker.start();
  console.log(`[Combined] Background Worker ${worker.workerId} started successfully.`);

  // 4. Coordinated Graceful Shutdown Handler
  let isShuttingDown = false;

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[Combined] ${signal} received. Initiating coordinated graceful shutdown...`);

    // Safety timeout to prevent hung processes
    const forceExitTimer = setTimeout(() => {
      console.error('[Combined] Graceful shutdown timed out after 10s. Forcing exit.');
      process.exit(1);
    }, 10000);
    forceExitTimer.unref();

    try {
      // Step A: Stop accepting new HTTP requests
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else {
            console.log('[Combined] HTTP server stopped accepting new connections.');
            resolve();
          }
        });
      });

      // Step B: Stop background worker and allow in-flight jobs to finish
      console.log('[Combined] Stopping background worker...');
      await worker.stop(5000);
      console.log('[Combined] Background worker stopped cleanly.');

      // Step C: Close all database connection pools
      console.log('[Combined] Closing database connection pools...');
      await closeAllPools();
      console.log('[Combined] All database pools closed.');

      // Step D: Quit Redis connection
      try {
        const redis = getRedisClient();
        await redis.quit();
        console.log('[Combined] Redis connection closed.');
      } catch (redisErr) {
        // Non-fatal if Redis already disconnected
      }

      console.log('[Combined] Coordinated shutdown complete. Exiting cleanly.');
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (shutdownErr) {
      console.error('[Combined] Error encountered during graceful shutdown:', shutdownErr);
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

bootstrap().catch((fatalErr) => {
  console.error('[Combined] Fatal error during bootstrap:', fatalErr);
  process.exit(1);
});
