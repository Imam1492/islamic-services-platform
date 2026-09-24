import { createBrowserClient } from '@supabase/ssr';

/**
 * Creates a Supabase client for use in Client Components / browser context.
 * Uses ONLY public/publishable credentials.
 */
export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
