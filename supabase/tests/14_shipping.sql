-- Shipping: create_shipment / update_shipment / set_shipment_status and
-- add_package / update_package. Operational only — never touches the order
-- lifecycle. Uses seeded site MAIN.
begin;
select plan(15);
\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set G    '''b0000000-0000-0000-0000-000000000050'''
\set O    '''b0000000-1111-0000-0000-000000000050'''

insert into fulfillment_groups(id, site_id) values (:G, :MAIN);
insert into orders(id, site_id, group_id) values (:O, :MAIN, :G);

-- create a shipment (status starts pending)
select lives_ok(
  $$ select create_shipment('b0000000-0000-0000-0000-000000000050','USPS','Priority',5.00) $$,
  'create_shipment succeeds');
select is((select status from shipments where group_id=:G), 'pending',
  'new shipment is pending');
select is((select carrier from shipments where group_id=:G), 'USPS',
  'carrier saved');

-- negative estimated cost is rejected
select throws_ok(
  $$ select create_shipment('b0000000-0000-0000-0000-000000000050', null, null, -1) $$,
  NULL, NULL, 'negative estimated cost rejected');

-- edit carrier / service / costs
select lives_ok(
  $$ select update_shipment((select id from shipments where group_id='b0000000-0000-0000-0000-000000000050'),
       'UPS','Ground',4.00,4.25) $$,
  'update_shipment succeeds');
select is((select actual_cost from shipments where group_id=:G), 4.25::numeric,
  'actual cost saved');

-- status flow: pending -> shipped
select lives_ok(
  $$ select set_shipment_status((select id from shipments where group_id='b0000000-0000-0000-0000-000000000050'),'shipped') $$,
  'mark shipped');
select is((select status from shipments where group_id=:G), 'shipped',
  'status advanced to shipped');

-- shipping must NOT change the order lifecycle
select is((select status from orders where id=:O), 'created',
  'order status unchanged by shipping');

-- add a package to the shipment
select lives_ok(
  $$ select add_package((select id from shipments where group_id='b0000000-0000-0000-0000-000000000050'),
       '1Z999AA10123456784', 4.00, 500) $$,
  'add_package succeeds');
select is(
  (select count(*) from packages p join shipments s on s.id=p.shipment_id
    where s.group_id=:G)::int, 1,
  'one package on the shipment');

-- negative package weight rejected
select throws_ok(
  $$ select add_package((select id from shipments where group_id='b0000000-0000-0000-0000-000000000050'),'x',1,-5) $$,
  NULL, NULL, 'negative package weight rejected');

-- cancel the shipment; cancelled is terminal
select lives_ok(
  $$ select set_shipment_status((select id from shipments where group_id='b0000000-0000-0000-0000-000000000050'),'cancelled') $$,
  'cancel shipment');
select throws_ok(
  $$ select set_shipment_status((select id from shipments where group_id='b0000000-0000-0000-0000-000000000050'),'shipped') $$,
  NULL, NULL, 'cannot change status of a cancelled shipment');
select throws_ok(
  $$ select add_package((select id from shipments where group_id='b0000000-0000-0000-0000-000000000050'),'y',1,1) $$,
  NULL, NULL, 'cannot add a package to a cancelled shipment');

select * from finish();
rollback;
