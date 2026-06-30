import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * store_sync_jobs helpers — the resumable, chunked backfill driver's data layer.
 *
 * A job tracks one connection's past-order import: the platform pagination
 * cursor plus running counters. The UI starts a job, then calls a per-channel
 * `step` action repeatedly (one page each) until `done`. All I/O here runs with
 * the SERVICE ROLE (the table is RLS-denied to the API role); callers authorize
 * against the connection separately before invoking these.
 */

export type StoreChannel = "shopify" | "woocommerce"

export type SyncJobRow = {
  id: string
  connection_id: string
  channel: StoreChannel
  status: "running" | "completed" | "failed" | "cancelled"
  cursor: string | null
  page_count: number
  fetched: number
  imported: number
  duplicates: number
  needs_mapping: number
  skipped: number
  first_error: string | null
  last_error: string | null
}

/** Serializable progress shape returned to the client runner. */
export type JobProgress = {
  jobId: string
  status: SyncJobRow["status"]
  pageCount: number
  fetched: number
  imported: number
  duplicates: number
  needsMapping: number
  skipped: number
  firstError: string | null
  lastError: string | null
  done: boolean
}

const JOB_COLS =
  "id, connection_id, channel, status, cursor, page_count, fetched, imported, duplicates, needs_mapping, skipped, first_error, last_error"

export function toProgress(j: SyncJobRow): JobProgress {
  return {
    jobId: j.id,
    status: j.status,
    pageCount: j.page_count,
    fetched: j.fetched,
    imported: j.imported,
    duplicates: j.duplicates,
    needsMapping: j.needs_mapping,
    skipped: j.skipped,
    firstError: j.first_error,
    lastError: j.last_error,
    done: j.status !== "running",
  }
}

/**
 * Resume the in-flight backfill for this connection if there is one, otherwise
 * start fresh. A running job is resumed as-is; a previously failed job is flipped
 * back to running (keeping its saved cursor) so a retry picks up where it left
 * off. The DB's partial unique index guarantees at most one running job.
 */
export async function startOrResumeJob(
  admin: SupabaseClient,
  connectionId: string,
  channel: StoreChannel,
): Promise<SyncJobRow> {
  const { data: running } = await admin
    .from("store_sync_jobs")
    .select(JOB_COLS)
    .eq("connection_id", connectionId)
    .eq("kind", "orders_backfill")
    .eq("status", "running")
    .maybeSingle()
  if (running) return running as SyncJobRow

  const { data: failed } = await admin
    .from("store_sync_jobs")
    .select(JOB_COLS)
    .eq("connection_id", connectionId)
    .eq("kind", "orders_backfill")
    .eq("status", "failed")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (failed) {
    const { data, error } = await admin
      .from("store_sync_jobs")
      .update({ status: "running", last_error: null, updated_at: new Date().toISOString() })
      .eq("id", failed.id)
      .select(JOB_COLS)
      .single()
    if (error) throw new Error(error.message)
    return data as SyncJobRow
  }

  const { data, error } = await admin
    .from("store_sync_jobs")
    .insert({ connection_id: connectionId, channel })
    .select(JOB_COLS)
    .single()
  if (error) throw new Error(error.message)
  return data as SyncJobRow
}

export async function getJob(
  admin: SupabaseClient,
  jobId: string,
): Promise<SyncJobRow | null> {
  const { data } = await admin
    .from("store_sync_jobs")
    .select(JOB_COLS)
    .eq("id", jobId)
    .maybeSingle()
  return (data as SyncJobRow) ?? null
}

export async function saveJob(
  admin: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<SyncJobRow> {
  const { data, error } = await admin
    .from("store_sync_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .select(JOB_COLS)
    .single()
  if (error) throw new Error(error.message)
  return data as SyncJobRow
}
