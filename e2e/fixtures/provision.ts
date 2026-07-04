import { createClient, type SupabaseClient } from "@supabase/supabase-js"

// ---------------------------------------------------------------------------
// Test-data provisioning for the E2E suite. Talks to your LOCAL Supabase using
// the service-role key (to create the auth user) and the test user's own
// session (to create the order, so RLS + auth.uid() behave like production).
// ---------------------------------------------------------------------------

const SUPABASE_URL =
  process.env.E2E_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? ""
const ANON_KEY =
  process.env.E2E_SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  ""

export const TEST_EMAIL = process.env.E2E_EMAIL ?? "e2e@example.com"
export const TEST_PASSWORD = process.env.E2E_PASSWORD ?? "e2e-Password-123!"

// From supabase/seed.sql: Main Warehouse + the Wildflower Honey child SKU
// (200 units of opening stock), so a standard order can reserve against it.
const SITE_ID = "11111111-1111-1111-1111-111111111111"
const CHILD_SKU_ID = "a0000000-0000-0000-0000-000000000001"

function assertEnv() {
  const missing: string[] = []
  if (!SUPABASE_URL) missing.push("E2E_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL")
  if (!SERVICE_ROLE_KEY) missing.push("E2E_SUPABASE_SERVICE_ROLE_KEY")
  if (!ANON_KEY)
    missing.push("E2E_SUPABASE_ANON_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY")
  if (missing.length) {
    throw new Error(
      `Missing E2E env vars: ${missing.join(", ")}. Copy .env.e2e.example to ` +
        `.env.e2e and fill from \`supabase status\`. See e2e/README.md.`,
    )
  }
}

function adminClient(): SupabaseClient {
  assertEnv()
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/** Idempotently ensure the confirmed test user exists. */
export async function ensureTestUser(): Promise<void> {
  const admin = adminClient()
  const { error } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  })
  // A duplicate means a previous run already created it — that's fine.
  if (error && !/already|exists|registered/i.test(error.message)) throw error
}

export type ReadyOrder = {
  orderId: string
  orderNumber: string
  groupId: string
}

/**
 * Create a fresh, ready-to-pack order and resolve the open fulfillment group it
 * lands in. Created as the test user (signed in with the anon key) so it goes
 * through the same RLS/auth path as the real app.
 */
export async function createReadyOrder(): Promise<ReadyOrder> {
  assertEnv()

  const user = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const signIn = await user.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  })
  if (signIn.error) throw signIn.error

  const { data: orderId, error: createErr } = await user.rpc("create_order", {
    p_site_id: SITE_ID,
    p_lines: [{ child_sku_id: CHILD_SKU_ID, quantity: 2, unit_price: 12.0 }],
    p_channel: "manual",
    p_order_type: "standard",
    p_notes: `E2E ${new Date().toISOString()}`,
  })
  if (createErr) throw createErr

  // Read back as the signed-in user (not service_role): this schema locks tables
  // down and exposes them via RLS, so the test user's session is what has SELECT
  // access — exactly the path the app itself uses.
  const { data: order, error: ordErr } = await user
    .from("orders")
    .select("order_number")
    .eq("id", orderId as string)
    .single()
  if (ordErr) throw ordErr

  // A created order is placed in an open fulfillment group (that's what the
  // packing queue lists). Resolve it so the spec can deep-link the group page.
  const { data: group, error: grpErr } = await user
    .from("fulfillment_groups")
    .select("id, orders!inner(id)")
    .eq("orders.id", orderId as string)
    .single()
  if (grpErr) {
    throw new Error(
      `Created order ${orderId} but could not find its fulfillment group ` +
        `(${grpErr.message}). If groups are created lazily, the flow may need a ` +
        `status transition before packing.`,
    )
  }

  return {
    orderId: orderId as string,
    orderNumber: order.order_number as string,
    groupId: (group as { id: string }).id,
  }
}
