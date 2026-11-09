import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import redisClient from '../config/redis.js';

const AUTH_RATE_LIMIT_COMMAND_TIMEOUT_MS = 2_000;

function evalAuthRateLimit(key: string, windowSeconds: number): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const command = redisClient.eval(
    "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
    1, key, windowSeconds,
  );
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Authentication rate-limit command timed out')), AUTH_RATE_LIMIT_COMMAND_TIMEOUT_MS);
  });
  return Promise.race([command, deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
}

export async function authRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const windowSeconds = 60;
  const maximum = 20;
  const identity = crypto.createHash('sha256').update(`${req.ip}:${req.path}`).digest('hex');
  const key = `rate:auth:${identity}`;
  try {
    if (redisClient.status !== 'ready') throw new Error('Redis is not ready for authentication admission');
    // A timed-out Redis command may finish later and increment the window, but
    // the request remains fail-closed and the late rejection stays observed.
    const count = Number(await evalAuthRateLimit(key, windowSeconds));
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid auth rate-limit counter');
    res.setHeader('RateLimit-Limit', maximum);
    res.setHeader('RateLimit-Remaining', Math.max(0, maximum - count));
    if (count > maximum) {
      res.setHeader('Retry-After', windowSeconds);
      res.status(429).json({ success: false, error: 'Too many authentication requests. Try again shortly.' });
      return;
    }
  } catch (error) {
    console.error('[RateLimit] Authentication admission unavailable:', error);
    res.setHeader('Retry-After', 5);
    res.status(503).json({success:false,code:'AUTH_RATE_LIMIT_UNAVAILABLE',retryable:true,
      error:'Authentication is temporarily unavailable. Please try again shortly.'});
    return;
  }
  next();
}
