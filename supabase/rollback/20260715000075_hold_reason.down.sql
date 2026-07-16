-- Down: migration 0075 (hold_reason)
begin;
alter table public.orders drop column hold_reason;
commit;
