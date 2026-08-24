-- What statement_timeout actually applies to the role PostgREST uses for
-- normal API requests (this is the ceiling the report is hitting).
select rolname, rolconfig
from pg_roles
where rolname in ('authenticator', 'authenticated', 'anon', 'service_role');

-- Current session's own timeout, for comparison (SQL editor may run under a
-- different, more generous setting than the API role).
show statement_timeout;
