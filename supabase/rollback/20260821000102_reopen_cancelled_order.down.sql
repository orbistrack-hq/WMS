-- Rollback for migration 0102. Net-new function; simply drop it.

begin;

drop function if exists public.reopen_cancelled_order(uuid, boolean);

commit;
