import { PageHeaderSkeleton, CardGridSkeleton } from "@/components/loading-skeletons"

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction />
      {/* Packing queue is a list of order cards, not a table */}
      <CardGridSkeleton count={6} columns="sm:grid-cols-2 lg:grid-cols-3" />
    </>
  )
}
