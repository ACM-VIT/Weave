import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { sendError } from '../utils/response.js';

const JWT_SECRET = process.env.JWT_SECRET as string;
if (!JWT_SECRET) {
  throw new Error('FATAL ERROR: JWT_SECRET is not defined in environment variables.');
}

// Extend the Express Request to include our custom decoded JWT payload
export interface AuthRequest extends Request {
  user?: {
    userId: string;
    email: string;
  };
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      sendError(res, 401, 'Authentication required. Missing Bearer token.');
      return;
    }

    const token = authHeader.split(' ')[1];

    // Validate the Custom JWT locally (No Supabase network call needed)
    // This will automatically throw an error to the catch block if tampered/expired
    const decodedPayload = jwt.verify(token, JWT_SECRET) as { userId: string; email: string };

    // Attach the decoded user data to the request object
    req.user = decodedPayload;
    
    next();
  } catch (error) {
    // Safely catches JsonWebTokenError and TokenExpiredError without crashing
    sendError(res, 401, 'Invalid or expired authentication token.');
    return;
  }
}