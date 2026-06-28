"use client"

import { useState } from "react"
import { ScanLine } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * Barcode / SKU entry. Handheld scanners are keyboard-wedge devices: they type
 * the code fast and send Enter, so we just capture the input and resolve on
 * Enter. The same box doubles as manual entry for damaged or missing labels —
 * type the code and press Enter (or the button).
 *
 * Submitting clears the field but keeps focus, so a picker can scan-scan-scan
 * without touching the screen.
 */
export function ScanInput({
  onScan,
  disabled,
  placeholder,
}: {
  onScan: (code: string) => void
  disabled?: boolean
  placeholder?: string
}) {
  const [value, setValue] = useState("")

  function submit() {
    const code = value.trim()
    setValue("")
    if (code) onScan(code)
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <ScanLine className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={placeholder ?? "Scan or type a barcode / SKU…"}
          className="pl-8 font-mono"
        />
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={submit}
      >
        Enter
      </Button>
    </div>
  )
}
