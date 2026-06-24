-- ============================================================================
-- WMS — Migration 0013: Shopify import scaffolding (orders, via webhooks)
--
-- Phase B starts here. Two tables:
--
--   shopify_connections   maps a Shopify store (shop_domain) to a WMS site, so
--                         an incoming order knows which site's child SKUs and
--                         inventory it belongs to. Admin-managed.
--   shopify_order_imports an idempotency + audit log. The webhook inserts one
--                         row per (shop_domain, shopify_order_id); the unique
--                         constraint makes Shopify's at-least-once delivery
--                         safe (a retry can't create a second WMS order). It
--                         also records mapping/processing status so unmapped
--                         variants are visible instead of silently dropped.
--
-- The webhook runs with the service role (no end-user session), so writes here
-- bypass RLS. Authenticated users get read-only visibility into both tables;
-- only admins manage connections.
-- ============================================================================

begin;

create table public.shopify_connections (
  id          uuid primary key default gen_random_uuid(),
  shop_domain text not null unique,          -- e.g. my-store.myshopify.com
  site_id     uuid not null references public.sites(id) on delete restrict,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger t_shopify_conn_updated before update on public.shopify_connections
  for each row execute function public.set_updated_at();

create table public.shopify_order_imports (
  id               uuid primary key default gen_random_uuid(),
  shop_domain      text not null,
  shopify_order_id text not null,
  topic            text,
  status           text not null default 'received'
                     check (status in
                       ('received','imported','needs_mapping','error','skipped','duplicate')),
  wms_order_id     uuid references public.orders(id) on delete set null,
  error            text,
  payload          jsonb,
  received_at      timestamptz not null default now(),
  processed_at     timestamptz,
  unique (shop_domain, shopify_order_id)     -- idempotency key
);
create index shopify_order_imports_status_idx
  on public.shopify_order_imports(status, received_at desc);

alter table public.shopify_connections    enable row level security;
alter table public.shopify_order_imports  enable row level security;

-- Connections: every authenticated user reads; admins manage.
create policy shopify_connections_read  on public.shopify_connections
  for select using (auth.uid() is not null);
create policy shopify_connections_admin on public.shopify_connections
  for all using (public.is_admin()) with check (public.is_admin());

-- Import log: read-only to app users. Writes come only from the service role
-- (the webhook), which bypasses RLS — there is deliberately no write policy.
create policy shopify_order_imports_read on public.shopify_order_imports
  for select using (auth.uid() is not null);

commit;
