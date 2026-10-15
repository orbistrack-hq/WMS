-- Rollback for migration 0114: drop the shake_grams column from
-- brand_billing_summary. The output columns change, so drop the function and
-- re-run supabase/migrations/20261013000113_brand_billing_summary_definer.sql
-- right after this (its create or replace restores the 0113 version and grants).
-- Shake rows already tagged with a site stay tagged; that is harmless.

begin;

drop function public.brand_billing_summary(date, date, uuid);
drop index if exists public.parent_inventory_ledger_shake_created_idx;

commit;
