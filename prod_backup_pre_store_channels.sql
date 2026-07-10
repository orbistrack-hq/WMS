


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";





SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."inventory_levels" (
    "child_sku_id" "uuid" NOT NULL,
    "on_hand" integer DEFAULT 0 NOT NULL,
    "reserved" integer DEFAULT 0 NOT NULL,
    "layby" integer DEFAULT 0 NOT NULL,
    "available" integer GENERATED ALWAYS AS (("on_hand" - "reserved")) STORED,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "inventory_levels_check" CHECK (("on_hand" >= "reserved")),
    CONSTRAINT "inventory_levels_layby_check" CHECK (("layby" >= 0)),
    CONSTRAINT "inventory_levels_on_hand_check" CHECK (("on_hand" >= 0)),
    CONSTRAINT "inventory_levels_reserved_check" CHECK (("reserved" >= 0))
);


ALTER TABLE "public"."inventory_levels" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_inv_lock"("p_child_sku_id" "uuid") RETURNS "public"."inventory_levels"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v public.inventory_levels;
begin
  select * into v from public.inventory_levels
   where child_sku_id = p_child_sku_id for update;
  if not found then
    raise exception 'No inventory row for child SKU %', p_child_sku_id
      using errcode = 'no_data_found';
  end if;
  return v;
end;
$$;


