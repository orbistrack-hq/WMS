import { PageHeaderSkeleton, TableSkeleton } from "@/components/loading-skeletons"

/**
 * App-wide fallback loading state. Sections with their own loading.tsx
 * (inventory, orders, catalog, packing, reports, dashboard) override this;
 * everything else (settings, integrations) gets a sensible generic skeleton.
 */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction />
      <TableSkeleton columns={4} rows={6} />
    </>
  )
}
