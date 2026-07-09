-- ============================================================================
-- WMS — Migration 0050: "manager" role
--
-- Adds a fourth role, `manager`, with the SAME data access as `operator` (all
-- sites, all operational tables). Because store sync authorizes against
-- store_connections via can_access_site(), an operator-level role can run syncs
-- — which is what we want: managers CAN sync stores, they just shouldn't reach
-- the Integrations *configuration* screen.
--
-- Why the "sync yes / manage no" split is NOT enforced here:
--   Store sync writes public.store_connections.last_synced_at through the user
--   client (integrations/shopify/actions.ts -> syncProducts, syncPastOrders),
--   i.e. the SAME row UPDATE used to change a connection's settings. Table-level
--   RLS can't distinguish "record a sync timestamp" from "flip is_active" or
--   "point credentials", so blocking connection management at the DB would also
--   break sync. That split therefore belongs in the server actions / navigation
--   (app layer): gate createConnection / deleteConnection / setConnectionActive /
--   setInventoryOutbound / setOrdersOutbound / setCredentials / registerWebhooks
--   to admin+operator, and leave the sync actions open to managers.
--
-- This migration's only job is to make `manager` a real, operator-equivalent
-- role so nothing in the data layer blocks a manager from the data + syncs they
-- SHOULD have.
--
-- Access model (mechanism unchanged):
--   is_operator() -> admin | operator | manager   (full cross-site access)
--   is_admin()    -> admin                         (unchanged)
--   can_access_site() already delegates to is_operator(), so managers see every
--   site's data exactly like operators.
-- ============================================================================

begin;

-- 1. Allow the new value on profiles.role.
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin', 'operator', 'manager', 'client'));

-- 2. Treat manager as operator-level for all row-level security. This single
--    change grants full cross-site data access AND the ability to sync stores.
create or replace function public.is_operator()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.app_role() in ('admin', 'operator', 'manager'), false);
$$;

commit;
