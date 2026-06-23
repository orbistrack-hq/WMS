-- ============================================================================
-- WMS — Migration 0001: DOWN (reverses 0001_init_schema.up.sql)
-- Drops tables in reverse dependency order, then types, functions, sequences.
-- Destroys all data in these tables — intended for dev/staging rollback.
-- ============================================================================

begin;

drop trigger if exists on_auth_user_created on auth.users;

drop table if exists public.audit_log         cascade;
drop table if exists public.billing_charges   cascade;
drop table if exists public.fee_schedules     cascade;
drop table if exists public.packages          cascade;
drop table if exists public.shipments         cascade;
drop table if exists public.packaging_usage   cascade;
drop table if exists public.packaging_types   cascade;
drop table if exists public.order_line_items  cascade;
drop table if exists public.orders            cascade;
drop table if exists public.fulfillment_groups cascade;
drop table if exists public.customers         cascade;
drop table if exists public.inventory_ledger  cascade;
drop table if exists public.inventory_levels  cascade;
drop table if exists public.child_skus        cascade;
drop table if exists public.products          cascade;
drop table if exists public.categories        cascade;
drop table if exists public.sites             cascade;
drop table if exists public.profiles          cascade;

drop sequence if exists public.order_number_seq;

drop function if exists public.create_inventory_level() cascade;
drop function if exists public.handle_new_user()        cascade;
drop function if exists public.audit_row()              cascade;
drop function if exists public.set_updated_at()         cascade;
drop function if exists public.is_admin()               cascade;
drop function if exists public.app_role()               cascade;

drop type if exists public.user_role;

commit;
