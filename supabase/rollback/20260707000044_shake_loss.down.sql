-- ============================================================================
-- Rollback 0044: remove the "Shake" loss feature.
--
-- Drops shake_report, record_shake / reverse_shake, the shake idempotency index,
-- and restores the parent_inventory_ledger reason list to the post-0042 set
-- (without 'shake'). Assumes no rows are reason='shake' (clean feature rollback).
-- ============================================================================

begin;

drop view     if exists public.shake_report;
drop function if exists public.reverse_shake(uuid);
drop function if exists public.record_shake(uuid,numeric,uuid,uuid,text,text);
drop index    if exists public.parent_inventory_ledger_shake_ref_idx;

alter table public.parent_inventory_ledger drop constraint parent_inventory_ledger_reason_check;
alter table public.parent_inventory_ledger add constraint parent_inventory_ledger_reason_check
  check (reason in ('intake','allocation','transfer','correction'));

commit;
