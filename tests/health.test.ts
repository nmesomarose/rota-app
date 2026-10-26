import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { closeAllPools } from '../src/db/connection.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

describe('Backend Health Check Endpoint (GET /health)', () => {
  after(async () => {
    await closeAllPools();
  });

  it('responds with 200 OK and expected health payload', async () => {
    const { setRedisClientForTesting } = await import('../src/services/redis-client.ts');
    const { setDatabaseCheckerForTesting } = await import('../src/db/connection.ts');

    setDatabaseCheckerForTesting(async () => true);
    const mockRedis = {
      ping: async () => 'PONG',
      llen: async () => 0,
      zcard: async () => 0,
      status: 'ready',
    };
    setRedisClientForTesting(mockRedis as any);

    const app = createApp();
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    try {
      const address = server.address() as AddressInfo;
      const port = address.port;
      const url = `http://127.0.0.1:${port}/health`;

      const res = await fetch(url);
      assert.strictEqual(res.status, 200);

      const data = (await res.json()) as {
        status: string;
        timestamp: string;
        uptimeSeconds: number;
        environment: string;
        version: string;
        checks: { server: string; database: string };
      };

      assert.strictEqual(data.status, 'ok');
      assert.strictEqual(data.checks.server, 'healthy');
      assert.strictEqual(data.checks.database, 'connected');
      assert.strictEqual((data.checks as any).redis, 'connected');
      assert.ok((data.checks as any).queues);
      assert.strictEqual(typeof (data.checks as any).queues.ready, 'number');
      assert.strictEqual(typeof (data.checks as any).queues.processing, 'number');
      assert.strictEqual(typeof (data.checks as any).queues.delayed, 'number');
      assert.strictEqual(typeof (data.checks as any).queues.deadLetter, 'number');
      assert.strictEqual(data.version, '0.1.0');
      assert.ok(typeof data.timestamp === 'string');
      assert.ok(typeof data.uptimeSeconds === 'number');
    } finally {
      setDatabaseCheckerForTesting(null);
      setRedisClientForTesting(null);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('responds with 200 OK on /health/live without invoking database or Redis checks', async () => {
    const app = createApp();
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    try {
      const address = server.address() as AddressInfo;
      const port = address.port;
      const url = `http://127.0.0.1:${port}/health/live`;

      const res = await fetch(url);
      assert.strictEqual(res.status, 200);

      const data = (await res.json()) as { status: string; uptimeSeconds: number; service: string };
      assert.strictEqual(data.status, 'ok');
      assert.strictEqual(data.service, 'rota-backend');
      assert.strictEqual(typeof data.uptimeSeconds, 'number');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('responds with 404 for undefined routes without exposing stack traces', async () => {
    const app = createApp();
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    try {
      const address = server.address() as AddressInfo;
      const port = address.port;
      const url = `http://127.0.0.1:${port}/non-existent-route`;

      const res = await fetch(url);
      assert.strictEqual(res.status, 404);

      const body = (await res.json()) as { error: { code: string; message: string } };
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('responds with 503 degraded when Redis is unavailable', async () => {
    const { setRedisClientForTesting } = await import('../src/services/redis-client.ts');
    // Inject failing client
    setRedisClientForTesting({
      ping: () => Promise.reject(new Error('ECONNREFUSED: Connection refused to Redis')),
      status: 'end',
    } as any);

    const app = createApp();
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    try {
      const address = server.address() as AddressInfo;
      const port = address.port;
      const url = `http://127.0.0.1:${port}/health`;

      const res = await fetch(url);
      assert.strictEqual(res.status, 503);

      const data = (await res.json()) as any;
      assert.strictEqual(data.status, 'degraded');
      assert.strictEqual(data.checks.redis, 'disconnected');
    } finally {
      setRedisClientForTesting(null);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('responds with 503 degraded when database is unavailable', async () => {
    const { setDatabaseCheckerForTesting } = await import('../src/db/connection.ts');
    setDatabaseCheckerForTesting(async () => false);

    const app = createApp();
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    try {
      const address = server.address() as AddressInfo;
      const port = address.port;
      const url = `http://127.0.0.1:${port}/health`;

      const res = await fetch(url);
      assert.strictEqual(res.status, 503);

      const data = (await res.json()) as any;
      assert.strictEqual(data.status, 'degraded');
      assert.strictEqual(data.checks.database, 'disconnected');
    } finally {
      setDatabaseCheckerForTesting(null);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
