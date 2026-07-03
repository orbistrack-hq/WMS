-- Rollback for migration 0030: per-storefront fulfillment cost report.
-- Reporting-only change; dropping the views is fully reversible and touches no data.
begin;

drop view if exists public.storefront_monthly_billing;
drop view if exists public.storefront_fulfillment_cost;

commit;
