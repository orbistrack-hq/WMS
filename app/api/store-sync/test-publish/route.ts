import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Isolated QStash publish diagnostic (temporary — delete after debugging).
 *
 *   GET /api/store-sync/test-publish
 *
 * Reproduces exactly what publishToQueue() does — publishes one throwaway
 * message to QStash aimed at THIS deployment — but returns the raw QStash
 * response instead of a boolean, so we can see whether the publish itself
 * succeeds. This sidesteps the store-signature (HMAC) gate on the real webhook
 * routes: if QStash accepts this, the "no jobs" problem is upstream (deliveries
 * 401ing before they reach publish); if it rejects this, the QStash token /
 * destination config is wrong.
 *
 * The message targets the /health route (GET-only) with 0 retries, so the
 * eventual delivery just 405s and disappears — it never touches real processing.
 * Returns no secrets.
 */
export async function GET() {
  const QSTASH_URL =
    process.env.QSTASH_URL?.replace(/\/+$/, "") ?? "https://qstash.upstash.io"
  const QSTASH_TOKEN = process.env.QSTASH_TOKEN
  const PUBLIC_BASE_URL = process.env.STORE_SYNC_PUBLIC_URL?.replace(/\/+$/, "")

  if (!QSTASH_TOKEN || !PUBLIC_BASE_URL) {
    return NextResponse.json(
      { ok: false, reason: "QSTASH_TOKEN or STORE_SYNC_PUBLIC_URL missing" },
      { status: 200 },
    )
  }

  const target = `${PUBLIC_BASE_URL}/api/store-sync/health`
  const publishUrl = `${QSTASH_URL}/v2/publish/${target}`
  // Echo the effective base URL so you can see whether QSTASH_URL is applied.
  // If this shows "https://qstash.upstash.io" you're on the default global
  // endpoint (routes to eu-central-1) instead of your token's region.
  const qstashUrlInUse = QSTASH_URL
  const qstashUrlFromEnv = Boolean(process.env.QSTASH_URL)

  // 1) Probe that the destination origin is publicly reachable (not behind a
  //    Vercel auth wall). A JSON 200 from /health = reachable; HTML = blocked.
  let reachable: unknown = null
  try {
    const p = await fetch(target, { signal: AbortSignal.timeout(5_000) })
    const ct = p.headers.get("content-type") ?? ""
    reachable = { status: p.status, contentType: ct, looksBlocked: !ct.includes("application/json") }
  } catch (e) {
    reachable = { error: e instanceof Error ? e.message : "unreachable" }
  }

  // 2) Attempt the actual QStash publish and surface the raw result.
  let publish: unknown = null
  try {
    const r = await fetch(publishUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${QSTASH_TOKEN}`,
        "Content-Type": "application/json",
        "Upstash-Retries": "0",
      },
      body: JSON.stringify({ test: true, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(8_000),
    })
    const body = await r.text().catch(() => "")
    publish = { status: r.status, ok: r.ok, body: body.slice(0, 400) }
  } catch (e) {
    publish = { error: e instanceof Error ? e.message : "publish failed" }
  }

  return NextResponse.json({
    qstashUrlInUse,
    qstashUrlFromEnv,
    target,
    reachable,
    publish,
  })
}
