-- ============================================================================
-- WMS — Migration 0043: "Shake" loss on the central pool (FB-4)
--
-- Shake = flower that falls off during packing and never reaches the customer.
-- At allocation time the team records how much shake there was; it is a pure
-- LOSS out of the CENTRAL parent pool (migration 0042) — grams leave the pool
-- and credit no child SKU. Recorded against the product + central pool, with an
-- OPTIONAL site tag (which team's packing shed it, for analytics only — it does
-- NOT re-introduce a pool site) and an OPTIONAL batch_no for traceability.
-- Always reversible.
--
--   record_shake(product, grams, ref, site?, batch?, note?) — idempotent on
--     `ref` (a client-supplied uuid): debit `grams` from the central pool as a
--     'shake' loss. Blocked if the pool doesn't hold that much. Any signed-in
--     user (ops action, mirrors intake/allocate).
--   reverse_shake(ledger_id) — credit the grams back and stamp the shake row
--     reversed. Admin/operator only, mirrors reverse_intake.
--   shake_report — one row per shake event (product, site tag, batch, grams
--     lost, reversed flag) for the loss analytics.
--
-- Reverse with rollback/20260707000043_shake_loss.down.sql.
-- ============================================================================

begin;

-- ---- 1. Ledger vocabulary + shake idempotency ------------------------------
alter table public.parent_inventory_ledger drop constraint parent_inventory_ledger_reason_check;
alter table public.parent_inventory_ledger add constraint parent_inventory_ledger_reason_check
  check (reason in ('intake','allocation','transfer','correction','shake'));

-- One shake movement per client-supplied ref (guards double-submit / retries).
create unique index parent_inventory_ledger_shake_ref_idx
  on public.parent_inventory_ledger(reference_id)
  where reason = 'shake';

-- ---- 2. record_shake -------------------------------------------------------
create or replace function public.record_shake(
  p_product_id uuid,
  p_grams      numeric,
  p_ref_id     uuid,
  p_site_id    uuid  default null,   -- optional analytics tag, NOT a pool site
  p_batch_no   text  default null,
  p_note       text  default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v  public.parent_inventory;
  le public.parent_inventory_ledger;
begin
  if p_product_id is null then
    raise exception 'record_shake: product is required';
  end if;
  if p_grams is null or p_grams <= 0 then
    raise exception 'record_shake: shake grams must be positive (got %)', p_grams
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'record_shake: product % not found', p_product_id;
  end if;
  if p_site_id is not null
     and not exists (select 1 from public.sites where id = p_site_id) then
    raise exception 'record_shake: site % not found', p_site_id;
  end if;

  -- Idempotent replay: same ref => return the prior result, no second debit.
  if p_ref_id is not null then
    select * into le from public.parent_inventory_ledger
     where reason = 'shake' and reference_id = p_ref_id;
    if found then
      return jsonb_build_object(
        'ledger_id',     le.id,
        'product_id',    p_product_id,
        'shake_grams',   -le.delta_grams,
        'on_hand_grams', (select on_hand_grams from public.parent_inventory
                            where product_id = p_product_id),
        'replayed',      true);
    end if;
  end if;

  v := public._parent_inv_lock(p_product_id);
  if v.on_hand_grams < p_grams then
    raise exception
      'Cannot record % g of shake: only % g available in the central pool.',
      p_grams, v.on_hand_grams using errcode = 'check_violation';
  end if;

  -- Debit the pool as a loss. Written directly (not via _parent_inv_write) so
  -- the optional site tag lands on the ledger row; this function is SECURITY
  -- DEFINER, so the "locked door" on direct writes still holds for API roles.
  update public.parent_inventory
     set on_hand_grams = on_hand_grams - p_grams, updated_at = now()
   where product_id = p_product_id
   returning * into v;

  insert into public.parent_inventory_ledger(
    product_id, site_id, delta_grams, reason,
    reference_type, reference_id, batch_no, note, actor)
  values (p_product_id, p_site_id, -p_grams, 'shake',
    'shake', p_ref_id, p_batch_no, p_note, auth.uid())
  returning * into le;

  return jsonb_build_object(
    'ledger_id',     le.id,
    'product_id',    p_product_id,
    'shake_grams',   p_grams,
    'on_hand_grams', v.on_hand_grams,
    'replayed',      false);
end;
$$;

comment on function public.record_shake(uuid,numeric,uuid,uuid,text,text) is
  'Record packing shake as a loss out of the central parent pool (no child credit). Idempotent on the ref uuid; optional site tag + batch for analytics/traceability. Blocked if the pool lacks the grams.';

-- ---- 3. reverse_shake ------------------------------------------------------
create or replace function public.reverse_shake(p_ledger_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  L public.parent_inventory_ledger;
  v public.parent_inventory;
begin
  if public.app_role() not in ('admin','operator') then
    raise exception 'Not authorized to reverse shake' using errcode = '42501';
  end if;

  select * into L from public.parent_inventory_ledger where id = p_ledger_id for update;
  if L.id is null then
    raise exception 'Shake entry % not found', p_ledger_id;
  end if;
  if L.reason <> 'shake' then
    raise exception 'Ledger entry % is not a shake loss (it is %)', p_ledger_id, L.reason;
  end if;
  if L.reversed_at is not null then
    raise exception 'This shake was already reversed on %', L.reversed_at;
  end if;

  -- delta_grams is negative (a debit); credit the same magnitude back.
  v := public._parent_inv_write(
         L.product_id, -L.delta_grams, 0,
         'correction', 'shake_reversal', L.id, L.batch_no,
         'Reversal of shake ' || L.id::text);

  update public.parent_inventory_ledger
     set reversed_at = now(), reversed_by = auth.uid()
   where id = L.id;

  return jsonb_build_object(
    'reversed_ledger_id', L.id, 'product_id', L.product_id,
    'restored_grams', -L.delta_grams, 'on_hand_grams', v.on_hand_grams);
end;
$$;

comment on function public.reverse_shake(uuid) is
  'Undo a recorded shake loss: credit its grams back to the central pool and stamp the shake reversed. Admin/operator only; audited.';

-- ---- 4. Grants -------------------------------------------------------------
revoke execute on function public.record_shake(uuid,numeric,uuid,uuid,text,text) from public;
grant  execute on function public.record_shake(uuid,numeric,uuid,uuid,text,text) to authenticated;
revoke execute on function public.reverse_shake(uuid) from public;
grant  execute on function public.reverse_shake(uuid) to authenticated;

-- ---- 5. Shake loss report --------------------------------------------------
create view public.shake_report with (security_invoker = true) as
select l.id            as ledger_id,
       l.product_id,
       p.name          as product_name,
       l.site_id,
       s.name          as site_name,
       l.batch_no,
       (-l.delta_grams) as grams_lost,
       l.note,
       l.created_at,
       l.reversed_at,
       l.actor
from public.parent_inventory_ledger l
join public.products p on p.id = l.product_id
left join public.sites s on s.id = l.site_id
where l.reason = 'shake';

comment on view public.shake_report is
  'One row per packing-shake loss: product, optional site tag, batch, grams lost, and whether it was reversed. Drives loss analytics. Readable by any signed-in user.';

grant select on public.shake_report to authenticated;

commit;
