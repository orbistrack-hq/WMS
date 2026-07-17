-- Down: migration 0076 (BOGO suspected-duplicate guard)
begin;

drop trigger if exists t_childskus_flag_siblings on public.child_skus;
drop trigger if exists t_childskus_flag_dup      on public.child_skus;

drop view if exists public.suspected_duplicate_skus;

drop function if exists public.flag_duplicate_siblings();
drop function if exists public.flag_suspected_duplicate();
drop function if exists public._is_suspected_duplicate(uuid, uuid, text, numeric, numeric, boolean);
drop function if exists public._sku_norm(text);

alter table public.child_skus drop column if exists suspected_duplicate;

commit;
