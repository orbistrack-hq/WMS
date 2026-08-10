-- Reverse of 0090: pick-fee schedule editing.
-- Restores the admin-only write policy and drops the freeze trigger, the
-- provenance columns, and the uniqueness/rate guards.

begin;

drop policy if exists fee_schedules_write on public.fee_schedules;

create policy fee_schedules_admin on public.fee_schedules
  for all
  using (public.is_admin())
  with check (public.is_admin());

drop trigger if exists a_fee_schedules on public.fee_schedules;
drop trigger if exists fee_schedules_frozen_when_used on public.fee_schedules;
drop function if exists public.fee_schedules_guard();

drop index if exists public.fee_schedules_client_date_uniq;

alter table public.fee_schedules
  drop constraint if exists fee_schedules_rates_nonneg;

alter table public.fee_schedules
  drop column if exists created_by,
  drop column if exists note;

drop function if exists public.can_manage_fee_schedules();

commit;
