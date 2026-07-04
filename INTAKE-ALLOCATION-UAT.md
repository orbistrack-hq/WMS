# Intake → Allocation → Store Sync — Staging Verification (Phase A / B)

**Goal:** prove the OrbisTrack intake flow end to end on a disposable environment before go-live — bulk intake, per-client allocation, and the outbound push — confirming the **parent bulk is never synced** and **each child pushes its exact unit count**. Kept to a ~12-step sign-off, per the project's lightweight-UAT principle.

Do this **one store at a time**. Nothing here touches production; use a Supabase branch and a throwaway/staging storefront.

---

## 0. Environment setup (once)

1. **Isolated DB.** Create a Supabase branch (or `supabase db reset` on a local/staging project). Apply all migrations through **0031**:
   ```
   supabase db reset          # applies 0001–0031 + seed.sql
   supabase test db           # all pgTAP green, incl. 18–22
   ```
2. **Real-ish catalog.** Seed with a small slice of real catalog data for one strain that has 3.5/7/14/28g variants, at 1–3 client sites. Either:
   - re-sync the staging store (forward sync now sets `grams_per_unit`), or
   - if the strain is already split into `"Strain - Xg"` products, run **Catalog → Group weights** to consolidate.
3. **One store, outbound-enabled.** On exactly one `store_connections` row:
   ```sql
   update store_connections
      set sync_inventory_outbound = true,
          inventory_location_id = '<shopify_location_id>'   -- Shopify only
    where source = '<staging.myshopify.com or woo url>';
   ```
   Confirm the store secret (Shopify access token / Woo key+secret) is set in `store_secrets`.
4. **A user** with `admin` (for backfill) and `operator` (for intake) access to the site(s).

**How the push fires:** saving an allocation calls `kickOutboundDrain()` inline (service role) — it claims due jobs and pushes immediately. A scheduled drain is the backstop. So after "Save allocation", pushes usually land within seconds; the completion screen's **Refresh** re-reads `store_outbound_inventory_jobs`.

---

## Pre-flight data checks (SQL)

Parent has **no** store mapping (can never be pushed), children **are** mapped:

```sql
-- Parent inventory is grams-only, no store identifiers exist for it.
select product_id, site_id, on_hand_grams from parent_inventory where product_id = '<PARENT>';

-- Children that will sync must be mapped; unmapped ones will show "No store mapping".
select id, variant_label, grams_per_unit, store_variant_id, store_inventory_item_id
  from child_skus where product_id = '<PARENT>' and grams_per_unit is not null;
```

---

## Sign-off checklist

| # | Scenario | Steps | Expected | ✅ |
|---|----------|-------|----------|----|
| 1 | **Intake credits the pool** | Inventory → Intake: pick the strain + site, receive `1 lb`, Continue | "Parent inventory available" shows **448g**; `parent_inventory.on_hand_grams` +448; one `parent_inventory_ledger` row `reason='intake'` | ☐ |
| 2 | **UoM conversion** | Repeat intake with `oz` and `g` | 1 oz → 28g, 100 g → 100g credited (matches `to_grams`) | ☐ |
| 3 | **Allocation debits pool, credits children** | Allocate e.g. 16×3.5 + 8×7 = 112g; Save | Pool on_hand −112g; each child `inventory_levels.on_hand` rises by **exactly** its unit count; `allocations`+`allocation_lines` written | ☐ |
| 4 | **Store push is exact** | On completion, wait/Refresh | Each allocated child in the store admin now shows **available = its unit count** (16, 8, …); `store_outbound_inventory_jobs.status='done'` per child | ☐ |
| 5 | **Parent never syncs** | Inspect jobs after allocation | Jobs exist **only** for allocated child SKUs — none for the parent; the parent has no `store_variant_id` and no job. Run the SQL below | ☐ |
| 6 | **Live summary colors** | In Allocate, enter quantities up to and past the pool | Green while valid → amber near-exhausted (≤10% left) → red when over; Save disabled on red | ☐ |
| 7 | **Over-allocation blocked** | Enter units summing > pool grams, force Save | Error: *"Total allocated inventory exceeds available Parent SKU inventory."*; **no** child credited, pool unchanged | ☐ |
| 8 | **Idempotent save** | Double-click Save / retry the request | Exactly one `allocations` row; pool debited once; second call returns `replayed = true` | ☐ |
| 9 | **Cross-client** | Allocate to children at 2+ client sites in one save | Each client's store updates its own SKU; each child's job targets its own `site_id`/store | ☐ |
| 10 | **Graceful non-sync** | Include a child with no `store_variant_id`, and one at a store with `sync_inventory_outbound=false` | Completion shows **No store mapping** / **Store sync off** (badges), not an error; allocation still saves | ☐ |
| 11 | **History & audit** | Open Allocation history → the allocation | Shows employee, timestamp, per-child lines; matches what was entered | ☐ |
| 12 | **Forward sync + backfill** | Re-sync the staging store; run Group weights on any leftovers | New imports land as weight children under one strain parent; backfill consolidates `"Strain - Xg"` splits; intake now lists the strain's weights | ☐ |

