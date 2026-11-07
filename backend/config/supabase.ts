import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { OAuthPkceStorageAdapter } from '../services/oauthPkceService.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY in environment');
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

export const createEmailAuthSupabaseClient = (): SupabaseClient => createClient(
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

export const createRecoverySupabaseClient = createEmailAuthSupabaseClient;

/** Fail closed rather than trusting auto-confirmed timestamps after config drift. */
export async function requireEmailConfirmation(): Promise<void> {
  try {
    const response = await fetch(`${supabaseUrl!.replace(/\/$/, '')}/auth/v1/settings`, {
      headers: { apikey: supabaseKey! }, signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error('Auth settings unavailable');
    const settings = await response.json() as { mailer_autoconfirm?: boolean; external?: { email?: boolean } };
    if (settings.mailer_autoconfirm !== false || settings.external?.email !== true) {
      throw new Error('Email confirmation must be enabled');
    }
  } catch {
    throw Object.assign(new Error('Email verification is temporarily unavailable. Please try again later.'), { statusCode: 503 });
  }
}

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

/** Dedicated bounded transport: never change the shared authentication client. */
export const createAvatarStorageClient = (): SupabaseClient => createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { fetch: (input, init) => fetch(input, { ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  }) },
});
