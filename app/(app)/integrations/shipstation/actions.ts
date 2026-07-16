"use server"

import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  reconcileShipStation,
  type ReconcileResult,
} from "@/lib/shipstation/reconcile"

export type ReconcileActionResult =
  | { ok: true; result: ReconcileResult }
  | { ok: false; error: string }

/**
 * Run the OT ⇄ ShipStation alignment check. Admin-only (integrations are
 * admin-scoped) and reads across all sites via the service role. On-demand:
 * ShipStation's API is paginated + rate-limited, so this runs on a button press,
 * not on every page load.
 */
export async function runShipStationReconcile(): Promise<ReconcileActionResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()
  if (profile?.role !== "admin") {
    return { ok: false, error: "Only an admin can run the ShipStation check." }
  }

  const apiKey = process.env.SHIPSTATION_API_KEY
  const apiSecret = process.env.SHIPSTATION_API_SECRET
  if (!apiKey || !apiSecret) {
    return {
      ok: false,
      error:
        "ShipStation API key/secret not configured. Set SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET in the environment.",
    }
  }

  try {
    const admin = createAdminClient()
    const result = await reconcileShipStation(admin, apiKey, apiSecret)
    return { ok: true, result }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "ShipStation check failed.",
    }
  }
}
