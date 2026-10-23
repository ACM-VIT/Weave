import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function requireInternalSecret(req: Request, res: Response, next: NextFunction): void {
  const expected = [process.env.INTERNAL_API_SECRET, process.env.INTERNAL_API_SECRET_PREVIOUS]
    .filter((value): value is string => !!value);
  const supplied = req.header('x-internal-secret');
  if (expected.length === 0) { res.status(503).json({ error: 'Internal API authentication is not configured.' }); return; }
  const suppliedBytes = supplied == null ? null : Buffer.from(supplied);
  const valid = suppliedBytes !== null && expected.some((candidate) => {
    const expectedBytes = Buffer.from(candidate);
    return suppliedBytes.length === expectedBytes.length && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
  });
  if (!valid) {
    res.status(401).json({ error: 'Invalid or missing internal secret.' }); return;
  }
  next();
}
