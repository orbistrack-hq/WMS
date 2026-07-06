# Migration round-trip test (GO-LIVE §7)

Proves every `supabase/migrations/*.sql` has a working, ordered inverse in
`supabase/rollback/*.down.sql`: applies all migrations forward, then all
rollbacks in reverse, then asserts the `public` schema is empty again.

## Run locally (no Docker)

```bash
pip install pgserver --break-system-packages
python3 supabase/tests/roundtrip/roundtrip.py
```

`pgserver` boots a throwaway Postgres 16. `gen_random_uuid()` is in core, so the
`pgcrypto` extension is only needed as a name; on a stock Supabase/Postgres it is
present. If your local `pgserver` build lacks it, add a stub control file (see CI,
which uses the real extension).

## Run in CI

Point it at a running Postgres 16 (the service container ships `pgcrypto`):

```bash
ROUNDTRIP_DATABASE_URL="postgres://postgres:postgres@localhost:5432/postgres" \
  python3 supabase/tests/roundtrip/roundtrip.py
```

The harness bootstraps the minimal Supabase primitives the migrations depend on
(roles `anon`/`authenticated`/`service_role`, an `auth` schema with `auth.users`
and `auth.uid()`), so it does not need the full Supabase stack.
