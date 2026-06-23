-- ============================================================================
-- WMS — Migration 0003: lock the inventory door
--
-- After this migration the ONLY way to change inventory_levels / inventory_ledger
-- is through the guarded transition functions. A stray
-- `update inventory_levels set on_hand = 9999` from app code is rejected, so the
-- materialized levels can never silently drift from the ledger.
--
-- How: the transition primitives become SECURITY DEFINER (run with the owner's
-- rights), and INSERT/UPDATE/DELETE on the two tables is revoked from the app
-- roles. The internal writer (_inv_write) and lock helper (_inv_lock) have
-- EXECUTE revoked too, so callers can't bypass the guards by invoking the raw
-- writer — only the owner-context primitives can reach it.
--
-- Reads are unaffected: app roles keep SELECT (governed by RLS) so the UI can
-- still show stock. search_path is pinned to '' on every definer function
-- (all object references are already schema-qualified) to close the classic
-- search_path hijack vector.
-- ============================================================================

begin;

-- 1. Promote the primitives to SECURITY DEFINER with a pinned search_path.
alter function public._inv_write(uuid,integer,integer,integer,text,text,uuid,text) security definer set search_path = '';
alter function public._inv_lock(uuid)                                              security definer set search_path = '';
alter function public.reserve_stock(uuid,integer,text,uuid)                        security definer set search_path = '';
alter function public.release_stock(uuid,integer,text,uuid)                        security definer set search_path = '';
alter function public.consume_stock(uuid,integer,text,uuid)                        security definer set search_path = '';
alter function public.layaway_book(uuid,integer,text,uuid)                         security definer set search_path = '';
alter function public.layaway_cancel(uuid,integer,text,uuid)                       security definer set search_path = '';
alter function public.layaway_consume(uuid,integer,text,uuid)                      security definer set search_path = '';
alter function public.receive_stock(uuid,integer,text,uuid,text)                   security definer set search_path = '';
alter function public.adjust_stock(uuid,integer,text,text,uuid)                    security definer set search_path = '';

-- 2. Revoke direct writes on the inventory tables from every app role.
revoke insert, update, delete on public.inventory_levels from public;
revoke insert, update, delete on public.inventory_ledger from public;
do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke insert, update, delete on public.inventory_levels from %I', r);
      execute format('revoke insert, update, delete on public.inventory_ledger from %I', r);
    end if;
  end loop;
end $$;

-- 3. Seal the raw writer and lock helper so the guards can't be bypassed.
--    (The definer primitives run as owner, so they can still call these.)
revoke execute on function public._inv_write(uuid,integer,integer,integer,text,text,uuid,text) from public;
revoke execute on function public._inv_lock(uuid) from public;
do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function public._inv_write(uuid,integer,integer,integer,text,text,uuid,text) from %I', r);
      execute format('revoke execute on function public._inv_lock(uuid) from %I', r);
    end if;
  end loop;
end $$;

commit;
