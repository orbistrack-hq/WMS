"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"

export type ActionResult = { ok: true } | { ok: false; error: string }

type PgError = { message?: string; details?: string; code?: string } | null

function err(error: PgError): string {
  if (!error) return "Something went wrong."
  if (error.code === "42501")
    return "Only an admin can manage sites."
  if (error.code === "23505") return "That site code is already in use."
  if (error.code === "23503")
    return "This site is used by SKUs or orders — deactivate it instead of deleting."
  return error.message || error.details || "Something went wrong."
}

function revalidate() {
  revalidatePath("/settings/sites")
  // Sites feed the site pickers across these screens.
  revalidatePath("/catalog")
  revalidatePath("/inventory")
  revalidatePath("/orders")
  revalidatePath("/integrations/shopify")
}

export async function createSite(
  name: string,
  code: string,
): Promise<ActionResult> {
  if (!name.trim()) return { ok: false, error: "Site name is required." }

  const supabase = await createClient()
  const { error } = await supabase
    .from("sites")
    .insert({ name: name.trim(), code: code.trim() || null, is_active: true })
  if (error) return { ok: false, error: err(error) }

  revalidate()
  return { ok: true }
}

export async function updateSite(
  id: string,
  name: string,
  code: string,
): Promise<ActionResult> {
  if (!name.trim()) return { ok: false, error: "Site name is required." }

  const supabase = await createClient()
  const { error } = await supabase
    .from("sites")
    .update({ name: name.trim(), code: code.trim() || null })
    .eq("id", id)
  if (error) return { ok: false, error: err(error) }

  revalidate()
  return { ok: true }
}

export async function setSiteActive(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("sites")
    .update({ is_active: isActive })
    .eq("id", id)
  if (error) return { ok: false, error: err(error) }

  revalidate()
  return { ok: true }
}

export async function deleteSite(id: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.from("sites").delete().eq("id", id)
  if (error) return { ok: false, error: err(error) }

  revalidate()
  return { ok: true }
}
