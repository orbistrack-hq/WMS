-- ============================================================================
-- WMS — Migration 0092: find_or_create_customer (ad-hoc customers on manual orders)
--
-- PROBLEM. The new-order form could only pick a customer that already existed,
-- because every customer in the system arrived through store sync. Manual
-- orders — influencer seeding above all — go to people who have never bought
-- anything and so are not in the table. The only workaround was leaving the
-- order customer-less and putting the name in ship-to, which loses it for
-- lookup and leaves the order detail page's Customer row blank.
--
-- WHY THIS NEEDS AN RPC AND NOT A PLAIN INSERT. Migration 0037 scoped customer
-- visibility to "the caller has an order for them at a site they can access":
--
--   create policy customers_read on public.customers for select using (
--     public.is_operator()
--     or exists (select 1 from public.orders o
--                 where o.customer_id = customers.id
--                   and public.can_access_site(o.site_id)));
--
-- A brand-new customer has no orders yet, so for a non-operator that predicate
-- is false at the moment of insert and the statement's RETURNING clause is
-- rejected — the childless-parent problem 0037's own header flagged:
--
--   "NOTE: if manual customer creation via the user client is ever added, route
--    it through the service role (like imports) or it will hit the same
--    childless-parent RETURNING rejection."
--
-- This is that route, as a SECURITY DEFINER function rather than a service-role
-- key in the app: the privilege stays inside one small, auditable function
-- instead of being handed to a Next.js server action.
--
-- FIND-OR-CREATE, NOT ALWAYS-CREATE. Seeding the same influencer twice is the
-- normal case, and a form that minted a fresh row per order would fill the
-- picker with duplicates that differ only by whitespace or capitalisation. The
-- lookup is on lower(trim(name)), so "Jane Doe", "jane doe" and " Jane Doe "
-- all resolve to one customer. An exact-duplicate name for two genuinely
-- different people collapses into one record — an accepted trade for a manual
-- entry form; distinguish them in the name ("Jane Doe (IG)") if it ever bites.
--
-- MATCH SCOPE. Reuse is limited to customers already linked to an order at a
-- site the caller can access, so this cannot be used to probe for the existence
-- of names at sites the caller cannot see: a miss simply creates a new row.
-- Operators (admin/manager/operator) see every site already, so for them the
-- scope is the whole table, matching customers_read.
--
-- Reverse with rollback/20260810000092_find_or_create_customer.down.sql.
-- ============================================================================

begin;

-- Case-insensitive name lookups happen on every manual order; without this the
-- match below is a sequential scan over customers.
create index if not exists customers_lower_name_idx
  on public.customers (lower(trim(name)));

create or replace function public.find_or_create_customer(
  p_name  text,
  p_email text default null
) returns public.customers
language plpgsql security definer set search_path = '' as $$
declare
  v_name  text := nullif(trim(p_name), '');
  v_email text := nullif(trim(p_email), '');
  v       public.customers;
begin
  -- Gated like the other write RPCs. SECURITY DEFINER means this runs past RLS,
  -- so the role check is the only thing standing between a client account and
  -- writing to the customers table — it is not optional.
  if not public.is_operator() then
    raise exception 'Not authorized to create a customer'
      using errcode = '42501';
  end if;
  if v_name is null then
    raise exception 'find_or_create_customer: a customer name is required';
  end if;

  -- ---- reuse -------------------------------------------------------------
  -- Restricted to customers the caller could already see (see MATCH SCOPE in
  -- the header). Oldest first so repeated seeding keeps converging on one row
  -- even if duplicates predate this migration.
  select c.* into v
    from public.customers c
   where lower(trim(c.name)) = lower(v_name)
     and (
       public.is_operator()
       or exists (
         select 1 from public.orders o
          where o.customer_id = c.id
            and public.can_access_site(o.site_id))
     )
   order by c.created_at asc
   limit 1;

  if found then
    -- Fill in an email we did not have before, but never overwrite one that is
    -- already recorded — the stored value came from a real store order and is
    -- more trustworthy than something typed into a manual form.
    if v_email is not null and nullif(trim(coalesce(v.email, '')), '') is null then
      update public.customers
         set email = v_email, updated_at = now()
       where id = v.id
      returning * into v;
    end if;
    return v;
  end if;

  -- ---- create ------------------------------------------------------------
  insert into public.customers (name, email)
  values (v_name, v_email)
  returning * into v;

  return v;
end;
$$;

comment on function public.find_or_create_customer is
  'Resolves a typed customer name to a customer row, reusing an existing one on a case-insensitive trimmed name match (scoped to customers the caller can already see) or creating one. Exists because customers_read (migration 0037) makes a plain client-side insert''s RETURNING fail for a customer that has no orders yet. Operator role required. Never overwrites an existing email.';

grant execute on function public.find_or_create_customer(text, text) to authenticated;

commit;

notify pgrst, 'reload schema';
