-- Rollback for migration 0096. Additive columns; drop them.

begin;

alter table public.orders
  drop column if exists ship_conflict_at,
  drop column if exists ship_conflict_note;

commit;
