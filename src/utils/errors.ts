import { type Request, type Response } from 'express';

export interface StandardErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Sends a standardized JSON error response following the canonical schema:
 * {
 *   "error": {
 *     "code": "STRING_ERROR_CODE",
 *     "message": "Human-readable description",
 *     "requestId": "uuid",
 *     "details": {}
 *   }
 * }
 */
export function sendError(
  req: Request,
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): void {
  const requestId = req.id || 'unknown';
  const response: StandardErrorResponse = {
    error: {
      code,
      message,
      requestId,
      ...(details ? { details } : {}),
    },
  };
  res.status(statusCode).json(response);
}
