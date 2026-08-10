-- ============================================================================
-- WMS — Migration 0090: pick-fee schedule becomes an editable setting
--
-- WHY. The pick-fee rate ($1.25 first unit / $0.25 additional) has lived only
-- in the 0001 seed since day one. Changing it meant running SQL by hand. This
-- migration makes `fee_schedules` a first-class, admin/manager-editable config
-- table backing a Settings screen — WITHOUT letting an edit rewrite history.
--
-- THE ONE INVARIANT. Pick fees are effective-dated and SNAPSHOTTED: at
-- fulfillment, charge_order_pick_fee() copies the resolved amount, unit rate,
-- and fee_schedule_id onto the billing_charges row. A rate change is therefore
-- forward-only *as long as rate changes are appends, not edits in place*. If a
-- Settings screen were allowed to UPDATE the seeded row, every recompute and
-- every reconciliation query would silently re-price already-billed history.
--
-- So the rule this migration enforces at the database, not in the UI:
--   * a rate change INSERTS a new schedule row with a later effective_from
--   * a schedule row that has ever billed an order is FROZEN — no update, no
--     delete, at any privilege level (the trigger is SECURITY DEFINER and fires
--     for service-role writes too, which RLS does not)
--   * a scheduled-but-not-yet-used row stays editable, so a rate queued for the
--     1st of next month can still be corrected or cancelled
--
-- Analytics impact: none for closed periods. resolve_fee_schedule() picks by
-- the order's fulfilment date, so backfilling an old uncharged order still
-- prices it at the rate that was in force when it shipped.
--
-- Authorization: admin + manager, matching the standing rule that a manager is
-- an admin for everything except integrations.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Who may manage rates. Mirrors can_manage_categories() so the UI can gate
--    its editing affordances with rpc('can_manage_fee_schedules').
-- ----------------------------------------------------------------------------
create or replace function public.can_manage_fee_schedules()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.app_role() in ('admin', 'manager'), false);
$$;

comment on function public.can_manage_fee_schedules() is
  'True for admins and managers: the roles allowed to publish a new pick-fee schedule.';

-- ----------------------------------------------------------------------------
-- 2. Provenance + integrity on the table itself
-- ----------------------------------------------------------------------------
alter table public.fee_schedules
  add column if not exists note       text,
  add column if not exists created_by uuid references public.profiles(id);

comment on column public.fee_schedules.note is
  'Free-text reason for the rate change, shown in the Settings history.';
comment on column public.fee_schedules.created_by is
  'Who published this rate. Null for the 0001 seed.';

-- Rates are money and must never be negative.
alter table public.fee_schedules
  drop constraint if exists fee_schedules_rates_nonneg;
alter table public.fee_schedules
  add constraint fee_schedules_rates_nonneg
  check (first_unit_rate >= 0 and additional_unit_rate >= 0);

-- One rate per client per day. Without this, two rows sharing an effective_from
-- make resolve_fee_schedule()'s "order by effective_from desc limit 1"
-- nondeterministic — the same order could bill differently on two runs.
-- client_id is null today, so coalesce it to a sentinel to keep the index total.
create unique index if not exists fee_schedules_client_date_uniq
  on public.fee_schedules (
    coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid),
    effective_from
  );

-- ----------------------------------------------------------------------------
-- 3. Freeze any schedule that has billed
-- ----------------------------------------------------------------------------
create or replace function public.fee_schedules_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.billing_charges where fee_schedule_id = old.id
  ) then
    raise exception
      'This rate has already billed orders, so it cannot be changed or removed. Publish a new rate with a later effective date instead.';
  end if;

  if tg_op = 'UPDATE' then
    return new;
  end if;
  return old;
end;
$$;

comment on function public.fee_schedules_guard() is
  'Blocks edits/deletes of a fee schedule once any billing_charge references it, so a rate change can never re-price closed history.';

drop trigger if exists fee_schedules_frozen_when_used on public.fee_schedules;
create trigger fee_schedules_frozen_when_used
  before update or delete on public.fee_schedules
  for each row execute function public.fee_schedules_guard();

-- Rate changes are money decisions; record them like every other change.
drop trigger if exists a_fee_schedules on public.fee_schedules;
create trigger a_fee_schedules
  after insert or update or delete on public.fee_schedules
  for each row execute function public.audit_row();

-- ----------------------------------------------------------------------------
-- 4. RLS: open writes from admin-only to admin+manager
--    (fee_schedules_read from 0001 already grants read to all authenticated.)
-- ----------------------------------------------------------------------------
drop policy if exists fee_schedules_admin on public.fee_schedules;

create policy fee_schedules_write on public.fee_schedules
  for all
  using (public.can_manage_fee_schedules())
  with check (public.can_manage_fee_schedules());

commit;
