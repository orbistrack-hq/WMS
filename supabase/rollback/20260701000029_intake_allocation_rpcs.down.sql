-- ============================================================================
-- Rollback for migration 0029 — intake + allocation RPCs.
-- ============================================================================

begin;

drop function if exists public.allocate_parent_stock(uuid,uuid,jsonb,text,text);
drop function if exists public.intake_receive(uuid,uuid,numeric,text,text,text);

commit;
