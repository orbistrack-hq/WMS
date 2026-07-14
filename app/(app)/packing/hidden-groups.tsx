"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Undo2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatDate, formatDateTime } from "@/lib/format"
import { undismissGroup, undismissAllHidden } from "./actions"

export type HiddenGroup = {
  id: string
  customer: string
  site: string
  windowStart: string
  dismissedAt: string | null
  orderCount: number
}

/**
 * Reverse-hiding panel for the packing queue. Lists every open group currently
 * hidden (dismissed_at set) with a per-row "Un-hide" and a bulk "Un-hide all".
 * Un-hiding is non-destructive — it just puts the group back on the queue — so
 * both actions confirm inline only for the bulk case (which can move a lot).
 */
export function HiddenGroups({ groups }: { groups: HiddenGroup[] }) {
  const router = useRouter()
  const [allPending, startAll] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  function undismissAll() {
    setError(null)
    setMsg(null)
    startAll(async () => {
      const res = await undismissAllHidden()
      if (!res.ok) {
        setError(res.error)
        return
      }
      setMsg(
        res.count === 0
          ? "Nothing was hidden."
          : `Restored ${res.count} group${res.count === 1 ? "" : "s"} to the queue.`,
      )
      router.refresh()
    })
  }

  if (groups.length === 0) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
        No hidden groups. Anything you hide from the queue will show up here so
        you can put it back.
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          {groups.length} hidden group{groups.length === 1 ? "" : "s"}. Un-hiding
          is non-destructive — it just puts the group back on the packing queue.
        </p>
        <div className="ml-auto flex items-center gap-2">
          {msg ? (
            <span className="text-sm text-muted-foreground">{msg}</span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={undismissAll}
            disabled={allPending}
          >
            <Undo2 className="size-4" />
            {allPending ? "Un-hiding…" : "Un-hide all"}
          </Button>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Site</TableHead>
              <TableHead className="text-right">Orders</TableHead>
              <TableHead>Window</TableHead>
              <TableHead>Hidden</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <HiddenRow key={g.id} group={g} />
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}

function HiddenRow({ group }: { group: HiddenGroup }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function run() {
    setError(null)
    startTransition(async () => {
      const res = await undismissGroup(group.id)
      if (!res.ok) {
        setError(res.error)
        return
      }
      router.refresh()
    })
  }

  return (
    <TableRow>
      <TableCell className="font-medium">{group.customer}</TableCell>
      <TableCell className="text-muted-foreground">{group.site}</TableCell>
      <TableCell className="text-right tabular-nums">
        {group.orderCount}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {formatDate(group.windowStart)}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {group.dismissedAt ? (
          formatDateTime(group.dismissedAt)
        ) : (
          <Badge variant="secondary">hidden</Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex flex-col items-end gap-1">
          <Button variant="ghost" size="sm" onClick={run} disabled={pending}>
            <Undo2 className="size-4" /> {pending ? "Un-hiding…" : "Un-hide"}
          </Button>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </TableCell>
    </TableRow>
  )
}
