import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function normalizeSupabaseUrl(raw: string | undefined): string {
  const trimmed = String(raw || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.origin;
  } catch {
    return trimmed;
  }
}

export function getSupabaseServerConfig(): { url: string; secretKey: string } {
  const url = normalizeSupabaseUrl(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL);
  const secretKey = String(
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  )
    .trim()
    .replace(/^["']|["']$/g, '');

  if (!url || !secretKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY server configuration.');
  }

  return { url, secretKey };
}

export function isSupabaseServerConfigured(): boolean {
  try {
    getSupabaseServerConfig();
    return true;
  } catch {
    return false;
  }
}

let cachedAdminClient: SupabaseClient | null = null;

export function getSupabaseAdminClient(): SupabaseClient {
  if (cachedAdminClient) return cachedAdminClient;
  const { url, secretKey } = getSupabaseServerConfig();
  cachedAdminClient = createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  return cachedAdminClient;
}

export async function supabaseAdminRequest(
  table: string,
  options: {
    method?: string;
    query?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error('Invalid Supabase table name.');
  }

  const { url: supabaseUrl, secretKey } = getSupabaseServerConfig();
  const method = options.method || 'GET';
  const url = `${supabaseUrl}/rest/v1/${table}${options.query ? `?${options.query}` : ''}`;

  const response = await fetch(url, {
    method,
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase request failed (${response.status}): ${responseText.slice(0, 500)}`
    );
  }

  return responseText ? JSON.parse(responseText) : null;
}

export interface VerifiedSupabaseAuthUser {
  id: string;
  email: string;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function verifySupabaseAccessToken(
  accessToken: string
): Promise<VerifiedSupabaseAuthUser> {
  if (!accessToken || accessToken.length > 10000) {
    throw new Error('Invalid access token.');
  }

  const { url: supabaseUrl, secretKey } = getSupabaseServerConfig();
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: 'GET',
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(
      `Invalid or expired Supabase session (${response.status})${errText ? `: ${errText.slice(0, 200)}` : ''}.`
    );
  }

  const data = (await response.json()) as VerifiedSupabaseAuthUser;
  if (!data?.id) {
    throw new Error('Invalid Supabase user payload.');
  }
  return data;
}
