/**
 * Read every row of a PostgREST query, a page at a time.
 *
 * WHY THIS EXISTS. `.limit(n)` is a REQUEST, not a guarantee. PostgREST enforces
 * its own server-side max-rows cap — 1000 on a stock Supabase project — and when
 * it truncates it returns those rows with NO error and no indication the result
 * was cut short. A report that asks for `.limit(5000)` and gets 1000 back looks
 * exactly like a report where only 1000 rows matched.
 *
 * The damage is worse than "some totals read low":
 *
 *   - Totals silently understate, and there is no signal to catch it in review.
 *   - Any page that DIFFS two result sets (e.g. fulfilled orders vs orders that
 *     were charged a fee) gets false positives, because two unordered queries
 *     truncate to arbitrary and non-corresponding subsets. An order lands in one
 *     set while its match falls outside the other, and gets reported as missing.
 *
 * CALLERS MUST ORDER. Pass a builder whose query carries an explicit .order() on
 * a stable, unique-enough column. Without it Postgres may return rows in any
 * order and the pages will not tile a consistent sequence — you can get
 * duplicates and omissions across page boundaries. Ordering is the caller's job
 * because only the caller knows which column is right.
 *
 * Usage — note the builder is a FUNCTION, called fresh per page, because a
 * PostgREST query builder is single-use:
 *
 *   const rows = await fetchAllPages<Row>(() =>
 *     supabase.from("orders").select("id, total").eq("status", "fulfilled").order("id"),
 *   )
 */

const PAGE_SIZE = 1000

/** Hard ceiling so a runaway query cannot loop forever against a huge table. */
const MAX_ROWS = 200_000

type Pageable = {
  range: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>
}

export async function fetchAllPages<T>(build: () => Pageable): Promise<T[]> {
  const out: T[] = []
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await build().range(offset, offset + PAGE_SIZE - 1)
    // A mid-run failure returns what we have rather than throwing the page away.
    // Callers render a report; a partial report beats an error screen, and the
    // alternative (throwing) would take out the whole route.
    if (error) break
    const batch = (data ?? []) as T[]
    out.push(...batch)
    // A short page means the end of the result set — the only reliable signal,
    // since the cap makes any single count untrustworthy.
    if (batch.length < PAGE_SIZE) break
  }
  return out
}
