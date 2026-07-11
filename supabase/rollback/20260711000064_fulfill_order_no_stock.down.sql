-- Rollback 0064: drop the inventory-neutral fulfillment helper. It's a new,
-- standalone function (no prior version to restore).

begin;

drop function if exists public.fulfill_order_no_stock(uuid, timestamptz);

commit;
