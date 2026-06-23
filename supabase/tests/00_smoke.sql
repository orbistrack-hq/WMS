-- Schema/structure sanity: the objects the rest of the system depends on exist.
begin;
select plan(16);

select has_table('public','sites','sites table exists');
select has_table('public','child_skus','child_skus table exists');
select has_table('public','inventory_levels','inventory_levels table exists');
select has_table('public','inventory_ledger','inventory_ledger table exists');
select has_table('public','orders','orders table exists');
select has_table('public','order_payments','order_payments table exists');
select has_table('public','billing_charges','billing_charges table exists');
select has_table('public','user_site_access','user_site_access table exists');

select has_view('public','sales_report','sales_report view exists');
select has_view('public','inventory_report','inventory_report view exists');
select has_view('public','order_payment_summary','order_payment_summary view exists');

select has_function('public','reserve_stock','reserve_stock function exists');
select has_function('public','fulfill_order','fulfill_order function exists');
select has_function('public','charge_order_pick_fee','charge_order_pick_fee function exists');

select ok((select relrowsecurity from pg_class where oid='public.orders'::regclass), 'RLS enabled on orders');
select ok((select relrowsecurity from pg_class where oid='public.inventory_levels'::regclass), 'RLS enabled on inventory_levels');

select * from finish();
rollback;
