import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env.js';

/**
 * Service-role client. Used only by the API for auth verification and by the
 * worker for privileged writes. Never expose this to the browser.
 */
export const supabaseAdmin: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

export const REFRESH_COOKIE = 'neuton_refresh';
export const ACCESS_TOKEN_HEADER = 'authorization';
