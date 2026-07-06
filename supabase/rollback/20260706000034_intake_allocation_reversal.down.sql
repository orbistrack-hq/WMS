-- WMS — Migration 0034 (intake_allocation_reversal): DOWN
begin;
drop function if exists public.reverse_allocation(uuid);
drop function if exists public.reverse_intake(uuid);
alter table public.parent_inventory_ledger drop column if exists reversed_by;
alter table public.parent_inventory_ledger drop column if exists reversed_at;
alter table public.allocations drop column if exists reversed_by;
alter table public.allocations drop column if exists reversed_at;
commit;
