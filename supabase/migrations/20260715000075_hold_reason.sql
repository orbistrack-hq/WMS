-- ============================================================================
-- WMS — Migration 0075: hold_reason (display label for held orders)
--
-- Woo `pending` and `on-hold` both hold as pending_payment and behave
-- identically (off packing, auto-promote on payment). But the team wants them
-- LABELLED distinctly — "Pending payment" vs "On hold". hold_reason records why
-- the order is held so the UI can pick the label. Display-only: nothing in the
-- hold/promote logic reads it. Null for orders that aren't held.
-- ============================================================================

begin;

alter table public.orders add column hold_reason text
  check (hold_reason is null or hold_reason in ('pending', 'on_hold'));

comment on column public.orders.hold_reason is
  'Why a pending_payment order is held, from the source store: ''pending'' (pending payment / never paid) or ''on_hold'' (Woo on-hold — awaiting bank transfer / manual review). Drives the display label only; the hold behaves identically either way. Null for non-held orders. Distinct from the on_hold boolean (manual pause flag).';

commit;
