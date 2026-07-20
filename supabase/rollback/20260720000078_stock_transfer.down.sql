-- Down: migration 0078 (stock transfer). Drops the transfer RPCs and header
-- table, then restores inventory_ledger.reason to the pre-0078 (0041) list.
-- Note: restoring the CHECK will fail if any transfer_out/transfer_in ledger
-- rows exist — a real rollback must first correct or remove those movements.
-- The shared helpers (_inv_write, _sku_norm, _stock_sku, promote_backorders,
-- can_access_site, app_role) are untouched; they predate this migration.
begin;

drop function if exists public.reverse_stock_transfer(uuid,text);
drop function if exists public.transfer_stock(uuid,uuid,integer,text,boolean,text);
drop function if exists public.transfer_warnings(uuid,uuid);

-- Dropping the table drops its policies and indexes with it.
drop table if exists public.stock_transfers;

alter table public.inventory_ledger drop constraint inventory_ledger_reason_check;
alter table public.inventory_ledger add constraint inventory_ledger_reason_check
  check (reason in (
    'order_reserve','order_release','order_consume',
    'layaway_remove','layaway_cancel','layaway_consume',
    'manual_adjustment','receipt','correction',
    'shopify_sync',
    'order_return'));

commit;
