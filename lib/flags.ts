/**
 * Feature flags.
 *
 * Barcode scanning — scan-to-pick on the picking screen, scan-to-pack on the
 * packing screen, and the per-child-SKU barcode field in the catalog — is
 * hidden behind this flag. It is OFF by default; picking and packing work
 * normally without it.
 *
 * To bring the whole feature back, set NEXT_PUBLIC_SCANNING_ENABLED=true in the
 * environment (no code change needed). The barcode database column is left in
 * place, so re-enabling restores everything as it was.
 */
export const SCANNING_ENABLED =
  process.env.NEXT_PUBLIC_SCANNING_ENABLED === "true"
