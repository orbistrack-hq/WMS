-- ============================================================================
-- WMS — Migration 0091: promo orders (influencer seeding / giveaways)
--
-- PROBLEM. Manual orders shipped to influencers are never meant to earn. They
-- are entered at $0 (or near it), fulfilled like any other order, and then land
-- in cogs_report / landed_margin_report as pure loss: zero revenue against real
-- product COGS plus an allocated share of packaging and shipping. A handful of
-- seeding orders a month is enough to visibly drag /reports' net margin down
-- and make the by-channel breakdown lie about how "manual" performs.
--
-- FIX. A per-order marker, orders.is_promo. The /reports screen splits these
-- rows out of every profit KPI, the trend series and the breakdown table, and
-- surfaces their landed cost on its own "Promo cost" KPI instead — so real
-- margin stays clean while the money spent on seeding stays visible. It is a
-- marketing spend, not a bad sale.
--
-- WHY A COLUMN AND NOT AN order_type / channel VALUE.
--   * order_type is ('standard','layaway') — a *stock* behaviour (reserve vs
--     remove-to-layby). A promo order can be either; the two are orthogonal.
--   * channel is ('manual','shopify','woocommerce') — where the order CAME
--     from, and it is what store sync writes. A promo order genuinely is a
--     manual order. Overloading either would break the check constraints and
--     the sync normalizers that switch on them.
-- A boolean sits alongside both and touches nothing else.
--
-- WHAT DELIBERATELY DOES NOT CHANGE.
--   * Inventory. The goods physically ship, so promo orders reserve and consume
--     stock exactly like any other order — untouched lifecycle, untouched RPCs.
--   * cogs_report / landed_margin_report. Their definitions are left alone on
--     purpose: the flag is applied at the /reports edge by matching order ids,
--     which keeps the reporting views (and everything else reading them, e.g.
--     storefront_monthly_billing) byte-identical.
--   * Packaging / shipping allocation. A promo order sharing a combined group
--     still takes its revenue-share of the box and postage. That cost simply
--     lands in "Promo cost" rather than in net profit — which is the point.
--
-- Reverse with rollback/20260810000091_promo_orders.down.sql.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The marker. NOT NULL DEFAULT false so every existing order is a normal,
--    profit-bearing order and nothing about today's numbers moves on apply.
-- ----------------------------------------------------------------------------
alter table public.orders
  add column if not exists is_promo boolean not null default false;

comment on column public.orders.is_promo is
  'Marketing giveaway (influencer seeding, sample, gift). Excluded from revenue/profit KPIs on /reports and reported as promo cost instead. Inventory, fulfillment and packaging behave exactly as a normal order.';

-- Partial index: promo orders are a small minority, and the only query shape is
-- "give me the promo ones", so indexing just the true rows keeps it tiny.
create index if not exists orders_is_promo_idx
  on public.orders (id)
  where is_promo;

-- ----------------------------------------------------------------------------
-- 2. set_order_promo — flip the marker on an existing order.
--
--    Deliberately a separate RPC rather than a new create_order parameter.
--    create_order already carries three live overloads (18/19/20 args, from
--    migrations 0010, 0024 and 0072) because none of them dropped the previous
--    signature; adding a 21st argument would add a fourth candidate and risk
--    PostgREST's "could not choose the best candidate function" on every order
--    creation. A standalone function avoids that entirely — and doubles as the
--    way to retro-flag influencer orders that were already entered before this
--    migration existed.
--
--    Gated on is_operator() (admin/manager/operator per migration 0050) since
--    it moves money between "profit" and "marketing spend".
--
--    SECURITY INVOKER, unlike the reverse/adjust RPCs. Those are DEFINER because
--    they must write ledger rows the caller cannot touch directly; this one only
--    sets a boolean on a row the caller can already update through the existing
--    orders_update policy, so running as the caller keeps site RLS in force for
--    free. An operator who cannot see a site's orders updates zero rows and gets
--    the not-found error below rather than silently reclassifying someone else's
--    revenue. search_path is still pinned.
-- ----------------------------------------------------------------------------
create or replace function public.set_order_promo(
  p_order_id uuid,
  p_is_promo boolean
) returns public.orders
language plpgsql security invoker set search_path = '' as $$
declare v public.orders;
begin
  if not public.is_operator() then
    raise exception 'Not authorized to change an order''s promo flag'
      using errcode = '42501';
  end if;
  if p_is_promo is null then
    raise exception 'set_order_promo: p_is_promo is required';
  end if;

  update public.orders
     set is_promo = p_is_promo
   where id = p_order_id
  returning * into v;

  -- Zero rows: either the id is wrong or it belongs to a site this caller has
  -- no access to. Both are "not yours to change" from here.
  if v.id is null then
    raise exception 'Order % not found, or not accessible from this account',
      p_order_id;
  end if;

  return v;
end;
$$;

comment on function public.set_order_promo is
  'Marks an order as a promo/giveaway (or clears it). Promo orders are excluded from revenue and profit reporting and counted as marketing cost instead. Operator role required. Purely a reporting marker: inventory and fulfillment are unaffected, and it is reversible at any point in the order lifecycle.';

grant execute on function public.set_order_promo(uuid, boolean) to authenticated;

commit;

-- New column + new function: PostgREST caches the schema and will 404 both
-- until it reloads (the adjust_packaging failure mode). Nudge it explicitly.
notify pgrst, 'reload schema';
