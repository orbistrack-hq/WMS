-- ============================================================================
-- OrbisTrack WMS — Parent ↔ Child SKU integrity check (pre-presentation)
--
-- READ-ONLY. Every query below returns ONLY problem rows: an empty result means
-- that check passed. Run the whole file in the Supabase SQL editor (or psql)
-- against the database you'll be demoing on, top to bottom, a day before the
-- talk. Anything that comes back non-empty is something to fix or be ready to
-- explain before you present.
--
-- Schema recap (from migrations 0001 / 0028 / 0043 / 0049):
--   products(id, name, sku[parent code, nullable], is_active)
--   child_skus(id, product_id, site_id, sku, store_variant_id, grams_per_unit,
--              price, cost, is_active, unique(product_id, site_id))
--   inventory_levels(child_sku_id PK, on_hand, reserved, layby, available)
--   inventory_ledger(child_sku_id, delta_on_hand/reserved/layby, reason, ...)
--   parent_inventory(product_id PK, on_hand_grams, allocated_grams)   [central pool]
--   allocations / allocation_lines                                    [parent→child grams]
-- ============================================================================


-- ============================================================================
-- 0. HEADLINE COUNTS — run this first for a one-glance health read.
--    All the "bad" numbers should be 0. Details for any non-zero are below.
-- ============================================================================
select
  (select count(*) from public.products  where is_active) as active_parents,
  (select count(*) from public.child_skus where is_active) as active_children,
  (select count(*) from public.sites      where is_active) as active_sites,
  -- problems:
  (select count(*) from public.products p
     where p.is_active
       and not exists (select 1 from public.child_skus c where c.product_id = p.id))
     as parents_with_no_child,
  (select count(*) from public.products p
     where p.is_active
       and not exists (select 1 from public.child_skus c
                        where c.product_id = p.id and c.is_active))
     as parents_with_no_active_child,
  (select count(*) from public.child_skus c
     where c.is_active and (c.sku is null or btrim(c.sku) = ''))
     as active_children_missing_sku_code,
  (select count(*) from public.child_skus c
     left join public.inventory_levels il on il.child_sku_id = c.id
     where il.child_sku_id is null)
     as children_missing_inventory_row,
  (select count(*) from public.child_skus c
     where c.is_active and c.grams_per_unit is null)
     as active_children_missing_grams_per_unit;


-- ============================================================================
-- 1. ORPHAN PARENTS — active product with NO child SKU at any site.
--    Nothing sellable hangs off it. Either add child SKUs or deactivate it so
--    it doesn't show up empty in the catalog / by-parent screen during the demo.
-- ============================================================================
select p.id as product_id, p.name, p.sku as parent_sku
  from public.products p
 where p.is_active
   and not exists (select 1 from public.child_skus c where c.product_id = p.id)
 order by p.name;


-- ============================================================================
-- 2. PARENTS WITH CHILDREN BUT NONE ACTIVE — the product is live but every
--    child SKU under it is deactivated, so it can't actually be ordered.
-- ============================================================================
select p.id as product_id, p.name, p.sku as parent_sku,
       count(c.*) as total_children
  from public.products p
  join public.child_skus c on c.product_id = p.id
 where p.is_active
 group by p.id, p.name, p.sku
having count(*) filter (where c.is_active) = 0
 order by p.name;


-- ============================================================================
-- 3. ACTIVE CHILD UNDER AN INACTIVE PARENT — mismatch: the sellable unit is on
--    but its parent is switched off. Usually a data slip during cleanup.
-- ============================================================================
select c.id as child_sku_id, c.sku, c.site_id,
       p.id as product_id, p.name as parent_name
  from public.child_skus c
  join public.products p on p.id = c.product_id
 where c.is_active and not p.is_active
 order by p.name, c.sku;


-- ============================================================================
-- 4. CHILD SKU MISSING ITS SKU CODE — a child with no sku string can't be
--    scanned, searched cleanly, or mapped to a store variant. (Trigger creates
--    the inventory row, but the code is free-text and can be left blank.)
-- ============================================================================
select c.id as child_sku_id, p.name as parent_name, s.name as site_name,
       c.is_active
  from public.child_skus c
  join public.products p on p.id = c.product_id
  join public.sites    s on s.id = c.site_id
 where c.is_active and (c.sku is null or btrim(c.sku) = '')
 order by p.name, s.name;


-- ============================================================================
-- 5. CHILD SKU WITH NO INVENTORY LEVEL ROW — should be impossible (an insert
--    trigger creates one), so any hit here means a data-load bypassed the app.
--    These SKUs would break the inventory screen and any level math.
-- ============================================================================
select c.id as child_sku_id, c.sku, p.name as parent_name, s.name as site_name
  from public.child_skus c
  join public.products p on p.id = c.product_id
  join public.sites    s on s.id = c.site_id
  left join public.inventory_levels il on il.child_sku_id = c.id
 where il.child_sku_id is null
 order by p.name, c.sku;


