-- ============================================================================
-- WMS — Migration 0065: let operators/managers delete packaging lines
--
-- Bug: a manager who accidentally added a packaging line to an order could not
-- remove it. The Remove button "worked" (no error) but deleted nothing.
--
-- Cause: packaging_usage is asymmetric. INSERT/UPDATE are site-scoped
-- (can_access_site — open to admin/operator/manager, and site-scoped clients),
-- but DELETE was admin-only (migration 0004):
--     create policy packaging_usage_delete ... for delete using (is_admin());
-- For a non-admin, the RLS USING clause is false, so the DELETE matches zero
-- rows. PostgREST returns success with 0 rows affected — a silent no-op, no
-- 42501. Hence "the button does nothing, no error message".
--
-- Fix: allow OPERATOR-LEVEL staff (admin/operator/manager, via is_operator())
-- to delete packaging lines — symmetric with add/edit, and in keeping with the
-- system being forgiving of human error at the packing bench. Every delete is
-- still captured by the a_packaging_usage audit trigger.
--
-- Scope note: we intentionally use is_operator() rather than can_access_site().
-- can_access_site() also grants site-scoped CLIENT (brand) accounts, and
-- packaging usage feeds storefront billing/reimbursement — a brand should not be
-- able to delete the packaging it is billed for. Ops staff correct mistakes;
-- clients do not.
--
-- Reverse with rollback/20260713000065_packaging_usage_delete_operator.down.sql.
-- ============================================================================

begin;

drop policy if exists packaging_usage_delete on public.packaging_usage;
create policy packaging_usage_delete on public.packaging_usage
  for delete using (public.is_operator());

commit;