ALTER FUNCTION "public"."_inv_lock"("p_child_sku_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_inv_write"("p_child_sku_id" "uuid", "p_d_on_hand" integer, "p_d_reserved" integer, "p_d_layby" integer, "p_reason" "text", "p_ref_type" "text", "p_ref_id" "uuid", "p_note" "text") RETURNS "public"."inventory_levels"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v public.inventory_levels;
begin
  update public.inventory_levels
     set on_hand  = on_hand  + p_d_on_hand,
         reserved = reserved + p_d_reserved,
         layby    = layby    + p_d_layby
   where child_sku_id = p_child_sku_id
   returning * into v;

  insert into public.inventory_ledger(
    child_sku_id, delta_on_hand, delta_reserved, delta_layby,
    reason, reference_type, reference_id, note, actor)
  values (p_child_sku_id, p_d_on_hand, p_d_reserved, p_d_layby,
    p_reason, p_ref_type, p_ref_id, p_note, auth.uid());

  return v;
end;
$$;


ALTER FUNCTION "public"."_inv_write"("p_child_sku_id" "uuid", "p_d_on_hand" integer, "p_d_reserved" integer, "p_d_layby" integer, "p_reason" "text", "p_ref_type" "text", "p_ref_id" "uuid", "p_note" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."packages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "shipment_id" "uuid" NOT NULL,
    "tracking_number" "text",
    "cost" numeric(12,2),
    "weight_grams" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."packages" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."add_package"("p_shipment_id" "uuid", "p_tracking_number" "text" DEFAULT NULL::"text", "p_cost" numeric DEFAULT NULL::numeric, "p_weight_grams" integer DEFAULT NULL::integer) RETURNS "public"."packages"
    LANGUAGE "plpgsql"
    AS $$
declare s public.shipments; v public.packages;
begin
  select * into s from public.shipments where id = p_shipment_id for update;
  if not found then raise exception 'Shipment % not found', p_shipment_id; end if;
  if s.status = 'cancelled' then
    raise exception 'Shipment % is cancelled; cannot add a package', p_shipment_id;
  end if;
  if p_cost is not null and p_cost < 0 then
    raise exception 'package cost cannot be negative (got %)', p_cost;
  end if;
  if p_weight_grams is not null and p_weight_grams < 0 then
    raise exception 'package weight cannot be negative (got %)', p_weight_grams;
  end if;

  insert into public.packages (shipment_id, tracking_number, cost, weight_grams)
  values (p_shipment_id, nullif(btrim(p_tracking_number), ''), p_cost, p_weight_grams)
  returning * into v;
  return v;
end;
$$;


ALTER FUNCTION "public"."add_package"("p_shipment_id" "uuid", "p_tracking_number" "text", "p_cost" numeric, "p_weight_grams" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."add_package"("p_shipment_id" "uuid", "p_tracking_number" "text", "p_cost" numeric, "p_weight_grams" integer) IS 'Add a package (tracking number, cost, weight) to a shipment.';



CREATE OR REPLACE FUNCTION "public"."adjust_stock"("p_child_sku_id" "uuid", "p_delta" integer, "p_note" "text", "p_ref_type" "text" DEFAULT 'manual'::"text", "p_ref_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."inventory_levels"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v public.inventory_levels;
begin
  if p_delta = 0 then raise exception 'adjustment delta must be non-zero'; end if;
  if p_note is null or length(trim(p_note)) = 0 then
    raise exception 'manual adjustment requires a note';
  end if;
  v := public._inv_lock(p_child_sku_id);
  if v.on_hand + p_delta < 0 then
    raise exception 'Adjustment would make on_hand negative for %: on_hand %, delta %',
      p_child_sku_id, v.on_hand, p_delta using errcode = 'check_violation';
  end if;
  if v.on_hand + p_delta < v.reserved then
    raise exception 'Adjustment would drop on_hand below reserved for %: reserved %, new on_hand %',
      p_child_sku_id, v.reserved, v.on_hand + p_delta using errcode = 'check_violation';
  end if;
  return public._inv_write(p_child_sku_id, p_delta, 0, 0, 'manual_adjustment', p_ref_type, p_ref_id, p_note);
end;
$$;


ALTER FUNCTION "public"."adjust_stock"("p_child_sku_id" "uuid", "p_delta" integer, "p_note" "text", "p_ref_type" "text", "p_ref_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_role"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select role::text from public.profiles where id = auth.uid();
$$;


ALTER FUNCTION "public"."app_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_order_cancellation"("p_order_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
declare r record; v_type text;
begin
  select order_type into v_type from public.orders where id = p_order_id;
  if v_type is null then raise exception 'Order % not found', p_order_id; end if;
  for r in select id, child_sku_id, quantity from public.order_line_items where order_id = p_order_id loop
    if v_type = 'layaway' then
      perform public.layaway_cancel(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    else
      perform public.release_stock(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    end if;
  end loop;
end;
$$;


ALTER FUNCTION "public"."apply_order_cancellation"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_order_creation"("p_order_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
declare r record; v_type text;
begin
  select order_type into v_type from public.orders where id = p_order_id;
  if v_type is null then raise exception 'Order % not found', p_order_id; end if;
  for r in select id, child_sku_id, quantity from public.order_line_items where order_id = p_order_id loop
    if v_type = 'layaway' then
      perform public.layaway_book(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    else
      perform public.reserve_stock(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    end if;
  end loop;
end;
$$;


ALTER FUNCTION "public"."apply_order_creation"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_order_fulfillment"("p_order_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
declare r record; v_type text;
begin
  select order_type into v_type from public.orders where id = p_order_id;
  if v_type is null then raise exception 'Order % not found', p_order_id; end if;

  -- COGS basis: freeze each line's current product cost at the sale moment.
  update public.order_line_items li
     set unit_cost_snapshot = cs.cost
    from public.child_skus cs
   where li.order_id = p_order_id
     and cs.id = li.child_sku_id
     and li.unit_cost_snapshot is null;

  for r in select id, child_sku_id, quantity from public.order_line_items where order_id = p_order_id loop
    if v_type = 'layaway' then
      perform public.layaway_consume(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    else
      perform public.consume_stock(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    end if;
  end loop;
end;
$$;


ALTER FUNCTION "public"."apply_order_fulfillment"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."audit_row"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_actor uuid := auth.uid();
  v_old jsonb;
  v_new jsonb;
  v_id  uuid;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_id  := coalesce(v_old->>'id', v_old->>'child_sku_id')::uuid;
    insert into public.audit_log(table_name, record_id, action, actor, old_data, new_data)
    values (tg_table_name, v_id, tg_op, v_actor, v_old, null);
    return old;
  else
    v_new := to_jsonb(new);
    v_id  := coalesce(v_new->>'id', v_new->>'child_sku_id')::uuid;
    if tg_op = 'UPDATE' then v_old := to_jsonb(old); end if;
    insert into public.audit_log(table_name, record_id, action, actor, old_data, new_data)
    values (tg_table_name, v_id, tg_op, v_actor, v_old, v_new);
    return new;
  end if;
end;
$$;


ALTER FUNCTION "public"."audit_row"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."calc_order_pick_fee"("p_order_id" "uuid", "p_as_of" "date" DEFAULT NULL::"date") RETURNS numeric
    LANGUAGE "plpgsql" STABLE
    AS $$
declare
  v_units integer;
  v_date  date;
  v_sched public.fee_schedules;
begin
  select coalesce(p_as_of, fulfilled_at::date, current_date) into v_date
    from public.orders where id = p_order_id;
  if v_date is null then raise exception 'Order % not found', p_order_id; end if;
  select coalesce(sum(quantity),0) into v_units
    from public.order_line_items where order_id = p_order_id;
  v_sched := public.resolve_fee_schedule(v_date);
  if v_sched.id is null then raise exception 'No fee schedule effective as of %', v_date; end if;
  return public.pick_fee_amount(v_units, v_sched.first_unit_rate, v_sched.additional_unit_rate);
end;
$$;


ALTER FUNCTION "public"."calc_order_pick_fee"("p_order_id" "uuid", "p_as_of" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_access_site"("p_site_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select public.is_operator()
      or exists (select 1 from public.user_site_access
                  where user_id = auth.uid() and site_id = p_site_id);
$$;


ALTER FUNCTION "public"."can_access_site"("p_site_id" "uuid") OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."order_number_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."order_number_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_number" "text" DEFAULT ('ORD-'::"text" || "lpad"(("nextval"('"public"."order_number_seq"'::"regclass"))::"text", 6, '0'::"text")) NOT NULL,
    "site_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "group_id" "uuid" NOT NULL,
    "channel" "text" DEFAULT 'manual'::"text" NOT NULL,
    "status" "text" DEFAULT 'created'::"text" NOT NULL,
    "on_hold" boolean DEFAULT false NOT NULL,
    "order_type" "text" DEFAULT 'standard'::"text" NOT NULL,
    "entered_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sale_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "ship_to_name" "text",
    "ship_to_address1" "text",
    "ship_to_address2" "text",
    "ship_to_city" "text",
    "ship_to_region" "text",
    "ship_to_postal" "text",
    "ship_to_country" "text",
    "ship_to_key" "text" GENERATED ALWAYS AS ("lower"(((((COALESCE("ship_to_address1", ''::"text") || '|'::"text") || COALESCE("ship_to_postal", ''::"text")) || '|'::"text") || COALESCE("ship_to_country", ''::"text")))) STORED,
    "discount_total" numeric(12,2) DEFAULT 0 NOT NULL,
    "tax_total" numeric(12,2) DEFAULT 0 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fulfilled_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    CONSTRAINT "orders_channel_check" CHECK (("channel" = ANY (ARRAY['manual'::"text", 'shopify'::"text", 'woocommerce'::"text"]))),
    CONSTRAINT "orders_order_type_check" CHECK (("order_type" = ANY (ARRAY['standard'::"text", 'layaway'::"text"]))),
    CONSTRAINT "orders_status_check" CHECK (("status" = ANY (ARRAY['created'::"text", 'picking'::"text", 'packed'::"text", 'fulfilled'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_order"("p_order_id" "uuid") RETURNS "public"."orders"
    LANGUAGE "plpgsql"
    AS $$
declare v public.orders;
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % is fulfilled and cannot be cancelled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % already cancelled', p_order_id; end if;

  perform public.apply_order_cancellation(p_order_id);  -- inventory
  update public.orders set status = 'cancelled', cancelled_at = now() where id = p_order_id returning * into v;
  return v;
end;
$$;


ALTER FUNCTION "public"."cancel_order"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."charge_group_pick_fees"("p_group_id" "uuid", "p_recompute" boolean DEFAULT false) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare r record;
begin
  for r in select id from public.orders where group_id = p_group_id loop
    perform public.charge_order_pick_fee(r.id, p_recompute);
  end loop;
end;
$$;


ALTER FUNCTION "public"."charge_group_pick_fees"("p_group_id" "uuid", "p_recompute" boolean) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_charges" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "fee_type" "text" NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "unit_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "fee_schedule_id" "uuid",
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "billing_charges_fee_type_check" CHECK (("fee_type" = ANY (ARRAY['pick_fee'::"text", 'packaging_charge'::"text", 'insert'::"text", 'kitting'::"text", 'labor'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."billing_charges" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."charge_order_pick_fee"("p_order_id" "uuid", "p_recompute" boolean DEFAULT false) RETURNS "public"."billing_charges"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_existing public.billing_charges;
  v_has_existing boolean;
  v_units integer;
  v_date  date;
  v_sched public.fee_schedules;
  v_amount numeric;
  v_row public.billing_charges;
begin
  select * into v_existing from public.billing_charges
   where order_id = p_order_id and fee_type = 'pick_fee';
  v_has_existing := found;
  if v_has_existing and not p_recompute then
    return v_existing;                                  -- already billed; never alter
  end if;

  select coalesce(fulfilled_at::date, current_date) into v_date
    from public.orders where id = p_order_id;
  if v_date is null then raise exception 'Order % not found', p_order_id; end if;
  select coalesce(sum(quantity),0) into v_units
    from public.order_line_items where order_id = p_order_id;
  if v_units = 0 then raise exception 'Order % has no units to bill', p_order_id; end if;

  v_sched := public.resolve_fee_schedule(v_date);
  if v_sched.id is null then raise exception 'No fee schedule effective as of %', v_date; end if;
  v_amount := public.pick_fee_amount(v_units, v_sched.first_unit_rate, v_sched.additional_unit_rate);

  if v_has_existing then
    delete from public.billing_charges where order_id = p_order_id and fee_type = 'pick_fee';
  end if;

  insert into public.billing_charges(
    order_id, fee_type, quantity, unit_amount, amount, fee_schedule_id, description)
  values (p_order_id, 'pick_fee', v_units, v_sched.additional_unit_rate, v_amount, v_sched.id,
          format('Pick fee: %s unit(s); first %s, additional %s',
                 v_units, v_sched.first_unit_rate, v_sched.additional_unit_rate))
  returning * into v_row;
  return v_row;
end;
$$;


ALTER FUNCTION "public"."charge_order_pick_fee"("p_order_id" "uuid", "p_recompute" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_pick"("p_group_id" "uuid", "p_takeover" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
declare
  g         public.fulfillment_groups;
  v_existing public.pick_claims;
  v_fresh   boolean;
  v_uid     uuid := auth.uid();
begin
  select * into g from public.fulfillment_groups where id = p_group_id for update;
  if not found then raise exception 'claim_pick: group % not found', p_group_id; end if;

  select * into v_existing from public.pick_claims where group_id = p_group_id;
  v_fresh := v_existing.picked_by is not null
             and v_existing.updated_at > now() - interval '30 minutes';

  -- Someone else holds a fresh claim and we're not forcing: report, don't grab.
  if v_fresh and v_existing.picked_by <> v_uid and not p_takeover then
    return jsonb_build_object(
      'holder_id',   v_existing.picked_by,
      'holder_name', (select full_name from public.profiles where id = v_existing.picked_by),
      'is_self',     false,
      'taken_over',  false);
  end if;

  insert into public.pick_claims (group_id, picked_by, claimed_at, updated_at)
  values (p_group_id, v_uid, now(), now())
  on conflict (group_id) do update
    set picked_by  = v_uid,
        updated_at = now(),
        -- keep the original claimed_at if the same person is re-claiming
        claimed_at = case when pick_claims.picked_by = v_uid
                          then pick_claims.claimed_at else now() end;

  return jsonb_build_object(
    'holder_id',   v_uid,
    'holder_name', (select full_name from public.profiles where id = v_uid),
    'is_self',     true,
    'taken_over',  coalesce(v_fresh and v_existing.picked_by <> v_uid, false));
end;
$$;


ALTER FUNCTION "public"."claim_pick"("p_group_id" "uuid", "p_takeover" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."claim_pick"("p_group_id" "uuid", "p_takeover" boolean) IS 'Claim (or take over) a fulfillment group for picking. Soft lock: returns the current holder when another picker holds a fresh claim and p_takeover is false.';



CREATE OR REPLACE FUNCTION "public"."combinable_orders"("p_order_id" "uuid") RETURNS SETOF "public"."orders"
    LANGUAGE "sql" STABLE
    AS $$
  select o2.*
  from public.orders o1
  join public.orders o2
    on o2.id <> o1.id
   and o2.site_id = o1.site_id
   and o2.customer_id = o1.customer_id
   and o2.ship_to_key = o1.ship_to_key
   and o2.status not in ('fulfilled','cancelled')
   and abs(extract(epoch from (o2.entered_at - o1.entered_at))) <= 86400
  where o1.id = p_order_id
    and o1.customer_id is not null
    and o1.status not in ('fulfilled','cancelled');
$$;


ALTER FUNCTION "public"."combinable_orders"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."combine_orders"("p_order_ids" "uuid"[]) RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_n      integer := array_length(p_order_ids, 1);
  v_active integer;
  v_sites  integer;
  v_custs  integer;
  v_ships  integer;
  v_target uuid;
begin
  if v_n is null or v_n < 2 then
    raise exception 'combine_orders needs at least two orders';
  end if;

  select count(*) filter (where status not in ('fulfilled','cancelled') and customer_id is not null),
         count(distinct site_id), count(distinct customer_id), count(distinct ship_to_key)
    into v_active, v_sites, v_custs, v_ships
    from public.orders where id = any(p_order_ids);

  if v_active <> v_n then
    raise exception 'all orders must exist, be active, and have a customer';
  end if;
  if v_sites <> 1 or v_custs <> 1 or v_ships <> 1 then
    raise exception 'orders must share the same site, customer, and ship-to address';
  end if;

  -- keep the earliest-entered order's group as the survivor
  select group_id into v_target
    from public.orders where id = any(p_order_ids) order by entered_at asc limit 1;
  update public.orders set group_id = v_target where id = any(p_order_ids);

  -- cancel any group left empty by the move
  update public.fulfillment_groups g set status = 'cancelled'
   where g.status = 'open'
     and not exists (select 1 from public.orders o where o.group_id = g.id);

  return v_target;
end;
$$;


ALTER FUNCTION "public"."combine_orders"("p_order_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."consume_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text" DEFAULT 'order_line_item'::"text", "p_ref_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."inventory_levels"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'consume qty must be positive (got %)', p_qty; end if;
  v := public._inv_lock(p_child_sku_id);
  if v.reserved < p_qty then
    raise exception 'Cannot consume more than reserved for %: reserved %, requested %',
      p_child_sku_id, v.reserved, p_qty using errcode = 'check_violation';
  end if;
  return public._inv_write(p_child_sku_id, -p_qty, -p_qty, 0, 'order_consume', p_ref_type, p_ref_id, null);
end;
$$;


ALTER FUNCTION "public"."consume_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_inventory_level"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  insert into public.inventory_levels(child_sku_id) values (new.id);
  return new;
end;
$$;


ALTER FUNCTION "public"."create_inventory_level"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_order"("p_site_id" "uuid", "p_lines" "jsonb", "p_customer_id" "uuid" DEFAULT NULL::"uuid", "p_channel" "text" DEFAULT 'manual'::"text", "p_order_type" "text" DEFAULT 'standard'::"text", "p_sale_date" "date" DEFAULT CURRENT_DATE, "p_entered_at" timestamp with time zone DEFAULT "now"(), "p_ship_to_name" "text" DEFAULT NULL::"text", "p_ship_to_address1" "text" DEFAULT NULL::"text", "p_ship_to_address2" "text" DEFAULT NULL::"text", "p_ship_to_city" "text" DEFAULT NULL::"text", "p_ship_to_region" "text" DEFAULT NULL::"text", "p_ship_to_postal" "text" DEFAULT NULL::"text", "p_ship_to_country" "text" DEFAULT NULL::"text", "p_discount_total" numeric DEFAULT 0, "p_tax_total" numeric DEFAULT 0, "p_notes" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_group_id uuid;
  v_order_id uuid;
  v_line     jsonb;
  v_sku_id   uuid;
  v_qty      integer;
  v_price    numeric(12,2);
  v_line_id  uuid;
  v_sku_site uuid;
  v_sku_price numeric(12,2);
begin
  -- ---- validate header ----------------------------------------------------
  if p_site_id is null then
    raise exception 'create_order: site is required';
  end if;
  if p_channel not in ('manual','shopify','woocommerce') then
    raise exception 'create_order: invalid channel %', p_channel;
  end if;
  if p_order_type not in ('standard','layaway') then
    raise exception 'create_order: invalid order_type %', p_order_type;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'create_order: at least one line item is required';
  end if;

  -- ---- open the fulfillment group (group of one) --------------------------
  insert into public.fulfillment_groups (site_id, customer_id)
  values (p_site_id, p_customer_id)
  returning id into v_group_id;

  -- ---- create the order ---------------------------------------------------
  insert into public.orders (
    site_id, customer_id, group_id, channel, order_type,
    entered_at, sale_date,
    ship_to_name, ship_to_address1, ship_to_address2, ship_to_city,
    ship_to_region, ship_to_postal, ship_to_country,
    discount_total, tax_total, notes
  ) values (
    p_site_id, p_customer_id, v_group_id, p_channel, p_order_type,
    coalesce(p_entered_at, now()), coalesce(p_sale_date, current_date),
    p_ship_to_name, p_ship_to_address1, p_ship_to_address2, p_ship_to_city,
    p_ship_to_region, p_ship_to_postal, p_ship_to_country,
    coalesce(p_discount_total, 0), coalesce(p_tax_total, 0), p_notes
  ) returning id into v_order_id;

  -- keep the group's ship-to key aligned with the order (used for combine match)
  update public.fulfillment_groups g
     set ship_to_key = o.ship_to_key
    from public.orders o
   where g.id = v_group_id and o.id = v_order_id;

  -- ---- line items ---------------------------------------------------------
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_sku_id := (v_line->>'child_sku_id')::uuid;
    v_qty    := (v_line->>'quantity')::integer;

    if v_sku_id is null then
      raise exception 'create_order: line missing child_sku_id';
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'create_order: line quantity must be positive (sku %)', v_sku_id;
    end if;

    -- the child SKU must exist and belong to this order's site
    select site_id, price into v_sku_site, v_sku_price
      from public.child_skus where id = v_sku_id;
    if v_sku_site is null then
      raise exception 'create_order: child SKU % not found', v_sku_id;
    end if;
    if v_sku_site <> p_site_id then
      raise exception 'create_order: child SKU % is not at site %', v_sku_id, p_site_id;
    end if;

    -- price: caller value if given, else snapshot the SKU's current price
    v_price := coalesce((v_line->>'unit_price')::numeric, v_sku_price);

    insert into public.order_line_items
      (order_id, child_sku_id, quantity, unit_price, discount, tax)
    values
      (v_order_id, v_sku_id, v_qty, v_price,
       coalesce((v_line->>'discount')::numeric, 0),
       coalesce((v_line->>'tax')::numeric, 0))
    returning id into v_line_id;
  end loop;

  -- ---- reserve (standard) / remove to layby (layaway) ---------------------
  -- Guarded path: raises and rolls the whole order back if stock is short.
  perform public.apply_order_creation(v_order_id);

  return v_order_id;
end;
$$;


ALTER FUNCTION "public"."create_order"("p_site_id" "uuid", "p_lines" "jsonb", "p_customer_id" "uuid", "p_channel" "text", "p_order_type" "text", "p_sale_date" "date", "p_entered_at" timestamp with time zone, "p_ship_to_name" "text", "p_ship_to_address1" "text", "p_ship_to_address2" "text", "p_ship_to_city" "text", "p_ship_to_region" "text", "p_ship_to_postal" "text", "p_ship_to_country" "text", "p_discount_total" numeric, "p_tax_total" numeric, "p_notes" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."create_order"("p_site_id" "uuid", "p_lines" "jsonb", "p_customer_id" "uuid", "p_channel" "text", "p_order_type" "text", "p_sale_date" "date", "p_entered_at" timestamp with time zone, "p_ship_to_name" "text", "p_ship_to_address1" "text", "p_ship_to_address2" "text", "p_ship_to_city" "text", "p_ship_to_region" "text", "p_ship_to_postal" "text", "p_ship_to_country" "text", "p_discount_total" numeric, "p_tax_total" numeric, "p_notes" "text") IS 'Atomically opens a fulfillment group, writes the order + line items, and reserves/lays-away stock. Returns the new order id.';



CREATE TABLE IF NOT EXISTS "public"."shipments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "uuid" NOT NULL,
    "carrier" "text",
    "service_level" "text",
    "estimated_cost" numeric(12,2),
    "actual_cost" numeric(12,2),
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "shipments_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'shipped'::"text", 'delivered'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."shipments" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_shipment"("p_group_id" "uuid", "p_carrier" "text" DEFAULT NULL::"text", "p_service_level" "text" DEFAULT NULL::"text", "p_estimated_cost" numeric DEFAULT NULL::numeric) RETURNS "public"."shipments"
    LANGUAGE "plpgsql"
    AS $$
declare g public.fulfillment_groups; v public.shipments;
begin
  select * into g from public.fulfillment_groups where id = p_group_id for update;
  if not found then raise exception 'Group % not found', p_group_id; end if;
  if g.status = 'cancelled' then
    raise exception 'Group % is cancelled; cannot add a shipment', p_group_id;
  end if;
  if p_estimated_cost is not null and p_estimated_cost < 0 then
    raise exception 'estimated cost cannot be negative (got %)', p_estimated_cost;
  end if;

  insert into public.shipments (group_id, carrier, service_level, estimated_cost)
  values (p_group_id,
          nullif(btrim(p_carrier), ''),
          nullif(btrim(p_service_level), ''),
          p_estimated_cost)
  returning * into v;
  return v;
end;
$$;


ALTER FUNCTION "public"."create_shipment"("p_group_id" "uuid", "p_carrier" "text", "p_service_level" "text", "p_estimated_cost" numeric) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."create_shipment"("p_group_id" "uuid", "p_carrier" "text", "p_service_level" "text", "p_estimated_cost" numeric) IS 'Open a pending shipment on a fulfillment group. Operational only — does not affect the order lifecycle.';



CREATE OR REPLACE FUNCTION "public"."fulfill_order"("p_order_id" "uuid", "p_fulfilled_at" timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS "public"."orders"
    LANGUAGE "plpgsql"
    AS $$
declare
  v    public.orders;
  v_at timestamptz := coalesce(p_fulfilled_at, now());
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % already fulfilled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % is cancelled and cannot be fulfilled', p_order_id; end if;

  -- fulfilled_at is set before charging so the pick fee resolves to the
  -- fulfillment date (now, or the backdated Shopify date when supplied).
  update public.orders set status = 'fulfilled', fulfilled_at = v_at
   where id = p_order_id returning * into v;
  perform public.apply_order_fulfillment(p_order_id);   -- inventory
  perform public.charge_order_pick_fee(p_order_id);     -- billing snapshot

  -- close the group once all its orders are fulfilled
  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = v_at
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;


ALTER FUNCTION "public"."fulfill_order"("p_order_id" "uuid", "p_fulfilled_at" timestamp with time zone) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."fulfill_order"("p_order_id" "uuid", "p_fulfilled_at" timestamp with time zone) IS 'Fulfill an order: consume/clear inventory, snapshot the pick fee, mark fulfilled and close the group when complete. Optional p_fulfilled_at backdates the fulfillment (Shopify import preserves historical dates); defaults to now().';



CREATE OR REPLACE FUNCTION "public"."group_packaging_cost"("p_group_id" "uuid") RETURNS numeric
    LANGUAGE "sql" STABLE
    AS $$
  select coalesce(sum(quantity * unit_cost_snapshot), 0)
    from public.packaging_usage where group_id = p_group_id;
$$;


ALTER FUNCTION "public"."group_packaging_cost"("p_group_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  insert into public.profiles(id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email));
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select coalesce(public.app_role() = 'admin', false);
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_operator"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select coalesce(public.app_role() in ('admin','operator'), false);
$$;


ALTER FUNCTION "public"."is_operator"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."layaway_book"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text" DEFAULT 'order_line_item'::"text", "p_ref_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."inventory_levels"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'layaway qty must be positive (got %)', p_qty; end if;
  v := public._inv_lock(p_child_sku_id);
  if v.on_hand - v.reserved < p_qty then
    raise exception 'Insufficient available stock to lay by for %: available %, requested %',
      p_child_sku_id, v.on_hand - v.reserved, p_qty using errcode = 'check_violation';
  end if;
  return public._inv_write(p_child_sku_id, -p_qty, 0, p_qty, 'layaway_remove', p_ref_type, p_ref_id, null);
end;
$$;


ALTER FUNCTION "public"."layaway_book"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."layaway_cancel"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text" DEFAULT 'order_line_item'::"text", "p_ref_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."inventory_levels"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'layaway cancel qty must be positive (got %)', p_qty; end if;
  v := public._inv_lock(p_child_sku_id);
  if v.layby < p_qty then
    raise exception 'Cannot cancel more layby than held for %: layby %, requested %',
      p_child_sku_id, v.layby, p_qty using errcode = 'check_violation';
  end if;
  return public._inv_write(p_child_sku_id, p_qty, 0, -p_qty, 'layaway_cancel', p_ref_type, p_ref_id, null);
end;
$$;


ALTER FUNCTION "public"."layaway_cancel"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."layaway_consume"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text" DEFAULT 'order_line_item'::"text", "p_ref_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."inventory_levels"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'layaway consume qty must be positive (got %)', p_qty; end if;
  v := public._inv_lock(p_child_sku_id);
  if v.layby < p_qty then
    raise exception 'Cannot consume more layby than held for %: layby %, requested %',
      p_child_sku_id, v.layby, p_qty using errcode = 'check_violation';
  end if;
  return public._inv_write(p_child_sku_id, 0, 0, -p_qty, 'layaway_consume', p_ref_type, p_ref_id, null);
end;
$$;


ALTER FUNCTION "public"."layaway_consume"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."merge_products"("p_survivor" "uuid", "p_losers" "uuid"[], "p_dry_run" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_losers     uuid[];
  v_conflicts  jsonb;
  v_moved      integer := 0;
  v_absorbed   uuid[];
  v_bad_site   uuid;
begin
  -- ---- authorization ------------------------------------------------------
  if not public.is_operator() then
    raise exception 'merge_products: not authorized';
  end if;

  -- ---- validate inputs ----------------------------------------------------
  if p_survivor is null then
    raise exception 'merge_products: survivor is required';
  end if;
  if p_losers is null or array_length(p_losers, 1) is null then
    raise exception 'merge_products: pick at least one product to merge in';
  end if;

  -- Distinct losers, never the survivor itself.
  select array_agg(distinct l) into v_losers
    from unnest(p_losers) as l
   where l is not null and l <> p_survivor;

  if v_losers is null or array_length(v_losers, 1) is null then
    raise exception 'merge_products: nothing to merge (only the survivor was given)';
  end if;

  -- Every id must be a real product.
  if (select count(*) from public.products p
       where p.id = p_survivor) = 0 then
    raise exception 'merge_products: survivor product not found';
  end if;
  if (select count(*) from public.products p
       where p.id = any(v_losers)) <> array_length(v_losers, 1) then
    raise exception 'merge_products: one or more products to merge no longer exist';
  end if;

  -- ---- site-access check: caller must own every site being moved ----------
  select cs.site_id into v_bad_site
    from public.child_skus cs
   where cs.product_id = any(v_losers)
     and not public.can_access_site(cs.site_id)
   limit 1;
  if v_bad_site is not null then
    raise exception 'merge_products: you do not have access to every site involved';
  end if;

  -- ---- conflict detection (one child per product per site) ---------------
  -- After the merge every site under the survivor must be unique. A conflict is
  -- any site held by more than one of {survivor + losers}.
  with involved as (
    select cs.id, cs.site_id, cs.sku
      from public.child_skus cs
     where cs.product_id = p_survivor or cs.product_id = any(v_losers)
  ),
  clashes as (
    select i.site_id, count(*) as n,
           array_remove(array_agg(i.sku order by i.sku), null) as skus
      from involved i
     group by i.site_id
    having count(*) > 1
  )
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'site_id', c.site_id,
             'site_name', s.name,
             'skus', to_jsonb(c.skus))),
           '[]'::jsonb)
    into v_conflicts
    from clashes c
    join public.sites s on s.id = c.site_id;

  -- ---- stop here if there's anything ambiguous ---------------------------
  if v_conflicts <> '[]'::jsonb then
    if p_dry_run then
      return jsonb_build_object(
        'ok', false, 'dry_run', true, 'survivor_id', p_survivor,
        'moved', 0, 'absorbed', '[]'::jsonb, 'conflicts', v_conflicts);
    end if;
    raise exception 'merge_products: site conflicts must be resolved first (%)',
      v_conflicts using errcode = '23505';
  end if;

  -- ---- dry run: report what WOULD happen, change nothing ------------------
  if p_dry_run then
    select count(*) into v_moved
      from public.child_skus cs where cs.product_id = any(v_losers);
    return jsonb_build_object(
      'ok', true, 'dry_run', true, 'survivor_id', p_survivor,
      'moved', v_moved, 'absorbed', to_jsonb(v_losers),
      'conflicts', '[]'::jsonb);
  end if;

  -- ---- commit -------------------------------------------------------------
  with moved as (
    update public.child_skus cs
       set product_id = p_survivor
     where cs.product_id = any(v_losers)
    returning 1)
  select count(*) into v_moved from moved;

  -- Survivor must stay active; absorb its metadata-free.
  update public.products set is_active = true where id = p_survivor;

  -- Deactivate losers that are now childless (all of them, post-move).
  with emptied as (
    update public.products p
       set is_active = false
     where p.id = any(v_losers)
       and not exists (
         select 1 from public.child_skus c where c.product_id = p.id)
    returning p.id)
  select coalesce(array_agg(id), '{}'::uuid[]) into v_absorbed from emptied;

  insert into public.product_merge_log
    (sku, survivor_product_id, absorbed_product_ids, kind, merged_by)
  values (null, p_survivor, v_absorbed, 'manual', auth.uid());

  return jsonb_build_object(
    'ok', true, 'dry_run', false, 'survivor_id', p_survivor,
    'moved', v_moved, 'absorbed', to_jsonb(v_absorbed),
    'conflicts', '[]'::jsonb);
end;
$$;


ALTER FUNCTION "public"."merge_products"("p_survivor" "uuid", "p_losers" "uuid"[], "p_dry_run" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."merge_products"("p_survivor" "uuid", "p_losers" "uuid"[], "p_dry_run" boolean) IS 'Manual product merge: move loser products'' child SKUs onto a survivor, deactivate the emptied losers, and log it. Operators/admins only; refuses ambiguous one-child-per-site conflicts; p_dry_run previews without writing.';



CREATE OR REPLACE FUNCTION "public"."merge_products_by_sku"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  r          record;
  v_survivor uuid;
  v_losers   uuid[];
  v_absorbed uuid[];
  v_groups   integer := 0;
begin
  for r in
    select cs.sku
      from public.child_skus cs
     where cs.sku is not null
     group by cs.sku
    having count(distinct cs.product_id) > 1
  loop
    -- Survivor: the most-connected parent for this SKU, then oldest, then id.
    select p.id into v_survivor
      from public.products p
      join public.child_skus c on c.product_id = p.id
     where c.sku = r.sku
     group by p.id, p.created_at
     order by count(*) desc, p.created_at asc, p.id asc
     limit 1;

    -- Candidate losers (captured before the move).
    select array_agg(distinct c.product_id) into v_losers
      from public.child_skus c
     where c.sku = r.sku and c.product_id <> v_survivor;

    -- Move each loser child onto the survivor, but only where the survivor's
    -- site slot is free (one child per product per site).
    update public.child_skus c
       set product_id = v_survivor
     where c.sku = r.sku
       and c.product_id <> v_survivor
       and not exists (
         select 1 from public.child_skus s
          where s.product_id = v_survivor and s.site_id = c.site_id);

    -- Deactivate losers that are now childless, capturing exactly those.
    with emptied as (
      update public.products p
         set is_active = false
       where p.id = any(v_losers)
         and not exists (
           select 1 from public.child_skus c where c.product_id = p.id)
      returning p.id)
    select coalesce(array_agg(id), '{}'::uuid[]) into v_absorbed from emptied;

    if array_length(v_absorbed, 1) is not null then
      insert into public.product_merge_log(sku, survivor_product_id, absorbed_product_ids)
      values (r.sku, v_survivor, v_absorbed);
      v_groups := v_groups + 1;
    end if;
  end loop;

  return v_groups;
end;
$$;


ALTER FUNCTION "public"."merge_products_by_sku"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."merge_products_by_sku"() IS 'Reconciliation: consolidate child SKUs that share a SKU under one surviving master, deactivating emptied parents and logging each merge. Guarded against the one-child-per-site rule; idempotent; service-role/owner only.';



CREATE TABLE IF NOT EXISTS "public"."fulfillment_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "site_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "ship_to_key" "text",
    "window_start" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fulfilled_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "packing_notes" "text",
    CONSTRAINT "fulfillment_groups_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'fulfilled'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."fulfillment_groups" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pack_group"("p_group_id" "uuid", "p_notes" "text" DEFAULT NULL::"text") RETURNS "public"."fulfillment_groups"
    LANGUAGE "plpgsql"
    AS $$
declare g public.fulfillment_groups; r record;
begin
  select * into g from public.fulfillment_groups where id = p_group_id for update;
  if not found then raise exception 'Group % not found', p_group_id; end if;
  if g.status <> 'open' then
    raise exception 'Group % is % and cannot be packed', p_group_id, g.status;
  end if;

  -- Gate: anything still on the floor must be fully picked (or marked short).
  if exists (select 1 from public.orders
              where group_id = p_group_id and status in ('created', 'picking'))
     and not public.pick_complete(p_group_id) then
    raise exception 'Finish picking this group before packing it'
      using errcode = 'P0001';
  end if;

  update public.fulfillment_groups
     set packing_notes = coalesce(p_notes, packing_notes)
   where id = p_group_id
   returning * into g;

  for r in
    select id from public.orders
     where group_id = p_group_id and status in ('created','picking')
  loop
    perform public.set_order_status(r.id, 'packed');
  end loop;

  return g;
end;
$$;


ALTER FUNCTION "public"."pack_group"("p_group_id" "uuid", "p_notes" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."pack_group"("p_group_id" "uuid", "p_notes" "text") IS 'Save a group''s packing note and advance its open orders (created/picking) to packed. Gated: picking must be complete (every required SKU picked or marked short).';



CREATE OR REPLACE FUNCTION "public"."pick_complete"("p_group_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select not exists (
    select 1
      from public.pick_required(p_group_id) req
      left join public.pick_progress pp
        on pp.group_id = p_group_id and pp.child_sku_id = req.child_sku_id
     where coalesce(pp.short, false) = false
       and coalesce(pp.qty_picked, 0) < req.required
  );
$$;


ALTER FUNCTION "public"."pick_complete"("p_group_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pick_fee_amount"("p_units" integer, "p_first" numeric, "p_additional" numeric) RETURNS numeric
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case when p_units <= 0 then 0::numeric
              else p_first + (p_units - 1) * p_additional end;
$$;


ALTER FUNCTION "public"."pick_fee_amount"("p_units" integer, "p_first" numeric, "p_additional" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pick_required"("p_group_id" "uuid") RETURNS TABLE("child_sku_id" "uuid", "required" integer)
    LANGUAGE "sql" STABLE
    AS $$
  select li.child_sku_id, sum(li.quantity)::int as required
    from public.orders o
    join public.order_line_items li on li.order_id = o.id
   where o.group_id = p_group_id
     and o.status in ('created', 'picking')   -- still to pick
   group by li.child_sku_id
$$;


ALTER FUNCTION "public"."pick_required"("p_group_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."receive_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text" DEFAULT 'receipt'::"text", "p_ref_id" "uuid" DEFAULT NULL::"uuid", "p_note" "text" DEFAULT NULL::"text") RETURNS "public"."inventory_levels"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if p_qty <= 0 then raise exception 'receive qty must be positive (got %)', p_qty; end if;
  perform public._inv_lock(p_child_sku_id);
  return public._inv_write(p_child_sku_id, p_qty, 0, 0, 'receipt', p_ref_type, p_ref_id, p_note);
end;
$$;


ALTER FUNCTION "public"."receive_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid", "p_note" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."order_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "method" "text",
    "paid_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "note" "text",
    "recorded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "order_payments_amount_check" CHECK (("amount" > (0)::numeric))
);


ALTER TABLE "public"."order_payments" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_order_payment"("p_order_id" "uuid", "p_amount" numeric, "p_method" "text" DEFAULT NULL::"text", "p_note" "text" DEFAULT NULL::"text") RETURNS "public"."order_payments"
    LANGUAGE "plpgsql"
    AS $$
declare v public.order_payments;
begin
  if p_amount <= 0 then raise exception 'payment amount must be positive (got %)', p_amount; end if;
  insert into public.order_payments(order_id, amount, method, note, recorded_by)
  values (p_order_id, p_amount, p_method, p_note, auth.uid())
  returning * into v;
  return v;
end;
$$;


ALTER FUNCTION "public"."record_order_payment"("p_order_id" "uuid", "p_amount" numeric, "p_method" "text", "p_note" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."packaging_usage" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "uuid" NOT NULL,
    "packaging_type_id" "uuid" NOT NULL,
    "quantity" integer NOT NULL,
    "unit_cost_snapshot" numeric(12,2) NOT NULL,
    "recorded_by" "uuid",
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "packaging_usage_quantity_check" CHECK (("quantity" > 0))
);


ALTER TABLE "public"."packaging_usage" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_packaging_usage"("p_group_id" "uuid", "p_packaging_type_id" "uuid", "p_quantity" integer) RETURNS "public"."packaging_usage"
    LANGUAGE "plpgsql"
    AS $$
declare v public.packaging_usage; v_cost numeric(12,2);
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'packaging quantity must be positive (got %)', p_quantity;
  end if;
  select unit_cost into v_cost
    from public.packaging_types
   where id = p_packaging_type_id and is_active;
  if v_cost is null then
    raise exception 'packaging type % not found or inactive', p_packaging_type_id;
  end if;

  insert into public.packaging_usage
    (group_id, packaging_type_id, quantity, unit_cost_snapshot, recorded_by)
  values
    (p_group_id, p_packaging_type_id, p_quantity, v_cost, auth.uid())
  returning * into v;
  return v;
end;
$$;


ALTER FUNCTION "public"."record_packaging_usage"("p_group_id" "uuid", "p_packaging_type_id" "uuid", "p_quantity" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."record_packaging_usage"("p_group_id" "uuid", "p_packaging_type_id" "uuid", "p_quantity" integer) IS 'Insert a packaging usage line for a fulfillment group, snapshotting the packaging type''s current unit cost.';



CREATE OR REPLACE FUNCTION "public"."release_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text" DEFAULT 'order_line_item'::"text", "p_ref_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."inventory_levels"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'release qty must be positive (got %)', p_qty; end if;
  v := public._inv_lock(p_child_sku_id);
  if v.reserved < p_qty then
    raise exception 'Cannot release more than reserved for %: reserved %, requested %',
      p_child_sku_id, v.reserved, p_qty using errcode = 'check_violation';
  end if;
  return public._inv_write(p_child_sku_id, 0, -p_qty, 0, 'order_release', p_ref_type, p_ref_id, null);
end;
$$;


ALTER FUNCTION "public"."release_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text" DEFAULT 'order_line_item'::"text", "p_ref_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."inventory_levels"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'reserve qty must be positive (got %)', p_qty; end if;
  v := public._inv_lock(p_child_sku_id);
  if v.on_hand - v.reserved < p_qty then
    raise exception 'Insufficient available stock for %: available %, requested %',
      p_child_sku_id, v.on_hand - v.reserved, p_qty using errcode = 'check_violation';
  end if;
  return public._inv_write(p_child_sku_id, 0, p_qty, 0, 'order_reserve', p_ref_type, p_ref_id, null);
end;
$$;


ALTER FUNCTION "public"."reserve_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fee_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid",
    "effective_from" "date" NOT NULL,
    "first_unit_rate" numeric(12,2) NOT NULL,
    "additional_unit_rate" numeric(12,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."fee_schedules" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_fee_schedule"("p_as_of" "date", "p_client_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."fee_schedules"
    LANGUAGE "sql" STABLE
    AS $$
  select * from public.fee_schedules
   where effective_from <= p_as_of
     and (client_id is not distinct from p_client_id)
   order by effective_from desc
   limit 1;
$$;


ALTER FUNCTION "public"."resolve_fee_schedule"("p_as_of" "date", "p_client_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_on_hand_to"("p_child_sku_id" "uuid", "p_target" integer, "p_ref_type" "text" DEFAULT 'shopify'::"text", "p_ref_id" "uuid" DEFAULT NULL::"uuid", "p_note" "text" DEFAULT NULL::"text") RETURNS "public"."inventory_levels"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v        public.inventory_levels;
  v_target integer;
  v_delta  integer;
begin
  if p_target is null then
    raise exception 'set_on_hand_to: target quantity is required';
  end if;

  v := public._inv_lock(p_child_sku_id);

  -- Never drop on_hand below stock already reserved to WMS orders.
  v_target := greatest(p_target, v.reserved, 0);
  v_delta  := v_target - v.on_hand;

  if v_delta = 0 then
    return v;  -- nothing to change; keep the ledger clean on repeat syncs
  end if;

  return public._inv_write(
    p_child_sku_id, v_delta, 0, 0,
    'shopify_sync', p_ref_type, p_ref_id,
    coalesce(p_note, 'Inventory synced from Shopify'));
end;
$$;


ALTER FUNCTION "public"."set_on_hand_to"("p_child_sku_id" "uuid", "p_target" integer, "p_ref_type" "text", "p_ref_id" "uuid", "p_note" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."set_on_hand_to"("p_child_sku_id" "uuid", "p_target" integer, "p_ref_type" "text", "p_ref_id" "uuid", "p_note" "text") IS 'Set on_hand to an absolute target (e.g. from a store sync), clamped up to the reserved floor, recorded in the inventory ledger as reason shopify_sync. Idempotent when the target is unchanged.';



CREATE OR REPLACE FUNCTION "public"."set_order_status"("p_order_id" "uuid", "p_new_status" "text") RETURNS "public"."orders"
    LANGUAGE "plpgsql"
    AS $$
declare v public.orders;
begin
  if p_new_status not in ('created','picking','packed') then
    raise exception 'set_order_status handles created/picking/packed only; use fulfill_order() or cancel_order() for %', p_new_status;
  end if;
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status in ('fulfilled','cancelled') then
    raise exception 'Order % is % and cannot change status', p_order_id, v.status;
  end if;
  update public.orders set status = p_new_status where id = p_order_id returning * into v;
  return v;
end;
$$;


ALTER FUNCTION "public"."set_order_status"("p_order_id" "uuid", "p_new_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_pick_qty"("p_group_id" "uuid", "p_child_sku_id" "uuid", "p_qty" integer, "p_short" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
declare
  g          public.fulfillment_groups;
  v_required integer;
  v_qty      integer;
  v_uid      uuid := auth.uid();
  r          record;
begin
  select * into g from public.fulfillment_groups where id = p_group_id for update;
  if not found then raise exception 'set_pick_qty: group % not found', p_group_id; end if;
  if g.status <> 'open' then
    raise exception 'set_pick_qty: group % is % and is not being picked', p_group_id, g.status;
  end if;

  select required into v_required
    from public.pick_required(p_group_id)
   where child_sku_id = p_child_sku_id;
  if v_required is null then
    raise exception 'set_pick_qty: that SKU is not on any order still to pick in this group';
  end if;

  -- Clamp into [0, required]; you can't pick more than the orders ask for.
  v_qty := greatest(0, least(coalesce(p_qty, 0), v_required));

  insert into public.pick_progress
    (group_id, child_sku_id, qty_picked, short, picked_by, updated_at)
  values
    (p_group_id, p_child_sku_id, v_qty, coalesce(p_short, false), v_uid, now())
  on conflict (group_id, child_sku_id) do update
    set qty_picked = excluded.qty_picked,
        short      = excluded.short,
        picked_by  = excluded.picked_by,
        updated_at = now();

  -- First pick activity moves the group's brand-new orders onto the floor.
  if v_qty > 0 or coalesce(p_short, false) then
    for r in select id from public.orders
              where group_id = p_group_id and status = 'created'
    loop
      perform public.set_order_status(r.id, 'picking');
    end loop;
  end if;

  -- Heartbeat the claim if the caller holds it.
  update public.pick_claims
     set updated_at = now()
   where group_id = p_group_id and picked_by = v_uid;

  return jsonb_build_object(
    'child_sku_id', p_child_sku_id,
    'qty_picked',   v_qty,
    'required',     v_required,
    'short',        coalesce(p_short, false),
    'complete',     public.pick_complete(p_group_id));
end;
$$;


ALTER FUNCTION "public"."set_pick_qty"("p_group_id" "uuid", "p_child_sku_id" "uuid", "p_qty" integer, "p_short" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."set_pick_qty"("p_group_id" "uuid", "p_child_sku_id" "uuid", "p_qty" integer, "p_short" boolean) IS 'Record picked quantity for a (group, child SKU), clamped to the required qty; p_short flags an out-of-stock line. First activity advances created orders to picking.';



CREATE OR REPLACE FUNCTION "public"."set_shipment_status"("p_shipment_id" "uuid", "p_new_status" "text") RETURNS "public"."shipments"
    LANGUAGE "plpgsql"
    AS $$
declare v public.shipments;
begin
  if p_new_status not in ('pending','shipped','delivered','cancelled') then
    raise exception 'invalid shipment status %', p_new_status;
  end if;
  select * into v from public.shipments where id = p_shipment_id for update;
  if not found then raise exception 'Shipment % not found', p_shipment_id; end if;
  if v.status = 'cancelled' then
    raise exception 'Shipment % is cancelled and cannot change status', p_shipment_id;
  end if;

  update public.shipments
     set status = p_new_status, updated_at = now()
   where id = p_shipment_id
   returning * into v;
  return v;
end;
$$;


ALTER FUNCTION "public"."set_shipment_status"("p_shipment_id" "uuid", "p_new_status" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."set_shipment_status"("p_shipment_id" "uuid", "p_new_status" "text") IS 'Advance a shipment''s status (pending/shipped/delivered/cancelled). Operational only — does not fulfill orders.';



CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_package"("p_package_id" "uuid", "p_tracking_number" "text" DEFAULT NULL::"text", "p_cost" numeric DEFAULT NULL::numeric, "p_weight_grams" integer DEFAULT NULL::integer) RETURNS "public"."packages"
    LANGUAGE "plpgsql"
    AS $$
declare v public.packages;
begin
  if p_cost is not null and p_cost < 0 then
    raise exception 'package cost cannot be negative (got %)', p_cost;
  end if;
  if p_weight_grams is not null and p_weight_grams < 0 then
    raise exception 'package weight cannot be negative (got %)', p_weight_grams;
  end if;

  update public.packages
     set tracking_number = nullif(btrim(p_tracking_number), ''),
         cost            = p_cost,
         weight_grams    = p_weight_grams
   where id = p_package_id
   returning * into v;
  if not found then raise exception 'Package % not found', p_package_id; end if;
  return v;
end;
$$;


ALTER FUNCTION "public"."update_package"("p_package_id" "uuid", "p_tracking_number" "text", "p_cost" numeric, "p_weight_grams" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."update_package"("p_package_id" "uuid", "p_tracking_number" "text", "p_cost" numeric, "p_weight_grams" integer) IS 'Edit a package''s tracking number, cost, and weight.';



CREATE OR REPLACE FUNCTION "public"."update_shipment"("p_shipment_id" "uuid", "p_carrier" "text" DEFAULT NULL::"text", "p_service_level" "text" DEFAULT NULL::"text", "p_estimated_cost" numeric DEFAULT NULL::numeric, "p_actual_cost" numeric DEFAULT NULL::numeric) RETURNS "public"."shipments"
    LANGUAGE "plpgsql"
    AS $$
declare v public.shipments;
begin
  if p_estimated_cost is not null and p_estimated_cost < 0 then
    raise exception 'estimated cost cannot be negative (got %)', p_estimated_cost;
  end if;
  if p_actual_cost is not null and p_actual_cost < 0 then
    raise exception 'actual cost cannot be negative (got %)', p_actual_cost;
  end if;

  update public.shipments
     set carrier        = nullif(btrim(p_carrier), ''),
         service_level  = nullif(btrim(p_service_level), ''),
         estimated_cost = p_estimated_cost,
         actual_cost    = p_actual_cost,
         updated_at     = now()
   where id = p_shipment_id
   returning * into v;
  if not found then raise exception 'Shipment % not found', p_shipment_id; end if;
  return v;
end;
$$;


ALTER FUNCTION "public"."update_shipment"("p_shipment_id" "uuid", "p_carrier" "text", "p_service_level" "text", "p_estimated_cost" numeric, "p_actual_cost" numeric) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."update_shipment"("p_shipment_id" "uuid", "p_carrier" "text", "p_service_level" "text", "p_estimated_cost" numeric, "p_actual_cost" numeric) IS 'Edit a shipment''s carrier, service level, and estimated/actual cost.';



CREATE OR REPLACE FUNCTION "public"."upsert_store_variant"("p_site_id" "uuid", "p_store_variant_id" "text", "p_name" "text", "p_sku" "text" DEFAULT NULL::"text", "p_price" numeric DEFAULT 0, "p_cost" numeric DEFAULT NULL::numeric, "p_inventory_qty" integer DEFAULT NULL::integer, "p_channel" "text" DEFAULT 'shopify'::"text") RETURNS TABLE("child_sku_id" "uuid", "created" boolean, "cost_seeded" boolean)
    LANGUAGE "plpgsql"
    AS $$
declare
  v_child            uuid;
  v_product          uuid;
  v_cost             numeric;
  v_existing_variant text;
  v_sku              text := nullif(btrim(coalesce(p_sku, '')), '');
  v_price            numeric := coalesce(p_price, 0);
  v_created          boolean := false;
  v_seeded           boolean := false;
begin
  if p_site_id is null or nullif(btrim(coalesce(p_store_variant_id, '')), '') is null then
    raise exception 'upsert_store_variant: site and store_variant_id are required';
  end if;

  -- 1. Same variant already mapped at this site -> update in place (idempotent).
  select cs.id, cs.product_id, cs.cost into v_child, v_product, v_cost
    from public.child_skus cs
   where cs.site_id = p_site_id and cs.store_variant_id = p_store_variant_id
   limit 1;

  if v_child is not null then
    v_seeded := (p_cost is not null and coalesce(v_cost, 0) = 0);
    begin
      update public.child_skus
         set sku = v_sku, price = v_price, is_active = true,
             cost = case when v_seeded then p_cost else cost end
       where id = v_child;
    exception when unique_violation then
      update public.child_skus
         set sku = null, price = v_price, is_active = true,
             cost = case when v_seeded then p_cost else cost end
       where id = v_child;
    end;
    -- The owning store may rename its own variant.
    update public.products set name = p_name, is_active = true where id = v_product;
    v_created := false;

  elsif v_sku is not null then
    -- 2a. Adopt an existing same-site SKU that isn't bound to a variant yet.
    select cs.id, cs.product_id, cs.cost, cs.store_variant_id
      into v_child, v_product, v_cost, v_existing_variant
      from public.child_skus cs
     where cs.site_id = p_site_id and cs.sku = v_sku
     limit 1;

    if v_child is not null and v_existing_variant is null then
      v_seeded := (p_cost is not null and coalesce(v_cost, 0) = 0);
      update public.child_skus
         set store_variant_id = p_store_variant_id, price = v_price, is_active = true,
             cost = case when v_seeded then p_cost else cost end
       where id = v_child;
      v_created := false;  -- reused an existing child; don't rename its parent
    else
      v_child := null;

      -- 2b. Same SKU at another site -> attach a new child to that master.
      select cs.product_id into v_product
        from public.child_skus cs
       where cs.sku = v_sku and cs.site_id <> p_site_id
       limit 1;

      if v_product is not null then
        v_seeded := (p_cost is not null);
        begin
          insert into public.child_skus
            (product_id, site_id, sku, store_variant_id, price, cost)
          values (v_product, p_site_id, v_sku, p_store_variant_id, v_price, coalesce(p_cost, 0))
          returning id into v_child;
          v_created := true;
        exception when unique_violation then
          v_child := null;  -- pre-existing collision; fall through to a new parent
        end;
      end if;

      -- 2c. No usable SKU match -> new master product.
      if v_child is null then
        v_seeded := (p_cost is not null);
        insert into public.products(name) values (p_name) returning id into v_product;
        begin
          insert into public.child_skus
            (product_id, site_id, sku, store_variant_id, price, cost)
          values (v_product, p_site_id, v_sku, p_store_variant_id, v_price, coalesce(p_cost, 0))
          returning id into v_child;
        exception when unique_violation then
          insert into public.child_skus
            (product_id, site_id, sku, store_variant_id, price, cost)
          values (v_product, p_site_id, null, p_store_variant_id, v_price, coalesce(p_cost, 0))
          returning id into v_child;
        end;
        v_created := true;
      end if;
    end if;

  else
    -- 3. No SKU to reconcile on -> new master product (legacy behaviour).
    v_seeded := (p_cost is not null);
    insert into public.products(name) values (p_name) returning id into v_product;
    insert into public.child_skus
      (product_id, site_id, sku, store_variant_id, price, cost)
    values (v_product, p_site_id, null, p_store_variant_id, v_price, coalesce(p_cost, 0))
    returning id into v_child;
    v_created := true;
  end if;

  -- Pull store stock into WMS on_hand (logged; reservations preserved).
  if p_inventory_qty is not null then
    perform public.set_on_hand_to(
      v_child, p_inventory_qty, p_channel, null,
      format('Inventory synced from %s', initcap(coalesce(p_channel, 'store'))));
  end if;

  return query select v_child, v_created, v_seeded;
end;
$$;


ALTER FUNCTION "public"."upsert_store_variant"("p_site_id" "uuid", "p_store_variant_id" "text", "p_name" "text", "p_sku" "text", "p_price" numeric, "p_cost" numeric, "p_inventory_qty" integer, "p_channel" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."upsert_store_variant"("p_site_id" "uuid", "p_store_variant_id" "text", "p_name" "text", "p_sku" "text", "p_price" numeric, "p_cost" numeric, "p_inventory_qty" integer, "p_channel" "text") IS 'Map one store variant (any channel) to a WMS product + child SKU. Attaches by SKU to an existing master product across sites instead of creating duplicate parents (forward-only un-flattening). Store owns name/price/sku; cost is seed-only; on_hand syncs via set_on_hand_to, tagged with p_channel.';



CREATE TABLE IF NOT EXISTS "public"."audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "table_name" "text" NOT NULL,
    "record_id" "uuid",
    "action" "text" NOT NULL,
    "actor" "uuid",
    "old_data" "jsonb",
    "new_data" "jsonb",
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "code" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sites" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."billing_report" WITH ("security_invoker"='true') AS
 SELECT "bc"."id" AS "charge_id",
    "bc"."order_id",
    "o"."order_number",
    "o"."site_id",
    "s"."name" AS "site_name",
    "o"."customer_id",
    "bc"."fee_type",
    "bc"."quantity",
    "bc"."amount",
    "bc"."created_at"
   FROM (("public"."billing_charges" "bc"
     JOIN "public"."orders" "o" ON (("o"."id" = "bc"."order_id")))
     JOIN "public"."sites" "s" ON (("s"."id" = "o"."site_id")));


ALTER VIEW "public"."billing_report" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "parent_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."child_skus" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "site_id" "uuid" NOT NULL,
    "sku" "text",
    "store_variant_id" "text",
    "price" numeric(12,2) DEFAULT 0 NOT NULL,
    "cost" numeric(12,2) DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "bin_location" "text",
    "barcode" "text"
);


ALTER TABLE "public"."child_skus" OWNER TO "postgres";


COMMENT ON COLUMN "public"."child_skus"."bin_location" IS 'Free-text pick location (e.g. "A-12-3"). Sorts the pick list into a walking route; blank means unassigned.';



COMMENT ON COLUMN "public"."child_skus"."barcode" IS 'Scannable label (UPC/EAN). Matched before the SKU code during scan-to-pick / scan-to-pack; blank means no barcode on file.';



CREATE TABLE IF NOT EXISTS "public"."order_line_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "child_sku_id" "uuid" NOT NULL,
    "quantity" integer NOT NULL,
    "unit_price" numeric(12,2) DEFAULT 0 NOT NULL,
    "discount" numeric(12,2) DEFAULT 0 NOT NULL,
    "tax" numeric(12,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "unit_cost_snapshot" numeric(12,2),
    CONSTRAINT "order_line_items_quantity_check" CHECK (("quantity" > 0))
);


ALTER TABLE "public"."order_line_items" OWNER TO "postgres";


COMMENT ON COLUMN "public"."order_line_items"."unit_cost_snapshot" IS 'Product unit cost frozen at fulfillment (COGS basis). Null until fulfilled; never rewritten by later cost changes.';



CREATE OR REPLACE VIEW "public"."cogs_report" WITH ("security_invoker"='true') AS
 SELECT "o"."id" AS "order_id",
    "o"."order_number",
    "o"."entered_at",
    "o"."sale_date",
    "o"."fulfilled_at",
    "o"."site_id",
    "s"."name" AS "site_name",
    "o"."channel",
    "o"."status",
    "sum"((("li"."quantity")::numeric * "li"."unit_price")) AS "revenue",
    "sum"("li"."discount") AS "discount",
    "sum"((("li"."quantity")::numeric * COALESCE("li"."unit_cost_snapshot", (0)::numeric))) AS "product_cogs",
    (("sum"((("li"."quantity")::numeric * "li"."unit_price")) - "sum"("li"."discount")) - "sum"((("li"."quantity")::numeric * COALESCE("li"."unit_cost_snapshot", (0)::numeric)))) AS "gross_profit"
   FROM (("public"."orders" "o"
     JOIN "public"."sites" "s" ON (("s"."id" = "o"."site_id")))
     JOIN "public"."order_line_items" "li" ON (("li"."order_id" = "o"."id")))
  WHERE ("o"."status" = 'fulfilled'::"text")
  GROUP BY "o"."id", "o"."order_number", "o"."entered_at", "o"."sale_date", "o"."fulfilled_at", "o"."site_id", "s"."name", "o"."channel", "o"."status";


ALTER VIEW "public"."cogs_report" OWNER TO "postgres";


COMMENT ON VIEW "public"."cogs_report" IS 'Order-grain product COGS and gross profit for fulfilled orders. revenue = qty*unit_price; gross_profit = revenue - discount - product COGS (product margin, before packaging/shipping). Tax excluded (pass-through). Packaging/shipping are reported separately at the group grain.';



CREATE TABLE IF NOT EXISTS "public"."customers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text",
    "email" "text",
    "phone" "text",
    "external_ref" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."customers" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."duplicate_products_report" WITH ("security_invoker"='true') AS
 SELECT "sku",
    "count"(DISTINCT "product_id") AS "parent_count",
    "array_agg"(DISTINCT "product_id") AS "product_ids"
   FROM "public"."child_skus" "cs"
  WHERE ("sku" IS NOT NULL)
  GROUP BY "sku"
 HAVING ("count"(DISTINCT "product_id") > 1);


ALTER VIEW "public"."duplicate_products_report" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_ledger" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "child_sku_id" "uuid" NOT NULL,
    "delta_on_hand" integer DEFAULT 0 NOT NULL,
    "delta_reserved" integer DEFAULT 0 NOT NULL,
    "delta_layby" integer DEFAULT 0 NOT NULL,
    "reason" "text" NOT NULL,
    "reference_type" "text",
    "reference_id" "uuid",
    "note" "text",
    "actor" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "inventory_ledger_reason_check" CHECK (("reason" = ANY (ARRAY['order_reserve'::"text", 'order_release'::"text", 'order_consume'::"text", 'layaway_remove'::"text", 'layaway_cancel'::"text", 'layaway_consume'::"text", 'manual_adjustment'::"text", 'receipt'::"text", 'correction'::"text", 'shopify_sync'::"text"])))
);


ALTER TABLE "public"."inventory_ledger" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "category_id" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."inventory_report" WITH ("security_invoker"='true') AS
 SELECT "cs"."id" AS "child_sku_id",
    "cs"."site_id",
    "s"."name" AS "site_name",
    "p"."name" AS "product_name",
    "cs"."sku",
    "il"."on_hand",
    "il"."available",
    "il"."reserved",
    "il"."layby",
    "cs"."cost",
    (("il"."on_hand")::numeric * "cs"."cost") AS "value_at_cost"
   FROM ((("public"."child_skus" "cs"
     JOIN "public"."sites" "s" ON (("s"."id" = "cs"."site_id")))
     JOIN "public"."products" "p" ON (("p"."id" = "cs"."product_id")))
     JOIN "public"."inventory_levels" "il" ON (("il"."child_sku_id" = "cs"."id")));


ALTER VIEW "public"."inventory_report" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."landed_margin_report" WITH ("security_invoker"='true') AS
 WITH "order_rev" AS (
         SELECT "o"."id" AS "order_id",
            "o"."group_id",
            "sum"((("li"."quantity")::numeric * "li"."unit_price")) AS "revenue"
           FROM ("public"."orders" "o"
             JOIN "public"."order_line_items" "li" ON (("li"."order_id" = "o"."id")))
          WHERE ("o"."status" <> 'cancelled'::"text")
          GROUP BY "o"."id", "o"."group_id"
        ), "group_pack" AS (
         SELECT "packaging_usage"."group_id",
            "sum"((("packaging_usage"."quantity")::numeric * "packaging_usage"."unit_cost_snapshot")) AS "packaging_cost"
           FROM "public"."packaging_usage"
          GROUP BY "packaging_usage"."group_id"
        ), "group_ship" AS (
         SELECT "shipments"."group_id",
            "sum"(COALESCE("shipments"."actual_cost", "shipments"."estimated_cost", (0)::numeric)) AS "shipping_cost"
           FROM "public"."shipments"
          WHERE ("shipments"."status" <> 'cancelled'::"text")
          GROUP BY "shipments"."group_id"
        ), "group_tot" AS (
         SELECT "r"."group_id",
            COALESCE("gp"."packaging_cost", (0)::numeric) AS "packaging_cost",
            COALESCE("gs"."shipping_cost", (0)::numeric) AS "shipping_cost",
            "sum"("r"."revenue") AS "group_revenue",
            "count"(*) AS "order_count"
           FROM (("order_rev" "r"
             LEFT JOIN "group_pack" "gp" ON (("gp"."group_id" = "r"."group_id")))
             LEFT JOIN "group_ship" "gs" ON (("gs"."group_id" = "r"."group_id")))
          GROUP BY "r"."group_id", "gp"."packaging_cost", "gs"."shipping_cost"
        ), "order_alloc" AS (
         SELECT "r"."order_id",
                CASE
                    WHEN ("t"."group_revenue" > (0)::numeric) THEN (("t"."packaging_cost" * "r"."revenue") / "t"."group_revenue")
                    ELSE ("t"."packaging_cost" / (NULLIF("t"."order_count", 0))::numeric)
                END AS "alloc_packaging",
                CASE
                    WHEN ("t"."group_revenue" > (0)::numeric) THEN (("t"."shipping_cost" * "r"."revenue") / "t"."group_revenue")
                    ELSE ("t"."shipping_cost" / (NULLIF("t"."order_count", 0))::numeric)
                END AS "alloc_shipping"
           FROM ("order_rev" "r"
             JOIN "group_tot" "t" ON (("t"."group_id" = "r"."group_id")))
        )
 SELECT "c"."order_id",
    "c"."order_number",
    "c"."entered_at",
    "c"."sale_date",
    "c"."fulfilled_at",
    "c"."site_id",
    "c"."site_name",
    "c"."channel",
    "c"."status",
    "c"."revenue",
    "c"."discount",
    "c"."product_cogs",
    "round"(COALESCE("a"."alloc_packaging", (0)::numeric), 2) AS "packaging_cost",
    "round"(COALESCE("a"."alloc_shipping", (0)::numeric), 2) AS "shipping_cost",
    "round"((("c"."product_cogs" + COALESCE("a"."alloc_packaging", (0)::numeric)) + COALESCE("a"."alloc_shipping", (0)::numeric)), 2) AS "landed_cost",
    "c"."gross_profit",
    "round"((("c"."gross_profit" - COALESCE("a"."alloc_packaging", (0)::numeric)) - COALESCE("a"."alloc_shipping", (0)::numeric)), 2) AS "net_profit"
   FROM ("public"."cogs_report" "c"
     LEFT JOIN "order_alloc" "a" ON (("a"."order_id" = "c"."order_id")));


ALTER VIEW "public"."landed_margin_report" OWNER TO "postgres";


COMMENT ON VIEW "public"."landed_margin_report" IS 'Order-grain fully-landed margin for fulfilled orders. Extends cogs_report by allocating each fulfillment group''s packaging + shipping cost across its non-cancelled orders by revenue share (equal split when group revenue is 0). landed_cost = product COGS + allocated packaging + allocated shipping; net_profit = product gross_profit - allocated packaging - shipping. Tax excluded (pass-through).';



CREATE OR REPLACE VIEW "public"."order_payment_summary" WITH ("security_invoker"='true') AS
 SELECT "o"."id" AS "order_id",
    COALESCE("li"."total_due", (0)::numeric) AS "total_due",
    COALESCE("p"."amount_paid", (0)::numeric) AS "amount_paid",
    (COALESCE("li"."total_due", (0)::numeric) - COALESCE("p"."amount_paid", (0)::numeric)) AS "balance"
   FROM (("public"."orders" "o"
     LEFT JOIN ( SELECT "order_line_items"."order_id",
            "sum"((((("order_line_items"."quantity")::numeric * "order_line_items"."unit_price") - "order_line_items"."discount") + "order_line_items"."tax")) AS "total_due"
           FROM "public"."order_line_items"
          GROUP BY "order_line_items"."order_id") "li" ON (("li"."order_id" = "o"."id")))
     LEFT JOIN ( SELECT "order_payments"."order_id",
            "sum"("order_payments"."amount") AS "amount_paid"
           FROM "public"."order_payments"
          GROUP BY "order_payments"."order_id") "p" ON (("p"."order_id" = "o"."id")));


ALTER VIEW "public"."order_payment_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."packaging_types" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "unit_cost" numeric(12,2) DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "packaging_types_kind_check" CHECK (("kind" = ANY (ARRAY['box'::"text", 'shipping_label'::"text", 'jar'::"text", 'jar_label'::"text", 'vacuum_bag'::"text", 'custom'::"text"])))
);


ALTER TABLE "public"."packaging_types" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."packaging_cost_report" WITH ("security_invoker"='true') AS
 SELECT "g"."id" AS "group_id",
    "g"."site_id",
    "s"."name" AS "site_name",
    "pt"."kind",
    "pt"."name" AS "packaging_name",
    "sum"("pu"."quantity") AS "quantity",
    "sum"((("pu"."quantity")::numeric * "pu"."unit_cost_snapshot")) AS "cost",
    "g"."created_at",
    "g"."fulfilled_at"
   FROM ((("public"."packaging_usage" "pu"
     JOIN "public"."fulfillment_groups" "g" ON (("g"."id" = "pu"."group_id")))
     JOIN "public"."sites" "s" ON (("s"."id" = "g"."site_id")))
     JOIN "public"."packaging_types" "pt" ON (("pt"."id" = "pu"."packaging_type_id")))
  GROUP BY "g"."id", "g"."site_id", "s"."name", "pt"."kind", "pt"."name", "g"."created_at", "g"."fulfilled_at";


ALTER VIEW "public"."packaging_cost_report" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pick_claims" (
    "group_id" "uuid" NOT NULL,
    "picked_by" "uuid" NOT NULL,
    "claimed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pick_claims" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pick_progress" (
    "group_id" "uuid" NOT NULL,
    "child_sku_id" "uuid" NOT NULL,
    "qty_picked" integer DEFAULT 0 NOT NULL,
    "short" boolean DEFAULT false NOT NULL,
    "picked_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pick_progress_qty_picked_check" CHECK (("qty_picked" >= 0))
);


ALTER TABLE "public"."pick_progress" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_merge_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sku" "text",
    "survivor_product_id" "uuid",
    "absorbed_product_ids" "uuid"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "kind" "text" DEFAULT 'auto'::"text" NOT NULL,
    "merged_by" "uuid",
    CONSTRAINT "product_merge_log_kind_check" CHECK (("kind" = ANY (ARRAY['auto'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."product_merge_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text",
    "role" "text" DEFAULT 'operator'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'operator'::"text", 'client'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."sales_report" WITH ("security_invoker"='true') AS
 SELECT "o"."id" AS "order_id",
    "o"."order_number",
    "o"."entered_at",
    "o"."sale_date",
    "o"."site_id",
    "s"."name" AS "site_name",
    "o"."customer_id",
    "c"."name" AS "customer_name",
    "o"."channel",
    "o"."status",
    "li"."id" AS "line_id",
    "li"."child_sku_id",
    "p"."name" AS "product_name",
    "cs"."sku",
    "li"."quantity",
    "li"."unit_price",
    (("li"."quantity")::numeric * "li"."unit_price") AS "revenue",
    "li"."discount",
    "li"."tax"
   FROM ((((("public"."orders" "o"
     JOIN "public"."sites" "s" ON (("s"."id" = "o"."site_id")))
     LEFT JOIN "public"."customers" "c" ON (("c"."id" = "o"."customer_id")))
     JOIN "public"."order_line_items" "li" ON (("li"."order_id" = "o"."id")))
     JOIN "public"."child_skus" "cs" ON (("cs"."id" = "li"."child_sku_id")))
     JOIN "public"."products" "p" ON (("p"."id" = "cs"."product_id")));


ALTER VIEW "public"."sales_report" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."shipping_cost_report" WITH ("security_invoker"='true') AS
 SELECT "sh"."id" AS "shipment_id",
    "sh"."group_id",
    "g"."site_id",
    "s"."name" AS "site_name",
    "sh"."carrier",
    "sh"."service_level",
    "sh"."estimated_cost",
    "sh"."actual_cost",
    ("sh"."actual_cost" - "sh"."estimated_cost") AS "variance",
    COALESCE("pk"."package_count", (0)::bigint) AS "package_count",
    COALESCE("pk"."package_cost", (0)::numeric) AS "package_cost",
    "sh"."status",
    "sh"."created_at"
   FROM ((("public"."shipments" "sh"
     JOIN "public"."fulfillment_groups" "g" ON (("g"."id" = "sh"."group_id")))
     JOIN "public"."sites" "s" ON (("s"."id" = "g"."site_id")))
     LEFT JOIN ( SELECT "packages"."shipment_id",
            "count"(*) AS "package_count",
            "sum"("packages"."cost") AS "package_cost"
           FROM "public"."packages"
          GROUP BY "packages"."shipment_id") "pk" ON (("pk"."shipment_id" = "sh"."id")));


ALTER VIEW "public"."shipping_cost_report" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."store_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source" "text" NOT NULL,
    "site_id" "uuid" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_synced_at" timestamp with time zone,
    "channel" "text" DEFAULT 'shopify'::"text" NOT NULL,
    CONSTRAINT "store_connections_channel_check" CHECK (("channel" = ANY (ARRAY['shopify'::"text", 'woocommerce'::"text"])))
);


ALTER TABLE "public"."store_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."store_secrets" (
    "connection_id" "uuid" NOT NULL,
    "access_token" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "api_secret" "text",
    "consumer_key" "text",
    "consumer_secret" "text",
    "webhook_secret" "text"
);


ALTER TABLE "public"."store_secrets" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."store_credential_status" AS
 SELECT "c"."id" AS "connection_id",
    "c"."channel",
    (("s"."access_token" IS NOT NULL) AND ("length"("btrim"("s"."access_token")) > 0)) AS "has_token",
    (("s"."api_secret" IS NOT NULL) AND ("length"("btrim"("s"."api_secret")) > 0)) AS "has_secret",
    (("s"."consumer_key" IS NOT NULL) AND ("length"("btrim"("s"."consumer_key")) > 0)) AS "has_consumer_key",
    (("s"."consumer_secret" IS NOT NULL) AND ("length"("btrim"("s"."consumer_secret")) > 0)) AS "has_consumer_secret",
    (("s"."webhook_secret" IS NOT NULL) AND ("length"("btrim"("s"."webhook_secret")) > 0)) AS "has_webhook_secret"
   FROM ("public"."store_connections" "c"
     LEFT JOIN "public"."store_secrets" "s" ON (("s"."connection_id" = "c"."id")))
  WHERE "public"."can_access_site"("c"."site_id");


ALTER VIEW "public"."store_credential_status" OWNER TO "postgres";


COMMENT ON VIEW "public"."store_credential_status" IS 'Per-connection credential setup status (booleans only, never secret values) for the integrations UI. Owner-privileged so it can read the sealed store_secrets table; rows scoped by can_access_site.';



CREATE TABLE IF NOT EXISTS "public"."store_order_imports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source" "text" NOT NULL,
    "external_order_id" "text" NOT NULL,
    "topic" "text",
    "status" "text" DEFAULT 'received'::"text" NOT NULL,
    "wms_order_id" "uuid",
    "error" "text",
    "payload" "jsonb",
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    "channel" "text" DEFAULT 'shopify'::"text" NOT NULL,
    CONSTRAINT "shopify_order_imports_status_check" CHECK (("status" = ANY (ARRAY['received'::"text", 'imported'::"text", 'needs_mapping'::"text", 'error'::"text", 'skipped'::"text", 'duplicate'::"text"]))),
    CONSTRAINT "store_order_imports_channel_check" CHECK (("channel" = ANY (ARRAY['shopify'::"text", 'woocommerce'::"text"])))
);


ALTER TABLE "public"."store_order_imports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_site_access" (
    "user_id" "uuid" NOT NULL,
    "site_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_site_access" OWNER TO "postgres";


ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing_charges"
    ADD CONSTRAINT "billing_charges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."child_skus"
    ADD CONSTRAINT "child_skus_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."child_skus"
    ADD CONSTRAINT "child_skus_product_id_site_id_key" UNIQUE ("product_id", "site_id");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fee_schedules"
    ADD CONSTRAINT "fee_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fulfillment_groups"
    ADD CONSTRAINT "fulfillment_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_ledger"
    ADD CONSTRAINT "inventory_ledger_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_levels"
    ADD CONSTRAINT "inventory_levels_pkey" PRIMARY KEY ("child_sku_id");



ALTER TABLE ONLY "public"."order_line_items"
    ADD CONSTRAINT "order_line_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."order_payments"
    ADD CONSTRAINT "order_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_order_number_key" UNIQUE ("order_number");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."packages"
    ADD CONSTRAINT "packages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."packaging_types"
    ADD CONSTRAINT "packaging_types_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."packaging_usage"
    ADD CONSTRAINT "packaging_usage_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pick_claims"
    ADD CONSTRAINT "pick_claims_pkey" PRIMARY KEY ("group_id");



ALTER TABLE ONLY "public"."pick_progress"
    ADD CONSTRAINT "pick_progress_pkey" PRIMARY KEY ("group_id", "child_sku_id");



ALTER TABLE ONLY "public"."product_merge_log"
    ADD CONSTRAINT "product_merge_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."shipments"
    ADD CONSTRAINT "shipments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."store_connections"
    ADD CONSTRAINT "shopify_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."store_order_imports"
    ADD CONSTRAINT "shopify_order_imports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."store_secrets"
    ADD CONSTRAINT "shopify_secrets_pkey" PRIMARY KEY ("connection_id");



ALTER TABLE ONLY "public"."sites"
    ADD CONSTRAINT "sites_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."sites"
    ADD CONSTRAINT "sites_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."store_connections"
    ADD CONSTRAINT "store_connections_channel_source_key" UNIQUE ("channel", "source");



ALTER TABLE ONLY "public"."store_order_imports"
    ADD CONSTRAINT "store_order_imports_channel_source_external_key" UNIQUE ("channel", "source", "external_order_id");



ALTER TABLE ONLY "public"."user_site_access"
    ADD CONSTRAINT "user_site_access_pkey" PRIMARY KEY ("user_id", "site_id");



CREATE INDEX "audit_log_record_idx" ON "public"."audit_log" USING "btree" ("table_name", "record_id");



CREATE UNIQUE INDEX "billing_charges_one_pick_fee" ON "public"."billing_charges" USING "btree" ("order_id") WHERE ("fee_type" = 'pick_fee'::"text");



CREATE INDEX "billing_charges_order_idx" ON "public"."billing_charges" USING "btree" ("order_id");



CREATE INDEX "child_skus_barcode_idx" ON "public"."child_skus" USING "btree" ("site_id", "barcode");



CREATE INDEX "child_skus_bin_idx" ON "public"."child_skus" USING "btree" ("site_id", "bin_location");



CREATE UNIQUE INDEX "child_skus_site_sku_key" ON "public"."child_skus" USING "btree" ("site_id", "sku") WHERE ("sku" IS NOT NULL);



CREATE INDEX "customers_email_idx" ON "public"."customers" USING "btree" ("lower"("email"));



CREATE INDEX "inventory_ledger_sku_idx" ON "public"."inventory_ledger" USING "btree" ("child_sku_id", "created_at");



CREATE INDEX "order_line_items_order_idx" ON "public"."order_line_items" USING "btree" ("order_id");



CREATE INDEX "order_payments_order_idx" ON "public"."order_payments" USING "btree" ("order_id");



CREATE INDEX "orders_customer_idx" ON "public"."orders" USING "btree" ("customer_id");



CREATE INDEX "orders_group_idx" ON "public"."orders" USING "btree" ("group_id");



CREATE INDEX "orders_site_idx" ON "public"."orders" USING "btree" ("site_id");



CREATE INDEX "orders_status_idx" ON "public"."orders" USING "btree" ("status");



CREATE INDEX "packages_shipment_idx" ON "public"."packages" USING "btree" ("shipment_id");



CREATE INDEX "packaging_usage_group_idx" ON "public"."packaging_usage" USING "btree" ("group_id");



CREATE INDEX "shipments_group_idx" ON "public"."shipments" USING "btree" ("group_id");



CREATE INDEX "shopify_order_imports_status_idx" ON "public"."store_order_imports" USING "btree" ("status", "received_at" DESC);



CREATE OR REPLACE TRIGGER "a_billing_charges" AFTER INSERT OR DELETE OR UPDATE ON "public"."billing_charges" FOR EACH ROW EXECUTE FUNCTION "public"."audit_row"();



CREATE OR REPLACE TRIGGER "a_child_skus" AFTER INSERT OR DELETE OR UPDATE ON "public"."child_skus" FOR EACH ROW EXECUTE FUNCTION "public"."audit_row"();



CREATE OR REPLACE TRIGGER "a_groups" AFTER INSERT OR DELETE OR UPDATE ON "public"."fulfillment_groups" FOR EACH ROW EXECUTE FUNCTION "public"."audit_row"();



CREATE OR REPLACE TRIGGER "a_order_lines" AFTER INSERT OR DELETE OR UPDATE ON "public"."order_line_items" FOR EACH ROW EXECUTE FUNCTION "public"."audit_row"();



CREATE OR REPLACE TRIGGER "a_order_payments" AFTER INSERT OR DELETE OR UPDATE ON "public"."order_payments" FOR EACH ROW EXECUTE FUNCTION "public"."audit_row"();



CREATE OR REPLACE TRIGGER "a_orders" AFTER INSERT OR DELETE OR UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."audit_row"();



CREATE OR REPLACE TRIGGER "a_packaging_usage" AFTER INSERT OR DELETE OR UPDATE ON "public"."packaging_usage" FOR EACH ROW EXECUTE FUNCTION "public"."audit_row"();



CREATE OR REPLACE TRIGGER "a_shipments" AFTER INSERT OR DELETE OR UPDATE ON "public"."shipments" FOR EACH ROW EXECUTE FUNCTION "public"."audit_row"();



CREATE OR REPLACE TRIGGER "child_sku_inventory_level" AFTER INSERT ON "public"."child_skus" FOR EACH ROW EXECUTE FUNCTION "public"."create_inventory_level"();



CREATE OR REPLACE TRIGGER "t_categories_updated" BEFORE UPDATE ON "public"."categories" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "t_childskus_updated" BEFORE UPDATE ON "public"."child_skus" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "t_customers_updated" BEFORE UPDATE ON "public"."customers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "t_groups_updated" BEFORE UPDATE ON "public"."fulfillment_groups" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "t_invlevels_updated" BEFORE UPDATE ON "public"."inventory_levels" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "t_orders_updated" BEFORE UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "t_pkgtypes_updated" BEFORE UPDATE ON "public"."packaging_types" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "t_products_updated" BEFORE UPDATE ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "t_profiles_updated" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "t_shipments_updated" BEFORE UPDATE ON "public"."shipments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "t_shopify_conn_updated" BEFORE UPDATE ON "public"."store_connections" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "t_shopify_secrets_updated" BEFORE UPDATE ON "public"."store_secrets" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "t_sites_updated" BEFORE UPDATE ON "public"."sites" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."billing_charges"
    ADD CONSTRAINT "billing_charges_fee_schedule_id_fkey" FOREIGN KEY ("fee_schedule_id") REFERENCES "public"."fee_schedules"("id");



ALTER TABLE ONLY "public"."billing_charges"
    ADD CONSTRAINT "billing_charges_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."child_skus"
    ADD CONSTRAINT "child_skus_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."child_skus"
    ADD CONSTRAINT "child_skus_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."fulfillment_groups"
    ADD CONSTRAINT "fulfillment_groups_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."fulfillment_groups"
    ADD CONSTRAINT "fulfillment_groups_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."inventory_ledger"
    ADD CONSTRAINT "inventory_ledger_actor_fkey" FOREIGN KEY ("actor") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."inventory_ledger"
    ADD CONSTRAINT "inventory_ledger_child_sku_id_fkey" FOREIGN KEY ("child_sku_id") REFERENCES "public"."child_skus"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."inventory_levels"
    ADD CONSTRAINT "inventory_levels_child_sku_id_fkey" FOREIGN KEY ("child_sku_id") REFERENCES "public"."child_skus"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_line_items"
    ADD CONSTRAINT "order_line_items_child_sku_id_fkey" FOREIGN KEY ("child_sku_id") REFERENCES "public"."child_skus"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."order_line_items"
    ADD CONSTRAINT "order_line_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_payments"
    ADD CONSTRAINT "order_payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_payments"
    ADD CONSTRAINT "order_payments_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."fulfillment_groups"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."packages"
    ADD CONSTRAINT "packages_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."packaging_usage"
    ADD CONSTRAINT "packaging_usage_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."fulfillment_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."packaging_usage"
    ADD CONSTRAINT "packaging_usage_packaging_type_id_fkey" FOREIGN KEY ("packaging_type_id") REFERENCES "public"."packaging_types"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."packaging_usage"
    ADD CONSTRAINT "packaging_usage_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pick_claims"
    ADD CONSTRAINT "pick_claims_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."fulfillment_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pick_claims"
    ADD CONSTRAINT "pick_claims_picked_by_fkey" FOREIGN KEY ("picked_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pick_progress"
    ADD CONSTRAINT "pick_progress_child_sku_id_fkey" FOREIGN KEY ("child_sku_id") REFERENCES "public"."child_skus"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."pick_progress"
    ADD CONSTRAINT "pick_progress_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."fulfillment_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pick_progress"
    ADD CONSTRAINT "pick_progress_picked_by_fkey" FOREIGN KEY ("picked_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."product_merge_log"
    ADD CONSTRAINT "product_merge_log_merged_by_fkey" FOREIGN KEY ("merged_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."product_merge_log"
    ADD CONSTRAINT "product_merge_log_survivor_product_id_fkey" FOREIGN KEY ("survivor_product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shipments"
    ADD CONSTRAINT "shipments_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."fulfillment_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."store_connections"
    ADD CONSTRAINT "shopify_connections_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."store_order_imports"
    ADD CONSTRAINT "shopify_order_imports_wms_order_id_fkey" FOREIGN KEY ("wms_order_id") REFERENCES "public"."orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."store_secrets"
    ADD CONSTRAINT "shopify_secrets_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."store_connections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_site_access"
    ADD CONSTRAINT "user_site_access_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_site_access"
    ADD CONSTRAINT "user_site_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_log_read" ON "public"."audit_log" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."billing_charges" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "billing_charges_delete" ON "public"."billing_charges" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "billing_charges_insert" ON "public"."billing_charges" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "billing_charges"."order_id") AND "public"."can_access_site"("o"."site_id")))));



CREATE POLICY "billing_charges_read" ON "public"."billing_charges" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "billing_charges"."order_id") AND "public"."can_access_site"("o"."site_id")))));



CREATE POLICY "billing_charges_update" ON "public"."billing_charges" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "billing_charges"."order_id") AND "public"."can_access_site"("o"."site_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "billing_charges"."order_id") AND "public"."can_access_site"("o"."site_id")))));



ALTER TABLE "public"."categories" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "categories_admin" ON "public"."categories" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "categories_read" ON "public"."categories" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."child_skus" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "child_skus_delete" ON "public"."child_skus" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "child_skus_insert" ON "public"."child_skus" FOR INSERT WITH CHECK ("public"."can_access_site"("site_id"));



CREATE POLICY "child_skus_read" ON "public"."child_skus" FOR SELECT USING ("public"."can_access_site"("site_id"));



CREATE POLICY "child_skus_update" ON "public"."child_skus" FOR UPDATE USING ("public"."can_access_site"("site_id")) WITH CHECK ("public"."can_access_site"("site_id"));



ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customers_delete" ON "public"."customers" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "customers_modify" ON "public"."customers" FOR UPDATE USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "customers_read" ON "public"."customers" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "customers_write" ON "public"."customers" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."fee_schedules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fee_schedules_admin" ON "public"."fee_schedules" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "fee_schedules_read" ON "public"."fee_schedules" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."fulfillment_groups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fulfillment_groups_delete" ON "public"."fulfillment_groups" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "fulfillment_groups_insert" ON "public"."fulfillment_groups" FOR INSERT WITH CHECK ("public"."can_access_site"("site_id"));



CREATE POLICY "fulfillment_groups_read" ON "public"."fulfillment_groups" FOR SELECT USING ("public"."can_access_site"("site_id"));



CREATE POLICY "fulfillment_groups_update" ON "public"."fulfillment_groups" FOR UPDATE USING ("public"."can_access_site"("site_id")) WITH CHECK ("public"."can_access_site"("site_id"));



ALTER TABLE "public"."inventory_ledger" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_ledger_read" ON "public"."inventory_ledger" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."child_skus" "cs"
  WHERE (("cs"."id" = "inventory_ledger"."child_sku_id") AND "public"."can_access_site"("cs"."site_id")))));



ALTER TABLE "public"."inventory_levels" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_levels_read" ON "public"."inventory_levels" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."child_skus" "cs"
  WHERE (("cs"."id" = "inventory_levels"."child_sku_id") AND "public"."can_access_site"("cs"."site_id")))));



ALTER TABLE "public"."order_line_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "order_line_items_delete" ON "public"."order_line_items" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "order_line_items_insert" ON "public"."order_line_items" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_line_items"."order_id") AND "public"."can_access_site"("o"."site_id")))));



CREATE POLICY "order_line_items_read" ON "public"."order_line_items" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_line_items"."order_id") AND "public"."can_access_site"("o"."site_id")))));



CREATE POLICY "order_line_items_update" ON "public"."order_line_items" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_line_items"."order_id") AND "public"."can_access_site"("o"."site_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_line_items"."order_id") AND "public"."can_access_site"("o"."site_id")))));



ALTER TABLE "public"."order_payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "order_payments_delete" ON "public"."order_payments" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "order_payments_insert" ON "public"."order_payments" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_payments"."order_id") AND "public"."can_access_site"("o"."site_id")))));



CREATE POLICY "order_payments_read" ON "public"."order_payments" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_payments"."order_id") AND "public"."can_access_site"("o"."site_id")))));



CREATE POLICY "order_payments_update" ON "public"."order_payments" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_payments"."order_id") AND "public"."can_access_site"("o"."site_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_payments"."order_id") AND "public"."can_access_site"("o"."site_id")))));



ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "orders_delete" ON "public"."orders" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "orders_insert" ON "public"."orders" FOR INSERT WITH CHECK ("public"."can_access_site"("site_id"));



CREATE POLICY "orders_read" ON "public"."orders" FOR SELECT USING ("public"."can_access_site"("site_id"));



CREATE POLICY "orders_update" ON "public"."orders" FOR UPDATE USING ("public"."can_access_site"("site_id")) WITH CHECK ("public"."can_access_site"("site_id"));



ALTER TABLE "public"."packages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "packages_delete" ON "public"."packages" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "packages_insert" ON "public"."packages" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."shipments" "s"
     JOIN "public"."fulfillment_groups" "g" ON (("g"."id" = "s"."group_id")))
  WHERE (("s"."id" = "packages"."shipment_id") AND "public"."can_access_site"("g"."site_id")))));



CREATE POLICY "packages_read" ON "public"."packages" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."shipments" "s"
     JOIN "public"."fulfillment_groups" "g" ON (("g"."id" = "s"."group_id")))
  WHERE (("s"."id" = "packages"."shipment_id") AND "public"."can_access_site"("g"."site_id")))));



CREATE POLICY "packages_update" ON "public"."packages" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM ("public"."shipments" "s"
     JOIN "public"."fulfillment_groups" "g" ON (("g"."id" = "s"."group_id")))
  WHERE (("s"."id" = "packages"."shipment_id") AND "public"."can_access_site"("g"."site_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."shipments" "s"
     JOIN "public"."fulfillment_groups" "g" ON (("g"."id" = "s"."group_id")))
  WHERE (("s"."id" = "packages"."shipment_id") AND "public"."can_access_site"("g"."site_id")))));



ALTER TABLE "public"."packaging_types" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "packaging_types_admin" ON "public"."packaging_types" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "packaging_types_read" ON "public"."packaging_types" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."packaging_usage" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "packaging_usage_delete" ON "public"."packaging_usage" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "packaging_usage_insert" ON "public"."packaging_usage" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "packaging_usage"."group_id") AND "public"."can_access_site"("g"."site_id")))));



