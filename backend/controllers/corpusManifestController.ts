import type { Request, Response } from 'express';
import { CorpusManifestService, InvalidManifestCursor } from '../services/corpusManifestService.js';

export function corpusManifestController(service: () => CorpusManifestService) {
  return async (req: Request, res: Response): Promise<void> => {
    const rawLimit = req.query.limit ?? '250';
    const cursor = req.query.cursor;
    if (typeof rawLimit !== 'string' || !/^\d{1,3}$/.test(rawLimit)
      || Number(rawLimit) < 1 || Number(rawLimit) > 250
      || (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2048))) {
      res.status(400).json({ error: 'Invalid manifest limit or cursor' }); return;
    }
    try { res.json(await service().page(Number(rawLimit), cursor)); }
    catch (error) {
      if (error instanceof InvalidManifestCursor) {
        res.status(409).json({ error: 'MANIFEST_CURSOR_STALE' }); return;
      }
      res.status(503).json({ error: 'Corpus manifest unavailable' });
    }
  };
}
