# Go-live hardening + operator UX batch

Branch: `test-staging` → `main`. Two bodies of work: (1) go-live hardening
(verification, security, sync, UAT, reversible migrations — already committed as
`7fabd28`) and (2) an operator-facing feature batch (undo, admin delete, wave
confirm-packed, navigation) plus a CI fix (still to commit).

Everything is verified: **81 unit tests pass**, **typecheck + lint clean**, and the
**migration round-trip passes** (all migrations apply forward and reverse to an
empty schema). DB logic for the new features was functionally tested against a real
Postgres 16.

---

## 1. Go-live hardening (committed — 7fabd28)

- **Migration round-trip test** — `supabase/tests/roundtrip/{roundtrip.py,README.md}`
  applies every migration forward, reverse-applies every rollback, asserts the public
  schema is empty. Wired into CI (`migration-roundtrip` job on a `postgres:16`
  service); `deploy-migrations` depends on it.
- **6 missing rollbacks authored** — `supabase/rollback/2026062500001{7,8,9},…0020,
  …0021, …0027*.down.sql` so the round-trip is complete and reversible.
- **Webhook contract tests** — `lib/store-sync/webhook-contract.test.ts`: replays
  recorded Shopify/Woo payloads, asserts auth (accept/reject) + idempotency.
- **Reconciliation draft** — `supabase/snippets/inventory_reconciliation.sql`
  (levels-vs-ledger + parent-vs-child drift views + `reconcile_inventory()`).
- **UAT + status docs** — `CORE-WORKFLOWS-UAT.md` (12-scenario sign-off sheet),
  `GO-LIVE-CHECKLIST.md`, `GO-LIVE-STATUS.md`.
- **User provisioning** — `scripts/provision-user.sql` (roles: admin / operator /
  client). `.github/workflows/ci.yml` gains the round-trip job.

## 2. CI fix — round-trip residue (to commit)

- `supabase/tests/roundtrip/roundtrip.py` — exclude extension-owned objects
  (pgcrypto, via `pg_depend`) from the residue check. Fixes the CI failure where
  `create extension pgcrypto` left ~36 functions counted as leftovers. Verified it
  still catches genuine non-extension leftovers.

## 3. Undo / reverse intake + allocation (to commit)

- **Migration 0034** — `supabase/migrations/20260706000034_intake_allocation_reversal.sql`
  (+ rollback): `reverse_intake()` and `reverse_allocation()`. Admin/operator only,
  all-or-nothing, audited; blocked with a clear message when stock has already moved
  (guards enforce it). Tracks `reversed_at/by` to prevent double-undo.
- `app/(app)/inventory/intake/actions.ts` — `reverseIntake` / `reverseAllocation`.
- `app/(app)/inventory/intake/history/[id]/page.tsx` + `reverse-allocation-button.tsx`
  (new) — reverse button + "Reversed on…" badge on the allocation detail.
- `app/(app)/inventory/intake/receipts/page.tsx` + `reverse-intake-button.tsx` (new)
  — new "Intake receipts" list with a reverse button per intake.
- `app/(app)/inventory/intake/page.tsx` — links to Intake receipts + Allocation history.

## 4. Admin-only catalog delete (to commit)

- **Migration 0035** — `supabase/migrations/20260706000035_catalog_delete.sql`
  (+ rollback): `delete_child_sku()` / `delete_product()`. Admin only; hard delete
  blocked with a specific message when there's history (orders, movements,
  allocations, child SKUs); FK constraints as a backstop; audited.
- `app/(app)/catalog/actions.ts` — `deleteChildSku` / `deleteProduct`.
- `app/(app)/catalog/[id]/child-sku-manager.tsx` — admin-only per-SKU delete button.
- `app/(app)/catalog/[id]/page.tsx` + `delete-product-button.tsx` (new) — admin-only
  "Delete product" in the header; computes `isAdmin` server-side.

## 5. Wave confirm-packed (to commit)

- `app/(app)/packing/wave/wave-view.tsx` — per-group "Confirm packed" + bulk
  "Confirm all packed" in the wave's Sort mode (status-only; reuses `pack_group`).
  Packaging is still recorded per group on its pack screen.

## 6. Navigation + Settings (to commit)

- `components/nav-items.ts` — `NAV_TREE` with a collapsible **Integrations** group
  (Shopify + WooCommerce); `NAV_ITEMS` is the derived flat leaf list (dashboard
  quick-links unchanged).
- `components/sidebar-nav.tsx` — renders collapsible groups (auto-opens on active
  child).
- `app/(app)/settings/page.tsx` — adds the WooCommerce settings card.

## 7. Bug fix — combobox clipping (to commit)

- `app/(app)/orders/new/order-form.tsx` — `overflow-visible` on the two cards holding
  a combobox, so the dropdown isn't clipped by the card's `overflow-hidden`.

---

## Committing notes

- **Force-add the new SQL** (the repo's `.gitignore` has `*.sql`):
  ```
  git add -f supabase/migrations/20260706000034_intake_allocation_reversal.sql \
             supabase/rollback/20260706000034_intake_allocation_reversal.down.sql \
             supabase/migrations/20260706000035_catalog_delete.sql \
             supabase/rollback/20260706000035_catalog_delete.down.sql
  ```
- **Do not commit** `next-env.d.ts` / `tsconfig.tsbuildinfo` (build artifacts; revert them).
- The `.ts`/`.tsx` files add normally with `git add -A`.

## Verification

- `pnpm test` → 81 pass · `pnpm typecheck` clean · `pnpm lint` clean.
- Migration round-trip: all migrations forward + reverse to empty schema (incl. 0034, 0035).
- 0034 / 0035 DB logic functionally tested on real Postgres (happy, blocked, role, double-undo).
