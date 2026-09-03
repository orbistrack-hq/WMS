-- ============================================================================
-- WMS — Migration 0103: audit_log diff snapshots
--
-- WHY. audit_row() (migration 0001) writes a FULL to_jsonb(old) and
-- to_jsonb(new) row snapshot on every UPDATE, across all 7 audited tables
-- (orders, order_line_items, fulfillment_groups, shipments, billing_charges,
-- child_skus, packaging_usage). Most UPDATE statements only touch a handful
-- of columns, so the unchanged columns get duplicated in full on every row —
-- that's the dominant driver of audit_log's size (335MB on a site under 90
-- days old, well within Supabase's free-plan storage cap). Nothing in the app
-- reads audit_log (verified — it's write-only from the UI's perspective), so
-- there's no display behavior to preserve here, only the historical record.
--
-- WHAT. audit_row() now stores, for UPDATE only, just the keys whose value
-- actually changed: old_data holds those keys' old values, new_data holds
-- their new values. INSERT and DELETE are unchanged (new_data on INSERT and
-- old_data on DELETE are already the minimum needed — there's nothing to
-- diff against on the missing side). Does not touch existing rows — see
-- supabase/snippets/shrink_audit_log.sql to backfill/compact history.
-- ============================================================================

begin;

create or replace function public.audit_row()
returns trigger language plpgsql security definer as $$
declare
  v_actor uuid := auth.uid();
  v_old jsonb;
  v_new jsonb;
  v_old_diff jsonb;
  v_new_diff jsonb;
  v_id  uuid;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_id  := coalesce(v_old->>'id', v_old->>'child_sku_id')::uuid;
    insert into public.audit_log(table_name, record_id, action, actor, old_data, new_data)
    values (tg_table_name, v_id, tg_op, v_actor, v_old, null);
    return old;
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    select coalesce(jsonb_object_agg(key, v_old -> key), '{}'::jsonb)
      into v_old_diff
      from jsonb_object_keys(v_old) as key
      where v_old -> key is distinct from v_new -> key;
    select coalesce(jsonb_object_agg(key, v_new -> key), '{}'::jsonb)
      into v_new_diff
      from jsonb_object_keys(v_new) as key
      where v_old -> key is distinct from v_new -> key;
    v_id := coalesce(v_new->>'id', v_new->>'child_sku_id')::uuid;
    insert into public.audit_log(table_name, record_id, action, actor, old_data, new_data)
    values (tg_table_name, v_id, tg_op, v_actor, v_old_diff, v_new_diff);
    return new;
  else
    v_new := to_jsonb(new);
    v_id  := coalesce(v_new->>'id', v_new->>'child_sku_id')::uuid;
    insert into public.audit_log(table_name, record_id, action, actor, old_data, new_data)
    values (tg_table_name, v_id, tg_op, v_actor, null, v_new);
    return new;
  end if;
end;
$$;

comment on function public.audit_row() is
  'Generic audit trigger. INSERT/DELETE store the full row (new_data / old_data respectively — nothing to diff against). UPDATE stores only the columns that changed, in both old_data and new_data, to avoid duplicating unchanged columns on every row (migration 0103).';

commit;
