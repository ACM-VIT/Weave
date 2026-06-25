import express from 'express';
import * as containerController from '../controllers/containerController.js';

const router = express.Router();

// Create a container (auto-seeds two public boards). Body: { user_id, container_name? }
router.post('/', containerController.createContainer);

// List containers for a user. Path param: userId
router.get('/user/:userId', containerController.getContainersByUser);

// Get a single container by id. Path param: containerId
router.get('/:containerId', containerController.getContainerById);

// Add a board to a container. Body: { board_id }
router.post('/:containerId/boards', containerController.addBoardToContainer);

// Remove a board from a container. Path params: containerId, boardId
router.delete('/:containerId/boards/:boardId', containerController.removeBoardFromContainer);

// Delete a container entirely. Path param: containerId
router.delete('/:containerId', containerController.deleteContainerById);

// List boards in a container. Path param: containerId
router.get('/:containerId/boards', containerController.getBoardsForContainer);

export default router;
