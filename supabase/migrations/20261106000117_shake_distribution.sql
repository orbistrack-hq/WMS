-- ============================================================================
-- WMS — Migration 0117: shake pots by quality, split to brands by sales
--
-- WHY. The fulfillment team packs a strain for every brand at once, so they
-- can't say how much shake each brand caused. Per-brand shake at allocation
-- (0114) went unused. The new flow:
--
--   1. Every strain has a fixed QUALITY: light dep, indoor or exotic.
--   2. A manager weighs shake and adds it to that quality's POT (one pot per
--      quality, not per strain or brand). Shake was never counted as stock
--      on its own, so adding it takes nothing from any strain's bulk.
--   3. DISTRIBUTE: the system works out each brand's share of the pot from the
--      grams it SOLD of that quality's products in a period the manager
--      chooses. The percentages are computed here, never typed in. The
--      manager only chooses how many units of each shake size (14g, 28g,
--      1/4 LB, ...) to make for each brand, up to that brand's gram target.
--   4. Those units land on the brand's shake product (a product flagged
--      is_shake, with the pot's quality) through receive_stock, so the usual
--      outbound sync pushes them to the store. Grams that don't fill a unit
--      stay in the pot for next time.
--
-- Objects:
--   products.quality / products.is_shake
--   shake_pots, shake_ledger, shake_distributions,
--   shake_distribution_brands, shake_distribution_lines
--   set_product_quality, set_product_is_shake
--   record_shake_in, reverse_shake_in
--   shake_brand_shares, shake_distribution_preview
--   distribute_shake, reverse_shake_distribution
--   brand_billing_summary: shake_grams now also counts distributed shake.
--
-- record_shake / reverse_shake (0044) stay for history; the app stops calling
-- record_shake. Reverse with rollback/20261106000117_shake_distribution.down.sql.
-- ============================================================================

begin;

-- ---- 1. Strain quality and the shake-product flag --------------------------
alter table public.products
  add column quality  text check (quality in ('light_dep','indoor','exotic')),
  add column is_shake boolean not null default false;

alter table public.products
  add constraint products_shake_needs_quality
  check (not is_shake or quality is not null);

comment on column public.products.quality is
  'Fixed quality of a strain (light_dep / indoor / exotic). Decides which shake pot its sales count toward. On a shake product (is_shake) it is the pot the product is filled from.';
comment on column public.products.is_shake is
  'True for a brand''s shake product (e.g. "Exotic Shake"). Its child SKUs are filled from the shake pot of the product''s quality by distribute_shake. Its own sales never count toward shake shares.';

create index products_quality_idx on public.products(quality) where quality is not null;

-- ---- 2. Pots, ledger, distributions ----------------------------------------
create table public.shake_pots (
  quality       text primary key check (quality in ('light_dep','indoor','exotic')),
  on_hand_grams numeric(12,2) not null default 0 check (on_hand_grams >= 0),
  updated_at    timestamptz not null default now()
);
insert into public.shake_pots(quality) values ('light_dep'), ('indoor'), ('exotic');

create table public.shake_ledger (
  id           uuid primary key default gen_random_uuid(),
  quality      text not null references public.shake_pots(quality),
  delta_grams  numeric(12,2) not null check (delta_grams <> 0),
  reason       text not null check (reason in ('shake_in','distribution','correction')),
  reference_id uuid,
  note         text,
  actor        uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  reversed_at  timestamptz,
  reversed_by  uuid references public.profiles(id)
);
-- One shake_in per client-supplied ref (guards double-submit / retries).
create unique index shake_ledger_shake_in_ref_idx
  on public.shake_ledger(reference_id) where reason = 'shake_in';
create index shake_ledger_quality_created_idx
  on public.shake_ledger(quality, created_at desc);

