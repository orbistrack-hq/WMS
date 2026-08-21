-- Rollback for migration 0095. Net-new function; simply drop it.

begin;

drop function if exists public.fulfill_cancelled_order(uuid, text, timestamptz);

commit;
