import { Router } from 'express';
import {
  getAllRepos,
  getRepoById,
  importRepo,
  viewRepo,
  syncRepo,
} from '../controllers/repoController.js';

const router: Router = Router();

// Routes only connect URLs to controller functions.

// Get all repository records.
router.get('/', getAllRepos);

// Import one repository from GitHub.
router.post('/import', importRepo);

// Get one repository record by repo id.
router.get('/:repoId', getRepoById);

// Increment view count for a repo.
router.post('/:repoId/view', viewRepo);

// Refresh one repository record from GitHub.
router.post('/:repoId/sync', syncRepo);

export default router;
