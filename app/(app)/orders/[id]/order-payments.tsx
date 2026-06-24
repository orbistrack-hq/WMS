"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { recordPayment } from "../actions"
import { formatCurrency, formatDateTime } from "@/lib/format"

type Payment = {
  id: string
  amount: number | string
  method: string | null
  note: string | null
  paid_at: string
}

const METHODS = ["cash", "card", "bank_transfer", "other"]

export function OrderPayments({
  orderId,
  total,
  paid,
  payments,
}: {
  orderId: string
  total: number
  paid: number
  payments: Payment[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [amount, setAmount] = useState("")
  const [method, setMethod] = useState("cash")
  const [note, setNote] = useState("")

  const balance = Math.max(0, total - paid)

  function submit() {
    const value = Number(amount)
    if (!(value > 0)) {
      setError("Enter a positive amount.")
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await recordPayment(orderId, value, method, note || null)
      if (!res.ok) {
        setError(res.error ?? "Could not record payment.")
      } else {
        setAmount("")
        setNote("")
        router.refresh()
      }
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3 text-sm">
        <Stat label="Order total" value={formatCurrency(total)} />
        <Stat label="Paid" value={formatCurrency(paid)} />
        <Stat
          label="Balance"
          value={formatCurrency(balance)}
          emphasis={balance > 0}
        />
      </div>

      {payments.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {payments.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              <div className="flex flex-col">
                <span className="font-medium tabular-nums">
                  {formatCurrency(p.amount)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {p.method ?? "—"}
                  {p.note ? ` · ${p.note}` : ""}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">
                {formatDateTime(p.paid_at)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No payments recorded yet.
        </p>
      )}

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="pay-amount" className="text-xs">
            Amount
          </Label>
          <Input
            id="pay-amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-28"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pay-method" className="text-xs">
            Method
          </Label>
          <Select
            id="pay-method"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="w-36"
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m.replace("_", " ")}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="pay-note" className="text-xs">
            Note (optional)
          </Label>
          <Input
            id="pay-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reference…"
          />
        </div>
        <Button onClick={submit} disabled={isPending}>
          <Plus data-icon="inline-start" /> Record
        </Button>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  emphasis,
}: {
  label: string
  value: string
  emphasis?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={
          emphasis
            ? "font-semibold tabular-nums text-foreground"
            : "tabular-nums"
        }
      >
        {value}
      </span>
    </div>
  )
}
