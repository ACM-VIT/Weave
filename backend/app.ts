import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import authRoutes from './routes/authRoutes.js';
import cookieParser from 'cookie-parser';
import feedV2Routes from './routes/feedV2Routes.js';
import activityV2Routes from './routes/activityV2Routes.js';
import ingestionRoutes from './routes/ingestionRoutes.js';
import operationsRoutes from './routes/operationsRoutes.js';
import productV2Routes from './routes/productV2Routes.js';
import { readiness } from './controllers/operationsController.js';
import { requestTelemetry } from './middlewares/requestTelemetryMiddleware.js';
import { authRateLimit, securityHeaders } from './middlewares/securityMiddleware.js';
import { isCorsOriginAllowed } from './security/originPolicy.js';
import {
  jsonBodyLimitLabel,
  scopedJsonBodyParser,
} from './middlewares/scopedJsonBodyMiddleware.js';

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

const configuredCorsOrigins = [
    ...(process.env.CORS_ORIGINS ?? '').split(','),
    process.env.CLIENT_URL?.startsWith('http') ? process.env.CLIENT_URL : '',
  ]
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

// Global middleware used by every route.
app.use(
  cors({
    // Native requests do not send an Origin header. Browser origins must be
    // explicitly configured in production; local/LAN origins are allowed in dev.
    origin: (origin, callback) => {
      const normalizedOrigin = origin?.replace(/\/$/, '');
      if (isCorsOriginAllowed(normalizedOrigin, configuredCorsOrigins, process.env.NODE_ENV)) {
        callback(null, true);
        return;
      }

      const error = new Error(`CORS origin is not allowed: ${normalizedOrigin}`) as Error & {
        code?: string;
      };
      error.code = 'CORS_ORIGIN_DENIED';
      callback(error);
    },
    credentials: true,
    exposedHeaders: ['x-request-id', 'traceparent'],
  })
);
// The ingestion router applies its larger parser only after internal-secret
// authentication. Public/authenticated endpoints keep this tighter envelope.
app.use(scopedJsonBodyParser);
app.use(cookieParser());
app.use(securityHeaders);
app.use(requestTelemetry);

// Basic health route to confirm the backend is running.
app.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'GH Social backend is running' });
});
app.get('/healthz', (_req: Request, res: Response) => res.status(200).json({ healthy: true }));
app.get('/readyz', readiness);

// Auth API routes 
app.use('/api/auth', authRateLimit, authRoutes);

// GitSocial product and ML-facing routes use the V2 contract exclusively.
app.use('/api/v2', feedV2Routes);
app.use('/api/v2', activityV2Routes);
app.use('/api/v2', productV2Routes);
app.use('/api/internal/v2/ingestion', ingestionRoutes);
app.use('/api/internal/v2/operations', operationsRoutes);

// Global error handler.
app.use((err: Error & { code?: string; type?: string }, req: Request, res: Response, _next: NextFunction) => {
  if (err.code === 'CORS_ORIGIN_DENIED') {
    res.status(403).json({ error: 'Request origin is not allowed.' });
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: `Request payload exceeds ${jsonBodyLimitLabel(req)}.` });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
