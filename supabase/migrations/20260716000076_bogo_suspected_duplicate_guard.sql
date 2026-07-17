-- ============================================================================
-- WMS — Migration 0076: BOGO suspected-duplicate guard (INTERIM)
--
-- Background. We are moving to a shared-stock model where a BOGO "free" child
-- SKU delegates its stock to the paid counterpart (see BOGO-SHARED-STOCK-SPEC).
-- That feature is not built yet. In the meantime, BOGO / give-away SKUs are
-- already leaking in — both as dash-mangled twins of a real SKU (managers drop
-- a dash to dodge the per-site unique-SKU index) and as store-order lines that
-- are free to the customer but still cost us.
--
-- If such a SKU lands unnoticed it gets its own inventory pool and (on outbound
-- sync) its own published stock number, which drifts the count. This migration
-- does NOT change any stock / reserve / publish behaviour. It only *flags* the
-- suspects so they cannot hide, on both manual entry and store sync, and
-- surfaces them for review. Superseded by delegates_to_child_sku_id when the
-- shared-stock feature ships.
--
-- Two independent fingerprints, either of which flags a child SKU:
--   1. Normalized-SKU collision — another coded child at the SAME site whose SKU
--      matches after stripping punctuation and case (catches the mangled twins).
--   2. Give-away fingerprint — a stock-tracked child with price = 0 and cost > 0
--      (free to the customer, still costs us; the defining BOGO trait). Service /
--      fee SKUs (track_inventory = false) are excluded so Shipping-Protection-
--      style lines are not mistaken for BOGO.
--
-- Reverse with rollback/20260716000076_bogo_suspected_duplicate_guard.down.sql.
-- ============================================================================

begin;

-- ---- 1. Flag column --------------------------------------------------------
alter table public.child_skus
  add column if not exists suspected_duplicate boolean not null default false;

comment on column public.child_skus.suspected_duplicate is
  'Interim BOGO guard: true when this SKU looks like a give-away/duplicate twin — '
  'either its normalized code (punctuation/case stripped) collides with another '
  'coded SKU at the same site, or it is stock-tracked with price = 0 and cost > 0 '
  '(the BOGO fingerprint: free to the customer but it still costs us). Review-only '
  'signal; does NOT alter stock/reserve/publish behaviour. Superseded by '
  'delegates_to_child_sku_id once shared-stock ships.';

-- ---- 2. SKU normalizer -----------------------------------------------------
create or replace function public._sku_norm(p_sku text)
returns text language sql immutable
set search_path = '' as $$
  select upper(regexp_replace(coalesce(p_sku, ''), '[^a-z0-9]', '', 'gi'));
$$;

-- ---- 3. Row-level detection predicate --------------------------------------
-- SECURITY DEFINER so the collision check sees siblings across RLS scopes;
-- detection must be complete regardless of who is inserting.
create or replace function public._is_suspected_duplicate(
  p_id uuid, p_site_id uuid, p_sku text, p_price numeric, p_cost numeric,
  p_track_inventory boolean
) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_norm text := public._sku_norm(p_sku);
begin
  -- Fingerprint 2: give-away — free to the customer but it costs us.
  if coalesce(p_track_inventory, true)
     and coalesce(p_price, 0) = 0
     and coalesce(p_cost, 0) > 0 then
    return true;
  end if;
  -- Fingerprint 1: normalized-SKU collision with another coded child, same site.
  if v_norm <> '' and exists (
    select 1 from public.child_skus o
     where o.site_id = p_site_id
       and o.id <> p_id
       and o.sku is not null and o.sku <> ''
       and public._sku_norm(o.sku) = v_norm
  ) then
    return true;
  end if;
  return false;
end;
$$;

-- ---- 4. BEFORE trigger: flag the incoming row -------------------------------
create or replace function public.flag_suspected_duplicate()
returns trigger language plpgsql
security definer set search_path = '' as $$
begin
  new.suspected_duplicate := public._is_suspected_duplicate(
    new.id, new.site_id, new.sku, new.price, new.cost, new.track_inventory);
  return new;
end;
$$;

drop trigger if exists t_childskus_flag_dup on public.child_skus;
create trigger t_childskus_flag_dup
  before insert or update of sku, price, cost, site_id, track_inventory
  on public.child_skus
  for each row execute function public.flag_suspected_duplicate();

-- ---- 5. AFTER trigger: also flag the pre-existing counterpart ---------------
-- A mangled twin arriving should light up BOTH members of the cluster. This
-- fires only on sku/price/cost/site changes, so the sibling's suspected_duplicate
-- update below does NOT recurse. Guarded by `= false` to avoid audit churn.
create or replace function public.flag_duplicate_siblings()
returns trigger language plpgsql
security definer set search_path = '' as $$
declare v_norm text := public._sku_norm(new.sku);
begin
  if v_norm <> '' then
    update public.child_skus o
       set suspected_duplicate = true
     where o.site_id = new.site_id
       and o.id <> new.id
       and o.sku is not null and o.sku <> ''
       and public._sku_norm(o.sku) = v_norm
       and o.suspected_duplicate = false;
  end if;
  return null;
end;
$$;

drop trigger if exists t_childskus_flag_siblings on public.child_skus;
create trigger t_childskus_flag_siblings
  after insert or update of sku, price, cost, site_id
  on public.child_skus
  for each row execute function public.flag_duplicate_siblings();

-- ---- 6. Backfill existing rows ---------------------------------------------
update public.child_skus cs
   set suspected_duplicate = true
 where public._is_suspected_duplicate(
         cs.id, cs.site_id, cs.sku, cs.price, cs.cost, cs.track_inventory);

-- ---- 7. Review surface ------------------------------------------------------
create or replace view public.suspected_duplicate_skus
  with (security_invoker = true) as
select cs.id,
       cs.site_id,
       s.name  as site,
       cs.product_id,
       p.name  as product,
       cs.sku,
       public._sku_norm(cs.sku) as sku_norm,
       cs.price,
       cs.cost,
       cs.store_variant_id,
       cs.is_active,
       cs.track_inventory,
       il.on_hand,
       il.reserved,
       il.available,
       (coalesce(cs.track_inventory, true)
        and coalesce(cs.price, 0) = 0
        and coalesce(cs.cost, 0) > 0)                 as bogo_fingerprint,
       cs.created_at
from public.child_skus cs
join public.products p          on p.id  = cs.product_id
join public.sites s             on s.id  = cs.site_id
join public.inventory_levels il on il.child_sku_id = cs.id
where cs.suspected_duplicate
order by s.name, public._sku_norm(cs.sku), cs.created_at;

comment on view public.suspected_duplicate_skus is
  'Review list of child SKUs flagged by the interim BOGO guard (migration 0076): '
  'normalized-SKU twins and give-away (price 0 / cost > 0) lines. Feeds the BOGO '
  'shared-stock cleanup. bogo_fingerprint marks the price-0/cost-positive signal.';

grant select on public.suspected_duplicate_skus to authenticated;

commit;
