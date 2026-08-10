-- Rollback for migration 0091 (promo orders).
--
-- Dropping is_promo is lossy: which orders were influencer seeding is not
-- recoverable from anything else. If the flag has been used in anger, prefer
-- leaving the column in place (it defaults to false and is inert) and simply
-- reverting the /reports changes.
--
-- Migration 0092 (find_or_create_customer) is independent — it does not read
-- is_promo — so the two roll back in either order.

begin;

drop function if exists public.set_order_promo(uuid, boolean);

drop index if exists public.orders_is_promo_idx;

alter table public.orders
  drop column if exists is_promo;

commit;

notify pgrst, 'reload schema';
