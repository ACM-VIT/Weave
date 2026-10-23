import express from 'express';
import { assertDisposableDatabase } from '../database/disposableDatabase.js';

assertDisposableDatabase();

// Only the actual registered interaction group is needed; no external auth/model service.
async function start() {
  const { default: activityRoutes } = await import('../../routes/activityV2Routes.js');
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/v2', activityRoutes);
  const server = app.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Activity fixture did not bind');
    console.log(`ACTIVITY_PORT=${address.port}`);
  });
}
void start().catch(error => { console.error(error); process.exitCode = 1; });
