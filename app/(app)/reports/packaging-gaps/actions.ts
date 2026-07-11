"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"

export type BulkPackagingLine = { packagingTypeId: string; quantity: number }

export type BulkRecordResult =
  | { ok: true; groups: number; recorded: number; failed: number; firstError?: string }
  | { ok: false; error: string }

/**
 * Record the same packaging config across many fulfillment groups at once — the
 * bulk backfill for store-completed orders that skipped the packing screen.
 *
 * Packaging is counted ONCE per group (the combine rule), so group ids are
 * de-duplicated first: selecting several orders that share a combined group
 * records their packaging a single time. Each (group, line) goes through the
 * same guarded record_packaging_usage the packing screen uses, so cost is
 * snapshotted and packaging stock is decremented exactly as normal. A line that
 * fails (e.g. packaging stock would go negative) is skipped and counted, never
 * aborting the whole run.
 */
export async function bulkRecordPackaging(
  groupIds: string[],
  lines: BulkPackagingLine[],
): Promise<BulkRecordResult> {
  const groups = Array.from(new Set(groupIds.filter(Boolean)))
  const valid = lines.filter((l) => l.packagingTypeId && l.quantity > 0)
  if (groups.length === 0) return { ok: false, error: "Select at least one order." }
  if (valid.length === 0)
    return { ok: false, error: "Add at least one packaging line to record." }

  const supabase = await createClient()
  let recorded = 0
  let failed = 0
  let firstError: string | undefined

  for (const groupId of groups) {
    for (const line of valid) {
      const { error } = await supabase.rpc("record_packaging_usage", {
        p_group_id: groupId,
        p_packaging_type_id: line.packagingTypeId,
        p_quantity: Math.trunc(line.quantity),
      })
      if (error) {
        failed++
        if (!firstError) firstError = error.message
      } else {
        recorded++
      }
    }
  }

  revalidatePath("/reports/packaging-gaps")
  revalidatePath("/packing")
  return { ok: true, groups: groups.length, recorded, failed, firstError }
}