create table public.shake_distributions (
  id              uuid primary key default gen_random_uuid(),
  quality         text not null references public.shake_pots(quality),
  period_from     date not null,
  period_to       date not null,
  pot_grams       numeric(12,2) not null,   -- pot before this distribution
  total_grams     numeric(12,2) not null check (total_grams > 0),
  note            text,
  idempotency_key text unique,
  actor           uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  reversed_at     timestamptz,
  reversed_by     uuid references public.profiles(id),
  check (period_from <= period_to)
);
create index shake_distributions_quality_created_idx
  on public.shake_distributions(quality, created_at desc);

-- The share snapshot: every brand that could receive shake, with the sales
-- behind its share, so a distribution can always be explained later.
create table public.shake_distribution_brands (
  distribution_id uuid not null references public.shake_distributions(id) on delete cascade,
  site_id         uuid not null references public.sites(id) on delete restrict,
  sold_grams      numeric(14,2) not null,
  share           numeric(9,6)  not null,
  target_grams    numeric(12,2) not null,
  grams           numeric(12,2) not null,   -- what it actually received
  primary key (distribution_id, site_id)
);
create index shake_distribution_brands_site_idx on public.shake_distribution_brands(site_id);

create table public.shake_distribution_lines (
  id              uuid primary key default gen_random_uuid(),
  distribution_id uuid not null references public.shake_distributions(id) on delete cascade,
  site_id         uuid not null references public.sites(id) on delete restrict,
  child_sku_id    uuid not null references public.child_skus(id) on delete restrict,
  units           integer not null check (units > 0),
  grams_per_unit  numeric(8,2) not null,
  grams           numeric(12,2) not null
);
create index shake_distribution_lines_dist_idx on public.shake_distribution_lines(distribution_id);

-- Read-only to the app. Every write goes through the definer RPCs below.
alter table public.shake_pots                enable row level security;
alter table public.shake_ledger              enable row level security;
alter table public.shake_distributions       enable row level security;
alter table public.shake_distribution_brands enable row level security;
alter table public.shake_distribution_lines  enable row level security;

create policy shake_pots_read on public.shake_pots for select using (public.is_operator());
create policy shake_ledger_read on public.shake_ledger for select using (public.is_operator());
create policy shake_distributions_read on public.shake_distributions for select using (public.is_operator());
create policy shake_distribution_brands_read on public.shake_distribution_brands
  for select using (public.can_access_site(site_id));
create policy shake_distribution_lines_read on public.shake_distribution_lines
  for select using (public.can_access_site(site_id));

