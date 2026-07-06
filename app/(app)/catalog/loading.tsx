import { ListPageSkeleton } from "@/components/loading-skeletons"

export default function Loading() {
  return <ListPageSkeleton columns={5} withAction filterFields={3} rows={10} />
}
