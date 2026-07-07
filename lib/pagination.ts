/**
 * Shared list pagination helpers.
 *
 * Navigation correctness is decoupled from row counts: callers fetch one extra
 * row (`pageSize + 1`) and pass `hasMore`, so Prev/Next never depend on a count
 * that might be an estimate. Any count shown is display-only and approximate.
 */

export const DEFAULT_PAGE_SIZE = 50

export function parsePageParam(raw: string | undefined): number {
  return Math.max(1, Number.parseInt(raw ?? "1", 10) || 1)
}

/**
 * Inclusive Postgres range for a page, fetching one extra row so the caller can
 * detect whether a next page exists. Slice the result back to `size` for display
 * and set `hasMore = rows.length > size`.
 */
export function pageRangePlusOne(
  page: number,
  size = DEFAULT_PAGE_SIZE,
): [number, number] {
  const from = (page - 1) * size
  return [from, from + size] // size + 1 rows (range is inclusive)
}

/** Build an href preserving all params except `page`, then setting `page`. */
export function pageHref(
  basePath: string,
  params: Record<string, string | undefined>,
  page: number,
): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (k !== "page" && v) qs.set(k, v)
  }
  qs.set("page", String(page))
  return `${basePath}?${qs.toString()}`
}
