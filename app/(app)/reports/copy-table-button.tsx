"use client"

import { useState } from "react"
import { Check, ClipboardCopy } from "lucide-react"

import { Button } from "@/components/ui/button"

type Row = Record<string, string | number | null | undefined>

/**
 * Copy a table to the clipboard as TSV.
 *
 * Tab-separated, not comma-separated, because Excel and Google Sheets both
 * treat a tab-delimited paste as columns automatically — no import dialog, no
 * "Text to Columns", no downloaded file to find. Pasting CSV text puts the
 * whole row in one cell, which is why this is not just the export with a
 * different button.
 *
 * Fields are sanitised rather than quoted: a literal tab or newline inside a
 * value would break the column alignment, and TSV has no escape convention that
 * spreadsheets agree on. Brand names and money never legitimately contain
 * either, so collapsing them to spaces is lossless in practice.
 */
function toTsv(columns: { key: string; label: string }[], rows: Row[]): string {
  const clean = (v: string | number | null | undefined) =>
    v == null ? "" : String(v).replace(/[\t\r\n]+/g, " ")
  const header = columns.map((c) => clean(c.label)).join("\t")
  const body = rows.map((r) => columns.map((c) => clean(r[c.key])).join("\t")).join("\n")
  return `${header}\n${body}`
}

export function CopyTableButton({
  columns,
  rows,
  label = "Copy for spreadsheet",
}: {
  columns: { key: string; label: string }[]
  rows: Row[]
  label?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    const tsv = toTsv(columns, rows)
    try {
      await navigator.clipboard.writeText(tsv)
    } catch {
      // navigator.clipboard needs a secure context. On plain http (a LAN box,
      // say) it throws, so fall back to the old selection-based copy.
      const ta = document.createElement("textarea")
      ta.value = tsv
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.select()
      document.execCommand("copy")
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button variant="default" size="sm" onClick={copy} disabled={rows.length === 0}>
      {copied ? <Check className="size-4" /> : <ClipboardCopy className="size-4" />}
      {copied ? "Copied" : label}
    </Button>
  )
}
