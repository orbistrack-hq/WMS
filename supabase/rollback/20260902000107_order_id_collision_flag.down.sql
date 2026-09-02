-- Rollback for migration 0107. Drops the order-id collision flag table.

begin;

drop table if exists public.store_order_import_collisions;

commit;
