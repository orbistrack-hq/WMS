-- Rollback for migration 0103. Restores audit_row() to its original
-- full-snapshot behavior from migration 0001 (no diffing on UPDATE).

begin;

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

comment on function public.audit_row() is null;

commit;
