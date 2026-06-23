-- ============================================================================
-- WMS — seed.sql
-- Runs after migrations on every `supabase db reset` (local only; NOT pushed to
-- production). Gives local dev and the test suite a realistic starting catalog.
-- The current pick-fee schedule is already seeded by migration 0001.
-- ============================================================================

-- Sites
insert into public.sites (id, name, code) values
 ('11111111-1111-1111-1111-111111111111','Main Warehouse','MAIN'),
 ('22222222-2222-2222-2222-222222222222','East Coast DC','EAST');

-- Categories (multi-level: Food > Honey / Preserves)
insert into public.categories (id, name, parent_id) values
 ('ca000000-0000-0000-0000-000000000001','Food', null),
 ('ca000000-0000-0000-0000-000000000002','Honey','ca000000-0000-0000-0000-000000000001'),
 ('ca000000-0000-0000-0000-000000000003','Preserves','ca000000-0000-0000-0000-000000000001');

-- Packaging types
insert into public.packaging_types (id, name, kind, unit_cost) values
 ('11111111-0000-0000-0000-000000000001','Standard Box','box',0.85),
 ('11111111-0000-0000-0000-000000000002','Shipping Label','shipping_label',0.12),
 ('11111111-0000-0000-0000-000000000003','8oz Jar','jar',0.40),
 ('11111111-0000-0000-0000-000000000004','Jar Label','jar_label',0.05),
 ('11111111-0000-0000-0000-000000000005','Vacuum Bag','vacuum_bag',0.18);

-- Products (master) and child SKUs (per site)
insert into public.products (id, name, category_id) values
 ('33333333-0000-0000-0000-000000000001','Wildflower Honey','ca000000-0000-0000-0000-000000000002'),
 ('33333333-0000-0000-0000-000000000002','Clover Honey','ca000000-0000-0000-0000-000000000002'),
 ('33333333-0000-0000-0000-000000000003','Strawberry Jam','ca000000-0000-0000-0000-000000000003');

insert into public.child_skus (id, product_id, site_id, sku, price, cost) values
 ('a0000000-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','WF-HONEY-MAIN',12.00,4.50),
 ('a0000000-0000-0000-0000-000000000002','33333333-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','CL-HONEY-MAIN',11.00,4.00),
 ('a0000000-0000-0000-0000-000000000003','33333333-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','STR-JAM-MAIN',9.00,3.25),
 ('a0000000-0000-0000-0000-000000000004','33333333-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','WF-HONEY-EAST',12.50,4.60);

-- Customers
insert into public.customers (id, name, email) values
 ('cc000000-0000-0000-0000-000000000001','Jane Roe','jane@example.com'),
 ('cc000000-0000-0000-0000-000000000002','John Doe','john@example.com');

-- Opening stock through the guarded path (writes levels + ledger together)
select public.receive_stock('a0000000-0000-0000-0000-000000000001', 200, 'seed', null, 'opening stock');
select public.receive_stock('a0000000-0000-0000-0000-000000000002', 150, 'seed', null, 'opening stock');
select public.receive_stock('a0000000-0000-0000-0000-000000000003', 80,  'seed', null, 'opening stock');
select public.receive_stock('a0000000-0000-0000-0000-000000000004', 120, 'seed', null, 'opening stock');
