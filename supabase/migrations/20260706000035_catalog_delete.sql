-- ============================================================================
-- WMS — Migration 0035: admin-only catalog delete (OrbisTrack)
--
-- Hard-delete a child SKU or a whole product from the catalog. This is for
-- removing genuine MISTAKES (a duplicate or wrongly-created entry) — not for
-- retiring a real SKU, which should be DEACTIVATED (is_active = false) so its
-- history stays intact.
--
-- Safety: deletion is blocked whenever the row carries real history. child_skus
-- and products are FK-referenced 'on delete restrict' by the ledgers, order
-- lines and allocations, so a delete is naturally impossible once stock has
-- moved. These functions pre-check the common cases and return a clear,
-- specific message ("on N orders", "has N movements", "has N child SKUs", …),
-- and wrap the delete so any other FK reference still fails safe with a generic
-- "referenced elsewhere; deactivate instead" rather than a raw Postgres error.
--
-- Authorization: ADMIN ONLY (is_admin()). SECURITY DEFINER. child_skus deletes
-- are captured by the existing audit trigger; product deletes are logged here.
-- ============================================================================

begin;

-- 1. delete_child_sku ---------------------------------------------------------
create or replace function public.delete_child_sku(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_sku   text;
  v_n     integer;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete from the catalog' using errcode = '42501';
  end if;

  select sku into v_sku from public.child_skus where id = p_id;
  if not found then
    raise exception 'Child SKU % not found', p_id;
  end if;

  select count(*) into v_n from public.order_line_items where child_sku_id = p_id;
  if v_n > 0 then
    raise exception 'This SKU is on % order line(s); deactivate it instead of deleting.', v_n
      using errcode = 'check_violation';
  end if;

  select count(*) into v_n from public.inventory_ledger where child_sku_id = p_id;
  if v_n > 0 then
    raise exception 'This SKU has % stock movement(s) on record; deactivate it instead.', v_n
      using errcode = 'check_violation';
  end if;

  select count(*) into v_n from public.allocation_lines where child_sku_id = p_id;
  if v_n > 0 then
    raise exception 'This SKU has % allocation(s) on record; deactivate it instead.', v_n
      using errcode = 'check_violation';
  end if;

  -- Delete (its zero inventory_levels row cascades; the audit trigger logs it).
  -- Any remaining FK reference (e.g. an outbound sync job) still blocks — catch
  -- it and return a friendly message rather than a raw error.
  begin
    delete from public.child_skus where id = p_id;
  exception when foreign_key_violation then
    raise exception 'This SKU is still referenced by other records; deactivate it instead.'
      using errcode = 'check_violation';
  end;

  return jsonb_build_object('deleted_child_sku_id', p_id, 'sku', v_sku);
end;
$$;

comment on function public.delete_child_sku(uuid) is
  'Admin-only hard delete of a child SKU. Blocked (clear message) if it has orders, stock movements, allocations, or any other reference; deactivate those instead. Audited.';

-- 2. delete_product -----------------------------------------------------------
create or replace function public.delete_product(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_row  jsonb;
  v_n    integer;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete from the catalog' using errcode = '42501';
  end if;

  select name, to_jsonb(p) into v_name, v_row from public.products p where id = p_id;
  if not found then
    raise exception 'Product % not found', p_id;
  end if;

  select count(*) into v_n from public.child_skus where product_id = p_id;
  if v_n > 0 then
    raise exception 'This product has % child SKU(s); delete or move them first.', v_n
      using errcode = 'check_violation';
  end if;

  select count(*) into v_n from public.parent_inventory_ledger where product_id = p_id;
  if v_n > 0 then
    raise exception 'This product has intake/allocation history; deactivate it instead.'
      using errcode = 'check_violation';
  end if;

  select count(*) into v_n from public.allocations where product_id = p_id;
  if v_n > 0 then
    raise exception 'This product has allocation history; deactivate it instead.'
      using errcode = 'check_violation';
  end if;

  -- products has no audit trigger, so log the delete explicitly first.
  insert into public.audit_log(table_name, record_id, action, actor, old_data)
  values ('products', p_id, 'DELETE', auth.uid(), v_row);

  begin
    delete from public.products where id = p_id;
  exception when foreign_key_violation then
    raise exception 'This product is still referenced by other records; deactivate it instead.'
      using errcode = 'check_violation';
  end;

  return jsonb_build_object('deleted_product_id', p_id, 'name', v_name);
end;
$$;

comment on function public.delete_product(uuid) is
  'Admin-only hard delete of a product. Blocked (clear message) if it still has child SKUs or any intake/allocation history; deactivate instead. Audited.';

-- 3. Grants: callable by the app; the admin check is enforced inside.
revoke execute on function public.delete_child_sku(uuid) from public;
revoke execute on function public.delete_product(uuid)  from public;
grant  execute on function public.delete_child_sku(uuid) to authenticated;
grant  execute on function public.delete_product(uuid)  to authenticated;

commit;
