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
      assert.strictEqual(data.version, '0.1.0');
      assert.ok(typeof data.timestamp === 'string');
      assert.ok(typeof data.uptimeSeconds === 'number');
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
});
