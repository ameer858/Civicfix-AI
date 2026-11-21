import { createClient } from '@supabase/supabase-js';

function normalizeSupabaseUrl(raw: string | undefined): string {
  const trimmed = String(raw || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed;
  }
}

const supabaseUrl = normalizeSupabaseUrl(import.meta.env.VITE_SUPABASE_URL);
const supabaseAnonKey = String(
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    ''
)
  .trim()
  .replace(/^["']|["']$/g, '');

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Supabase frontend configuration is missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
