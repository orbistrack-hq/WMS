-- Rollback for migration 0092 (find_or_create_customer).
--
-- Only drops the function and its supporting index. Customer rows created
-- through it are left alone on purpose: by the time you roll back they are
-- referenced by real orders, and deleting them would orphan those orders'
-- customer_id. They are ordinary customers — nothing marks them as having come
-- from this path.

begin;

drop function if exists public.find_or_create_customer(text, text);

drop index if exists public.customers_lower_name_idx;

commit;

notify pgrst, 'reload schema';
