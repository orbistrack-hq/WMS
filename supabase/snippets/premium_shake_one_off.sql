-- ============================================================================
-- One-off: split the ~50 lb of untracked "premium" shake (a light dep / indoor
-- mix) into the Premium Shake products. Needs migration 0118 (premium pot).
--
--   Bud Club  45 lb = 20,430 g      Tsunami  5 lb = 2,270 g   (1 lb = 454 g)
--
-- Each brand's grams are spread evenly across its Premium Shake sizes (same
-- grams per size, whole bags only), then what's left tops up with the
-- biggest bag that still fits. Anything under the smallest bag stays in the
-- premium pot.
--
-- It is recorded exactly like a Shake screen split, so it:
--   * counts as shake on the brand billing report,
--   * shows under "Recent splits" on the Shake screen as "Premium",
--   * can be undone there (only while none of the bags have sold).
--
-- HOW TO RUN (Supabase SQL Editor, prod):
--   1. Run as is. v_apply is false: nothing is saved, and the error message
--      at the end is the PREVIEW (bags per size). That error is expected.
--   2. Bag the shake to match the preview.
--   3. Set v_apply := true and run again. It saves and the stores update.
--   Running it again after that does nothing (it checks for its own key).
-- ============================================================================

do $$
declare
  v_apply   boolean := false;                     -- <<< set true to save
  v_key     constant text := 'premium-shake-one-off-2026-11';
  v_note    constant text := 'Premium shake one-off (untracked light dep / indoor mix)';
  v_lb      constant numeric := 454;
  v_brands  constant jsonb := jsonb_build_object('BC-', 45, 'TSU-', 5);  -- SKU prefix -> lb
  v_skus    constant text[] := array[
    'BC-SHAKE-PREM14G', 'BC-SHAKE-PREM28G', 'BC-SHAKE-PREM-QP',
    'TSU-SHAKE-PREM14G', 'TSU-SHAKE-PREM28G', 'TSU-SHAKE-PREM-QP'];

  v_in      numeric;          -- grams going into the premium pot
  v_total   numeric := 0;     -- grams bagged
  v_id      uuid;
  v_today   date := (now() at time zone 'America/Los_Angeles')::date;
  v_summary text := '';
  b         record;
  s         record;
  v_target  numeric;
  v_per     numeric;
  v_left    numeric;
  v_n       integer;
