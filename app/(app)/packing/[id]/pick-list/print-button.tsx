"use client"

import { Printer } from "lucide-react"

import { Button } from "@/components/ui/button"

/** Triggers the browser print dialog (→ print or Save as PDF). */
export function PrintButton() {
  return (
    <Button variant="outline" onClick={() => window.print()}>
      <Printer data-icon="inline-start" /> Print / Save as PDF
    </Button>
  )
}
