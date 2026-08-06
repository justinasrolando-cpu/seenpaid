import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { log } from '../observability/logger.js'

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly isOperational = true,
  ) {
    super(message)
    Object.setPrototypeOf(this, ApiError.prototype)
  }
}

// Register LAST in the Express middleware chain.
export function globalErrorHandler(
  err: unknown, req: Request, res: Response, _next: NextFunction,
) {
  if (err instanceof ApiError) {
    if (!err.isOperational) {
      log.error({ err, requestId: req.requestId }, 'Non-operational error — requires alert')
    }
    return res.status(err.statusCode).json({ success: false, error: err.message })
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
    })
  }

  log.error({ err, requestId: req.requestId }, 'Unhandled error')
  res.status(500).json({ success: false, error: 'Internal server error' })
}
