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
export async function runShipStationReconcile(
  opts?: { ignoreBefore?: string | null },
): Promise<ReconcileActionResult> {
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
  // Read-only check (no connection/secret management), so admin OR manager can
  // run it — unlike integration *management*, which stays admin-only.
  if (profile?.role !== "admin" && profile?.role !== "manager") {
    return {
      ok: false,
      error: "Only an admin or manager can run the ShipStation check.",
    }
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
    // Go-live floor: hide orders placed before OT launched from the SS-only
    // presence buckets (those orders were never meant to import). Default to the
    // LATEST store connection cutoff (sync_orders_since) so pre-launch noise is
    // gone out of the box; the caller can override — an explicit "" clears the
    // floor to show everything, an explicit date sets a custom one.
    let ignoreBefore: string | null
    if (opts && "ignoreBefore" in opts) {
      ignoreBefore = opts.ignoreBefore ? opts.ignoreBefore : null
    } else {
      const { data: conns } = await admin
        .from("store_connections")
        .select("sync_orders_since")
        .eq("is_active", true)
        .not("sync_orders_since", "is", null)
      const floors = (conns ?? [])
        .map((c) => c.sync_orders_since as string | null)
        .filter((v): v is string => Boolean(v))
        .sort()
      ignoreBefore = floors.length ? floors[floors.length - 1] : null
    }
    const result = await reconcileShipStation(admin, apiKey, apiSecret, ignoreBefore)
    return { ok: true, result }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "ShipStation check failed.",
    }
  }
}