-- ============================================================================
-- 6. CHILD SKU WITH NO grams_per_unit — the central parent pool allocates to
--    children BY GRAMS (units × grams_per_unit). A child with NULL grams_per_unit
--    CANNOT receive an allocation ("child SKU has no grams_per_unit"). Flag any
--    active child whose parent has a central pool but the child can't be filled.
-- ============================================================================
select c.id as child_sku_id, c.sku, p.name as parent_name, s.name as site_name,
       pi.on_hand_grams as parent_grams_on_hand
  from public.child_skus c
  join public.products p        on p.id = c.product_id
  join public.sites    s        on s.id = c.site_id
  left join public.parent_inventory pi on pi.product_id = p.id
 where c.is_active
   and c.grams_per_unit is null
 order by (pi.on_hand_grams is not null) desc, p.name, s.name;


-- ============================================================================
-- 7. UNMAPPED STORE VARIANTS (informational, not always a defect) — active
--    child SKUs with no store_variant_id. These will never receive outbound
--    inventory pushes (by design, unmapped SKUs never enqueue). Fine for
--    manual-only SKUs; a problem for any SKU you expect a store to sync.
-- ============================================================================
select c.id as child_sku_id, c.sku, p.name as parent_name, s.name as site_name,
       c.store_variant_id
  from public.child_skus c
  join public.products p on p.id = c.product_id
  join public.sites    s on s.id = c.site_id
 where c.is_active
   and (c.store_variant_id is null or btrim(c.store_variant_id) = '')
 order by p.name, s.name;


-- ============================================================================
-- 8. PARENT HAS BULK ON HAND BUT NO ALLOCATABLE CHILD — central grams are
--    sitting in the pool but there's no active child with grams_per_unit to
--    delegate them to, so the stock is stranded. Worth catching before you show
--    the by-parent inventory numbers.
-- ============================================================================
select pi.product_id, p.name as parent_name,
       pi.on_hand_grams, pi.allocated_grams
  from public.parent_inventory pi
  join public.products p on p.id = pi.product_id
 where pi.on_hand_grams > 0
   and not exists (
     select 1 from public.child_skus c
      where c.product_id = pi.product_id
        and c.is_active
        and c.grams_per_unit is not null)
 order by pi.on_hand_grams desc;


-- ============================================================================
-- 9. PARENT POOL SANITY — negative on-hand grams, or an allocated counter that
--    has drifted below zero. These should never happen; a hit points at a bad
--    manual correction or a reversal edge case.
-- ============================================================================
select pi.product_id, p.name as parent_name,
       pi.on_hand_grams, pi.allocated_grams
  from public.parent_inventory pi
  join public.products p on p.id = pi.product_id
 where pi.on_hand_grams < 0
    or pi.allocated_grams < 0
 order by p.name;


-- ============================================================================
-- 10. LEVEL ↔ LEDGER DRIFT — the core invariant: every inventory_levels number
--     must equal the sum of its ledger deltas. Zero rows = no silent drift.
--     (Same check reconcile_inventory() automates; also in CORE-WORKFLOWS-UAT.)
-- ============================================================================
select cs.sku, il.on_hand, il.reserved, il.layby,
       g.on_hand  as ledger_on_hand,
       g.reserved as ledger_reserved,
       g.layby    as ledger_layby
  from public.inventory_levels il
  join public.child_skus cs on cs.id = il.child_sku_id
  left join (
    select child_sku_id,
           sum(delta_on_hand)  as on_hand,
           sum(delta_reserved) as reserved,
           sum(delta_layby)    as layby
      from public.inventory_ledger
     group by child_sku_id) g on g.child_sku_id = il.child_sku_id
 where il.on_hand  <> coalesce(g.on_hand, 0)
    or il.reserved <> coalesce(g.reserved, 0)
    or il.layby    <> coalesce(g.layby, 0);


-- ============================================================================
-- 11. DUPLICATE-LOOKING PARENTS (informational) — same product name appearing
--     more than once. Names are intentionally NOT unique (a real product can
--     exist per site/channel), but during a demo two identical names are
--     confusing. Use the catalog "Duplicates" screen to merge if unintended.
-- ============================================================================
select lower(btrim(name)) as normalized_name,
       count(*) as copies,
       array_agg(id) as product_ids
  from public.products
 where is_active
 group by lower(btrim(name))
having count(*) > 1
 order by copies desc, normalized_name;


-- ============================================================================
-- 12. STUCK OUTBOUND JOBS (informational) — any failed store-push jobs. Not a
--     SKU-mapping defect per se, but a red "failed" badge on the integrations
--     page mid-demo is avoidable. Empty = clean.
--     (Table exists once outbound sync migrations are applied; ignore if absent.)
-- ============================================================================
select id, child_sku_id, status, desired_available, updated_at
  from public.store_outbound_inventory_jobs
 where status = 'failed'
 order by updated_at desc
 limit 100;
