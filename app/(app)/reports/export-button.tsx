"use client"

import { Download } from "lucide-react"

import { Button } from "@/components/ui/button"

type Row = Record<string, string | number | null | undefined>

function toCsv(columns: { key: string; label: string }[], rows: Row[]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = columns.map((c) => esc(c.label)).join(",")
  const body = rows
    .map((r) => columns.map((c) => esc(r[c.key])).join(","))
    .join("\n")
  return `${header}\n${body}`
}

export function ExportButton({
  columns,
  rows,
  filename,
}: {
  columns: { key: string; label: string }[]
  rows: Row[]
  filename: string
}) {
  function download() {
    const csv = toCsv(columns, rows)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={download}
      disabled={rows.length === 0}
    >
      <Download className="size-4" />
      Export CSV
    </Button>
  )
}
