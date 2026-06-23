import { BarChart3 } from "lucide-react"

import { PageHeader, Placeholder } from "@/components/page-header"

export default function ReportsPage() {
  return (
    <>
      <PageHeader
        title="Reports"
        description="Sales, inventory, packaging, and shipping — by date range and site."
      />
      <Placeholder icon={BarChart3} title="Reports coming next">
        This section will provide sales, inventory, packaging cost, and shipping
        cost reports — each supporting date ranges, per-location or all-location
        rollups, channel filtering, and CSV export.
      </Placeholder>
    </>
  )
}
