# End-to-end tests (Playwright)

Browser tests that drive the real app + a local Supabase through the critical
**pick → pack → fulfill (ship)** flow. Local-only for now (not wired into CI).

## One-time setup

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.e2e.example .env.e2e
```

Start a local Supabase and fill `.env.e2e` from its output:

```bash
supabase start           # or: supabase db reset  (applies migrations + seed)
supabase status          # copy the API URL, anon key, and service_role key
```

The app under test must point at that same local Supabase (set
`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `.env.local`).

## Run

```bash
pnpm test:e2e            # headless
pnpm test:e2e:ui        # interactive Playwright UI
pnpm test:e2e:report    # open the last HTML report
```

The config starts `pnpm dev` automatically if nothing is serving `E2E_BASE_URL`,
and reuses an already-running server otherwise.

## How it works

- `auth.setup.ts` (the `setup` project) runs first: it ensures a confirmed test
  user, creates one ready-to-pack order via `create_order`, writes the ids to
  `e2e/.data/order.json`, logs in through the UI, and saves the session to
  `e2e/.auth/user.json`.
- `pack-ship.spec.ts` reuses that session and walks the group through picking,
  packing, and fulfillment, asserting the order reaches its terminal state.

`.auth/` and `.data/` are gitignored. Each run creates a new order, so reruns
are safe; `supabase db reset` gives a clean slate.

## Notes

- Selectors follow the current UI labels (**Pick**, **All**, **Pack group**,
  **Confirm packed**, **Fulfill**). If the UI copy changes, update the spec.
- Seed data comes from `supabase/seed.sql` (Main Warehouse + Wildflower Honey).
