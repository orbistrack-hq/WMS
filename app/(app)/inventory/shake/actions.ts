"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { kickOutboundDrain } from "@/lib/store-sync/outbound"
import { isQuality, type Quality } from "@/lib/shake"

// ---------------------------------------------------------------------------
// Shake screen actions — thin wrappers over the 0117 RPCs. The database owns
// the shares, the per-brand caps, idempotency and the stock writes.
// ---------------------------------------------------------------------------

type Ok<T> = { ok: true } & T
type Err = { ok: false; error: string }
export type Result<T = object> = Ok<T> | Err

type PgError = { message?: string; details?: string; code?: string } | null

function rpcError(error: PgError): string {
  if (!error) return "Something went wrong."
  if (error.code === "42501") return "You don't have permission to do that."
  return error.message || error.details || "Something went wrong."
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export type PreviewVariant = {
  child_sku_id: string
  product_name: string
  sku: string | null
  variant_label: string | null
  grams_per_unit: number
  on_hand: number
}

export type PreviewBrand = {
  site_id: string
  site_name: string
  sold_grams: number
  share: number
  target_grams: number
  variants: PreviewVariant[]
}

export type Preview = {
  quality: Quality
  pot_grams: number
  period_from: string
  period_to: string
  last_period_to: string | null
  total_sold_grams: number
  brands: PreviewBrand[]
}

export async function recordShake(input: {
  quality: string
  grams: number
  ref: string
  note?: string | null
}): Promise<Result<{ potGrams: number }>> {
  if (!isQuality(input.quality)) return { ok: false, error: "Pick a quality." }
  if (!(input.grams > 0)) return { ok: false, error: "Enter how much shake you weighed." }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("record_shake_in", {
    p_quality: input.quality,
    p_grams: input.grams,
    p_ref_id: input.ref,
    p_note: input.note?.trim() || null,
  })
  if (error) return { ok: false, error: rpcError(error) }
  revalidatePath("/inventory/shake")
  return { ok: true, potGrams: Number((data as { pot_grams: number }).pot_grams) }
}

export async function loadPreview(input: {
  quality: string
  from: string
  to: string
}): Promise<Result<{ preview: Preview }>> {
  if (!isQuality(input.quality)) return { ok: false, error: "Pick a quality." }
  if (!ISO_DATE.test(input.from) || !ISO_DATE.test(input.to))
    return { ok: false, error: "Pick a sales period." }
  if (input.from > input.to)
    return { ok: false, error: "The period's start must be on or before its end." }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("shake_distribution_preview", {
    p_quality: input.quality,
    p_from: input.from,
    p_to: input.to,
  })
  if (error) return { ok: false, error: rpcError(error) }
  const raw = data as Preview
  const preview: Preview = {
    ...raw,
    pot_grams: Number(raw.pot_grams),
    total_sold_grams: Number(raw.total_sold_grams),
    brands: (raw.brands ?? []).map((b) => ({
      ...b,
      sold_grams: Number(b.sold_grams),
      share: Number(b.share),
      target_grams: Number(b.target_grams),
      variants: (b.variants ?? []).map((v) => ({
        ...v,
        grams_per_unit: Number(v.grams_per_unit),
        on_hand: Number(v.on_hand),
      })),
    })),
  }
  return { ok: true, preview }
}

export async function distributeShake(input: {
  quality: string
  from: string
  to: string
  lines: { child_sku_id: string; units: number }[]
  idempotencyKey: string
  note?: string | null
}): Promise<Result<{ totalGrams: number; potGrams: number }>> {
  if (!isQuality(input.quality)) return { ok: false, error: "Pick a quality." }
  const lines = input.lines.filter((l) => Number.isInteger(l.units) && l.units > 0)
  if (lines.length === 0) return { ok: false, error: "Enter at least one unit to make." }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("distribute_shake", {
    p_quality: input.quality,
    p_from: input.from,
    p_to: input.to,
    p_lines: lines,
    p_idempotency_key: input.idempotencyKey,
    p_note: input.note?.trim() || null,
  })
  if (error) return { ok: false, error: rpcError(error) }
  // Push the new shake-product stock out to each brand's store.
  await kickOutboundDrain()
  revalidatePath("/inventory/shake")
  const r = data as { total_grams: number; pot_grams: number }
  return { ok: true, totalGrams: Number(r.total_grams), potGrams: Number(r.pot_grams) }
}

export async function undoDistribution(id: string): Promise<Result> {
  const supabase = await createClient()
  const { error } = await supabase.rpc("reverse_shake_distribution", {
    p_distribution_id: id,
  })
  if (error) return { ok: false, error: rpcError(error) }
  await kickOutboundDrain()
  revalidatePath("/inventory/shake")
  return { ok: true }
}

export async function undoShakeEntry(ledgerId: string): Promise<Result> {
  const supabase = await createClient()
  const { error } = await supabase.rpc("reverse_shake_in", { p_ledger_id: ledgerId })
  if (error) return { ok: false, error: rpcError(error) }
  revalidatePath("/inventory/shake")
  return { ok: true }
}
