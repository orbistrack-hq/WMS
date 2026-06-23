import { ClipboardList } from "lucide-react"

import { PageHeader, Placeholder } from "@/components/page-header"

export default function OrdersPage() {
  return (
    <>
      <PageHeader
        title="Orders"
        description="Create and manage orders through the full status flow."
      />
      <Placeholder icon={ClipboardList} title="Orders list coming next">
        This screen will handle order creation and editing with line items,
        holds, layaway, post-dated sales, and combining orders shipped together
        within 24 hours to the same address.
      </Placeholder>
    </>
  )
}
