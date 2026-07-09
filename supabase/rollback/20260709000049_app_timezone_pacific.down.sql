-- ============================================================================
-- Rollback 0049: revert the app timezone to UTC. Safe to re-run.
-- ============================================================================
begin;

do $$
declare
  r text;
  tz text := 'UTC';
begin
  execute format('alter database %I set timezone to %L', current_database(), tz);
  foreach r in array array['authenticator','authenticated','anon','service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('alter role %I set timezone to %L', r, tz);
    end if;
  end loop;
end $$;

commit;
