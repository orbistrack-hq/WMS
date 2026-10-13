-- Rollback for migration 0112. Drops brand_billing_summary and the
-- fulfilled_at index. Revert the billing page to the 0111 version (which
-- reads storefront_fulfillment_cost_for_period directly) in the same deploy.

begin;

drop function if exists public.brand_billing_summary(date, date, uuid);
drop index if exists public.orders_fulfilled_at_idx;

commit;
