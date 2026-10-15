import { createAdminClient } from "@/lib/supabase/admin"

export type CredentialStatus = {
  has_token: boolean
  has_secret: boolean
  has_consumer_key: boolean
  has_consumer_secret: boolean
  has_webhook_secret: boolean
}

const set = (v: unknown) => typeof v === "string" && v.trim().length > 0

/**
 * Which credentials are saved for each connection — booleans only; the raw
 * values never leave the server.
 *
 * Pass ONLY connection ids the caller already read through the user client
 * (store_connections RLS is the authorization). store_secrets is sealed from
 * the API role, so this reads it with the service role, like the integration
 * actions do. Replaces the store_credential_status view for the integrations
 * pages: a failed read of that view was indistinguishable from "no
 * credentials", so every card showed "No token" when it broke.
 */
export async function loadCredentialStatus(
  connectionIds: string[],
): Promise<{ byConn: Map<string, CredentialStatus>; error: string | null }> {
  const byConn = new Map<string, CredentialStatus>()
  if (connectionIds.length === 0) return { byConn, error: null }

  const { data, error } = await createAdminClient()
    .from("store_secrets")
    .select(
      "connection_id, access_token, api_secret, consumer_key, consumer_secret, webhook_secret",
    )
    .in("connection_id", connectionIds)
  if (error) {
    return {
      byConn,
      error: `Could not check saved credentials: ${error.message}`,
    }
  }

  for (const s of data ?? []) {
    byConn.set(s.connection_id as string, {
      has_token: set(s.access_token),
      has_secret: set(s.api_secret),
      has_consumer_key: set(s.consumer_key),
      has_consumer_secret: set(s.consumer_secret),
      has_webhook_secret: set(s.webhook_secret),
    })
  }
  return { byConn, error: null }
}