---

## Cross-cutting DB assertions (run after a few allocations)

```sql
-- (5) No outbound job ever references a parent — jobs are per child SKU only,
--     and only for children that carry a weight + store mapping.
select j.child_sku_id, c.variant_label, j.site_id, j.desired_available, j.status
  from store_outbound_inventory_jobs j
  join child_skus c on c.id = j.child_sku_id
 where c.product_id = '<PARENT>'
 order by j.updated_at desc;

-- (4) desired_available equals the child's live available (on_hand - reserved).
select c.variant_label,
       il.on_hand - il.reserved as live_available,
       j.desired_available
  from store_outbound_inventory_jobs j
  join child_skus c        on c.id = j.child_sku_id
  join inventory_levels il on il.child_sku_id = c.id
 where c.product_id = '<PARENT>' and j.status = 'done';

-- (3) Conservation: intake grams = remaining pool + total allocated.
select pi.on_hand_grams as remaining,
       coalesce(sum(a.total_grams),0) as allocated,
       pi.on_hand_grams + coalesce(sum(a.total_grams),0) as should_equal_total_intake
  from parent_inventory pi
  left join allocations a on a.product_id = pi.product_id and a.site_id = pi.site_id
 where pi.product_id = '<PARENT>' and pi.site_id = '<SITE>'
 group by pi.on_hand_grams;

-- Any stuck pushes? (should be empty)
select * from store_outbound_inventory_jobs where status = 'failed';
```

---

## One-store-at-a-time rollout

1. Enable `sync_inventory_outbound` for **store A** only; run scenarios 1–12 against a strain sold in store A.
2. When A is signed off, enable **store B**, and verify a cross-client allocation (scenario 9) pushes A and B independently.
3. Repeat per store. Leave `sync_inventory_outbound = false` on any store not yet verified — its children park as **Store sync off** (never lost, never wrongly pushed).

---

## Go / No-Go

**Go** when all 12 boxes pass on ≥1 store, scenario 5 (parent-never-syncs) and 7 (over-allocation) hold, and `store_outbound_inventory_jobs` has no `failed` rows after a full run.

**No-Go / rollback:** each feature migration is reversible. To back out cleanly, apply the down migrations in reverse: `0031 → 0030 → 0029 → 0028` (`supabase/rollback/*.down.sql`). Because the store push **sets an absolute available** (never a delta), re-runs and retries can't corrupt store stock, so a mid-run abort is safe.

---

## Notes / known follow-ups

- **Collisions in backfill** (a `28g` and a `1oz` at one site) are intentionally *skipped and reported*, not merged — resolve those manually before relying on that weight.
- **Frontend is not gated in CI** — run `npx tsc --noEmit` before pushing (the `lint` script is misconfigured; see project notes). Consider adding a `tsc`/`next build` step to `ci.yml`.
