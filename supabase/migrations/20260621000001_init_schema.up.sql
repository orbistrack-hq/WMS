-- ============================================================================
-- WMS — Migration 0001: core schema (Phase A)
-- Target: Supabase (Postgres 15+) with Row Level Security.
--
-- Scope of THIS migration: structure only — tables, constraints, generated
-- columns, the audit log, the updated_at/order-number/auto-row triggers, and
-- baseline RLS. It deliberately does NOT include the inventory
-- reserve/release/consume state-machine functions; those are the risky logic
-- and get their own migration with tests.
--
-- DECISION markers below flag choices that shape table structure. Each is
-- reversible cheaply now and expensive later — change them here, not in prod.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. Extensions & shared helpers
-- ----------------------------------------------------------------------------
create extension if not exists pgcrypto;   -- gen_random_uuid()

-- Stamp updated_at on every row update.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Generic audit trigger: writes a before/after snapshot to audit_log for any
-- INSERT/UPDATE/DELETE on the tables it's attached to.
-- Reads the row's primary key generically (id, or child_sku_id for the one
-- table keyed that way) so it can be attached to any table without assuming an
-- "id" column exists.
create or replace function public.audit_row()
returns trigger language plpgsql security definer as $$
declare
  v_actor uuid := auth.uid();
  v_old jsonb;
  v_new jsonb;
  v_id  uuid;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_id  := coalesce(v_old->>'id', v_old->>'child_sku_id')::uuid;
    insert into public.audit_log(table_name, record_id, action, actor, old_data, new_data)
    values (tg_table_name, v_id, tg_op, v_actor, v_old, null);
    return old;
  else
    v_new := to_jsonb(new);
    v_id  := coalesce(v_new->>'id', v_new->>'child_sku_id')::uuid;
    if tg_op = 'UPDATE' then v_old := to_jsonb(old); end if;
    insert into public.audit_log(table_name, record_id, action, actor, old_data, new_data)
    values (tg_table_name, v_id, tg_op, v_actor, v_old, v_new);
    return new;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 1. Identity & access  (DECISION 6: role-based RLS; staff = all sites for now)
-- ----------------------------------------------------------------------------
create type public.user_role as enum ('admin', 'staff');

create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text,
  role       public.user_role not null default 'staff',
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-create a profile when a new auth user signs up.
-- NOTE: first user must be promoted to 'admin' manually after signup.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles(id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email));
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Resolve the calling user's role / admin status (used by RLS policies).
create or replace function public.app_role()
returns public.user_role language sql stable security definer as $$
  select role from public.profiles where id = auth.uid();
$$;
create or replace function public.is_admin()
returns boolean language sql stable as $$
  select coalesce(public.app_role() = 'admin', false);
$$;

