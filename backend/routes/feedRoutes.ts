import { Router } from 'express'; 
import { receiveMlRecommendations, getFeedForMobile, postFeedback } from '../controllers/feedController.js';
import { requireAuth } from '../middlewares/authMiddleware.js';

const router = Router();

//Endpoint 1: Expose the POST endpoint for Subhro's ML model
//URL : POST http://localhost:5000/api/internal/recommendations
router.post('/internal/recommendations', receiveMlRecommendations);

//Endpoint 2: The Mobile App PULLS the fast cached feed from here
//URL : GET http://localhost:5000/api/feed?userId=your_user_id
router.get('/feed', requireAuth, getFeedForMobile);

//Endpoint 3: Mobile App PUSHES feedback swiping actions here
//URL : POST http://localhost:5000/api/feedback
router.post('/feedback', requireAuth, postFeedback);

export default router;