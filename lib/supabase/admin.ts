import { createClient } from "@supabase/supabase-js"

/**
 * Service-role Supabase client. The service role BYPASSES Row Level Security,
 * so this must only ever be used in trusted server-side code with no end-user
 * session — e.g. the Shopify webhook, which is authenticated by HMAC, not by a
 * logged-in user. NEVER import this into a client component or expose the key.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      "Supabase admin client unavailable: set SUPABASE_SERVICE_ROLE_KEY (and NEXT_PUBLIC_SUPABASE_URL).",
    )
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
