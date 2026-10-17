import { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

declare global {
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

/**
 * Middleware that ensures every request has a unique Request ID.
 * Uses client-provided X-Request-Id if present, otherwise generates a UUIDv4.
 * Attaches the Request ID to the response header and req.id.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingId = req.header('x-request-id');
  const requestId = incomingId && incomingId.trim().length > 0 ? incomingId.trim() : randomUUID();

  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}
