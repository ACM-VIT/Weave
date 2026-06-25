import { Router } from 'express'; 
import { receiveMlRecommendations, getFeedForMobile } from '../controllers/feedController.js';

const router = Router();

//Endpoint 1: Expose the POST endpoint for Subhro's ML model
//URL : POST http://localhost:5000/api/internal/recommendations
router.post('/internal/recommendations', receiveMlRecommendations);

//Endpoint 2: The Mobile App PULLS the fast cached feed from here
//URL : GET http://localhost:5000/api/feed?userId=your_user_id
router.get('/feed', getFeedForMobile);

export default router;