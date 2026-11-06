"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { QUALITIES, QUALITY_LABEL, type Quality } from "@/lib/shake"

import { setProductIsShake, setProductQuality } from "./actions"

export type QualityRow = {
  id: string
  name: string
  quality: Quality | null
  isShake: boolean
  brands: string[]
  sized: boolean
}

type Filter = "unset" | "all" | Quality | "shake"

export function QualityManager({ rows }: { rows: QualityRow[] }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState("")
  const unsetCount = rows.filter((r) => !r.quality).length
  const [filter, setFilter] = useState<Filter>(unsetCount > 0 ? "unset" : "all")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<Quality | "">("")

  const counts = useMemo(() => {
    const c: Record<string, number> = { unset: 0, shake: 0, all: rows.length }
    for (const r of rows) {
      if (!r.quality) c.unset++
      else c[r.quality] = (c[r.quality] ?? 0) + 1
      if (r.isShake) c.shake++
    }
    return c
  }, [rows])

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter === "unset" && r.quality) return false
      if (filter === "shake" && !r.isShake) return false
      if (filter !== "unset" && filter !== "shake" && filter !== "all" && r.quality !== filter)
        return false
      if (needle && !r.name.toLowerCase().includes(needle)) return false
      return true
    })
  }, [rows, q, filter])

  const visibleIds = visible.map((r) => r.id)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) return setError(res.error ?? "Something went wrong.")
      after?.()
      router.refresh()
    })
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {(
          [
            ["unset", `Not set (${counts.unset})`],
            ...QUALITIES.map((x) => [x, `${QUALITY_LABEL[x]} (${counts[x] ?? 0})`] as const),
            ["shake", `Shake products (${counts.shake})`],
            ["all", `All (${counts.all})`],
          ] as [Filter, string][]
        ).map(([f, label]) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "default" : "outline"}
            onClick={() => {
              setFilter(f)
              setSelected(new Set())
            }}
          >
            {label}
          </Button>
        ))}
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search strains…"
          aria-label="Search strains"
          className="ml-auto w-full sm:w-56"
        />
      </div>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
        <span className="text-muted-foreground">{selected.size} selected</span>
        <Select
          aria-label="Quality for selected"
          value={bulk}
          onChange={(e) => setBulk(e.target.value as Quality | "")}
          className="w-36"
        >
          <option value="">Set quality…</option>
          {QUALITIES.map((x) => (
            <option key={x} value={x}>
              {QUALITY_LABEL[x]}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          disabled={isPending || selected.size === 0 || !bulk}
          onClick={() =>
            run(
              () => setProductQuality([...selected], bulk || null),
              () => {
                setSelected(new Set())
                setBulk("")
              },
            )
          }
        >
          Apply to selected
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">
              <input
                type="checkbox"
                aria-label="Select all shown"
                checked={allVisibleSelected}
                onChange={() =>
                  setSelected((prev) => {
                    const next = new Set(prev)
                    if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id))
                    else visibleIds.forEach((id) => next.add(id))
                    return next
                  })
                }
              />
            </TableHead>
            <TableHead>Product</TableHead>
            <TableHead>Brands</TableHead>
            <TableHead className="w-40">Quality</TableHead>
            <TableHead className="w-32">Shake product</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                {filter === "unset" ? "Every strain has a quality." : "Nothing matches."}
              </TableCell>
            </TableRow>
          ) : (
            visible.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.name}`}
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                </TableCell>
                <TableCell className="font-medium">
                  {r.name}
                  {r.isShake ? (
                    <Badge variant="secondary" className="ml-2">
                      Shake
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.brands.join(", ") || "—"}
                </TableCell>
                <TableCell>
                  <Select
                    aria-label={`${r.name} quality`}
                    value={r.quality ?? ""}
                    disabled={isPending}
                    onChange={(e) =>
                      run(() => setProductQuality([r.id], (e.target.value as Quality) || null))
                    }
                  >
                    <option value="">Not set</option>
                    {QUALITIES.map((x) => (
                      <option key={x} value={x}>
                        {QUALITY_LABEL[x]}
                      </option>
                    ))}
                  </Select>
                </TableCell>
                <TableCell>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={`${r.name} is a shake product`}
                      checked={r.isShake}
                      disabled={isPending || (!r.isShake && !r.quality)}
                      title={!r.quality ? "Set a quality first" : undefined}
                      onChange={(e) => run(() => setProductIsShake(r.id, e.target.checked))}
                    />
                    <span className="text-muted-foreground">{r.isShake ? "Yes" : "No"}</span>
                  </label>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