CREATE POLICY "packaging_usage_read" ON "public"."packaging_usage" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "packaging_usage"."group_id") AND "public"."can_access_site"("g"."site_id")))));



CREATE POLICY "packaging_usage_update" ON "public"."packaging_usage" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "packaging_usage"."group_id") AND "public"."can_access_site"("g"."site_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "packaging_usage"."group_id") AND "public"."can_access_site"("g"."site_id")))));



ALTER TABLE "public"."pick_claims" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pick_claims_delete" ON "public"."pick_claims" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "pick_claims_insert" ON "public"."pick_claims" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "pick_claims"."group_id") AND "public"."can_access_site"("g"."site_id")))));



CREATE POLICY "pick_claims_read" ON "public"."pick_claims" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "pick_claims"."group_id") AND "public"."can_access_site"("g"."site_id")))));



CREATE POLICY "pick_claims_update" ON "public"."pick_claims" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "pick_claims"."group_id") AND "public"."can_access_site"("g"."site_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "pick_claims"."group_id") AND "public"."can_access_site"("g"."site_id")))));



ALTER TABLE "public"."pick_progress" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pick_progress_delete" ON "public"."pick_progress" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "pick_progress_insert" ON "public"."pick_progress" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "pick_progress"."group_id") AND "public"."can_access_site"("g"."site_id")))));



CREATE POLICY "pick_progress_read" ON "public"."pick_progress" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "pick_progress"."group_id") AND "public"."can_access_site"("g"."site_id")))));



