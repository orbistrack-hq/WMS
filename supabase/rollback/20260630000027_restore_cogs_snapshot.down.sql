-- ============================================================================
-- WMS — Rollback 0027: revert apply_order_fulfillment to the 0024 body
-- (backorder guard only, without the COGS snapshot). Restores the exact state
-- that migration 0024 left. NOTE: this re-introduces the COGS regression; it
-- exists only for strict reversibility.
-- ============================================================================

begin;

create or replace function public.apply_order_fulfillment(p_order_id uuid)
returns void language plpgsql as $$
declare r record; v_type text; v_back integer;
begin
  select order_type into v_type from public.orders where id = p_order_id;
  if v_type is null then raise exception 'Order % not found', p_order_id; end if;

  select coalesce(sum(backordered_qty), 0) into v_back
    from public.order_line_items where order_id = p_order_id;
  if v_back > 0 then
    raise exception
      'Cannot fulfill order %: % unit(s) still backordered awaiting stock',
      p_order_id, v_back using errcode = 'check_violation';
  end if;

  for r in
    select id, child_sku_id, quantity
      from public.order_line_items where order_id = p_order_id
  loop
    if v_type = 'layaway' then
      perform public.layaway_consume(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    else
      perform public.consume_stock(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    end if;
  end loop;
end;
$$;

commit;
