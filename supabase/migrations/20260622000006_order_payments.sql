-- ============================================================================
-- WMS — Migration 0006: order payments (layaway installments)
--
-- Layaway removes stock now and is paid later in one or more installments, so
-- payments need their own ledger. order_payments records each payment against
-- an order; order_payment_summary derives total_due / amount_paid / balance.
--
-- NOTE (flagged for a later cleanup): orders carries discount_total/tax_total
-- AND order_line_items carries per-line discount/tax. They overlap. The balance
-- here uses the LINE-LEVEL figures (qty*price - discount + tax); the order-level
-- totals should be reconciled to one source of truth in a follow-up migration.
-- ============================================================================

begin;

create table public.order_payments (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  amount      numeric(12,2) not null check (amount > 0),
  method      text,
  paid_at     timestamptz not null default now(),
  note        text,
  recorded_by uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index order_payments_order_idx on public.order_payments(order_id);

alter table public.order_payments enable row level security;
create policy order_payments_read on public.order_payments for select
  using (exists (select 1 from public.orders o where o.id = order_id and public.can_access_site(o.site_id)));
create policy order_payments_insert on public.order_payments for insert
  with check (exists (select 1 from public.orders o where o.id = order_id and public.can_access_site(o.site_id)));
create policy order_payments_update on public.order_payments for update
  using (exists (select 1 from public.orders o where o.id = order_id and public.can_access_site(o.site_id)))
  with check (exists (select 1 from public.orders o where o.id = order_id and public.can_access_site(o.site_id)));
create policy order_payments_delete on public.order_payments for delete using (public.is_admin());

create trigger a_order_payments after insert or update or delete on public.order_payments
  for each row execute function public.audit_row();

-- security_invoker so the caller's RLS on the underlying tables applies through
-- the view (otherwise a view runs as its owner and leaks across sites).
create view public.order_payment_summary
with (security_invoker = true) as
select o.id as order_id,
       coalesce(li.total_due, 0)                              as total_due,
       coalesce(p.amount_paid, 0)                             as amount_paid,
       coalesce(li.total_due, 0) - coalesce(p.amount_paid, 0) as balance
from public.orders o
left join (
  select order_id, sum(quantity * unit_price - discount + tax) as total_due
    from public.order_line_items group by order_id) li on li.order_id = o.id
left join (
  select order_id, sum(amount) as amount_paid
    from public.order_payments group by order_id) p on p.order_id = o.id;

create or replace function public.record_order_payment(
  p_order_id uuid, p_amount numeric, p_method text default null, p_note text default null)
returns public.order_payments language plpgsql as $$
declare v public.order_payments;
begin
  if p_amount <= 0 then raise exception 'payment amount must be positive (got %)', p_amount; end if;
  insert into public.order_payments(order_id, amount, method, note, recorded_by)
  values (p_order_id, p_amount, p_method, p_note, auth.uid())
  returning * into v;
  return v;
end;
$$;

commit;