-- ----------------------------------------------------------------------------
-- 2. Catalog & sites
-- ----------------------------------------------------------------------------
create table public.sites (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       text unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Multi-level categories via adjacency list. Cycle prevention is enforced in
-- the app layer (a category cannot be its own ancestor).
create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  parent_id  uuid references public.categories(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Parent / master product. DECISION 1: there is no variant tier below this;
-- the sellable unit is the child SKU. Names are intentionally NOT unique.
create table public.products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  category_id uuid references public.categories(id) on delete set null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Child SKU = one product at one site, with its own price, cost, and external
-- variant mapping. This is the atomic unit inventory and orders attach to.
create table public.child_skus (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid not null references public.products(id) on delete restrict,
  site_id          uuid not null references public.sites(id)    on delete restrict,
  sku              text,
  store_variant_id text,          -- external platform variant id (Phase B sync)
  price            numeric(12,2) not null default 0,
  cost             numeric(12,2) not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (product_id, site_id)    -- one child per product per site
);
-- SKU codes unique per site when present.
create unique index child_skus_site_sku_key
  on public.child_skus(site_id, sku) where sku is not null;

-- ----------------------------------------------------------------------------
-- 3. Inventory  (DECISION 3: materialized levels + append-only ledger)
-- ----------------------------------------------------------------------------
-- available is derived, never stored by hand. layby is a parallel visibility
-- counter: laybyd stock has already been removed from on_hand, so it is NOT
-- subtracted again — it just keeps reserved/layby visible per requirements.
create table public.inventory_levels (
  child_sku_id uuid primary key references public.child_skus(id) on delete cascade,
  on_hand      integer not null default 0,
  reserved     integer not null default 0,
  layby        integer not null default 0,
  available    integer generated always as (on_hand - reserved) stored,
  updated_at   timestamptz not null default now(),
  check (on_hand  >= 0),
  check (reserved >= 0),
  check (layby    >= 0),
  check (on_hand  >= reserved)   -- guard against overselling
);

-- One level row per child SKU, created automatically.
create or replace function public.create_inventory_level()
returns trigger language plpgsql as $$
begin
  insert into public.inventory_levels(child_sku_id) values (new.id);
  return new;
end;
$$;
create trigger child_sku_inventory_level
  after insert on public.child_skus
  for each row execute function public.create_inventory_level();

-- Append-only movement log. Every change to inventory_levels is paired with a
-- ledger row recording the delta, why, and what referenced it.
create table public.inventory_ledger (
  id             uuid primary key default gen_random_uuid(),
  child_sku_id   uuid not null references public.child_skus(id) on delete restrict,
  delta_on_hand  integer not null default 0,
  delta_reserved integer not null default 0,
  delta_layby    integer not null default 0,
  reason         text not null check (reason in (
                   'order_reserve','order_release','order_consume',
                   'layaway_remove','manual_adjustment','receipt','correction')),
  reference_type text,           -- e.g. 'order', 'order_line_item'
  reference_id   uuid,
  note           text,
  actor          uuid references public.profiles(id),
  created_at     timestamptz not null default now()
);
create index inventory_ledger_sku_idx on public.inventory_ledger(child_sku_id, created_at);

-- ----------------------------------------------------------------------------
-- 4. Customers  (DECISION 2: first-class, lightweight)
-- ----------------------------------------------------------------------------
create table public.customers (
  id           uuid primary key default gen_random_uuid(),
  name         text,
  email        text,
  phone        text,
  external_ref jsonb,            -- platform customer ids, filled in Phase B
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index customers_email_idx on public.customers(lower(email));

-- ----------------------------------------------------------------------------
-- 5. Fulfillment groups  (DECISION 4: every order belongs to one)
-- ----------------------------------------------------------------------------
-- Box/label, shipping, and packaging consumption attach HERE, once, so a group
-- of combined orders is never double-counted. Solo orders are a group of one.
create table public.fulfillment_groups (
  id           uuid primary key default gen_random_uuid(),
  site_id      uuid not null references public.sites(id) on delete restrict,
  customer_id  uuid references public.customers(id) on delete set null,
  ship_to_key  text,            -- normalized address key used for combine match
  window_start timestamptz not null default now(),
  status       text not null default 'open'
                 check (status in ('open','fulfilled','cancelled')),
  created_at   timestamptz not null default now(),
  fulfilled_at timestamptz,
  updated_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 6. Orders & line items
-- ----------------------------------------------------------------------------
create sequence public.order_number_seq;

create table public.orders (
  id          uuid primary key default gen_random_uuid(),
  order_number text not null unique
                 default ('ORD-' || lpad(nextval('public.order_number_seq')::text, 6, '0')),
  site_id     uuid not null references public.sites(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete set null,
  group_id    uuid not null references public.fulfillment_groups(id) on delete restrict,

  channel     text not null default 'manual'
                 check (channel in ('manual','shopify','woocommerce')),
  -- DECISION 5: holds are a flag, orthogonal to the status flow.
  status      text not null default 'created'
                 check (status in ('created','picking','packed','fulfilled','cancelled')),
  on_hold     boolean not null default false,
  -- standard reserves stock; layaway removes it from on_hand now (paid later).
  order_type  text not null default 'standard'
                 check (order_type in ('standard','layaway')),

  -- Post-dated sales: the booked sale date can differ from when it was entered.
  entered_at  timestamptz not null default now(),
  sale_date   date not null default current_date,

  -- Ship-to lives on the order so it can differ between a customer's orders.
  ship_to_name     text,
  ship_to_address1 text,
  ship_to_address2 text,
  ship_to_city     text,
  ship_to_region   text,
  ship_to_postal   text,
  ship_to_country  text,
  ship_to_key text generated always as (
    lower(coalesce(ship_to_address1,'') || '|' ||
          coalesce(ship_to_postal,'')   || '|' ||
          coalesce(ship_to_country,''))
  ) stored,

  discount_total numeric(12,2) not null default 0,
  tax_total      numeric(12,2) not null default 0,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  fulfilled_at timestamptz,
  cancelled_at timestamptz
);
create index orders_site_idx     on public.orders(site_id);
create index orders_group_idx    on public.orders(group_id);
create index orders_customer_idx on public.orders(customer_id);
create index orders_status_idx   on public.orders(status);

create table public.order_line_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders(id) on delete cascade,
  child_sku_id uuid not null references public.child_skus(id) on delete restrict,
  quantity     integer not null check (quantity > 0),
  unit_price   numeric(12,2) not null default 0,
  discount     numeric(12,2) not null default 0,
  tax          numeric(12,2) not null default 0,
  created_at   timestamptz not null default now()
);
create index order_line_items_order_idx on public.order_line_items(order_id);

-- ----------------------------------------------------------------------------
-- 7. Packaging
-- ----------------------------------------------------------------------------
create table public.packaging_types (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  kind       text not null check (kind in
               ('box','shipping_label','jar','jar_label','vacuum_bag','custom')),
  unit_cost  numeric(12,2) not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Consumption is recorded against the GROUP, not the order, so box/label are
-- counted once and consumables (jars, jar labels, bags) sum across combined
-- orders without double-counting. unit_cost_snapshot freezes the cost at the
-- time of packing so later price changes don't rewrite historical reports.
create table public.packaging_usage (
  id                  uuid primary key default gen_random_uuid(),
  group_id            uuid not null references public.fulfillment_groups(id) on delete cascade,
  packaging_type_id   uuid not null references public.packaging_types(id) on delete restrict,
  quantity            integer not null check (quantity > 0),
  unit_cost_snapshot  numeric(12,2) not null,
  recorded_by         uuid references public.profiles(id),
  recorded_at         timestamptz not null default now()
);
create index packaging_usage_group_idx on public.packaging_usage(group_id);

-- ----------------------------------------------------------------------------
-- 8. Shipping  (group -> shipments -> packages; >1 package per order supported)
-- ----------------------------------------------------------------------------
create table public.shipments (
  id             uuid primary key default gen_random_uuid(),
  group_id       uuid not null references public.fulfillment_groups(id) on delete cascade,
  carrier        text,
  service_level  text,
  estimated_cost numeric(12,2),
  actual_cost    numeric(12,2),
  status         text not null default 'pending'
                   check (status in ('pending','shipped','delivered','cancelled')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index shipments_group_idx on public.shipments(group_id);

create table public.packages (
  id              uuid primary key default gen_random_uuid(),
  shipment_id     uuid not null references public.shipments(id) on delete cascade,
  tracking_number text,
  cost            numeric(12,2),
  weight_grams    integer,
  created_at      timestamptz not null default now()
);
create index packages_shipment_idx on public.packages(shipment_id);

-- ----------------------------------------------------------------------------
-- 9. Billing (charge-side, billable to client — separate from internal cost)
-- ----------------------------------------------------------------------------
-- Effective-dated fee schedule. The row in effect at fulfillment is resolved
-- as: max(effective_from) <= the order's fulfillment date. client_id is null
-- now (single implicit client) and becomes per-client in a later phase.
create table public.fee_schedules (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid,                       -- future: per-client rates
  effective_from       date not null,
  first_unit_rate      numeric(12,2) not null,
  additional_unit_rate numeric(12,2) not null,
  created_at           timestamptz not null default now()
);

-- Pick fees accrue per ORDER (first-unit premium once per order, even when
-- combined), so charges reference the order. The resolved rates are snapshotted
-- onto each charge so a later rate change never alters an already-billed order.
create table public.billing_charges (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id) on delete restrict,
  fee_type        text not null check (fee_type in
                    ('pick_fee','packaging_charge','insert','kitting','labor','other')),
  quantity        integer not null default 1,
  unit_amount     numeric(12,2) not null default 0,
  amount          numeric(12,2) not null,
  fee_schedule_id uuid references public.fee_schedules(id),
  description     text,
  created_at      timestamptz not null default now()
);
create index billing_charges_order_idx on public.billing_charges(order_id);

-- ----------------------------------------------------------------------------
-- 10. Audit log (generic; written by the audit_row trigger)
-- ----------------------------------------------------------------------------
create table public.audit_log (
  id         uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_id  uuid,
  action     text not null,
  actor      uuid,
  old_data   jsonb,
  new_data   jsonb,
  changed_at timestamptz not null default now()
);
create index audit_log_record_idx on public.audit_log(table_name, record_id);

-- ----------------------------------------------------------------------------
-- 11. updated_at triggers
-- ----------------------------------------------------------------------------
create trigger t_profiles_updated   before update on public.profiles           for each row execute function public.set_updated_at();
create trigger t_sites_updated      before update on public.sites              for each row execute function public.set_updated_at();
create trigger t_categories_updated before update on public.categories         for each row execute function public.set_updated_at();
create trigger t_products_updated   before update on public.products           for each row execute function public.set_updated_at();
create trigger t_childskus_updated  before update on public.child_skus         for each row execute function public.set_updated_at();
create trigger t_invlevels_updated  before update on public.inventory_levels   for each row execute function public.set_updated_at();
create trigger t_customers_updated  before update on public.customers          for each row execute function public.set_updated_at();
create trigger t_groups_updated     before update on public.fulfillment_groups for each row execute function public.set_updated_at();
create trigger t_orders_updated     before update on public.orders             for each row execute function public.set_updated_at();
create trigger t_pkgtypes_updated   before update on public.packaging_types    for each row execute function public.set_updated_at();
create trigger t_shipments_updated  before update on public.shipments          for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 12. Audit triggers on the operational tables
-- ----------------------------------------------------------------------------
create trigger a_child_skus       after insert or update or delete on public.child_skus        for each row execute function public.audit_row();
-- inventory_levels is intentionally NOT audited here: its change history lives
-- in inventory_ledger, which records the delta, reason, and reference per move.
create trigger a_orders           after insert or update or delete on public.orders            for each row execute function public.audit_row();
create trigger a_order_lines      after insert or update or delete on public.order_line_items  for each row execute function public.audit_row();
create trigger a_groups           after insert or update or delete on public.fulfillment_groups for each row execute function public.audit_row();
create trigger a_packaging_usage  after insert or update or delete on public.packaging_usage   for each row execute function public.audit_row();
create trigger a_shipments        after insert or update or delete on public.shipments         for each row execute function public.audit_row();
create trigger a_billing_charges  after insert or update or delete on public.billing_charges   for each row execute function public.audit_row();

-- ----------------------------------------------------------------------------
-- 13. Row Level Security
--   Pattern: every authenticated profile may read and write operational data;
--   deletes and config tables (sites, categories, packaging_types,
--   fee_schedules, profiles) are admin-only. Tighten to per-site staff scope in
--   a later migration if DECISION 6 goes that way.
-- ----------------------------------------------------------------------------
alter table public.profiles            enable row level security;
alter table public.sites               enable row level security;
alter table public.categories          enable row level security;
alter table public.products            enable row level security;
alter table public.child_skus          enable row level security;
alter table public.inventory_levels    enable row level security;
alter table public.inventory_ledger    enable row level security;
alter table public.customers           enable row level security;
alter table public.fulfillment_groups  enable row level security;
alter table public.orders              enable row level security;
alter table public.order_line_items    enable row level security;
alter table public.packaging_types     enable row level security;
alter table public.packaging_usage     enable row level security;
alter table public.shipments           enable row level security;
alter table public.packages            enable row level security;
alter table public.fee_schedules       enable row level security;
alter table public.billing_charges     enable row level security;
alter table public.audit_log           enable row level security;

-- profiles: everyone reads; users update their own non-role fields; admins manage all.
create policy profiles_select on public.profiles for select using (auth.uid() is not null);
create policy profiles_update_self on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin_all on public.profiles for all using (public.is_admin()) with check (public.is_admin());

-- Config tables: read by all authenticated, written by admins only.
do $$
declare t text;
begin
  foreach t in array array['sites','categories','packaging_types','fee_schedules'] loop
    execute format('create policy %1$s_read on public.%1$s for select using (auth.uid() is not null);', t);
    execute format('create policy %1$s_admin on public.%1$s for all using (public.is_admin()) with check (public.is_admin());', t);
  end loop;
end $$;

-- Operational tables: authenticated read + insert + update; admin-only delete.
do $$
declare t text;
begin
  foreach t in array array[
    'products','child_skus','inventory_levels','customers','fulfillment_groups',
    'orders','order_line_items','packaging_usage','shipments','packages','billing_charges'
  ] loop
    execute format('create policy %1$s_read on public.%1$s for select using (auth.uid() is not null);', t);
    execute format('create policy %1$s_write on public.%1$s for insert with check (auth.uid() is not null);', t);
    execute format('create policy %1$s_modify on public.%1$s for update using (auth.uid() is not null) with check (auth.uid() is not null);', t);
    execute format('create policy %1$s_delete on public.%1$s for delete using (public.is_admin());', t);
  end loop;
end $$;

-- Ledger and audit are append-only for everyone; readable by all authenticated.
create policy inventory_ledger_read   on public.inventory_ledger for select using (auth.uid() is not null);
create policy inventory_ledger_insert on public.inventory_ledger for insert with check (auth.uid() is not null);
create policy audit_log_read on public.audit_log for select using (auth.uid() is not null);

-- ----------------------------------------------------------------------------
-- 14. Seed: the current pick-fee schedule (DECISION: $1.25 / $0.25, locked)
-- ----------------------------------------------------------------------------
-- effective_from is a fixed early date, NOT current_date: the migration may be
-- applied while the container clock (UTC) has already rolled past Pacific
-- midnight, which would seed the schedule as effective "tomorrow" and leave
-- Pacific-dated orders with no effective schedule. A fixed past date is immune.
insert into public.fee_schedules (effective_from, first_unit_rate, additional_unit_rate)
values (date '2020-01-01', 1.25, 0.25);

commit;
