import express, { type NextFunction, type Request, type Response } from 'express';

const defaultJsonParser = express.json({ limit: '256kb' });
export const canonicalIngestionJsonParser = express.json({ limit: '8mb' });

export function isCanonicalIngestionPath(request: Request): boolean {
  return request.path === '/api/internal/v2/ingestion'
    || request.path.startsWith('/api/internal/v2/ingestion/');
}

export function scopedJsonBodyParser(req: Request, res: Response, next: NextFunction): void {
  if (isCanonicalIngestionPath(req)) {
    next();
    return;
  }
  defaultJsonParser(req, res, next);
}

export function jsonBodyLimitLabel(request: Request): '8 MiB' | '256 KB' {
  return isCanonicalIngestionPath(request) ? '8 MiB' : '256 KB';
}
