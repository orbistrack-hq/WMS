-- ============================================================================
-- Rollback 0061 — restore receive_stock WITHOUT backorder promotion.
--
-- Reinstates the 0002 body (with the 0003 SECURITY DEFINER + pinned search_path
-- attributes, which is the live state before 0061). NOTE: this reintroduces the
-- bug 0061 fixed — receiving or allocating stock will no longer auto-promote
-- waiting backorders, so orders can stay stuck at "still backordered awaiting
-- stock" even with stock on the shelf. Reverse only if you must.
-- ============================================================================

begin;

create or replace function public.receive_stock(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'receipt', p_ref_id uuid default null, p_note text default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
begin
  if p_qty <= 0 then raise exception 'receive qty must be positive (got %)', p_qty; end if;
  perform public._inv_lock(p_child_sku_id);
  return public._inv_write(
    p_child_sku_id, p_qty, 0, 0, 'receipt', p_ref_type, p_ref_id, p_note);
end;
$$;

commit;
