"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { updatePackagingRule } from "./actions"

/**
 * Edits the single global jar/bag weight threshold (FB-3). Admins can save;
 * everyone else sees it read-only. Changing it only re-seeds packaging at pack
 * time — packers always keep the final say on each order.
 */
export function PackagingRuleEditor({
  jarMaxGrams,
  isAdmin,
}: {
  jarMaxGrams: number
  isAdmin: boolean
}) {
  const router = useRouter()
  const [value, setValue] = useState(String(jarMaxGrams))
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const dirty = value.trim() !== String(jarMaxGrams)

  function save() {
    setError(null)
    setSaved(false)
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) {
      setError("Threshold must be greater than zero.")
      return
    }
    startTransition(async () => {
      const res = await updatePackagingRule(n)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setSaved(true)
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Units at or below this weight are packed in a{" "}
        <span className="font-medium text-foreground">jar</span> (plus one jar
        label); anything heavier goes in{" "}
        <span className="font-medium text-foreground">one Mylar bag</span>. Every
        order also gets one box and one label. This only pre-fills packaging at
        pack time — packers can always adjust.
      </p>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="jarMax" className="text-xs">
            Jar threshold (grams)
          </Label>
          <Input
            id="jarMax"
            type="number"
            min="0"
            step="0.5"
            value={value}
            disabled={!isAdmin || isPending}
            onChange={(e) => {
              setValue(e.target.value)
              setSaved(false)
            }}
            className="w-28"
          />
        </div>
        {isAdmin ? (
          <Button onClick={save} disabled={isPending || !dirty}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        ) : null}
        {saved && !dirty ? (
          <span className="inline-flex items-center gap-1 pb-2 text-sm text-emerald-600 dark:text-emerald-400">
            <Check className="size-4" /> Saved
          </span>
        ) : null}
      </div>

      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">
          Only an admin can change this rule.
        </p>
      ) : null}
    </div>
  )
}
