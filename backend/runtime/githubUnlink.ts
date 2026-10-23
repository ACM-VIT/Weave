import redis from '../config/redis.js';
import { PostgresGithubUnlink } from '../adapters/postgresGithubUnlink.js';
import { GithubUnlinkFlow, createGithubUnlinkClients } from '../services/githubUnlinkFlow.js';
import { GitHubImportConsentService } from '../services/githubImportConsentService.js';
import { createGithubUnlinkRoutes } from '../routes/githubUnlinkRoutes.js';

let routes: ReturnType<typeof createGithubUnlinkRoutes> | undefined;
export function githubUnlinkRoutes() {
  if (!routes) {
    const clients = createGithubUnlinkClients({ url: process.env.SUPABASE_URL!, anonKey: process.env.SUPABASE_KEY!, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY! });
    const imports = new GitHubImportConsentService({ collect: async () => { throw new Error('Unlink never collects activity.'); } }, redis);
    const flow = new GithubUnlinkFlow({ ...clients, redis, persistence: new PostgresGithubUnlink(),
      revokeImport: userId => imports.revoke(userId), secret: process.env.JWT_SECRET! });
    routes = createGithubUnlinkRoutes({ flow, backendUrl: process.env.BACKEND_URL ?? '', clientUrl: process.env.CLIENT_URL ?? 'http://localhost:8081',
      clientRedirects: (process.env.OAUTH_REDIRECT_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean),
      nodeEnv: process.env.NODE_ENV, port: process.env.PORT });
  }
  return routes;
}
