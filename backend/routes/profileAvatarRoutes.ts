import express, { Router, type Request, type Response, type NextFunction } from 'express';
import type { AuthRequest } from '../middlewares/authMiddleware.js';
import { isValidUuid } from '../utils/validators.js';
import { AVATAR_MAX_BYTES, avatarError } from '../services/profileAvatarImage.js';
import type { SavedAvatarProfile } from '../services/profileAvatarService.js';
export function createProfileAvatarRouter(ports: {
    save(owner: string, input: Buffer, expectedVersion: string): Promise<SavedAvatarProfile>;
    admit(owner: string): Promise<void>;
    readBudgetMs?: number;
}): Router {
    const router = Router();
    let active = 0;
    const parse = express.raw({ type: 'application/octet-stream', limit: AVATAR_MAX_BYTES, inflate: false });
    router.put('/', async (request: AuthRequest, res: Response, next: NextFunction) => {
        let admitted = false;
        let bodyDeadline: ReturnType<typeof setTimeout> | undefined;
        try {
            const owner = request.user?.userId;
            if (typeof owner !== 'string' || !isValidUuid(owner))
                throw avatarError(401, 'Authentication required.');
            const precondition = request.get('If-Match');
            if (!precondition) throw avatarError(428, 'Check your current profile before uploading a photo.');
            const expectedVersion = /^"([1-9][0-9]{0,18})"$/.exec(precondition)?.[1];
            if (!expectedVersion) throw avatarError(400, 'If-Match must quote the current profile_version.');
            if (request.query && Object.keys(request.query).length)
                throw avatarError(400, 'Photo uploads do not accept query parameters.');
            if (!request.is('application/octet-stream'))
                throw avatarError(415, 'Send raw image bytes as application/octet-stream.');
            if (active >= 2)
                throw avatarError(503, 'Photo uploads are busy. Try again shortly.');
            // Reserve before Redis awaits: a stalled admission backend must not
            // accumulate an unbounded queue of authenticated upload attempts.
            active++;
            admitted = true;
            await ports.admit(owner);
            // A wall-clock budget, not an idle timeout: periodic bytes must not
            // let a slow client retain one of the bounded slots indefinitely.
            bodyDeadline = setTimeout(() => request.destroy(), ports.readBudgetMs ?? 20_000);
            await new Promise<void>((resolve, reject) => parse(request, res, error => error ? reject(error) : resolve()));
            clearTimeout(bodyDeadline);
            bodyDeadline = undefined;
            if (!Buffer.isBuffer(request.body) || !request.body.length)
                throw avatarError(400, 'Choose an image first.');
            const saved = await ports.save(owner.toLowerCase(), request.body, expectedVersion);
            if (!res.destroyed)
                res.status(200).json({ success: true, data: saved });
        }
        catch (error) {
            next(error);
        }
        finally {
            if (admitted)
                active--;
            clearTimeout(bodyDeadline);
        }
    });
    router.use((error: Error & {
        statusCode?: number;
        type?: string;
    }, _req: Request, res: Response, _next: NextFunction) => {
        if (res.destroyed || res.headersSent)
            return;
        const status = error.type === 'entity.too.large' ? 413 : error.type === 'encoding.unsupported' ? 415 : error.statusCode ?? 503;
        if (status === 429)
            res.setHeader('Retry-After', '60');
        if (status === 503)
            res.setHeader('Retry-After', '5');
        res.status(status).json({ success: false, error: status === 413 ? 'The photo exceeds the upload limits.' : status >= 500 ? 'Photo upload could not be confirmed. Check your profile before retrying.' : error.message });
    });
    return router;
}
