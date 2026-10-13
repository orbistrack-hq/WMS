-- Rollback for migration 0111. Drops the bounded billing function and its
-- index. The storefront_fulfillment_cost view was never changed, so the
-- billing page must be reverted to read the view in the same deploy.

begin;

drop function if exists public.storefront_fulfillment_cost_for_period(date, date, uuid);
drop index if exists public.fulfillment_groups_billing_ts_idx;

commit;
