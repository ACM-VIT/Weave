import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function createFallbackProxy(name: string): SupabaseClient {
  console.warn(`[Supabase Warning] ${name} is unconfigured. Calls will return mocked promises.`);
  const dummyHandler = () => {
    return new Proxy({}, {
      get(target, prop) {
        if (prop === 'then') return undefined; // avoid promise-like behavior issues
        return dummyHandler;
      }
    });
  };
  return new Proxy({} as SupabaseClient, {
    get(target, prop) {
      console.warn(`[Supabase Warning] Accessing property '${String(prop)}' on unconfigured ${name}`);
      return () => {
        return {
          select: dummyHandler,
          insert: dummyHandler,
          update: dummyHandler,
          delete: dummyHandler,
          eq: dummyHandler,
          neq: dummyHandler,
          gt: dummyHandler,
          lt: dummyHandler,
          order: dummyHandler,
          limit: dummyHandler,
          single: dummyHandler,
          maybeSingle: dummyHandler,
          then: (resolve: any) => resolve({ data: null, error: new Error(`${name} is not configured`) })
        };
      };
    }
  });
}

let supabase: SupabaseClient;
let supabaseAdmin: SupabaseClient;

if (!supabaseUrl || !supabaseKey) {
  console.warn('Missing SUPABASE_URL or SUPABASE_KEY in environment. Supabase client will be a mock proxy.');
  supabase = createFallbackProxy('supabase');
} else {
  supabase = createClient(supabaseUrl, supabaseKey);
}

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('Missing SUPABASE_SERVICE_ROLE_KEY in environment. Supabase admin client will be a mock proxy.');
  supabaseAdmin = createFallbackProxy('supabaseAdmin');
} else {
  supabaseAdmin = createClient(supabaseUrl || '', supabaseServiceKey);
}

export { supabaseAdmin };
export default supabase;