begin
  if exists (select 1 from public.shake_distributions where idempotency_key = v_key) then
    raise notice 'Already done: the premium split (%) was saved earlier. Nothing changed.', v_key;
    return;
  end if;
  if not exists (select 1 from public.shake_pots where quality = 'premium') then
    raise exception 'The premium pot is missing. Push migration 0118 first.';
  end if;

  -- The SKUs must all exist, be active, sized and hold their own stock.
  if (select count(*) from public.child_skus
       where sku = any(v_skus) and is_active and grams_per_unit > 0
         and delegates_to_child_sku_id is null) <> array_length(v_skus, 1) then
    raise exception 'Expected % active, sized Premium Shake SKUs (%). Check the products.',
      array_length(v_skus, 1), array_to_string(v_skus, ', ');
  end if;

  -- 1/4 LB shake bags are 113.5 g (a quarter of a 454 g pound), like the other
  -- shake products. Only touches sizes still at 112 g with no stock.
  update public.child_skus cs
     set grams_per_unit = 113.5, updated_at = now()
   where cs.sku = any(v_skus) and cs.variant_label = '1/4 LB' and cs.grams_per_unit = 112
     and coalesce((select il.on_hand from public.inventory_levels il
                    where il.child_sku_id = cs.id), 0) = 0;

  -- Plan the bags per brand.
  create temp table _prem_line (
    site_id uuid, prefix text, child_sku_id uuid, sku text, gpu numeric, units integer
  ) on commit drop;
  create temp table _prem_brand (
    site_id uuid, prefix text, target numeric, grams numeric, share numeric
  ) on commit drop;

  v_in := 0;
  for b in select key as prefix, value::numeric as lb from jsonb_each_text(v_brands) loop
    v_target := b.lb * v_lb;
    v_in := v_in + v_target;

    insert into _prem_line(site_id, prefix, child_sku_id, sku, gpu, units)
    select cs.site_id, b.prefix, cs.id, cs.sku, cs.grams_per_unit, 0
      from public.child_skus cs
     where cs.sku = any(v_skus) and cs.sku like b.prefix || '%';

    if (select count(distinct site_id) from _prem_line where prefix = b.prefix) <> 1 then
      raise exception 'SKUs starting with % must all belong to one brand.', b.prefix;
    end if;

    -- Even grams per size, whole bags.
    v_per := v_target / (select count(*) from _prem_line where prefix = b.prefix);
    update _prem_line set units = floor(v_per / gpu) where prefix = b.prefix;

    -- Top up the rest with the biggest bag that fits, then smaller ones.
    v_left := v_target - (select sum(units * gpu) from _prem_line where prefix = b.prefix);
    for s in select * from _prem_line where prefix = b.prefix order by gpu desc loop
      v_n := floor(v_left / s.gpu);
      if v_n > 0 then
        update _prem_line set units = units + v_n where child_sku_id = s.child_sku_id;
        v_left := v_left - v_n * s.gpu;
      end if;
    end loop;

    insert into _prem_brand(site_id, prefix, target, grams)
    select site_id, b.prefix, v_target, sum(units * gpu)
      from _prem_line where prefix = b.prefix group by site_id;
  end loop;

  select sum(grams) into v_total from _prem_brand;
  update _prem_brand set share = round(target / v_in, 6);

  -- Into the premium pot, then out to the brands (same records as distribute_shake).
  update public.shake_pots set on_hand_grams = on_hand_grams + v_in, updated_at = now()
   where quality = 'premium';
  insert into public.shake_ledger(quality, delta_grams, reason, note)
  values ('premium', v_in, 'shake_in', v_note);

  insert into public.shake_distributions(quality, period_from, period_to, pot_grams,
                                         total_grams, note, idempotency_key)
  values ('premium', v_today, v_today,
          (select on_hand_grams from public.shake_pots where quality = 'premium'),
          v_total, v_note, v_key)
  returning id into v_id;

  -- sold_grams 0: this split is a fixed 45 / 5 lb, not by sales.
  insert into public.shake_distribution_brands(distribution_id, site_id, sold_grams, share,
                                               target_grams, grams)
  select v_id, site_id, 0, share, target, grams from _prem_brand;

  for s in select * from _prem_line where units > 0 order by prefix, gpu loop
    insert into public.shake_distribution_lines(distribution_id, site_id, child_sku_id,
                                                units, grams_per_unit, grams)
    values (v_id, s.site_id, s.child_sku_id, s.units, s.gpu, s.units * s.gpu);
    perform public.receive_stock(s.child_sku_id, s.units, 'shake_distribution', v_id,
                                 'Premium shake one-off');
    v_summary := v_summary || format(E'\n  %s: %s bags x %sg = %sg', s.sku, s.units,
                                     s.gpu, s.units * s.gpu);
  end loop;

  update public.shake_pots set on_hand_grams = on_hand_grams - v_total, updated_at = now()
   where quality = 'premium';
  insert into public.shake_ledger(quality, delta_grams, reason, reference_id, note)
  values ('premium', -v_total, 'distribution', v_id, v_note);

  for b in select * from _prem_brand order by target desc loop
    v_summary := v_summary || format(E'\n  %s total: %sg of %sg', rtrim(b.prefix, '-'),
                                     b.grams, b.target);
  end loop;
  v_summary := v_summary || format(E'\n  Left in the premium pot: %sg', v_in - v_total);

  if not v_apply then
    raise exception E'PREVIEW ONLY, nothing saved.%\nSet v_apply := true and run again to save.',
      v_summary;
  end if;
  raise notice E'Saved premium split %.%', v_id, v_summary;
end;
$$;
