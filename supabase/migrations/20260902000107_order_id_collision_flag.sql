-- ============================================================================
-- WMS — Migration 0107: store order-id collision flag
--
-- WHY. budclub's WooCommerce order-id counter was reset (a database restore
-- during a domain migration, by all appearances) and started reusing numbers
-- WMS had already imported days earlier as unrelated orders. importWooOrder's
-- idempotency key is (channel, source, external_order_id) — a genuinely
-- different order that happens to reuse an old number looks identical to a
-- re-delivered webhook for the order WMS already has. Two failure modes
-- followed from that: the new order silently never reaches WMS (treated as a
-- plain duplicate), and applyWooLifecycleUpdate could go on to fulfill/cancel
-- the OLD, unrelated order based on the NEW order's status.
--
-- WHAT. A dedicated table, written by applyWooLifecycleUpdate the moment it
-- notices the incoming order's date_created doesn't match the WMS order it
-- was about to touch: it records the mismatch and returns without mutating
-- anything, instead of guessing. Ops resolves each row by hand once the real
-- order is created (or the id collision is confirmed harmless).
-- ============================================================================

begin;

create table public.store_order_import_collisions (
  id                     uuid primary key default gen_random_uuid(),
  channel                text not null,
  source                 text not null,
  external_order_id      text not null,
  site_id                uuid not null references public.sites(id) on delete cascade,
  existing_wms_order_id  uuid not null references public.orders(id) on delete cascade,
  existing_entered_at    timestamptz,
  incoming_created_at    timestamptz,
  incoming_payload       jsonb not null,
  note                   text not null,
  detected_at            timestamptz not null default now(),
  resolved_at            timestamptz,
  resolved_note          text
);

create index store_order_import_collisions_open_idx
  on public.store_order_import_collisions (site_id)
  where resolved_at is null;

comment on table public.store_order_import_collisions is
  'A store re-used an external_order_id WMS already has on file for a different order (e.g. a WooCommerce post-ID reset after a DB restore). applyWooLifecycleUpdate detected the date mismatch and skipped mutating the existing WMS order rather than guessing. Needs a human to reconcile.';
comment on column public.store_order_import_collisions.existing_wms_order_id is
  'The WMS order the incoming webhook would have mutated, left untouched.';
comment on column public.store_order_import_collisions.resolved_at is
  'Stamped when ops has reconciled this row (e.g. manually created the real order). Null = needs attention.';

alter table public.store_order_import_collisions enable row level security;

create policy store_order_import_collisions_read on public.store_order_import_collisions
  for select using (public.can_access_site(site_id));

-- Ops resolves a row (stamps resolved_at/resolved_note) from the app; nothing
-- else about a collision row is meant to change after the fact.
create policy store_order_import_collisions_resolve on public.store_order_import_collisions
  for update using (public.can_access_site(site_id))
  with check (public.can_access_site(site_id));

commit;
