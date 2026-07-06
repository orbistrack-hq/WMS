import {
  PageHeaderSkeleton,
  CardGridSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons"

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mb-6">
        <CardGridSkeleton count={6} columns="sm:grid-cols-2 lg:grid-cols-3" />
      </div>
      <TableSkeleton columns={5} rows={6} />
    </>
  )
}
