-- Down: migration 0073 (demote_to_pending_payment)
begin;
drop function if exists public.demote_to_pending_payment(uuid);
commit;
