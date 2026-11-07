-- ============================================================================
-- WMS — Migration 0118: a hidden "premium" shake pot for a one-off batch
--
-- About 50 lb of shake on hand is a mix of light dep and indoor from before
-- shake was tracked by quality. It is sold once as "Premium Shake" (one
-- product per brand) and then goes away, split on a fixed 45 lb / 5 lb
-- between Bud Club and Tsunami instead of by sales.
--
-- It still has to count as shake on the brand billing report, which reads
-- shake_distributions. A distribution must belong to a pot, so this adds a
-- fourth pot, 'premium', that only the one-off script
-- (supabase/snippets/premium_shake_one_off.sql) writes to.
--
-- Deliberately NOT changed:
--   * products.quality stays light_dep / indoor / exotic. No strain is
--     premium, so no sales count toward it and the Shake screen never offers it.
--   * record_shake_in / distribute_shake / shake_brand_shares still refuse
--     'premium'. The pot cannot be added to or split from the screen.
--   * reverse_shake_distribution and reverse_shake_in work on any pot, so the
--     one-off can be undone from the Shake screen's history like any split.
-- ============================================================================

alter table public.shake_pots drop constraint shake_pots_quality_check;
alter table public.shake_pots
  add constraint shake_pots_quality_check
  check (quality in ('light_dep','indoor','exotic','premium'));

insert into public.shake_pots(quality) values ('premium') on conflict do nothing;

comment on table public.shake_pots is
  'Shake on hand per quality pot, in grams. light_dep / indoor / exotic are filled on the Shake screen and split to brands by sales. premium (0118) is a hidden one-off pot for an untracked light dep / indoor mix, split on a fixed ratio by a script.';
