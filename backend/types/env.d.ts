declare namespace NodeJS {
  interface ProcessEnv {
    SUPABASE_URL: string;
    SUPABASE_KEY: string;
    GITHUB_TOKEN: string;
    PORT?: string;
    NODE_ENV?: string;
  }
}
