import { ListPageSkeleton } from "@/components/loading-skeletons"

export default function Loading() {
  return <ListPageSkeleton columns={7} withAction filterFields={4} rows={10} />
}
