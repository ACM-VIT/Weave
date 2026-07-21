declare namespace NodeJS {
  interface ProcessEnv {
    SUPABASE_URL: string;
    SUPABASE_KEY: string;
    GITHUB_TOKEN: string;
    BACKEND_URL: string;
    CLIENT_URL: string;
    CORS_ORIGINS?: string;
    OAUTH_REDIRECT_ORIGINS?: string;
    OAUTH_ATTEMPT_TTL_SECONDS?: string;
    PASSWORD_RESET_URL?: string;
    PORT?: string;
    NODE_ENV?: string;
  }
}
