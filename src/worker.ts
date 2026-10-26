import { createDefaultWorker } from './queue/job-worker.ts';
import { closeAllPools } from './db/connection.ts';
import { ensureRedisConnected } from './services/redis-client.ts';

async function main() {
  console.log('[Worker] Starting Rota Background Job Worker...');

  try {
    await ensureRedisConnected();
    console.log('[Worker] Connected to Redis instance.');
  } catch (err: any) {
    console.error('[Worker] Fatal: Could not connect to Redis:', err.message);
    process.exit(1);
  }

  const worker = createDefaultWorker({
    pollIntervalMs: 300,
    delayedCheckIntervalMs: 1000,
    staleCheckIntervalMs: 5000,
    enableSweeper: true,
  });

  worker.start();
  console.log('[Worker] Worker loop running. Waiting for jobs... (Press Ctrl+C to exit)');

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[Worker] Received ${signal}. Initiating graceful shutdown...`);

    try {
      await worker.stop(5000);
      await closeAllPools();
      console.log('[Worker] Graceful shutdown complete.');
      process.exit(0);
    } catch (err: any) {
      console.error('[Worker] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[Worker] Unhandled startup error:', err);
  process.exit(1);
});
