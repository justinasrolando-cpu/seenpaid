import pino from 'pino'
import type { NextFunction, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  redact: ['req.headers.authorization', '*.accessToken', '*.refreshToken'],
  base: { service: 'seenpaid' },
})

export function requestLogger() {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = randomUUID()
    req.requestId = requestId
    const start = Date.now()

    res.on('finish', () => {
      log.info({
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - start,
        orgId: req.orgId,
      }, 'HTTP request completed')
    })
    next()
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string
    }
  }
}
