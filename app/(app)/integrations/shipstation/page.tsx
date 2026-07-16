import { PageHeader } from "@/components/page-header"
import { ReconcileView } from "./reconcile-view"

export const dynamic = "force-dynamic"

export default function ShipStationPage() {
  const configured = Boolean(
    process.env.SHIPSTATION_API_KEY && process.env.SHIPSTATION_API_SECRET,
  )
  return (
    <>
      <PageHeader
        title="ShipStation alignment"
        description="Check that OT's ready-to-ship orders line up with ShipStation's Awaiting Shipment — and spot any that haven't synced across yet."
      />
      <ReconcileView configured={configured} />
    </>
  )
}
