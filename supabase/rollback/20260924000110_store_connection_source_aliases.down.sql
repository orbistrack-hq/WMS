-- Rollback for migration 0110: store connections lose their alternate domains.
-- Webhooks from an alias domain (e.g. https://budclub.com) stop resolving to the
-- connection, so revert the webhook receiver's alias lookup in the same deploy.

begin;

alter table public.store_connections drop column if exists source_aliases;

commit;
