import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config(); 
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseKey);