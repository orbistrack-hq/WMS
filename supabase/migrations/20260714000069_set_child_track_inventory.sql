-- ============================================================================
-- WMS — Migration 0069: admin/manager toggle for child_skus.track_inventory
--
-- Migration 0068 added the non-inventory flag and drives it from the store-sync
-- name pattern. This adds a manual override so an operator can flag/unflag a SKU
-- by hand (e.g. a fee product the pattern didn't catch, or a false positive).
--
-- Gated to admin||manager (managers are admin-equivalent for everything except
-- integrations — see the manager-role policy). SECURITY DEFINER with a pinned
-- empty search_path so the role gate can't be bypassed via search_path and the
-- write reaches child_skus regardless of the caller's row-level policies; the
-- role gate itself reads the JWT (auth.uid()/app_role()), not the SQL role.
--
-- The change is captured by the generic audit_row() trigger already on
-- child_skus (old/new snapshot + actor), so no explicit audit write is needed.
--
-- Reverse with the matching rollback/…0069….down.sql.
-- ============================================================================

begin;

create or replace function public.set_child_track_inventory(
  p_child_sku_id uuid,
  p_track        boolean
) returns public.child_skus
language plpgsql security definer set search_path = '' as $$
declare v public.child_skus;
begin
  if public.app_role() not in ('admin', 'manager') then
    raise exception 'set_child_track_inventory requires the admin or manager role'
      using errcode = 'insufficient_privilege';
  end if;

  update public.child_skus
     set track_inventory = coalesce(p_track, true),
         updated_at = now()
   where id = p_child_sku_id
   returning * into v;

  if not found then
    raise exception 'child SKU % not found', p_child_sku_id;
  end if;

  return v;
end;
$$;

grant execute on function public.set_child_track_inventory(uuid, boolean) to authenticated;

comment on function public.set_child_track_inventory is
  'Admin/manager-only manual override of child_skus.track_inventory. false = '
  'service/fee SKU that skips all inventory ops (reserve/backorder/consume/'
  'release/receive); true = normal physical inventory. Change is audit-logged '
  'by the child_skus audit trigger.';

commit;
