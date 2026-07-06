import { Card } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Shared loading skeletons used by route-level loading.tsx files.
 * These render instantly on navigation (no data fetch) so a click never
 * feels like a freeze — the real server component streams in behind them.
 */

export function PageHeaderSkeleton({ withAction = false }: { withAction?: boolean }) {
  return (
    <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      {withAction ? <Skeleton className="h-8 w-32 shrink-0" /> : null}
    </div>
  )
}

export function FiltersSkeleton({ fields = 3 }: { fields?: number }) {
  return (
    <div className="mb-4 flex flex-wrap gap-3">
      {Array.from({ length: fields }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-40" />
      ))}
    </div>
  )
}

export function TableSkeleton({
  columns,
  rows = 8,
}: {
  columns: number
  rows?: number
}) {
  return (
    <Card className="p-0">
      <Table>
        <TableHeader>
          <TableRow>
            {Array.from({ length: columns }).map((_, i) => (
              <TableHead key={i}>
                <Skeleton className="h-4 w-20" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, r) => (
            <TableRow key={r}>
              {Array.from({ length: columns }).map((_, c) => (
                <TableCell key={c}>
                  <Skeleton className="h-4 w-full max-w-24" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

export function CardGridSkeleton({
  count = 4,
  columns = "sm:grid-cols-2 lg:grid-cols-4",
}: {
  count?: number
  columns?: string
}) {
  return (
    <div className={`grid gap-4 ${columns}`}>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} className="p-4">
          <Skeleton className="mb-3 h-4 w-24" />
          <Skeleton className="h-8 w-20" />
        </Card>
      ))}
    </div>
  )
}

/** Table-based list page: header + filters + table. Covers most sections. */
export function ListPageSkeleton({
  columns,
  withAction = false,
  filterFields = 3,
  rows = 8,
}: {
  columns: number
  withAction?: boolean
  filterFields?: number
  rows?: number
}) {
  return (
    <>
      <PageHeaderSkeleton withAction={withAction} />
      <FiltersSkeleton fields={filterFields} />
      <TableSkeleton columns={columns} rows={rows} />
    </>
  )
}
