import { createApp } from './app.ts';
import { env } from './config/env.ts';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`[Rota Backend] Server running in ${env.NODE_ENV} mode on port ${env.PORT}`);
  console.log(`[Rota Backend] Health endpoint available at http://localhost:${env.PORT}/health`);
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('[Rota Backend] SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('[Rota Backend] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Rota Backend] SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('[Rota Backend] Server closed');
    process.exit(0);
  });
});
