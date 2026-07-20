-- ============================================================================
-- WMS — Migration 0078: stock transfer between sites (finished child-SKU units)
--
-- Move on-hand units of a finished child SKU from one site to the SAME parent
-- product's child SKU at another site. Child SKUs are per-site, so a transfer
-- is a paired inventory move: source loses N units, destination gains N — both
-- written through the guarded _inv_write path, so each site gets its own ledger
-- rows and (via the 0026 tg_enqueue_outbound_inventory trigger on
-- inventory_levels) its own coalesced, idempotent outbound store push. Nothing
-- here touches store-sync directly.
--
-- Design (confirmed):
--   * Finished units only. Parent BULK is a single central pool since 0043, so
--     "bulk between sites" is already reverse_allocation + allocate_parent_stock
--     and is intentionally out of scope here.
--   * INSTANT one-step (no in-transit state).
--   * Destination child SKU MUST already exist — no auto-create. Both children
--     must belong to the same product_id.
--   * Only AVAILABLE stock moves (on_hand - reserved); reserved units backing an
--     open order at the source can never be shipped away.
--   * Destination keeps its OWN cost. If source/dest unit cost differs, or the
--     normalized SKUs differ, transfer_stock refuses UNLESS p_ack_warnings is
--     true, and reports the reasons (custom SQLSTATE 'WMS01') so the UI can show
--     a confirm dialog rather than hard-block.
--   * Idempotent by optional idempotency_key on the stock_transfers header.
--   * Reversible operation: reverse_stock_transfer undoes a move (audit-safe).
--
-- Reverse with rollback/20260720000078_stock_transfer.down.sql.
-- ============================================================================

begin;

-- ---- 1. Ledger reason: add transfer_out / transfer_in ----------------------
-- Preserve the full current list (last set in 0041) and extend it.
alter table public.inventory_ledger drop constraint inventory_ledger_reason_check;
alter table public.inventory_ledger add constraint inventory_ledger_reason_check
  check (reason in (
    'order_reserve','order_release','order_consume',
    'layaway_remove','layaway_cancel','layaway_consume',
    'manual_adjustment','receipt','correction',
    'shopify_sync',
    'order_return',
    'transfer_out','transfer_in'));

-- ---- 2. Transfer header ----------------------------------------------------
-- One row per transfer (single source child -> single dest child, N units).
-- The two inventory_ledger rows reference this via ('stock_transfer', id).
create table public.stock_transfers (
  id                 uuid primary key default gen_random_uuid(),
  product_id         uuid not null references public.products(id)   on delete restrict,
  source_child_sku_id uuid not null references public.child_skus(id) on delete restrict,
  dest_child_sku_id   uuid not null references public.child_skus(id) on delete restrict,
  source_site_id     uuid not null references public.sites(id)      on delete restrict,
  dest_site_id       uuid not null references public.sites(id)      on delete restrict,
  units              integer not null check (units > 0),
  note               text,
  warnings           text[] not null default '{}',  -- acknowledged mismatch reasons, if any
  idempotency_key    text unique,                    -- guards double-submit; many nulls ok
  actor              uuid references public.profiles(id),
  created_at         timestamptz not null default now(),
  reversed_at        timestamptz,
  reversed_by        uuid references public.profiles(id),
  reversal_note      text,
  check (source_child_sku_id <> dest_child_sku_id),
  check (source_site_id      <> dest_site_id)
);
create index stock_transfers_source_idx on public.stock_transfers(source_child_sku_id, created_at);
create index stock_transfers_dest_idx   on public.stock_transfers(dest_child_sku_id, created_at);
create index stock_transfers_product_idx on public.stock_transfers(product_id, created_at);

comment on table public.stock_transfers is
  'Header for a finished-unit stock transfer between two sites'' child SKUs of '
  'the same product (migration 0078). The paired inventory_ledger rows '
  '(transfer_out on source, transfer_in on dest) reference (stock_transfer, id). '
  'warnings records acknowledged cost/SKU mismatches at the time of transfer.';

alter table public.stock_transfers enable row level security;

-- Read scoped to either endpoint's site (operators/managers/admins pass through
-- can_access_site for any site; clients need access to source or dest). Writes
-- go only through the SECURITY DEFINER RPCs below.
create policy stock_transfers_read on public.stock_transfers for select
  using (public.can_access_site(source_site_id)
      or public.can_access_site(dest_site_id));

