-- ============================================================================
-- WMS — Migration 0040: editable weight→packaging rule (FB-3)
--
-- Packing auto-seeds packaging from a single weight threshold: a unit at or
-- below `jar_max_grams` goes in a jar (+ one jar label); anything heavier goes
-- in one Mylar bag; every group still gets 1 box + 1 label. Until now that
-- threshold (3.5g) lived only in application code. This makes it an
-- admin-editable setting so operations can change it without a deploy — while it
-- stays a SEED that the packer can always override at pack time.
--
-- Model: a singleton config table. A uuid PK keeps the shared audit_row()
-- trigger happy (it casts record_id to uuid); a UNIQUE, always-true `singleton`
-- column pins the table to exactly one row. Everyone signed in may READ the
-- threshold (the packing/wave screens need it); only an ADMIN may change it.
-- set_updated_at + audit_row (both from 0001) stamp and log every change, per
-- the project's audit NFR.
--
-- Reverse with rollback/20260707000040_packaging_rule.down.sql.
-- ============================================================================

begin;

create table public.packaging_rule (
  id            uuid primary key default gen_random_uuid(),
  -- Singleton guard: UNIQUE on an always-true column allows exactly one row.
  singleton     boolean not null default true unique check (singleton),
  jar_max_grams numeric(8,2) not null default 3.5 check (jar_max_grams > 0),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles(id)
);

-- Seed the single row at the current in-code default (3.5g).
insert into public.packaging_rule default values;

alter table public.packaging_rule enable row level security;

-- Read: any signed-in user (packing/wave screens read the threshold).
create policy packaging_rule_read on public.packaging_rule for select
  using (auth.uid() is not null);
-- Write: admins only.
create policy packaging_rule_admin on public.packaging_rule for all
  using (public.is_admin()) with check (public.is_admin());

grant select on public.packaging_rule to authenticated;
-- Column-level: the API role may only touch the threshold + who changed it;
-- updated_at is set by the trigger, id/singleton are immutable.
grant update (jar_max_grams, updated_by) on public.packaging_rule to authenticated;

-- Stamp updated_at + write an audit_log row on every change (shared 0001 fns).
create trigger t_packaging_rule_updated before update on public.packaging_rule
  for each row execute function public.set_updated_at();
create trigger a_packaging_rule after insert or update or delete on public.packaging_rule
  for each row execute function public.audit_row();

comment on table public.packaging_rule is
  'Singleton config for weight-based packaging auto-seed (FB-3): jar_max_grams is the at-or-below threshold for a jar; heavier units get a bag. Admin-editable; read by the packing/wave screens. A seed, not a lock — packers override per order.';

commit;