CREATE POLICY "pick_progress_update" ON "public"."pick_progress" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "pick_progress"."group_id") AND "public"."can_access_site"("g"."site_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "pick_progress"."group_id") AND "public"."can_access_site"("g"."site_id")))));



ALTER TABLE "public"."product_merge_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_merge_log_read" ON "public"."product_merge_log" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "products_delete" ON "public"."products" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "products_modify" ON "public"."products" FOR UPDATE USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "products_read" ON "public"."products" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "products_write" ON "public"."products" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_admin_all" ON "public"."profiles" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "profiles_select" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "profiles_update_self" ON "public"."profiles" FOR UPDATE USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));



ALTER TABLE "public"."shipments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "shipments_delete" ON "public"."shipments" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "shipments_insert" ON "public"."shipments" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "shipments"."group_id") AND "public"."can_access_site"("g"."site_id")))));



CREATE POLICY "shipments_read" ON "public"."shipments" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "shipments"."group_id") AND "public"."can_access_site"("g"."site_id")))));



CREATE POLICY "shipments_update" ON "public"."shipments" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "shipments"."group_id") AND "public"."can_access_site"("g"."site_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."fulfillment_groups" "g"
  WHERE (("g"."id" = "shipments"."group_id") AND "public"."can_access_site"("g"."site_id")))));