-- ---- 3. Classifying products -----------------------------------------------
create or replace function public.set_product_quality(
  p_product_ids uuid[],
  p_quality     text        -- null clears it
) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if not public.is_operator() then
    raise exception 'Not authorized to set product quality' using errcode = '42501';
  end if;
  if p_quality is not null and p_quality not in ('light_dep','indoor','exotic') then
    raise exception 'Unknown quality %', p_quality using errcode = 'check_violation';
  end if;
  if p_quality is null and exists (
       select 1 from public.products where id = any(p_product_ids) and is_shake) then
    raise exception 'A shake product needs a quality. Turn off "shake product" first.'
      using errcode = 'check_violation';
  end if;

  update public.products
     set quality = p_quality, updated_at = now()
   where id = any(p_product_ids)
     and quality is distinct from p_quality;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.set_product_is_shake(
  p_product_id uuid,
  p_is_shake   boolean
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_quality text;
begin
  if not public.is_operator() then
    raise exception 'Not authorized to change shake products' using errcode = '42501';
  end if;
  select quality into v_quality from public.products where id = p_product_id;
  if not found then
    raise exception 'Product % not found', p_product_id;
  end if;
  if p_is_shake and v_quality is null then
    raise exception 'Set the product''s quality before marking it as a shake product.'
      using errcode = 'check_violation';
  end if;
  update public.products set is_shake = p_is_shake, updated_at = now()
   where id = p_product_id;
end;
$$;

-- ---- 4. Adding shake to a pot ----------------------------------------------
create or replace function public.record_shake_in(
  p_quality text,
  p_grams   numeric,
  p_ref_id  uuid,
  p_note    text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  le public.shake_ledger;
  v  public.shake_pots;
begin
  if not public.is_operator() then
    raise exception 'Not authorized to record shake' using errcode = '42501';
  end if;
  if p_quality is null or p_quality not in ('light_dep','indoor','exotic') then
    raise exception 'Pick a quality (light dep, indoor or exotic).'
      using errcode = 'check_violation';
  end if;
  if p_grams is null or p_grams <= 0 then
    raise exception 'Shake grams must be positive (got %)', p_grams
      using errcode = 'check_violation';
  end if;

  if p_ref_id is not null then
    select * into le from public.shake_ledger
     where reason = 'shake_in' and reference_id = p_ref_id;
    if found then
      return jsonb_build_object(
        'ledger_id', le.id, 'quality', le.quality, 'grams', le.delta_grams,
        'pot_grams', (select on_hand_grams from public.shake_pots where quality = le.quality),
        'replayed', true);
    end if;
  end if;

  update public.shake_pots
     set on_hand_grams = on_hand_grams + p_grams, updated_at = now()
   where quality = p_quality
   returning * into v;

  insert into public.shake_ledger(quality, delta_grams, reason, reference_id, note, actor)
  values (p_quality, p_grams, 'shake_in', p_ref_id, nullif(btrim(p_note), ''), auth.uid())
  returning * into le;

  return jsonb_build_object(
    'ledger_id', le.id, 'quality', p_quality, 'grams', p_grams,
    'pot_grams', v.on_hand_grams, 'replayed', false);
end;
$$;

create or replace function public.reverse_shake_in(p_ledger_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  L public.shake_ledger;
  v public.shake_pots;
begin
  if not public.is_operator() then
    raise exception 'Not authorized to reverse shake' using errcode = '42501';
  end if;
  select * into L from public.shake_ledger where id = p_ledger_id for update;
  if L.id is null then
    raise exception 'Shake entry % not found', p_ledger_id;
  end if;
  if L.reason <> 'shake_in' then
    raise exception 'Only a shake entry can be undone here (this one is %).', L.reason;
  end if;
  if L.reversed_at is not null then
    raise exception 'This shake entry was already undone on %', L.reversed_at;
  end if;

  select * into v from public.shake_pots where quality = L.quality for update;
  if v.on_hand_grams < L.delta_grams then
    raise exception
      'Cannot undo % g: only % g left in the pot (the rest was already distributed).',
      L.delta_grams, v.on_hand_grams using errcode = 'check_violation';
  end if;

  update public.shake_pots
     set on_hand_grams = on_hand_grams - L.delta_grams, updated_at = now()
   where quality = L.quality
   returning * into v;

  insert into public.shake_ledger(quality, delta_grams, reason, reference_id, note, actor)
  values (L.quality, -L.delta_grams, 'correction', L.id,
          'Undo of shake entry ' || L.id::text, auth.uid());

  update public.shake_ledger set reversed_at = now(), reversed_by = auth.uid()
   where id = L.id;

  return jsonb_build_object('reversed_ledger_id', L.id, 'quality', L.quality,
    'removed_grams', L.delta_grams, 'pot_grams', v.on_hand_grams);
end;
$$;

-- ---- 5. Shares: grams sold of the quality, per brand -----------------------
-- A brand can receive shake only if it has an active shake product of this
-- quality with at least one sized variant. Its share = grams it sold of this
-- quality's (non-shake) products in fulfilled orders, Pacific days, divided by
-- all eligible brands' grams. A brand with a shake product but no sales gets 0.
create or replace function public.shake_brand_shares(
  p_quality text,
  p_from    date,
  p_to      date
) returns table (site_id uuid, site_name text, sold_grams numeric, share numeric)
language sql stable security definer
set search_path = ''
set timezone = 'America/Los_Angeles'
as $$
  with eligible as (
    select distinct cs.site_id
      from public.child_skus cs
      join public.products p on p.id = cs.product_id
     where p.is_shake and p.quality = p_quality
       and p.is_active and cs.is_active
       and cs.grams_per_unit is not null
  ),
  sold as (
    select o.site_id, sum(li.quantity * cs.grams_per_unit) as grams
      from public.orders o
      join public.order_line_items li on li.order_id = o.id
      join public.child_skus cs       on cs.id = li.child_sku_id
      join public.products p          on p.id = cs.product_id
     where o.status = 'fulfilled'
       and o.fulfilled_at >= p_from::timestamptz
       and o.fulfilled_at <  (p_to + 1)::timestamptz
       and o.site_id in (select e.site_id from eligible e)
       and p.quality = p_quality
       and not p.is_shake
       and cs.grams_per_unit is not null
     group by o.site_id
  ),
  tot as (select coalesce(sum(grams), 0) as g from sold)
  select e.site_id,
         s.name::text,
         coalesce(so.grams, 0)::numeric,
         case when t.g > 0 then round(coalesce(so.grams, 0) / t.g, 6) else 0 end::numeric
    from eligible e
    join public.sites s on s.id = e.site_id
    left join sold so on so.site_id = e.site_id
    cross join tot t
   where public.is_operator()
   order by 3 desc, 2;
$$;

-- Everything the distribution screen needs in one call.
create or replace function public.shake_distribution_preview(
  p_quality text,
  p_from    date,
  p_to      date
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_pot  numeric;
  v_last date;
  v_out  jsonb;
begin
  if not public.is_operator() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select on_hand_grams into v_pot from public.shake_pots where quality = p_quality;
  if v_pot is null then
    raise exception 'Unknown quality %', p_quality using errcode = 'check_violation';
  end if;
  select max(period_to) into v_last from public.shake_distributions
   where quality = p_quality and reversed_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
           'site_id',      b.site_id,
           'site_name',    b.site_name,
           'sold_grams',   b.sold_grams,
           'share',        b.share,
           'target_grams', floor(v_pot * b.share * 100) / 100,
           'variants', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'child_sku_id',   cs.id,
                      'product_name',   p.name,
                      'sku',            cs.sku,
                      'variant_label',  cs.variant_label,
                      'grams_per_unit', cs.grams_per_unit,
                      'on_hand',        coalesce(il.on_hand, 0))
                    order by cs.grams_per_unit, p.name), '[]'::jsonb)
               from public.child_skus cs
               join public.products p on p.id = cs.product_id
               left join public.inventory_levels il on il.child_sku_id = cs.id
              where cs.site_id = b.site_id
                and p.is_shake and p.quality = p_quality
                and p.is_active and cs.is_active
                and cs.grams_per_unit is not null
                and cs.delegates_to_child_sku_id is null))
         order by b.sold_grams desc, b.site_name), '[]'::jsonb)
    into v_out
    from public.shake_brand_shares(p_quality, p_from, p_to) b;

  return jsonb_build_object(
    'quality',          p_quality,
    'pot_grams',        v_pot,
    'period_from',      p_from,
    'period_to',        p_to,
    'last_period_to',   v_last,
    'total_sold_grams', (select coalesce(sum((x->>'sold_grams')::numeric), 0)
                           from jsonb_array_elements(v_out) x),
    'brands',           v_out);
