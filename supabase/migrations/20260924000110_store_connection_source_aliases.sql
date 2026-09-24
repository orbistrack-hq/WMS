-- ============================================================================
-- WMS — Migration 0110: store connections accept alternate domains
--
-- Bud Club's WooCommerce store moved from budclub.com to budclubshop.com
-- (2026-09-04), and budclub.com may come back. Woo stamps every webhook with
-- x-wc-webhook-source = the site URL WordPress is configured with, so whichever
-- domain is live, WMS has to recognise it as the SAME connection.
--
-- source_aliases lists extra domains (normalized "https://host", same form as
-- source) that resolve to this connection. The webhook receiver maps an alias
-- to the connection's canonical `source` BEFORE anything else, so orders,
-- imports and the (channel, source, external_order_id) idempotency key all
-- stay under one source string — no split history, no duplicate imports.
--
-- Outbound REST calls (stock pushes, syncs) still go to `source` only; aliases
-- are inbound-only. To make an alias the primary later, use
-- supabase/snippets/repoint_woo_domain.sql and swap the two here.
-- ============================================================================

alter table public.store_connections
  add column if not exists source_aliases text[] not null default '{}';

comment on column public.store_connections.source_aliases is
  'Alternate normalized store URLs whose inbound webhooks resolve to this connection (source stays canonical).';

-- Bud Club: primary is budclubshop.com, accept the old budclub.com too.
update public.store_connections
   set source_aliases = array['https://budclub.com']
 where channel = 'woocommerce'
   and source  = 'https://budclubshop.com'
   and not ('https://budclub.com' = any (source_aliases));
