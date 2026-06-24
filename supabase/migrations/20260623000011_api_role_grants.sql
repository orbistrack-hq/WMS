-- ============================================================================
-- WMS — Migration 0011: explicit API-role grants
--
-- The earlier migrations enable RLS and write policies but never GRANT table
-- privileges to the API role, relying on Supabase's default-privilege auto-
-- grant. In environments where that default isn't in effect, the `authenticated`
-- role has no privileges and every read fails with "permission denied for
-- table/view ...". This migration makes the grants explicit so the app works
-- the same way on any Postgres, not just one pre-wired by the platform.
--
-- Layering is unchanged: GRANT is the table-privilege layer; RLS (already in
-- place) is the row layer. A request must pass BOTH. We grant broadly and let
-- the existing policies do the gating. The inventory "locked door" from
-- migration 0003 is preserved — direct writes to inventory_levels /
-- inventory_ledger stay revoked, and the raw writer/lock helpers stay sealed.
-- ============================================================================

begin;

grant usage on schema public to authenticated;

-- Reads: all tables AND views (value-at-cost reports, payment summary, etc.).
-- RLS decides which rows come back.
grant select on all tables in schema public to authenticated;

-- Writes: gated by the existing RLS write policies. Inventory tables are
-- re-locked immediately below.
grant insert, update, delete on all tables in schema public to authenticated;

-- Sequences (e.g. order_number_seq) — needed because create_order inserts as
-- the calling role and the order_number default calls nextval().
grant usage, select on all sequences in schema public to authenticated;

-- RPCs. Functions default to PUBLIC execute, but make it explicit in case the
-- platform stripped that default, then re-seal the raw inventory primitives so
-- the guards can't be bypassed (mirrors migration 0003).
grant execute on all functions in schema public to authenticated;
revoke execute on function public._inv_write(uuid,integer,integer,integer,text,text,uuid,text) from authenticated;
revoke execute on function public._inv_lock(uuid) from authenticated;

-- Preserve the inventory locked door (migration 0003): the ONLY way to change
-- these tables is through the SECURITY DEFINER transition functions.
revoke insert, update, delete on public.inventory_levels from authenticated;
revoke insert, update, delete on public.inventory_ledger from authenticated;

-- Future objects created by the migration role inherit the same grants, so new
-- tables don't silently lose API access.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;
alter default privileges in schema public
  grant execute on functions to authenticated;

commit;