-- ---- 3. Warning helper -----------------------------------------------------
-- Returns the list of soft-warning reasons for a proposed transfer, empty when
-- source and dest look equivalent. Normalized-SKU comparison reuses _sku_norm
-- (migration 0076). STABLE, no writes; callable for a pre-submit preview.
create or replace function public.transfer_warnings(
  p_source_child uuid, p_dest_child uuid
) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.child_skus;
  d public.child_skus;
  w text[] := '{}';
begin
  select * into s from public.child_skus where id = p_source_child;
  select * into d from public.child_skus where id = p_dest_child;
  if s.id is null or d.id is null then
    return w;  -- existence is enforced (harder) by transfer_stock itself
  end if;
  if s.cost is distinct from d.cost then
    w := w || format('Unit cost differs: source %s vs destination %s',
                     to_char(s.cost, 'FM999999990.00'), to_char(d.cost, 'FM999999990.00'));
  end if;
  if public._sku_norm(s.sku) is distinct from public._sku_norm(d.sku) then
    w := w || format('SKUs differ: %s vs %s',
                     coalesce(s.sku, '(none)'), coalesce(d.sku, '(none)'));
  end if;
  return w;
end;
$$;

-- ---- 4. transfer_stock -----------------------------------------------------
-- Moves p_units AVAILABLE units source -> dest. Returns the header id.
-- Raises 'WMS01' with the warning list when mismatches exist and not acked.
create or replace function public.transfer_stock(
  p_source_child   uuid,
  p_dest_child     uuid,
  p_units          integer,
  p_note           text    default null,
  p_ack_warnings   boolean default false,
  p_idempotency_key text   default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.child_skus;
  d public.child_skus;
  lv public.inventory_levels;
  w  text[];
  v_id uuid;
  v_existing public.stock_transfers;
begin
  -- Idempotent replay: same key => return the prior transfer, move nothing.
  if p_idempotency_key is not null then
    select * into v_existing from public.stock_transfers
      where idempotency_key = p_idempotency_key;
    if found then return v_existing.id; end if;
  end if;

  if p_units is null or p_units <= 0 then
    raise exception 'transfer units must be positive (got %)', p_units
      using errcode = 'check_violation';
  end if;
  if p_source_child = p_dest_child then
    raise exception 'source and destination SKU must differ'
      using errcode = 'check_violation';
  end if;

  select * into s from public.child_skus where id = p_source_child;
  if s.id is null then raise exception 'source SKU % not found', p_source_child; end if;
  select * into d from public.child_skus where id = p_dest_child;
  if d.id is null then
    raise exception 'Destination SKU does not exist. Create the product at the destination site first.'
      using errcode = 'no_data_found';
  end if;

  -- Same parent product on both ends.
  if s.product_id <> d.product_id then
    raise exception 'Transfer must be between child SKUs of the same product (% vs %)',
      s.product_id, d.product_id using errcode = 'check_violation';
  end if;
  if s.site_id = d.site_id then
    raise exception 'source and destination are the same site'
      using errcode = 'check_violation';
  end if;

  -- Both ends must actually hold inventory.
  if not coalesce(s.track_inventory, true) or not coalesce(d.track_inventory, true) then
    raise exception 'Cannot transfer a non-inventory (service/fee) SKU'
      using errcode = 'check_violation';
  end if;

  -- Neither end may be a BOGO shared-stock twin (transfer the paid SKU instead).
  if public._stock_sku(p_source_child) <> p_source_child then
    raise exception 'Source SKU % shares stock with % — transfer the paid SKU instead',
      p_source_child, public._stock_sku(p_source_child) using errcode = 'check_violation';
  end if;
  if public._stock_sku(p_dest_child) <> p_dest_child then
    raise exception 'Destination SKU % shares stock with % — transfer into the paid SKU instead',
      p_dest_child, public._stock_sku(p_dest_child) using errcode = 'check_violation';
  end if;

  -- Access: caller must reach BOTH sites (operators/managers/admins always do).
  if not (public.can_access_site(s.site_id) and public.can_access_site(d.site_id)) then
    raise exception 'You do not have access to both the source and destination sites'
      using errcode = 'insufficient_privilege';
  end if;

  -- Soft warnings: cost / SKU mismatch. Refuse unless acknowledged.
  w := public.transfer_warnings(p_source_child, p_dest_child);
  if array_length(w, 1) is not null and not p_ack_warnings then
    raise exception 'WARN: %', array_to_string(w, ' | ') using errcode = 'WMS01';
  end if;

  -- Lock source, ensure only AVAILABLE units move (never reserved).
  lv := public._inv_lock(p_source_child);
  if lv.on_hand - lv.reserved < p_units then
    raise exception 'Insufficient available stock at source: available %, requested %',
      lv.on_hand - lv.reserved, p_units using errcode = 'check_violation';
  end if;

  insert into public.stock_transfers(
    id, product_id, source_child_sku_id, dest_child_sku_id,
    source_site_id, dest_site_id, units, note, warnings, idempotency_key, actor)
  values (
    gen_random_uuid(), s.product_id, p_source_child, p_dest_child,
    s.site_id, d.site_id, p_units, nullif(trim(coalesce(p_note, '')), ''),
    coalesce(w, '{}'), p_idempotency_key, auth.uid())
  returning id into v_id;

  -- Paired move. reference = ('stock_transfer', header id) on both legs.
  perform public._inv_write(p_source_child, -p_units, 0, 0,
            'transfer_out', 'stock_transfer', v_id, p_note);
  perform public._inv_write(p_dest_child,   p_units, 0, 0,
            'transfer_in',  'stock_transfer', v_id, p_note);

  -- New units at the destination may satisfy waiting backorders.
  perform public.promote_backorders(p_dest_child);

  return v_id;
end;
$$;

comment on function public.transfer_stock(uuid,uuid,integer,text,boolean,text) is
  'Move p_units AVAILABLE units of a finished child SKU to the same product''s '
  'child SKU at another site (migration 0078). Guards: same product, both sites '
  'reachable, both stock-tracked, not BOGO twins, units <= source available. '
  'Raises SQLSTATE WMS01 with the reasons when cost/SKU differ and p_ack_warnings '
  'is false. Idempotent on p_idempotency_key. Returns the stock_transfers id.';

-- ---- 5. reverse_stock_transfer --------------------------------------------
-- Undo a transfer: credit the source, debit the destination. Blocked if the
-- destination no longer has enough free (unreserved) units to give back.
create or replace function public.reverse_stock_transfer(
  p_transfer_id uuid, p_note text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t  public.stock_transfers;
  lv public.inventory_levels;
begin
  select * into t from public.stock_transfers where id = p_transfer_id for update;
  if t.id is null then raise exception 'transfer % not found', p_transfer_id; end if;
  if t.reversed_at is not null then
    raise exception 'transfer % is already reversed', p_transfer_id
      using errcode = 'check_violation';
  end if;

  -- Reversal is a privileged correction: admin or manager only.
  if not (public.app_role() in ('admin','manager')) then
    raise exception 'Only an admin or manager can reverse a transfer'
      using errcode = 'insufficient_privilege';
  end if;

  -- The destination must still hold the units free to return them.
  lv := public._inv_lock(t.dest_child_sku_id);
  if lv.on_hand - lv.reserved < t.units then
    raise exception 'Cannot reverse: destination available % is below the % transferred',
      lv.on_hand - lv.reserved, t.units using errcode = 'check_violation';
  end if;

  perform public._inv_write(t.dest_child_sku_id, -t.units, 0, 0,
            'transfer_out', 'stock_transfer_reversal', t.id, p_note);
  perform public._inv_write(t.source_child_sku_id, t.units, 0, 0,
            'transfer_in',  'stock_transfer_reversal', t.id, p_note);
  perform public.promote_backorders(t.source_child_sku_id);

  update public.stock_transfers
     set reversed_at = now(), reversed_by = auth.uid(),
         reversal_note = nullif(trim(coalesce(p_note, '')), '')
   where id = t.id;

  return t.id;
end;
$$;

comment on function public.reverse_stock_transfer(uuid,text) is
  'Undo a stock_transfer (migration 0078): credit the source, debit the '
  'destination, mark reversed. Admin/manager only. Blocked if the destination '
  'no longer has enough free units to return.';

-- ---- 6. Lock the doors -----------------------------------------------------
revoke execute on function public.transfer_warnings(uuid,uuid)                       from public;
revoke execute on function public.transfer_stock(uuid,uuid,integer,text,boolean,text) from public;
revoke execute on function public.reverse_stock_transfer(uuid,text)                  from public;
grant  execute on function public.transfer_warnings(uuid,uuid)                       to authenticated;
grant  execute on function public.transfer_stock(uuid,uuid,integer,text,boolean,text) to authenticated;
grant  execute on function public.reverse_stock_transfer(uuid,text)                  to authenticated;

grant select on public.stock_transfers to authenticated;

commit;
