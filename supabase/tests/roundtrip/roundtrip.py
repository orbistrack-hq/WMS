#!/usr/bin/env python3
"""
Migration round-trip verifier (GO-LIVE §7).

Proves every migration has a working, ordered inverse:
  1. bootstrap the minimal Supabase primitives the migrations rely on
     (roles anon/authenticated/service_role, auth schema, auth.uid(), pgcrypto)
  2. apply every supabase/migrations/*.sql in order            (forward chain)
  3. apply every supabase/rollback/*.down.sql in REVERSE order (rollback chain)
  4. assert the public schema is empty again                   (full reversibility)

Two modes, same logic:
  * CI:    set ROUNDTRIP_DATABASE_URL to a running Postgres 16 and have `psql`
           on PATH. (The postgres service container already ships pgcrypto.)
  * Local: no env -> boots a throwaway Postgres via the `pgserver` pip package
           (no Docker needed). Requires `pip install pgserver`.

Any SQL error names the exact file + message. Exit 0 = reversible, 1 = not.
"""
import os, sys, re, subprocess, tempfile, glob

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.environ.get("REPO_ROOT", os.path.join(HERE, "..", "..", "..")))
MIG = os.path.join(REPO, "supabase", "migrations")
ROLL = os.path.join(REPO, "supabase", "rollback")

BOOTSTRAP = """
create extension if not exists pgcrypto;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb);
create or replace function auth.uid() returns uuid language sql stable as $BODY$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $BODY$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to service_role;
"""

def descriptive(fname):
    b = os.path.basename(fname)
    for suf in (r'\.down\.sql$', r'\.up\.sql$', r'\.sql$'):
        b = re.sub(suf, '', b)
    b = re.sub(r'^\d+_', '', b)
    b = re.sub(r'^up_', '', b)
    return b

def run_sql(psql, uri, path=None, sql=None, label=""):
    cmd = [psql, uri, "-v", "ON_ERROR_STOP=1", "-q", "--no-psqlrc"]
    cmd += ["-f", path] if path else ["-c", sql]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  FAIL: {label}\n    {r.stderr.strip()}")
        return False
    return True

def verify(psql, uri):
    ok = True
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
        f.write(BOOTSTRAP); boot = f.name
    if not run_sql(psql, uri, path=boot, label="bootstrap"):
        return False
    migrations = sorted(glob.glob(os.path.join(MIG, "*.sql")))
    roll_by_name = {descriptive(p): p for p in glob.glob(os.path.join(ROLL, "*.down.sql"))}

    print(f"FORWARD: applying {len(migrations)} migrations")
    for m in migrations:
        if not run_sql(psql, uri, path=m, label=os.path.basename(m)):
            ok = False; break
    else:
        print("  OK all migrations applied")

    if ok:
        print(f"\nROLLBACK: reverse-applying downs for {len(migrations)} migrations")
        missing = []
        for m in reversed(migrations):
            down = roll_by_name.get(descriptive(m))
            if not down:
                missing.append(descriptive(m)); print(f"  MISSING down for: {descriptive(m)}"); ok = False; continue
            if not run_sql(psql, uri, path=down, label=os.path.basename(down)):
                ok = False; break
        else:
            if not missing: print("  OK all rollbacks applied cleanly")

    print("\nRESIDUE: public objects remaining after full rollback")
    q = ("select 'table '||tablename from pg_tables where schemaname='public' "
         "union all select 'view '||viewname from pg_views where schemaname='public' "
         "union all select 'func '||p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' "
         "union all select 'type '||t.typname from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype='e'")
    r = subprocess.run([psql, uri, "-tAc", q], capture_output=True, text=True)
    leftovers = [x for x in r.stdout.strip().splitlines() if x]
    if leftovers:
        print(f"  {len(leftovers)} leftover object(s):"); [print("    -", x) for x in leftovers]; ok = False
    else:
        print("  OK public schema clean - migrations fully reversible")
    print("\nRESULT:", "PASS" if ok else "FAIL")
    return ok

def main():
    url = os.environ.get("ROUNDTRIP_DATABASE_URL")
    if url:  # CI mode: external Postgres + system psql
        psql = os.environ.get("PSQL_BIN", "psql")
        return 0 if verify(psql, url) else 1
    # Local mode: throwaway Postgres via pgserver
    try:
        import pgserver
    except ImportError:
        print("No ROUNDTRIP_DATABASE_URL set and pgserver not installed.\n"
              "  CI:    set ROUNDTRIP_DATABASE_URL and ensure psql is on PATH.\n"
              "  Local: pip install pgserver --break-system-packages", file=sys.stderr)
        return 2
    pgroot = os.path.join(os.path.dirname(pgserver.__file__), "pginstall")
    psql = os.path.join(pgroot, "bin", "psql")
    # gen_random_uuid() is in core (PG13+); some pgserver builds omit the pgcrypto
    # extension files. Drop in a no-op stub so `create extension pgcrypto` succeeds.
    extdir = os.path.join(pgroot, "share", "postgresql", "extension")
    ctl = os.path.join(extdir, "pgcrypto.control")
    if os.path.isdir(extdir) and not os.path.exists(ctl):
        open(ctl, "w").write("comment = 'stub'\ndefault_version = '1.3'\nrelocatable = true\n")
        open(os.path.join(extdir, "pgcrypto--1.3.sql"), "w").write("-- stub: gen_random_uuid() is in core\n")
    tmp = tempfile.mkdtemp(prefix="rt_pgdata_")
    server = pgserver.get_server(tmp, cleanup_mode="stop")
    try:
        return 0 if verify(psql, server.get_uri()) else 1
    finally:
        server.cleanup()

if __name__ == "__main__":
    sys.exit(main())