end;
$$;

-- ---- 6. Distribute ---------------------------------------------------------
-- p_lines: [{"child_sku_id": uuid, "units": int}, ...]. Shares and targets are
-- recomputed here from the same sales the preview showed; each brand's grams
-- must stay within its target, so the split can't be changed from the screen.
create or replace function public.distribute_shake(
  p_quality         text,
  p_from            date,
  p_to              date,
  p_lines           jsonb,
  p_idempotency_key text default null,
  p_note            text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_pot    public.shake_pots;
  v_id     uuid;
  v_line   jsonb;
  v_child  uuid;
  v_units  integer;
  v_gpu    numeric;
  v_site   uuid;
  v_total  numeric := 0;
  v_sold   numeric;
  v_block  text := '';
  b        record;
begin
  if not public.is_operator() then
    raise exception 'Not authorized to distribute shake' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Pick a sales period (from on or before to).' using errcode = 'check_violation';
  end if;

  -- Idempotent replay.
  if p_idempotency_key is not null then
    select id into v_id from public.shake_distributions where idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('distribution_id', v_id, 'replayed', true,
        'total_grams', (select total_grams from public.shake_distributions where id = v_id),
        'pot_grams', (select on_hand_grams from public.shake_pots where quality = p_quality));
    end if;
  end if;

  select * into v_pot from public.shake_pots where quality = p_quality for update;
  if v_pot.quality is null then
    raise exception 'Unknown quality %', p_quality using errcode = 'check_violation';
  end if;

  create temp table _sd_brand on commit drop as
    select s.site_id, s.site_name, s.sold_grams, s.share,
           floor(v_pot.on_hand_grams * s.share * 100) / 100 as target_grams,
           0::numeric as grams
      from public.shake_brand_shares(p_quality, p_from, p_to) s;

  select coalesce(sum(sold_grams), 0) into v_sold from _sd_brand;
  if not exists (select 1 from _sd_brand) then
    raise exception 'No brand has a % shake product yet.', replace(p_quality, '_', ' ')
      using errcode = 'check_violation';
  end if;
  if v_sold <= 0 then
    raise exception 'No % sales in that period, so there is nothing to split by.',
      replace(p_quality, '_', ' ') using errcode = 'check_violation';
  end if;

  create temp table _sd_line (child_sku_id uuid, site_id uuid, units integer, gpu numeric)
    on commit drop;

  -- Pass 1: validate every line before any write.
  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_child := (v_line->>'child_sku_id')::uuid;
    v_units := coalesce((v_line->>'units')::integer, 0);
    if v_units < 0 then
      raise exception 'Units cannot be negative.' using errcode = 'check_violation';
    end if;
    continue when v_units = 0;

    select cs.site_id, cs.grams_per_unit into v_site, v_gpu
      from public.child_skus cs
      join public.products p on p.id = cs.product_id
     where cs.id = v_child and p.is_shake and p.quality = p_quality
       and p.is_active and cs.is_active
       and cs.delegates_to_child_sku_id is null;
    if v_site is null or v_gpu is null then
      raise exception 'SKU % is not a % shake product.', v_child, replace(p_quality, '_', ' ')
        using errcode = 'check_violation';
    end if;
    if not exists (select 1 from _sd_brand where site_id = v_site) then
      raise exception 'That brand cannot receive % shake.', replace(p_quality, '_', ' ')
        using errcode = 'check_violation';
    end if;

    insert into _sd_line values (v_child, v_site, v_units, v_gpu);
    update _sd_brand set grams = grams + v_units * v_gpu where site_id = v_site;
    v_total := v_total + v_units * v_gpu;
    v_site := null; v_gpu := null;
  end loop;

  if v_total <= 0 then
    raise exception 'Enter at least one unit to make.' using errcode = 'check_violation';
  end if;
  if v_total > v_pot.on_hand_grams then
    raise exception 'That uses % g but the pot only has % g.', v_total, v_pot.on_hand_grams
      using errcode = 'check_violation';
  end if;
  for b in select * from _sd_brand where grams > target_grams loop
    v_block := v_block || format(E'\n  - %s: %s g entered, share is %s g.',
                                 b.site_name, b.grams, b.target_grams);
  end loop;
  if length(v_block) > 0 then
    raise exception 'Over a brand''s share of the pot:%', v_block using errcode = 'check_violation';
  end if;

  -- Pass 2: write.
  begin
    insert into public.shake_distributions(quality, period_from, period_to, pot_grams,
                                           total_grams, note, idempotency_key, actor)
    values (p_quality, p_from, p_to, v_pot.on_hand_grams, v_total,
            nullif(btrim(p_note), ''), p_idempotency_key, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    select id into v_id from public.shake_distributions where idempotency_key = p_idempotency_key;
    return jsonb_build_object('distribution_id', v_id, 'replayed', true,
      'total_grams', (select total_grams from public.shake_distributions where id = v_id),
      'pot_grams', (select on_hand_grams from public.shake_pots where quality = p_quality));
  end;

  insert into public.shake_distribution_brands(distribution_id, site_id, sold_grams, share,
                                               target_grams, grams)
  select v_id, site_id, sold_grams, share, target_grams, grams from _sd_brand;

  for b in select * from _sd_line loop
    insert into public.shake_distribution_lines(distribution_id, site_id, child_sku_id,
                                                units, grams_per_unit, grams)
    values (v_id, b.site_id, b.child_sku_id, b.units, b.gpu, b.units * b.gpu);
    -- 'receipt' ledger row -> the outbound-sync trigger pushes the new stock.
    perform public.receive_stock(b.child_sku_id, b.units, 'shake_distribution', v_id,
                                 'Shake distribution');
  end loop;

  update public.shake_pots
     set on_hand_grams = on_hand_grams - v_total, updated_at = now()
   where quality = p_quality
   returning * into v_pot;

  insert into public.shake_ledger(quality, delta_grams, reason, reference_id, note, actor)
  values (p_quality, -v_total, 'distribution', v_id, nullif(btrim(p_note), ''), auth.uid());

  return jsonb_build_object(
    'distribution_id', v_id,
    'quality',         p_quality,
    'total_grams',     v_total,
    'pot_grams',       v_pot.on_hand_grams,
    'replayed',        false);
end;
$$;

create or replace function public.reverse_shake_distribution(p_distribution_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  D       public.shake_distributions;
  ln      record;
  il      public.inventory_levels;
  v_block text := '';
  v_pot   public.shake_pots;
begin
  if not public.is_operator() then
    raise exception 'Not authorized to undo a distribution' using errcode = '42501';
  end if;
  select * into D from public.shake_distributions where id = p_distribution_id for update;
  if D.id is null then
    raise exception 'Distribution % not found', p_distribution_id;
  end if;
  if D.reversed_at is not null then
    raise exception 'This distribution was already undone on %', D.reversed_at;
  end if;

  perform 1 from public.shake_pots where quality = D.quality for update;

  -- All-or-nothing: every unit must still be free to take back.
  for ln in
    select l.child_sku_id, sum(l.units)::integer as units, max(cs.sku) as sku
      from public.shake_distribution_lines l
      join public.child_skus cs on cs.id = l.child_sku_id
     where l.distribution_id = D.id
     group by l.child_sku_id
  loop
    il := public._inv_lock(ln.child_sku_id);
    if il.on_hand < ln.units or (il.on_hand - ln.units) < il.reserved then
      v_block := v_block || format(
        E'\n  - %s: %s made, but only %s free to take back.',
        coalesce(ln.sku, '(no SKU)'), ln.units, greatest(il.on_hand - il.reserved, 0));
    end if;
  end loop;
  if length(v_block) > 0 then
    raise exception 'Cannot undo - some units are already reserved or sold:%', v_block
      using errcode = 'check_violation';
  end if;

  for ln in
    select l.child_sku_id, l.units from public.shake_distribution_lines l
     where l.distribution_id = D.id
  loop
    perform public._inv_write(ln.child_sku_id, -ln.units, 0, 0,
      'correction', 'shake_distribution_reversal', D.id,
      'Undo of shake distribution ' || D.id::text);
  end loop;

  update public.shake_pots
     set on_hand_grams = on_hand_grams + D.total_grams, updated_at = now()
   where quality = D.quality
   returning * into v_pot;

  insert into public.shake_ledger(quality, delta_grams, reason, reference_id, note, actor)
  values (D.quality, D.total_grams, 'correction', D.id,
          'Undo of shake distribution ' || D.id::text, auth.uid());

  update public.shake_distributions set reversed_at = now(), reversed_by = auth.uid()
   where id = D.id;

  return jsonb_build_object('reversed_distribution_id', D.id, 'quality', D.quality,
    'restored_grams', D.total_grams, 'pot_grams', v_pot.on_hand_grams);
end;
$$;

-- ---- 7. Grants -------------------------------------------------------------
revoke all on function public.set_product_quality(uuid[], text)                  from public, anon;
revoke all on function public.set_product_is_shake(uuid, boolean)               from public, anon;
revoke all on function public.record_shake_in(text, numeric, uuid, text)        from public, anon;
revoke all on function public.reverse_shake_in(uuid)                            from public, anon;
revoke all on function public.shake_brand_shares(text, date, date)              from public, anon;
revoke all on function public.shake_distribution_preview(text, date, date)      from public, anon;
revoke all on function public.distribute_shake(text, date, date, jsonb, text, text) from public, anon;
revoke all on function public.reverse_shake_distribution(uuid)                  from public, anon;
grant execute on function public.set_product_quality(uuid[], text)              to authenticated;
grant execute on function public.set_product_is_shake(uuid, boolean)           to authenticated;
grant execute on function public.record_shake_in(text, numeric, uuid, text)    to authenticated;
grant execute on function public.reverse_shake_in(uuid)                        to authenticated;
grant execute on function public.shake_brand_shares(text, date, date)          to authenticated;
grant execute on function public.shake_distribution_preview(text, date, date)  to authenticated;
grant execute on function public.distribute_shake(text, date, date, jsonb, text, text) to authenticated;
grant execute on function public.reverse_shake_distribution(uuid)              to authenticated;

-- ---- 8. Brand billing: count distributed shake too -------------------------
-- Same function as 0114 with one change: shake_by_site adds the grams each
-- brand received from (non-undone) distributions made in the period.
create or replace function public.brand_billing_summary(
  p_from date,
  p_to   date,
  p_site uuid default null
)
returns table (
  site_id                  uuid,
  site_name                text,
  channel                  text,
  storefront               text,
  fulfilled_groups         bigint,
  open_groups              bigint,
  packaging                numeric,
  store_gap_groups         bigint,
  manual_gap_groups        bigint,
  mixed_channel_groups     bigint,
  orders                   bigint,
  units                    bigint,
  pick_fees                numeric,
  missing_fee_order_ids     uuid[],
  missing_fee_order_numbers text[],
  shake_grams              numeric
)
language sql stable security definer
set search_path = ''
set timezone = 'America/Los_Angeles'
set statement_timeout = '30s'
as $$
  with
    -- The one access check: a handful of sites, not every row.
    allowed as (
      select s.id
      from public.sites s
      where public.can_access_site(s.id)
        and (p_site is null or s.id = p_site)
    ),
    cost as (
      select c.*
      from public.storefront_fulfillment_cost_for_period(p_from, p_to, p_site) c
      where c.site_id in (select a.id from allowed a)
    ),
    cost_by_site as (
      select c.site_id,
             min(c.channel)    filter (where c.group_status = 'fulfilled') as channel,
             min(c.storefront) filter (where c.group_status = 'fulfilled') as storefront,
             count(*) filter (where c.group_status = 'fulfilled')          as fulfilled_groups,
             count(*) filter (where c.group_status <> 'fulfilled')         as open_groups,
             coalesce(sum(c.packaging_cost) filter (where c.group_status = 'fulfilled'), 0) as packaging,
             count(*) filter (where c.group_status = 'fulfilled' and c.packaging_cost = 0
                                and c.channel in ('shopify','woocommerce'))  as store_gap_groups,
             count(*) filter (where c.group_status = 'fulfilled' and c.packaging_cost = 0
                                and c.channel not in ('shopify','woocommerce')) as manual_gap_groups,
             count(*) filter (where c.group_status = 'fulfilled' and c.channel_count > 1) as mixed_channel_groups
      from cost c
      group by c.site_id
    ),
    -- Orders fulfilled in the period, Pacific days, allowed sites only.
    period_orders as (
      select o.id, o.site_id, o.status, o.order_number
      from public.orders o
      where o.fulfilled_at >= p_from::timestamptz
        and o.fulfilled_at <  (p_to + 1)::timestamptz
        and o.site_id in (select a.id from allowed a)
    ),
    charged as (
      select po.id as order_id, po.site_id, bc.amount
      from period_orders po
      join public.billing_charges bc on bc.order_id = po.id and bc.fee_type = 'pick_fee'
      where po.status <> 'cancelled'
    ),
    charged_units as (
      select ch.order_id, sum(li.quantity) as units
      from charged ch
      join public.order_line_items li on li.order_id = ch.order_id
      group by ch.order_id
    ),
    fees_by_site as (
      select ch.site_id,
             count(*)                        as orders,
             coalesce(sum(cu.units), 0)      as units,
             sum(ch.amount)                  as pick_fees
      from charged ch
      left join charged_units cu on cu.order_id = ch.order_id
      group by ch.site_id
    ),
    missing_by_site as (
      select po.site_id,
             array_agg(po.id           order by po.order_number desc) as ids,
             array_agg(po.order_number order by po.order_number desc) as numbers
      from period_orders po
      where po.status = 'fulfilled'
        and not exists (select 1 from public.billing_charges bc
                         where bc.order_id = po.id and bc.fee_type = 'pick_fee')
      group by po.site_id
    ),
    -- Shake per brand in the period (Pacific days), excluding undone entries:
    -- legacy shake tagged at allocation (0114) plus shake distributed to the
    -- brand from the quality pots (0117).
    shake_rows as (
      select l.site_id, -l.delta_grams as grams
      from public.parent_inventory_ledger l
      where l.reason = 'shake'
        and l.reversed_at is null
        and l.created_at >= p_from::timestamptz
        and l.created_at <  (p_to + 1)::timestamptz
        and l.site_id in (select a.id from allowed a)
      union all
      select db.site_id, db.grams
      from public.shake_distributions d
      join public.shake_distribution_brands db on db.distribution_id = d.id
      where d.reversed_at is null
        and db.grams > 0
        and d.created_at >= p_from::timestamptz
        and d.created_at <  (p_to + 1)::timestamptz
        and db.site_id in (select a.id from allowed a)
    ),
    shake_by_site as (
      select sr.site_id, sum(sr.grams) as grams
      from shake_rows sr
      group by sr.site_id
    ),
    all_sites as (
      select cs.site_id from cost_by_site cs
      union select fs.site_id from fees_by_site fs
      union select ms.site_id from missing_by_site ms
      union select sh.site_id from shake_by_site sh
    )
  select a.site_id,
         s.name::text,
         coalesce(cs.channel, 'manual')::text,
         cs.storefront::text,
         coalesce(cs.fulfilled_groups, 0),
         coalesce(cs.open_groups, 0),
         coalesce(cs.packaging, 0),
         coalesce(cs.store_gap_groups, 0),
         coalesce(cs.manual_gap_groups, 0),
         coalesce(cs.mixed_channel_groups, 0),
         coalesce(fs.orders, 0),
         coalesce(fs.units, 0)::bigint,
         coalesce(fs.pick_fees, 0),
         coalesce(ms.ids, '{}'),
         coalesce(ms.numbers, '{}'),
         coalesce(sh.grams, 0)
  from all_sites a
  join public.sites s          on s.id = a.site_id
  left join cost_by_site cs    on cs.site_id = a.site_id
  left join fees_by_site fs    on fs.site_id = a.site_id
  left join missing_by_site ms on ms.site_id = a.site_id
  left join shake_by_site sh   on sh.site_id = a.site_id
  order by s.name;
$$;

comment on function public.brand_billing_summary(date, date, uuid) is
  'Brand billing page in one call: per site for the period, fulfilled-group packaging (with gap / mixed-channel counts and open groups), pick fees with order and unit counts, the fulfilled orders missing a pick fee, and shake grams for the brand: legacy shake tagged at allocation (0114) plus shake distributed to it from the quality pots (0117). Pacific days. security definer since 0113: site access is checked once per site via can_access_site instead of per row through RLS (which made it time out); results are limited to the caller''s sites exactly as RLS would.';

revoke all on function public.brand_billing_summary(date, date, uuid) from public, anon;
grant execute on function public.brand_billing_summary(date, date, uuid) to authenticated;

commit;
