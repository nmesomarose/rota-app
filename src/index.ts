import { createApp } from './app.ts';
import { env } from './config/env.ts';
import { closeAllPools } from './db/connection.ts';

const app = createApp();

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`[Rota Backend] Server running in ${env.NODE_ENV} mode on ${env.HOST}:${env.PORT}`);
  console.log(`[Rota Backend] Health endpoint available at http://${env.HOST}:${env.PORT}/health (or http://localhost:${env.PORT}/health)`);
});

// Graceful shutdown handling
const shutdown = (signal: string) => {
  console.log(`[Rota Backend] ${signal} received. Shutting down gracefully...`);
  server.close(async () => {
    try {
      await closeAllPools();
      console.log('[Rota Backend] Server and connection pools closed successfully');
      process.exit(0);
    } catch (err) {
      console.error('[Rota Backend] Error closing pools during shutdown:', err);
      process.exit(1);
    }
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
