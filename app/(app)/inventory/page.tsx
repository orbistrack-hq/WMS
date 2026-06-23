import { Boxes } from "lucide-react"

import { PageHeader, Placeholder } from "@/components/page-header"

export default function InventoryPage() {
  return (
    <>
      <PageHeader
        title="Inventory"
        description="Real-time stock per child SKU per location — available vs. reserved."
      />
      <Placeholder icon={Boxes} title="Inventory list coming next">
        This screen will show on-hand, available, reserved, and layby counts per
        child SKU per site, with a zero-stock filter and manual adjustments
        written to the audit trail.
      </Placeholder>
    </>
  )
}
