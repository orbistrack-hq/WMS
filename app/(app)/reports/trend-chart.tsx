import { formatCurrency } from "@/lib/format"

export type TrendPoint = {
  label: string
  revenue: number
  landedCost: number
  netProfit: number
}

// Lightweight inline-SVG trend chart — no chart dependency. Renders revenue and
// landed-cost as lines and net profit as a filled area, on a shared scale.
export function TrendChart({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
        No fulfilled orders in this range.
      </div>
    )
  }

  const W = 760
  const H = 240
  const padL = 8
  const padR = 8
  const padT = 16
  const padB = 28
  const innerW = W - padL - padR
  const innerH = H - padT - padB

  const maxV = Math.max(
    1,
    ...data.map((d) => Math.max(d.revenue, d.landedCost, d.netProfit, 0)),
  )
  const minV = Math.min(0, ...data.map((d) => d.netProfit))
  const span = maxV - minV || 1

  const x = (i: number) =>
    padL + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW)
  const y = (v: number) => padT + innerH - ((v - minV) / span) * innerH

  const line = (key: keyof TrendPoint) =>
    data
      .map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d[key] as number).toFixed(1)}`)
      .join(" ")

  const area =
    `M${x(0).toFixed(1)},${y(0).toFixed(1)} ` +
    data.map((d, i) => `L${x(i).toFixed(1)},${y(d.netProfit).toFixed(1)}`).join(" ") +
    ` L${x(data.length - 1).toFixed(1)},${y(0).toFixed(1)} Z`

  const zeroY = y(0)
  // Thin x-axis labels so they don't collide.
  const labelEvery = Math.ceil(data.length / 8)

  return (
    <div className="w-full">
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <Legend className="bg-foreground/70" label="Revenue" />
        <Legend className="bg-muted-foreground/60" label="Landed cost" />
        <Legend className="bg-emerald-500" label="Net profit" />
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-56 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="Revenue, landed cost, and net profit over time"
      >
        {/* zero baseline */}
        <line
          x1={padL}
          x2={W - padR}
          y1={zeroY}
          y2={zeroY}
          className="stroke-border"
          strokeWidth={1}
        />
        {/* net profit area */}
        <path d={area} className="fill-emerald-500/15" />
        {/* landed cost line */}
        <path
          d={line("landedCost")}
          fill="none"
          className="stroke-muted-foreground/60"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
        {/* net profit line */}
        <path
          d={line("netProfit")}
          fill="none"
          className="stroke-emerald-500"
          strokeWidth={1.5}
        />
        {/* revenue line */}
        <path
          d={line("revenue")}
          fill="none"
          className="stroke-foreground/70"
          strokeWidth={2}
        />
        {/* points with tooltips */}
        {data.map((d, i) => (
          <g key={d.label}>
            <circle
              cx={x(i)}
              cy={y(d.revenue)}
              r={2.5}
              className="fill-foreground/70"
            />
            <rect
              x={x(i) - innerW / data.length / 2}
              y={padT}
              width={innerW / data.length}
              height={innerH}
              fill="transparent"
            >
              <title>
                {`${d.label}\nRevenue: ${formatCurrency(d.revenue)}\nLanded cost: ${formatCurrency(d.landedCost)}\nNet profit: ${formatCurrency(d.netProfit)}`}
              </title>
            </rect>
          </g>
        ))}
        {/* x labels */}
        {data.map((d, i) =>
          i % labelEvery === 0 || i === data.length - 1 ? (
            <text
              key={`l-${d.label}`}
              x={x(i)}
              y={H - 8}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {d.label}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  )
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block size-2.5 rounded-sm ${className}`} />
      {label}
    </span>
  )
}
