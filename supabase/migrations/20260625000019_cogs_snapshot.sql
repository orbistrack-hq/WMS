-- ============================================================================
-- WMS — Migration 0019: product cost snapshot + COGS report
--
-- Until now the only product cost was child_skus.cost — the *current* cost,
-- which gets overwritten by manual edits and Shopify cost seeding. Nothing
-- recorded what a unit cost at the moment it sold, so COGS / gross margin per
-- sale couldn't be computed. (Packaging and shipping costs were already
-- snapshotted; this closes the product-cost gap.)
--
-- Decision: snapshot at FULFILLMENT (the sale moment), not at order creation.
-- For post-dated / layaway orders the entered date and the sale/fulfillment date
-- differ, and COGS should land on the fulfillment cost. apply_order_fulfillment
-- freezes each line's cost once; later cost edits never rewrite history.
--
-- cogs_report is order-grain product COGS + gross profit. Packaging and shipping
-- costs live at the fulfillment-group grain (their own reports) and are left out
-- here to avoid mis-allocating shared box/label/shipping across combined orders;
-- full landed margin can be layered on later at the group grain.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Per-line cost snapshot, frozen at fulfillment. Nullable: null until the
--    order is fulfilled (and for orders that never reach fulfillment).
-- ----------------------------------------------------------------------------
alter table public.order_line_items
  add column if not exists unit_cost_snapshot numeric(12,2);

comment on column public.order_line_items.unit_cost_snapshot is
  'Product unit cost frozen at fulfillment (COGS basis). Null until fulfilled; never rewritten by later cost changes.';

-- ----------------------------------------------------------------------------
-- 2. Snapshot the cost as part of fulfillment. Set-based, runs once per line
--    (only where the snapshot is still null), then the existing consume loop.
-- ----------------------------------------------------------------------------
create or replace function public.apply_order_fulfillment(p_order_id uuid)
returns void language plpgsql as $$
declare r record; v_type text;
begin
  select order_type into v_type from public.orders where id = p_order_id;
  if v_type is null then raise exception 'Order % not found', p_order_id; end if;

  -- COGS basis: freeze each line's current product cost at the sale moment.
  update public.order_line_items li
     set unit_cost_snapshot = cs.cost
    from public.child_skus cs
   where li.order_id = p_order_id
     and cs.id = li.child_sku_id
     and li.unit_cost_snapshot is null;

  for r in select id, child_sku_id, quantity from public.order_line_items where order_id = p_order_id loop
    if v_type = 'layaway' then
      perform public.layaway_consume(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    else
      perform public.consume_stock(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    end if;
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. COGS / gross-profit report, order grain, fulfilled orders only.
--    security_invoker so it inherits each caller's RLS (operator: all sites;
--    client: their sites), like the other reporting views.
-- ----------------------------------------------------------------------------
create or replace view public.cogs_report with (security_invoker = true) as
select o.id            as order_id,
       o.order_number,
       o.entered_at,
       o.sale_date,
       o.fulfilled_at,
       o.site_id,
       s.name          as site_name,
       o.channel,
       o.status,
       sum(li.quantity * li.unit_price)                          as revenue,
       sum(li.discount)                                          as discount,
       sum(li.quantity * coalesce(li.unit_cost_snapshot, 0))     as product_cogs,
       sum(li.quantity * li.unit_price)
         - sum(li.discount)
         - sum(li.quantity * coalesce(li.unit_cost_snapshot, 0)) as gross_profit
from public.orders o
join public.sites s             on s.id = o.site_id
join public.order_line_items li on li.order_id = o.id
where o.status = 'fulfilled'
group by o.id, o.order_number, o.entered_at, o.sale_date, o.fulfilled_at,
         o.site_id, s.name, o.channel, o.status;

comment on view public.cogs_report is
  'Order-grain product COGS and gross profit for fulfilled orders. revenue = qty*unit_price; gross_profit = revenue - discount - product COGS (product margin, before packaging/shipping). Tax excluded (pass-through). Packaging/shipping are reported separately at the group grain.';

grant select on public.cogs_report to authenticated;

commit;