ALTER TABLE "public"."sites" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sites_admin" ON "public"."sites" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "sites_read" ON "public"."sites" FOR SELECT USING ("public"."can_access_site"("id"));



ALTER TABLE "public"."store_connections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "store_connections_rw" ON "public"."store_connections" USING ("public"."can_access_site"("site_id")) WITH CHECK ("public"."can_access_site"("site_id"));



ALTER TABLE "public"."store_order_imports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "store_order_imports_read" ON "public"."store_order_imports" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."store_connections" "c"
  WHERE (("c"."channel" = "store_order_imports"."channel") AND ("c"."source" = "store_order_imports"."source") AND "public"."can_access_site"("c"."site_id")))));



ALTER TABLE "public"."store_secrets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "usa_admin_manage" ON "public"."user_site_access" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "usa_self_read" ON "public"."user_site_access" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."user_site_access" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."inventory_levels" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."inventory_levels" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_levels" TO "service_role";



REVOKE ALL ON FUNCTION "public"."_inv_lock"("p_child_sku_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."_inv_lock"("p_child_sku_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."_inv_write"("p_child_sku_id" "uuid", "p_d_on_hand" integer, "p_d_reserved" integer, "p_d_layby" integer, "p_reason" "text", "p_ref_type" "text", "p_ref_id" "uuid", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."_inv_write"("p_child_sku_id" "uuid", "p_d_on_hand" integer, "p_d_reserved" integer, "p_d_layby" integer, "p_reason" "text", "p_ref_type" "text", "p_ref_id" "uuid", "p_note" "text") TO "service_role";



GRANT ALL ON TABLE "public"."packages" TO "anon";
GRANT ALL ON TABLE "public"."packages" TO "authenticated";
GRANT ALL ON TABLE "public"."packages" TO "service_role";



GRANT ALL ON FUNCTION "public"."add_package"("p_shipment_id" "uuid", "p_tracking_number" "text", "p_cost" numeric, "p_weight_grams" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."add_package"("p_shipment_id" "uuid", "p_tracking_number" "text", "p_cost" numeric, "p_weight_grams" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."add_package"("p_shipment_id" "uuid", "p_tracking_number" "text", "p_cost" numeric, "p_weight_grams" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."adjust_stock"("p_child_sku_id" "uuid", "p_delta" integer, "p_note" "text", "p_ref_type" "text", "p_ref_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."adjust_stock"("p_child_sku_id" "uuid", "p_delta" integer, "p_note" "text", "p_ref_type" "text", "p_ref_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."adjust_stock"("p_child_sku_id" "uuid", "p_delta" integer, "p_note" "text", "p_ref_type" "text", "p_ref_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."app_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."app_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_role"() TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_order_cancellation"("p_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."apply_order_cancellation"("p_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_order_cancellation"("p_order_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_order_creation"("p_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."apply_order_creation"("p_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_order_creation"("p_order_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_order_fulfillment"("p_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."apply_order_fulfillment"("p_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_order_fulfillment"("p_order_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."audit_row"() TO "anon";
GRANT ALL ON FUNCTION "public"."audit_row"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."audit_row"() TO "service_role";



GRANT ALL ON FUNCTION "public"."calc_order_pick_fee"("p_order_id" "uuid", "p_as_of" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."calc_order_pick_fee"("p_order_id" "uuid", "p_as_of" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."calc_order_pick_fee"("p_order_id" "uuid", "p_as_of" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."can_access_site"("p_site_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."can_access_site"("p_site_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_access_site"("p_site_id" "uuid") TO "service_role";



GRANT ALL ON SEQUENCE "public"."order_number_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."order_number_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."order_number_seq" TO "service_role";



GRANT ALL ON TABLE "public"."orders" TO "anon";
GRANT ALL ON TABLE "public"."orders" TO "authenticated";
GRANT ALL ON TABLE "public"."orders" TO "service_role";



GRANT ALL ON FUNCTION "public"."cancel_order"("p_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."cancel_order"("p_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cancel_order"("p_order_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."charge_group_pick_fees"("p_group_id" "uuid", "p_recompute" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."charge_group_pick_fees"("p_group_id" "uuid", "p_recompute" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."charge_group_pick_fees"("p_group_id" "uuid", "p_recompute" boolean) TO "service_role";



GRANT ALL ON TABLE "public"."billing_charges" TO "anon";
GRANT ALL ON TABLE "public"."billing_charges" TO "authenticated";
GRANT ALL ON TABLE "public"."billing_charges" TO "service_role";



GRANT ALL ON FUNCTION "public"."charge_order_pick_fee"("p_order_id" "uuid", "p_recompute" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."charge_order_pick_fee"("p_order_id" "uuid", "p_recompute" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."charge_order_pick_fee"("p_order_id" "uuid", "p_recompute" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_pick"("p_group_id" "uuid", "p_takeover" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_pick"("p_group_id" "uuid", "p_takeover" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_pick"("p_group_id" "uuid", "p_takeover" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."combinable_orders"("p_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."combinable_orders"("p_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."combinable_orders"("p_order_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."combine_orders"("p_order_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."combine_orders"("p_order_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."combine_orders"("p_order_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."consume_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."consume_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."consume_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_inventory_level"() TO "anon";
GRANT ALL ON FUNCTION "public"."create_inventory_level"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_inventory_level"() TO "service_role";



GRANT ALL ON FUNCTION "public"."create_order"("p_site_id" "uuid", "p_lines" "jsonb", "p_customer_id" "uuid", "p_channel" "text", "p_order_type" "text", "p_sale_date" "date", "p_entered_at" timestamp with time zone, "p_ship_to_name" "text", "p_ship_to_address1" "text", "p_ship_to_address2" "text", "p_ship_to_city" "text", "p_ship_to_region" "text", "p_ship_to_postal" "text", "p_ship_to_country" "text", "p_discount_total" numeric, "p_tax_total" numeric, "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_order"("p_site_id" "uuid", "p_lines" "jsonb", "p_customer_id" "uuid", "p_channel" "text", "p_order_type" "text", "p_sale_date" "date", "p_entered_at" timestamp with time zone, "p_ship_to_name" "text", "p_ship_to_address1" "text", "p_ship_to_address2" "text", "p_ship_to_city" "text", "p_ship_to_region" "text", "p_ship_to_postal" "text", "p_ship_to_country" "text", "p_discount_total" numeric, "p_tax_total" numeric, "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_order"("p_site_id" "uuid", "p_lines" "jsonb", "p_customer_id" "uuid", "p_channel" "text", "p_order_type" "text", "p_sale_date" "date", "p_entered_at" timestamp with time zone, "p_ship_to_name" "text", "p_ship_to_address1" "text", "p_ship_to_address2" "text", "p_ship_to_city" "text", "p_ship_to_region" "text", "p_ship_to_postal" "text", "p_ship_to_country" "text", "p_discount_total" numeric, "p_tax_total" numeric, "p_notes" "text") TO "service_role";



GRANT ALL ON TABLE "public"."shipments" TO "anon";
GRANT ALL ON TABLE "public"."shipments" TO "authenticated";
GRANT ALL ON TABLE "public"."shipments" TO "service_role";



GRANT ALL ON FUNCTION "public"."create_shipment"("p_group_id" "uuid", "p_carrier" "text", "p_service_level" "text", "p_estimated_cost" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."create_shipment"("p_group_id" "uuid", "p_carrier" "text", "p_service_level" "text", "p_estimated_cost" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_shipment"("p_group_id" "uuid", "p_carrier" "text", "p_service_level" "text", "p_estimated_cost" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."fulfill_order"("p_order_id" "uuid", "p_fulfilled_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."fulfill_order"("p_order_id" "uuid", "p_fulfilled_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."fulfill_order"("p_order_id" "uuid", "p_fulfilled_at" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."group_packaging_cost"("p_group_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."group_packaging_cost"("p_group_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."group_packaging_cost"("p_group_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_operator"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_operator"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_operator"() TO "service_role";



GRANT ALL ON FUNCTION "public"."layaway_book"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."layaway_book"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."layaway_book"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."layaway_cancel"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."layaway_cancel"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."layaway_cancel"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."layaway_consume"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."layaway_consume"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."layaway_consume"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."merge_products"("p_survivor" "uuid", "p_losers" "uuid"[], "p_dry_run" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."merge_products"("p_survivor" "uuid", "p_losers" "uuid"[], "p_dry_run" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."merge_products_by_sku"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."merge_products_by_sku"() TO "anon";
GRANT ALL ON FUNCTION "public"."merge_products_by_sku"() TO "service_role";



GRANT ALL ON TABLE "public"."fulfillment_groups" TO "anon";
GRANT ALL ON TABLE "public"."fulfillment_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."fulfillment_groups" TO "service_role";



GRANT ALL ON FUNCTION "public"."pack_group"("p_group_id" "uuid", "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."pack_group"("p_group_id" "uuid", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pack_group"("p_group_id" "uuid", "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."pick_complete"("p_group_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."pick_complete"("p_group_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pick_complete"("p_group_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."pick_fee_amount"("p_units" integer, "p_first" numeric, "p_additional" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."pick_fee_amount"("p_units" integer, "p_first" numeric, "p_additional" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."pick_fee_amount"("p_units" integer, "p_first" numeric, "p_additional" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."pick_required"("p_group_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."pick_required"("p_group_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pick_required"("p_group_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."receive_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid", "p_note" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."receive_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."receive_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid", "p_note" "text") TO "service_role";



GRANT ALL ON TABLE "public"."order_payments" TO "anon";
GRANT ALL ON TABLE "public"."order_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."order_payments" TO "service_role";



GRANT ALL ON FUNCTION "public"."record_order_payment"("p_order_id" "uuid", "p_amount" numeric, "p_method" "text", "p_note" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."record_order_payment"("p_order_id" "uuid", "p_amount" numeric, "p_method" "text", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_order_payment"("p_order_id" "uuid", "p_amount" numeric, "p_method" "text", "p_note" "text") TO "service_role";



GRANT ALL ON TABLE "public"."packaging_usage" TO "anon";
GRANT ALL ON TABLE "public"."packaging_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."packaging_usage" TO "service_role";



GRANT ALL ON FUNCTION "public"."record_packaging_usage"("p_group_id" "uuid", "p_packaging_type_id" "uuid", "p_quantity" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."record_packaging_usage"("p_group_id" "uuid", "p_packaging_type_id" "uuid", "p_quantity" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_packaging_usage"("p_group_id" "uuid", "p_packaging_type_id" "uuid", "p_quantity" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."release_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."release_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."release_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."reserve_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."reserve_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reserve_stock"("p_child_sku_id" "uuid", "p_qty" integer, "p_ref_type" "text", "p_ref_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."fee_schedules" TO "anon";
GRANT ALL ON TABLE "public"."fee_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."fee_schedules" TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_fee_schedule"("p_as_of" "date", "p_client_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_fee_schedule"("p_as_of" "date", "p_client_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_fee_schedule"("p_as_of" "date", "p_client_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_on_hand_to"("p_child_sku_id" "uuid", "p_target" integer, "p_ref_type" "text", "p_ref_id" "uuid", "p_note" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."set_on_hand_to"("p_child_sku_id" "uuid", "p_target" integer, "p_ref_type" "text", "p_ref_id" "uuid", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_on_hand_to"("p_child_sku_id" "uuid", "p_target" integer, "p_ref_type" "text", "p_ref_id" "uuid", "p_note" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_order_status"("p_order_id" "uuid", "p_new_status" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."set_order_status"("p_order_id" "uuid", "p_new_status" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_order_status"("p_order_id" "uuid", "p_new_status" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_pick_qty"("p_group_id" "uuid", "p_child_sku_id" "uuid", "p_qty" integer, "p_short" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."set_pick_qty"("p_group_id" "uuid", "p_child_sku_id" "uuid", "p_qty" integer, "p_short" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_pick_qty"("p_group_id" "uuid", "p_child_sku_id" "uuid", "p_qty" integer, "p_short" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_shipment_status"("p_shipment_id" "uuid", "p_new_status" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."set_shipment_status"("p_shipment_id" "uuid", "p_new_status" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_shipment_status"("p_shipment_id" "uuid", "p_new_status" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_package"("p_package_id" "uuid", "p_tracking_number" "text", "p_cost" numeric, "p_weight_grams" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."update_package"("p_package_id" "uuid", "p_tracking_number" "text", "p_cost" numeric, "p_weight_grams" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_package"("p_package_id" "uuid", "p_tracking_number" "text", "p_cost" numeric, "p_weight_grams" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."update_shipment"("p_shipment_id" "uuid", "p_carrier" "text", "p_service_level" "text", "p_estimated_cost" numeric, "p_actual_cost" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."update_shipment"("p_shipment_id" "uuid", "p_carrier" "text", "p_service_level" "text", "p_estimated_cost" numeric, "p_actual_cost" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_shipment"("p_shipment_id" "uuid", "p_carrier" "text", "p_service_level" "text", "p_estimated_cost" numeric, "p_actual_cost" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."upsert_store_variant"("p_site_id" "uuid", "p_store_variant_id" "text", "p_name" "text", "p_sku" "text", "p_price" numeric, "p_cost" numeric, "p_inventory_qty" integer, "p_channel" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."upsert_store_variant"("p_site_id" "uuid", "p_store_variant_id" "text", "p_name" "text", "p_sku" "text", "p_price" numeric, "p_cost" numeric, "p_inventory_qty" integer, "p_channel" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_store_variant"("p_site_id" "uuid", "p_store_variant_id" "text", "p_name" "text", "p_sku" "text", "p_price" numeric, "p_cost" numeric, "p_inventory_qty" integer, "p_channel" "text") TO "service_role";


















GRANT ALL ON TABLE "public"."audit_log" TO "anon";
GRANT ALL ON TABLE "public"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."sites" TO "anon";
GRANT ALL ON TABLE "public"."sites" TO "authenticated";
GRANT ALL ON TABLE "public"."sites" TO "service_role";



GRANT ALL ON TABLE "public"."billing_report" TO "anon";
GRANT ALL ON TABLE "public"."billing_report" TO "authenticated";
GRANT ALL ON TABLE "public"."billing_report" TO "service_role";



GRANT ALL ON TABLE "public"."categories" TO "anon";
GRANT ALL ON TABLE "public"."categories" TO "authenticated";
GRANT ALL ON TABLE "public"."categories" TO "service_role";



GRANT ALL ON TABLE "public"."child_skus" TO "anon";
GRANT ALL ON TABLE "public"."child_skus" TO "authenticated";
GRANT ALL ON TABLE "public"."child_skus" TO "service_role";



GRANT ALL ON TABLE "public"."order_line_items" TO "anon";
GRANT ALL ON TABLE "public"."order_line_items" TO "authenticated";
GRANT ALL ON TABLE "public"."order_line_items" TO "service_role";



GRANT ALL ON TABLE "public"."cogs_report" TO "anon";
GRANT ALL ON TABLE "public"."cogs_report" TO "authenticated";
GRANT ALL ON TABLE "public"."cogs_report" TO "service_role";



GRANT ALL ON TABLE "public"."customers" TO "anon";
GRANT ALL ON TABLE "public"."customers" TO "authenticated";
GRANT ALL ON TABLE "public"."customers" TO "service_role";



GRANT ALL ON TABLE "public"."duplicate_products_report" TO "anon";
GRANT ALL ON TABLE "public"."duplicate_products_report" TO "authenticated";
GRANT ALL ON TABLE "public"."duplicate_products_report" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."inventory_ledger" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."inventory_ledger" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_report" TO "anon";
GRANT ALL ON TABLE "public"."inventory_report" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_report" TO "service_role";



GRANT ALL ON TABLE "public"."landed_margin_report" TO "anon";
GRANT ALL ON TABLE "public"."landed_margin_report" TO "authenticated";
GRANT ALL ON TABLE "public"."landed_margin_report" TO "service_role";



GRANT ALL ON TABLE "public"."order_payment_summary" TO "anon";
GRANT ALL ON TABLE "public"."order_payment_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."order_payment_summary" TO "service_role";



GRANT ALL ON TABLE "public"."packaging_types" TO "anon";
GRANT ALL ON TABLE "public"."packaging_types" TO "authenticated";
GRANT ALL ON TABLE "public"."packaging_types" TO "service_role";



GRANT ALL ON TABLE "public"."packaging_cost_report" TO "anon";
GRANT ALL ON TABLE "public"."packaging_cost_report" TO "authenticated";
GRANT ALL ON TABLE "public"."packaging_cost_report" TO "service_role";



GRANT ALL ON TABLE "public"."pick_claims" TO "anon";
GRANT ALL ON TABLE "public"."pick_claims" TO "authenticated";
GRANT ALL ON TABLE "public"."pick_claims" TO "service_role";



GRANT ALL ON TABLE "public"."pick_progress" TO "anon";
GRANT ALL ON TABLE "public"."pick_progress" TO "authenticated";
GRANT ALL ON TABLE "public"."pick_progress" TO "service_role";



GRANT ALL ON TABLE "public"."product_merge_log" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."product_merge_log" TO "authenticated";
GRANT ALL ON TABLE "public"."product_merge_log" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."sales_report" TO "anon";
GRANT ALL ON TABLE "public"."sales_report" TO "authenticated";
GRANT ALL ON TABLE "public"."sales_report" TO "service_role";



GRANT ALL ON TABLE "public"."shipping_cost_report" TO "anon";
GRANT ALL ON TABLE "public"."shipping_cost_report" TO "authenticated";
GRANT ALL ON TABLE "public"."shipping_cost_report" TO "service_role";



GRANT ALL ON TABLE "public"."store_connections" TO "anon";
GRANT ALL ON TABLE "public"."store_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."store_connections" TO "service_role";



GRANT ALL ON TABLE "public"."store_secrets" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."store_secrets" TO "authenticated";
GRANT ALL ON TABLE "public"."store_secrets" TO "service_role";



GRANT ALL ON TABLE "public"."store_credential_status" TO "anon";
GRANT ALL ON TABLE "public"."store_credential_status" TO "authenticated";
GRANT ALL ON TABLE "public"."store_credential_status" TO "service_role";



GRANT ALL ON TABLE "public"."store_order_imports" TO "anon";
GRANT ALL ON TABLE "public"."store_order_imports" TO "authenticated";
GRANT ALL ON TABLE "public"."store_order_imports" TO "service_role";



GRANT ALL ON TABLE "public"."user_site_access" TO "anon";
GRANT ALL ON TABLE "public"."user_site_access" TO "authenticated";
GRANT ALL ON TABLE "public"."user_site_access" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































