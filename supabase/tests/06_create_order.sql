-- create_order RPC: atomic group + order + lines + reservation, and its guards.
-- Uses seeded SKU WF-HONEY-MAIN (a0000000-...0001, 200 on hand) at site MAIN,
-- and CL-HONEY-MAIN (a0000000-...0002) at MAIN. WF-HONEY-EAST (...0004) is at EAST.
begin;
select plan(12);
\set SKU '''a0000000-0000-0000-0000-000000000001'''
\set SKU2 '''a0000000-0000-0000-0000-000000000002'''
\set EASTSKU '''a0000000-0000-0000-0000-000000000004'''
\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set CUST '''cc000000-0000-0000-0000-000000000001'''

-- ---- standard order reserves stock and snapshots price ----------------------
select lives_ok($$
  select create_order(
    '11111111-1111-1111-1111-111111111111'::uuid,
    '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":4},
      {"child_sku_id":"a0000000-0000-0000-0000-000000000002","quantity":2,"unit_price":10.5}]'::jsonb,
    'cc000000-0000-0000-0000-000000000001'::uuid
  )
$$, 'create_order (standard, 2 lines) succeeds');

select is((select reserved from inventory_levels where child_sku_id=:SKU), 4, 'sku1 reserved = 4');
select is((select reserved from inventory_levels where child_sku_id=:SKU2), 2, 'sku2 reserved = 2');
select is((select count(*)::int from orders where customer_id=:CUST), 1, 'one order created');
select is((select count(*)::int from fulfillment_groups where customer_id=:CUST), 1, 'one group of one created');
-- price snapshot: line 1 defaults to SKU price (12.00), line 2 uses caller's 10.50
select is((select unit_price from order_line_items oli
             join orders o on o.id=oli.order_id
            where o.customer_id=:CUST and oli.child_sku_id=:SKU), 12.00::numeric,
          'line price defaults to current SKU price');
select is((select unit_price from order_line_items oli
             join orders o on o.id=oli.order_id
            where o.customer_id=:CUST and oli.child_sku_id=:SKU2), 10.50::numeric,
          'line price honours caller override');

-- ---- layaway order removes from on_hand (layby), not reservation ------------
select lives_ok($$
  select create_order(
    '11111111-1111-1111-1111-111111111111'::uuid,
    '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":3}]'::jsonb,
    null, 'manual', 'layaway'
  )
$$, 'create_order (layaway) succeeds');
select is((select layby from inventory_levels where child_sku_id=:SKU), 3, 'layby = 3 after layaway order');

-- ---- guards ----------------------------------------------------------------
select throws_ok($$
  select create_order('11111111-1111-1111-1111-111111111111'::uuid, '[]'::jsonb)
$$, NULL, NULL, 'empty line items rejected');

select throws_ok($$
  select create_order(
    '11111111-1111-1111-1111-111111111111'::uuid,
    '[{"child_sku_id":"a0000000-0000-0000-0000-000000000004","quantity":1}]'::jsonb)
$$, NULL, NULL, 'SKU from another site rejected');

select throws_ok($$
  select create_order(
    '11111111-1111-1111-1111-111111111111'::uuid,
    '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":0}]'::jsonb)
$$, NULL, NULL, 'non-positive quantity rejected');

select * from finish();
rollback;
