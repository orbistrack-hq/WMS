-- ============================================================================
-- Rollback for migration 0081 — restore the 0069 set_child_track_inventory body
-- (plain flag flip, no cleanup on the non-inventory transition).
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
