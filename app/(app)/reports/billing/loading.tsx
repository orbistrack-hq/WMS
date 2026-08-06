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
      <FiltersSkeleton fields={3} />
      <div className="mb-4">
        <CardGridSkeleton count={6} />
      </div>
      <TableSkeleton columns={9} rows={6} />
    </>
  )
}
