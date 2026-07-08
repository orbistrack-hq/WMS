-- ============================================================================
-- Rollback 0046: remove the weight→packaging map + per-order defaults.
-- Drops the two config tables, deletes the canonical FB-6 packaging types
-- (including the Mylar bags), and restores the original packaging_types.kind
-- list (without 'mylar_bag'). Deleting the FB-6 types assumes they aren't in
-- packing history (as on a clean feature rollback).
-- ============================================================================

begin;

drop table if exists public.packaging_order_default;
drop table if exists public.packaging_weight_rule;

delete from public.packaging_types where id in (
  'fb600000-0000-0000-0000-0000000000b1',
  'fb600000-0000-0000-0000-0000000000e1',
  'fb600000-0000-0000-0000-0000000000a1',
  'fb600000-0000-0000-0000-0000000000a2',
  'fb600000-0000-0000-0000-0000000000f1',
  'fb600000-0000-0000-0000-0000000000c1',
  'fb600000-0000-0000-0000-0000000000c2');

alter table public.packaging_types drop constraint packaging_types_kind_check;
alter table public.packaging_types add constraint packaging_types_kind_check
  check (kind in
    ('box','shipping_label','jar','jar_label','vacuum_bag','custom'));

commit;
