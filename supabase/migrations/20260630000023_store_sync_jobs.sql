-- ============================================================================
-- WMS — Migration 0023: store_sync_jobs (resumable background import)
--
-- The past-order backfill used to run as one long server action: a single
-- request paged through the whole store and imported every order before
-- returning. For a store with thousands of orders that blocks the Integrations
-- page for a long time and can hit serverless time limits.
--
-- This table makes the backfill resumable and chunked WITHOUT new infra: the UI
-- starts a job, then drives it one page (~100 orders) per short server call,
-- persisting the platform cursor and running counters here between calls. If the
-- tab is closed mid-import the job simply pauses; re-opening resumes from the
-- saved cursor. Idempotency still lives in store_order_imports, so a replayed
-- page never double-imports. (When QStash is later configured the same row can
-- be driven server-side by a worker instead of the browser.)
--
-- Access: RLS is enabled with NO policy, so the public API role can't read or
-- write it. All job I/O goes through server actions that first authorize the
-- caller against the connection (site-scoped RLS) and then use the service role.
-- ============================================================================

begin;

create table public.store_sync_jobs (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.store_connections(id) on delete cascade,
  channel       text not null check (channel in ('shopify','woocommerce')),
  kind          text not null default 'orders_backfill'
                  check (kind in ('orders_backfill')),
  status        text not null default 'running'
                  check (status in ('running','completed','failed','cancelled')),

  -- Platform pagination position for the NEXT page to fetch. Shopify: GraphQL
  -- endCursor. Woo: the next page number as text. Null = start from the top.
  cursor        text,

  page_count    integer not null default 0,
  fetched       integer not null default 0,
  imported      integer not null default 0,
  duplicates    integer not null default 0,
  needs_mapping integer not null default 0,
  skipped       integer not null default 0,

  first_error   text,
  last_error    text,

  started_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  finished_at   timestamptz,
  created_by    uuid default auth.uid()
);

-- One active backfill per connection at a time: lets startOrderImport resume an
-- in-flight job instead of spawning duplicates that would race the same cursor.
create unique index store_sync_jobs_one_running
  on public.store_sync_jobs (connection_id, kind)
  where status = 'running';

create index store_sync_jobs_connection on public.store_sync_jobs (connection_id);

-- RLS on, no policy: deny by default to the API role. Server actions use the
-- service role after authorizing the caller against the connection.
alter table public.store_sync_jobs enable row level security;

comment on table public.store_sync_jobs is
  'Resumable, chunked store backfill jobs. Driven one page per call; progress + cursor persisted here. Reached only via service-role server actions.';

commit;
