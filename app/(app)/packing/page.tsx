import { PackageCheck } from "lucide-react"

import { PageHeader, Placeholder } from "@/components/page-header"

export default function PackingPage() {
  return (
    <>
      <PageHeader
        title="Packing"
        description="Pack orders, record consumables, and confirm to advance."
      />
      <Placeholder icon={PackageCheck} title="Packing screen coming next">
        This screen will capture box, label, bag, and jar usage with automatic
        packaging cost calculation and packing notes — counting box and label
        once per combined-order group.
      </Placeholder>
    </>
  )
}
