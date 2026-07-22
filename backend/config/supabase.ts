import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { OAuthPkceStorageAdapter } from '../services/oauthPkceService.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY in environment');
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

export const createRecoverySupabaseClient = (): SupabaseClient => createClient(
  supabaseUrl,
  supabaseKey,
  {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  },
);

export const createOAuthSupabaseClient = (
  storage: OAuthPkceStorageAdapter,
  storageKey: string,
): SupabaseClient => createClient(
  supabaseUrl,
  supabaseKey,
  {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: 'pkce',
      persistSession: true,
      skipAutoInitialize: true,
      storage,
      storageKey,
    },
  },
);

const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseServiceKey) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in environment');
}

export const supabaseAdmin: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey);

export default supabase;
