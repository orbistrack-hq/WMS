-- Rollback for 0118: remove the premium pot and its history.
-- Refuses while premium stock from it is still in place, so stock and billing
-- never point at a pot that no longer exists. Undo the premium split on the
-- Shake screen first.

do $$
begin
  if exists (select 1 from public.shake_distributions
              where quality = 'premium' and reversed_at is null) then
    raise exception 'A premium shake split is still active. Undo it on the Shake screen before rolling back 0118.';
  end if;
end;
$$;

delete from public.shake_distributions where quality = 'premium';
delete from public.shake_ledger        where quality = 'premium';
delete from public.shake_pots          where quality = 'premium';

alter table public.shake_pots drop constraint shake_pots_quality_check;
alter table public.shake_pots
  add constraint shake_pots_quality_check
  check (quality in ('light_dep','indoor','exotic'));
