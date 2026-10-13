-- Rollback for migration 0113: put brand_billing_summary back to security
-- invoker (0112 behaviour — correct, but per-row RLS makes it slow under the
-- app role). The body is unchanged apart from the access filter, so switching
-- the security mode and dropping the allowed-sites filter is a re-apply of 0112:
-- run supabase/migrations/20261013000112_brand_billing_summary.sql again
-- (its create or replace restores the invoker version and grants).

begin;

alter function public.brand_billing_summary(date, date, uuid) security invoker;

commit;
