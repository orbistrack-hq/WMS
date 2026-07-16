-- Down: migration 0074 (store-completion marker)
begin;
alter table public.orders drop column store_completed_at;
commit;
