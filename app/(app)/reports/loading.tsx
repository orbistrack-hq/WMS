import {
  PageHeaderSkeleton,
  FiltersSkeleton,
  CardGridSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons"

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction />
      <FiltersSkeleton fields={4} />
      <div className="mb-4">
        <CardGridSkeleton count={4} />
      </div>
      <TableSkeleton columns={6} rows={8} />
    </>
  )
}
