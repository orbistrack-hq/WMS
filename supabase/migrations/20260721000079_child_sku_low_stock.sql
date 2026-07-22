-- ============================================================================
-- WMS — Migration 0079: child-SKU low-stock alerts
--
-- Adds a low-stock signal for child SKUs, mirroring the packaging low-stock
-- model (migration 0047). A red portal-wide banner shows the ops team when any
-- active, inventory-tracked child SKU is at/below its low-stock threshold, and
-- links to the inventory list filtered to just those SKUs.
--
-- Threshold resolution (per J's decisions):
--   * Basis is ON-HAND (physical count), not available.
--   * A per-child override lives on child_skus.low_stock_threshold (per site,
--     since a child SKU already is one product at one site). NULL = fall back to
--     the app-wide default.
--   * The app-wide default (initially 5) lives in a new app_settings key/value
--     table so it is editable without a migration.
--   * A threshold of 0 SILENCES the alert for that SKU (never flagged low). This
--     is the clean-up path for the many dead / discontinued zero-stock SKUs:
--     bulk-set their threshold to 0 to drop them out of the alert.
--
--   effective threshold = coalesce(child.low_stock_threshold, low_stock_default())
--   is_low = is_active AND track_inventory AND effective >= 1 AND on_hand <= effective
--
-- Writes are gated to the internal ops team (is_operator() = admin/operator/
-- manager) via SECURITY DEFINER RPCs; reads are open to any signed-in user
-- (single tenant per deployment), same as packaging.
--
-- Reverse with rollback/20260721000079_child_sku_low_stock.down.sql.
-- ============================================================================

begin;

-- ---- 1. app_settings: app-wide key/value config (first use: low-stock default)
create table if not exists public.app_settings (
  key        text primary key,
  int_value  integer,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table public.app_settings enable row level security;

create policy app_settings_read on public.app_settings
  for select using (auth.uid() is not null);

grant select on public.app_settings to authenticated;

insert into public.app_settings (key, int_value)
values ('low_stock_default', 5)
on conflict (key) do nothing;

-- ---- 2. Per-child override column (NULL = use the app-wide default) ----------
alter table public.child_skus
  add column if not exists low_stock_threshold integer;

alter table public.child_skus
  drop constraint if exists child_skus_low_stock_threshold_check;
alter table public.child_skus
  add constraint child_skus_low_stock_threshold_check
  check (low_stock_threshold is null or low_stock_threshold >= 0);

comment on column public.child_skus.low_stock_threshold is
  'Per-child low-stock alert threshold on ON-HAND (on_hand <= this flags low). NULL = use the app-wide low_stock_default. 0 = alert silenced for this SKU.';

-- ---- 3. Effective default reader --------------------------------------------
create or replace function public.low_stock_default()
returns integer language sql stable set search_path = '' as $$
  select coalesce(
    (select int_value from public.app_settings where key = 'low_stock_default'),
    5);
$$;

grant execute on function public.low_stock_default() to authenticated;

-- ---- 4. Writer: set the app-wide default (ops only) -------------------------
create or replace function public.set_low_stock_default(p_value integer)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_operator() then
    raise exception 'set_low_stock_default: not authorized' using errcode = '42501';
  end if;
  if p_value is null or p_value < 0 then
    raise exception 'set_low_stock_default: value must be zero or more';
  end if;
  insert into public.app_settings (key, int_value, updated_at, updated_by)
  values ('low_stock_default', p_value, now(), auth.uid())
  on conflict (key) do update
    set int_value  = excluded.int_value,
        updated_at = now(),
        updated_by = auth.uid();
  return p_value;
end;
$$;

revoke execute on function public.set_low_stock_default(integer) from public;
grant  execute on function public.set_low_stock_default(integer) to authenticated;

-- ---- 5. Writer: set per-child threshold(s), array in for bulk edits (ops only)
create or replace function public.set_child_low_stock_threshold(
  p_child_ids uuid[], p_point integer
) returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if not public.is_operator() then
    raise exception 'set_child_low_stock_threshold: not authorized' using errcode = '42501';
  end if;
  if p_point is not null and p_point < 0 then
    raise exception 'set_child_low_stock_threshold: threshold cannot be negative';
  end if;
  if p_child_ids is null or array_length(p_child_ids, 1) is null then
    raise exception 'set_child_low_stock_threshold: at least one child SKU is required';
  end if;
  update public.child_skus
     set low_stock_threshold = p_point, updated_at = now()
   where id = any(p_child_ids);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.set_child_low_stock_threshold(uuid[],integer) from public;
grant  execute on function public.set_child_low_stock_threshold(uuid[],integer) to authenticated;

-- ---- 6. Recreate inventory_report with low-stock fields (appended) -----------
-- create-or-replace keeps the existing leading columns in place (no dependents
-- break) and appends the low-stock columns at the end.
create or replace view public.inventory_report with (security_invoker = true) as
select cs.id            as child_sku_id,
       cs.site_id,
       s.name           as site_name,
       p.name           as product_name,
       cs.sku,
       il.on_hand,
       il.available,
       il.reserved,
       il.layby,
       cs.cost,
       (il.on_hand * cs.cost) as value_at_cost,
       cs.product_id,
       cs.grams_per_unit,
       cs.variant_label,
       cs.price,
       cs.bin_location,
       -- 0079: low-stock fields (appended)
       cs.is_active,
       cs.track_inventory,
       cs.low_stock_threshold,
       coalesce(cs.low_stock_threshold, public.low_stock_default())
         as effective_low_stock_threshold,
       (cs.is_active
        and cs.track_inventory
        and coalesce(cs.low_stock_threshold, public.low_stock_default()) >= 1
        and il.on_hand <= coalesce(cs.low_stock_threshold, public.low_stock_default()))
         as is_low
from public.child_skus cs
join public.sites s             on s.id  = cs.site_id
join public.products p          on p.id  = cs.product_id
join public.inventory_levels il on il.child_sku_id = cs.id;

comment on view public.inventory_report is
  'Per child-SKU stock with parent/weight/display fields and 0079 low-stock flags (on_hand basis, effective threshold = per-child override or app-wide default; 0 silences). Reads open to any signed-in user.';

grant select on public.inventory_report to authenticated;

commit;
