import { FolderTree } from "lucide-react"

import { PageHeader, Placeholder } from "@/components/page-header"

export default function CatalogPage() {
  return (
    <>
      <PageHeader
        title="Catalog"
        description="Master products, their child SKUs per location, and categories."
      />
      <Placeholder icon={FolderTree} title="Catalog coming next">
        This screen will manage parent products and the child SKUs that
        represent each product at a store or site — each with its own price,
        cost, and store variant ID — plus multi-level categories.
      </Placeholder>
    </>
  )
}
