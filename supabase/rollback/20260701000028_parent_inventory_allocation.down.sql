-- ============================================================================
-- Rollback for migration 0028 — parent bulk inventory + client allocation.
-- Drops in reverse dependency order and restores the original child_skus
-- uniqueness. Note: relaxing the constraint back to (product_id, site_id) will
-- FAIL if weight variants already exist — that is intentional (you cannot
-- un-model live data silently). Remove the extra variants first if needed.
-- ============================================================================

begin;

drop view if exists public.parent_inventory_report;

-- Primitives.
drop function if exists public._parent_inv_write(uuid,uuid,numeric,numeric,text,text,uuid,text,text);
drop function if exists public._parent_inv_lock(uuid,uuid);
drop function if exists public.to_grams(numeric, text);

-- History + level tables (triggers drop with the tables).
drop table if exists public.allocation_lines;
drop table if exists public.allocations;
drop table if exists public.parent_inventory_ledger;
drop table if exists public.parent_inventory;

-- Restore original child_skus uniqueness (one child per product per site).
drop index if exists public.child_skus_product_site_variant_key;
alter table public.child_skus
  add constraint child_skus_product_id_site_id_key unique (product_id, site_id);

alter table public.child_skus
  drop column if exists variant_label,
  drop column if exists grams_per_unit;

commit;
