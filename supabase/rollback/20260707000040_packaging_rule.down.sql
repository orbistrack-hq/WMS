-- ============================================================================
-- Rollback 0040: drop the editable weight→packaging rule.
--
-- Restores the post-0039 state: the jar/bag threshold lives only in application
-- code again (JAR_MAX_GRAMS). Dropping the table takes its RLS policies and its
-- set_updated_at / audit_row triggers with it; the shared trigger functions from
-- 0001 are left intact.
-- ============================================================================

begin;

drop table if exists public.packaging_rule;

commit;
