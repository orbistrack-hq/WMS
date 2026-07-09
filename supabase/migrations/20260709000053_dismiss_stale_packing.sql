-- ============================================================================
-- WMS — Migration 0053: dismiss (hide) stale packing groups
--
-- The packing queue shows every fulfillment_group with status='open'. Orders that
-- were fulfilled outside the WMS (e.g. in the store) but never marked fulfilled
-- here linger on the queue forever and clutter onboarding.
--
-- This adds a NON-DESTRUCTIVE "dismiss": a dismissed group drops off the packing
-- queue but its orders, inventory reservations, and billing are left completely
-- untouched. It's reversible (undismiss). This is deliberately NOT a cancel — no
-- inventory is released — because these stale orders were typically already
-- handled elsewhere and their old reservations no longer reflect reality.
--
-- Authorization: operator-level (admin/operator/manager) via is_operator(), so
-- managers can clean up the queue too.
-- ============================================================================

begin;

-- 1. Audit columns (mirror the reversed_at/reversed_by pattern used elsewhere).
alter table public.fulfillment_groups
  add column if not exists dismissed_at timestamptz,
  add column if not exists dismissed_by uuid references public.profiles(id);

comment on column public.fulfillment_groups.dismissed_at is
  'When set, the group is hidden from the packing queue (stale / already handled). Non-destructive: orders, inventory, and billing are untouched. Cleared by undismiss_fulfillment_group.';

-- 2. Keep the packing-queue read (status=open, not dismissed, by window) fast.
create index if not exists fulfillment_groups_queue_idx
  on public.fulfillment_groups (window_start)
  where status = 'open' and dismissed_at is null;

-- 3. Dismiss one group. Only 'open' groups are on the queue, so only those can be
--    dismissed; fulfilled/cancelled are already off it.
create or replace function public.dismiss_fulfillment_group(p_group_id uuid)
returns public.fulfillment_groups
language plpgsql security definer set search_path = '' as $$
declare g public.fulfillment_groups;
begin
  if not public.is_operator() then
    raise exception 'Not authorized to dismiss a fulfillment group' using errcode = '42501';
  end if;

  select * into g from public.fulfillment_groups where id = p_group_id for update;
  if g.id is null then
    raise exception 'Fulfillment group % not found', p_group_id;
  end if;
  if g.status <> 'open' then
    raise exception 'Only open groups can be dismissed (group % is %)', p_group_id, g.status
      using errcode = 'check_violation';
  end if;
  if g.dismissed_at is not null then
    return g;  -- already dismissed — idempotent no-op
  end if;

  update public.fulfillment_groups
     set dismissed_at = now(), dismissed_by = auth.uid(), updated_at = now()
   where id = p_group_id
   returning * into g;
  return g;
end;
$$;

comment on function public.dismiss_fulfillment_group(uuid) is
  'Hide a stale fulfillment group from the packing queue. Non-destructive and reversible (undismiss_fulfillment_group). Operator-level (admin/operator/manager).';

-- 4. Restore a dismissed group back onto the queue.
create or replace function public.undismiss_fulfillment_group(p_group_id uuid)
returns public.fulfillment_groups
language plpgsql security definer set search_path = '' as $$
declare g public.fulfillment_groups;
begin
  if not public.is_operator() then
    raise exception 'Not authorized to restore a fulfillment group' using errcode = '42501';
  end if;

  update public.fulfillment_groups
     set dismissed_at = null, dismissed_by = null, updated_at = now()
   where id = p_group_id
   returning * into g;
  if g.id is null then
    raise exception 'Fulfillment group % not found', p_group_id;
  end if;
  return g;
end;
$$;

comment on function public.undismiss_fulfillment_group(uuid) is
  'Un-hide a previously dismissed fulfillment group (put it back on the packing queue). Operator-level.';

-- 5. Bulk dismiss every open, not-yet-dismissed group whose window is before a
--    cutoff. Returns the count dismissed.
create or replace function public.dismiss_stale_fulfillment_groups(p_before timestamptz)
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if not public.is_operator() then
    raise exception 'Not authorized to dismiss fulfillment groups' using errcode = '42501';
  end if;
  if p_before is null then
    raise exception 'A cutoff date is required';
  end if;

  with upd as (
    update public.fulfillment_groups
       set dismissed_at = now(), dismissed_by = auth.uid(), updated_at = now()
     where status = 'open'
       and dismissed_at is null
       and window_start < p_before
    returning 1
  )
  select count(*) into v_count from upd;
  return v_count;
end;
$$;

comment on function public.dismiss_stale_fulfillment_groups(timestamptz) is
  'Bulk-hide every open, not-yet-dismissed fulfillment group with window_start before the cutoff. Returns the number hidden. Operator-level (admin/operator/manager).';

-- 6. Grants: callable by the app; the is_operator() check inside is the gate.
revoke execute on function public.dismiss_fulfillment_group(uuid)              from public;
revoke execute on function public.undismiss_fulfillment_group(uuid)            from public;
revoke execute on function public.dismiss_stale_fulfillment_groups(timestamptz) from public;
grant  execute on function public.dismiss_fulfillment_group(uuid)              to authenticated;
grant  execute on function public.undismiss_fulfillment_group(uuid)            to authenticated;
grant  execute on function public.dismiss_stale_fulfillment_groups(timestamptz) to authenticated;

commit;
