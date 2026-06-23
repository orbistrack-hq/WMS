-- ============================================================================
-- WMS — Migration 0003: DOWN (reverses 0003_lock_inventory_door.up.sql)
-- Returns the functions to SECURITY INVOKER and restores direct write access.
-- ============================================================================

begin;

alter function public._inv_write(uuid,integer,integer,integer,text,text,uuid,text) security invoker reset search_path;
alter function public._inv_lock(uuid)                                              security invoker reset search_path;
alter function public.reserve_stock(uuid,integer,text,uuid)                        security invoker reset search_path;
alter function public.release_stock(uuid,integer,text,uuid)                        security invoker reset search_path;
alter function public.consume_stock(uuid,integer,text,uuid)                        security invoker reset search_path;
alter function public.layaway_book(uuid,integer,text,uuid)                         security invoker reset search_path;
alter function public.layaway_cancel(uuid,integer,text,uuid)                       security invoker reset search_path;
alter function public.layaway_consume(uuid,integer,text,uuid)                      security invoker reset search_path;
alter function public.receive_stock(uuid,integer,text,uuid,text)                   security invoker reset search_path;
alter function public.adjust_stock(uuid,integer,text,text,uuid)                    security invoker reset search_path;

grant execute on function public._inv_write(uuid,integer,integer,integer,text,text,uuid,text) to public;
grant execute on function public._inv_lock(uuid) to public;

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant insert, update, delete on public.inventory_levels to %I', r);
      execute format('grant insert, update, delete on public.inventory_ledger to %I', r);
    end if;
  end loop;
end $$;

commit;
