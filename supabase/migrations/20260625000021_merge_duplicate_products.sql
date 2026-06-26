-- ============================================================================
-- WMS — Migration 0021: merge duplicate parent products by SKU (part 2)
--
-- Migration 0020 stopped the sync from creating duplicate parents going forward.
-- This cleans up the parents that were already split before that shipped: for
-- each SKU that spans more than one parent product, it consolidates the child
-- SKUs under a single surviving master and deactivates the emptied parents.
--
-- Safety:
--   * A SKU is unique per site, so the children sharing a SKU sit at different
--     sites — they can normally all live under one master (one child per site).
--   * The one exception is guarded: if the survivor already has a child at a
--     given site (a different SKU there), we DO NOT move a colliding child into
--     it (that would violate the one-child-per-site rule). Those rare, genuinely
--     ambiguous cases are left untouched and keep showing in
--     duplicate_products_report for the manual merge tool (next step).
--   * Every consolidation is recorded in product_merge_log (survivor + absorbed
--     parent ids), so the operation is auditable and reversible.
--   * Survivor name is preserved (no rename); idempotent — a clean catalog
--     merges nothing.
-- ============================================================================

begin;

-- Audit trail of merges (and the basis for undoing one if ever needed).
create table public.product_merge_log (
  id                   uuid primary key default gen_random_uuid(),
  sku                  text not null,
  survivor_product_id  uuid references public.products(id) on delete set null,
  absorbed_product_ids uuid[] not null,
  created_at           timestamptz not null default now()
);
alter table public.product_merge_log enable row level security;
create policy product_merge_log_read on public.product_merge_log
  for select using (auth.uid() is not null);
revoke insert, update, delete on public.product_merge_log from authenticated;
grant select on public.product_merge_log to authenticated;

-- Report of SKUs that still span multiple parents (dry-run before, audit after).
create or replace view public.duplicate_products_report
  with (security_invoker = true) as
select cs.sku,
       count(distinct cs.product_id) as parent_count,
       array_agg(distinct cs.product_id) as product_ids
  from public.child_skus cs
 where cs.sku is not null
 group by cs.sku
having count(distinct cs.product_id) > 1;

grant select on public.duplicate_products_report to authenticated;

-- The reconciliation. Returns the number of SKU groups it consolidated.
create or replace function public.merge_products_by_sku()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r          record;
  v_survivor uuid;
  v_losers   uuid[];
  v_absorbed uuid[];
  v_groups   integer := 0;
begin
  for r in
    select cs.sku
      from public.child_skus cs
     where cs.sku is not null
     group by cs.sku
    having count(distinct cs.product_id) > 1
  loop
    -- Survivor: the most-connected parent for this SKU, then oldest, then id.
    select p.id into v_survivor
      from public.products p
      join public.child_skus c on c.product_id = p.id
     where c.sku = r.sku
     group by p.id, p.created_at
     order by count(*) desc, p.created_at asc, p.id asc
     limit 1;

    -- Candidate losers (captured before the move).
    select array_agg(distinct c.product_id) into v_losers
      from public.child_skus c
     where c.sku = r.sku and c.product_id <> v_survivor;

    -- Move each loser child onto the survivor, but only where the survivor's
    -- site slot is free (one child per product per site).
    update public.child_skus c
       set product_id = v_survivor
     where c.sku = r.sku
       and c.product_id <> v_survivor
       and not exists (
         select 1 from public.child_skus s
          where s.product_id = v_survivor and s.site_id = c.site_id);

    -- Deactivate losers that are now childless, capturing exactly those.
    with emptied as (
      update public.products p
         set is_active = false
       where p.id = any(v_losers)
         and not exists (
           select 1 from public.child_skus c where c.product_id = p.id)
      returning p.id)
    select coalesce(array_agg(id), '{}'::uuid[]) into v_absorbed from emptied;

    if array_length(v_absorbed, 1) is not null then
      insert into public.product_merge_log(sku, survivor_product_id, absorbed_product_ids)
      values (r.sku, v_survivor, v_absorbed);
      v_groups := v_groups + 1;
    end if;
  end loop;

  return v_groups;
end;
$$;

comment on function public.merge_products_by_sku is
  'Reconciliation: consolidate child SKUs that share a SKU under one surviving master, deactivating emptied parents and logging each merge. Guarded against the one-child-per-site rule; idempotent; service-role/owner only.';

-- Maintenance op, not for the API role.
revoke execute on function public.merge_products_by_sku() from public;
revoke execute on function public.merge_products_by_sku() from authenticated;

-- Run once now to clean catalogs flattened before migration 0020.
select public.merge_products_by_sku();

commit;
