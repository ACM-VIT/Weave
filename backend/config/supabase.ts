import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY in environment');
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseServiceKey) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in environment');
}

export const supabaseAdmin: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey);

export default supabase;
