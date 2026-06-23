-- WMS — Migration 0009: DOWN
begin;
drop view if exists public.billing_report;
drop view if exists public.shipping_cost_report;
drop view if exists public.packaging_cost_report;
drop view if exists public.inventory_report;
drop view if exists public.sales_report;
commit;
