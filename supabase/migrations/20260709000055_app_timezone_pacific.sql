-- ============================================================================
-- WMS — Migration 0049: pin the app timezone to US Pacific.
--
-- The operation is single-region (Pacific). Day boundaries — current_date, the
-- sale_date/pick-fee defaults, ::date casts, date_trunc('day', now()), report
-- range filters, and the order-sync floor — previously resolved in the DB's
-- default zone (UTC), so "today" flipped ~7 hours early and dates displayed off.
--
-- This sets the session timezone to America/Los_Angeles (the IANA name, so PST
-- and PDT switch automatically — never a fixed -08/-07 offset) at the database
-- level and on the Supabase connection roles. timestamptz storage is UNCHANGED
-- (always UTC internally); only the zone used to render them and to derive
-- dates changes.
--
-- NOTE: a GUC set via ALTER DATABASE/ROLE applies to NEW sessions. Existing
-- pooled connections keep the old zone until recycled — after deploy, restart
-- the project (or wait for the pooler to cycle) so every connection is Pacific.
--
-- Reverse with rollback/20260709000049_app_timezone_pacific.down.sql.
-- ============================================================================

begin;

do $$
declare
  r text;
  tz text := 'America/Los_Angeles';
begin
  execute format('alter database %I set timezone to %L', current_database(), tz);
  -- Supabase standard roles; guarded so the migration is portable to any DB.
  foreach r in array array['authenticator','authenticated','anon','service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('alter role %I set timezone to %L', r, tz);
    end if;
  end loop;
end $$;

commit;
