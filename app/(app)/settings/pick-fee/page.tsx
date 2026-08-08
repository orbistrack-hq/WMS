import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { todayISODate } from "@/lib/format"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { PickFeeEditor, type ScheduleRow } from "./pick-fee-editor"

export const dynamic = "force-dynamic"

type Row = {
  id: string
  effective_from: string
  first_unit_rate: number | string
  additional_unit_rate: number | string
  note: string | null
  created_at: string
  created_by: string | null
}

export default async function PickFeeSettingsPage() {
  const supabase = await createClient()

  const [schedulesRes, canManageRes] = await Promise.all([
    supabase
      .from("fee_schedules")
      .select(
        "id, effective_from, first_unit_rate, additional_unit_rate, note, created_at, created_by",
      )
      .is("client_id", null)
      .order("effective_from", { ascending: false }),
    supabase.rpc("can_manage_fee_schedules"),
  ])

  const rows = (schedulesRes.data ?? []) as Row[]
  const canManage = canManageRes.data === true

  // How many orders each schedule has billed. This is the number that decides
  // whether a row is frozen, so it is read from billing_charges rather than
  // inferred from dates — a schedule can be dated in the future and still have
  // billed if someone fulfilled ahead of it, and the DB trigger goes by charges.
  const chargeCounts = await Promise.all(
    rows.map(async (r) => {
      const { count } = await supabase
        .from("billing_charges")
        .select("id", { count: "exact", head: true })
        .eq("fee_schedule_id", r.id)
      return [r.id, count ?? 0] as const
    }),
  )
  const counts = new Map(chargeCounts)

  const today = todayISODate()

  // The rate in force right now: latest row whose effective_from has arrived.
  // Mirrors resolve_fee_schedule() exactly — same ordering, same comparison.
  const currentId = rows.find((r) => r.effective_from <= today)?.id ?? null

  const schedules: ScheduleRow[] = rows.map((r) => ({
    id: r.id,
    effectiveFrom: r.effective_from,
    firstUnitRate: Number(r.first_unit_rate),
    additionalUnitRate: Number(r.additional_unit_rate),
    note: r.note,
    createdAt: r.created_at,
    chargeCount: counts.get(r.id) ?? 0,
    isCurrent: r.id === currentId,
  }))

  return (
    <>
      <PageHeader
        title="Pick fee"
        description="What each order is billed for picking and packing."
        action={
          <Link
            href="/settings"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
          >
            <ArrowLeft /> Settings
          </Link>
        }
      />

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">How the pick fee works</CardTitle>
            <CardDescription>
              Every fulfilled order is billed one pick fee: the first-unit rate
              once, plus the additional-unit rate for every unit after the
              first. On combined orders the first-unit rate applies once per
              order, not once per group — combining saves a box and a label, not
              a pick.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>
              Rates are dated. The rate charged is whichever one was in force on
              the day the order was fulfilled, and that amount is copied onto
              the order&apos;s charge at fulfilment. Publishing a new rate never
              changes an order that has already been billed, and never changes a
              past month&apos;s billing report.
            </p>
          </CardContent>
        </Card>

        <PickFeeEditor
          schedules={schedules}
          canManage={canManage}
          today={today}
        />
      </div>
    </>
  )
}
