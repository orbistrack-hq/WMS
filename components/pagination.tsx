import Link from "next/link"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import { DEFAULT_PAGE_SIZE, pageHref } from "@/lib/pagination"

type Props = {
  basePath: string
  /** Current searchParams to preserve across page links. */
  params: Record<string, string | undefined>
  page: number
  /** True when a full extra page was detected (drives the Next button). */
  hasMore: boolean
  /** Rows rendered on the current page (for the "X–Y" range label). */
  pageRows: number
  pageSize?: number
  /** Optional approximate total (e.g. a planner estimate); shown as "~N". */
  approxTotal?: number | null
}

const disabled =
  "pointer-events-none opacity-50"

export function Pagination({
  basePath,
  params,
  page,
  hasMore,
  pageRows,
  pageSize = DEFAULT_PAGE_SIZE,
  approxTotal = null,
}: Props) {
  // Nothing to page through.
  if (page <= 1 && !hasMore) return null

  const rangeStart = pageRows === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeEnd = (page - 1) * pageSize + pageRows
  // Only show an approximate total when it's at least as large as what we've
  // already shown — avoids "1–50 of ~0" when the planner estimate is stale.
  const showTotal = approxTotal != null && approxTotal >= rangeEnd

  const linkCls = buttonVariants({ variant: "outline", size: "sm" })

  return (
    <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
      <span className="text-muted-foreground tabular-nums">
        {rangeStart}-{rangeEnd}
        {showTotal ? ` of ~${approxTotal!.toLocaleString()}` : ""}
      </span>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={pageHref(basePath, params, page - 1)} className={linkCls}>
            <ChevronLeft data-icon="inline-start" /> Prev
          </Link>
        ) : (
          <span className={`${linkCls} ${disabled}`} aria-disabled>
            <ChevronLeft data-icon="inline-start" /> Prev
          </span>
        )}
        <span className="tabular-nums text-muted-foreground">Page {page}</span>
        {hasMore ? (
          <Link href={pageHref(basePath, params, page + 1)} className={linkCls}>
            Next <ChevronRight data-icon="inline-end" />
          </Link>
        ) : (
          <span className={`${linkCls} ${disabled}`} aria-disabled>
            Next <ChevronRight data-icon="inline-end" />
          </span>
        )}
      </div>
    </div>
  )
}
