# OrbisTrack — Go-Live Status: Verification, Security, Syncing, UAT

_Prepared for J · 2026-07-05 · reference: `GO-LIVE-CHECKLIST.md`_

## Summary

The four gates you want to sign off are close. **Everything that can be proven
in code is now green and automated**; what remains is a short list of
production-only confirmations and live spot-checks that can only be done against
the real Vercel/Supabase/store environments — none of which are code changes.

| Gate | State | What's left before you can say "complete" |
|------|-------|--------------------------------------------|
| **Verification** | ✅ Complete | — (baseline green, contract tests + migration round-trip both passing) |
| **Security** | ✅ Proven in CI | Prod confirmation of RLS + secrets + webhook secrets; `/security-review` on final diff |
| **Syncing** | 🟡 Proven + drafted | One explicit invariant assertion; review/promote the reconciliation draft; live dev-store run |
| **UAT** | 🟡 Mostly signed off | Manual layaway end-to-end; one-day shadow run; record remaining intake steps |

---

## Verification — DONE (baseline green + contract tests added)

Ran the full local suite this session: **81 unit tests pass** (up from 74),
**typecheck clean**, **lint clean**.

New this session — `lib/store-sync/webhook-contract.test.ts` (7 tests): replays
recorded Shopify and Woo order payloads and locks the receiver's two guarantees —
**authentication** (accept a valid HMAC/signature, reject a tampered body, a wrong
secret, or a missing header) and **idempotency** (a re-delivery produces the same
dedupe key so it collapses; distinct events produce distinct keys; Woo retries —
which carry fresh delivery ids — collapse on the body hash).

Migration round-trip — DONE. `supabase/tests/roundtrip/roundtrip.py` applies all 41
migrations forward, reverse-applies every rollback, and asserts the `public` schema
is empty again. The 6 previously-missing `down` files (0017, 0018, 0019, 0020, 0021,
0027) were authored and **verified against a real Postgres 16** (passes from a clean
state). Wired into CI as the `migration-roundtrip` job, and `deploy-migrations` now
depends on it — a non-reversible migration blocks the prod deploy.

## Security — PROVEN IN CI (prod confirmation outstanding)

This gate was in better shape than the checklist implied. Already automated:

- **Site-scoped RLS** — `supabase/tests/05_rls.sql` runs as the real
  `authenticated` role with simulated JWT claims and proves a client sees only its
  assigned site's SKUs while an operator sees all. This is exactly the invariant
  the manual check describes, running on every push.
- **Store-secret lockdown** — `supabase/tests/10_shopify_secrets_lockdown.sql`
  proves the `authenticated` role gets a `42501` permission error reading
  `store_secrets`, and the status view exposes only `has_token`/`has_secret`
  booleans, never raw values.
- **Webhook signature enforcement** — enforced in both receiver routes (raw-body
  HMAC-SHA256, **401 before any enqueue** on mismatch) and now covered by the new
  contract tests above.

**Remaining (prod-only, your action):** run the two SQL spot-checks in §6 of the
checklist against **prod**; confirm `SHOPIFY_WEBHOOK_SECRET` /
`WOOCOMMERCE_WEBHOOK_SECRET` (or per-store secrets) are set; run `/security-review`
on the final pre-merge diff.

## Syncing — INVARIANT PROVEN, RECONCILIATION DRAFTED

The core invariant ("parent bulk is never synced; each child pushes its exact unit
count") is substantially proven in CI: `tests/18` shows outbound enqueues **one job
per child SKU carrying its live unit count** and that **unmapped SKUs never
enqueue**; `tests/19` keeps parent stock in a **separate grams ledger** with no
outbound trigger. Loop suppression, coalescing, backoff and the failure cap are all
covered too.

New this session — `supabase/snippets/inventory_reconciliation.sql` (DRAFT): two
drift views (levels-vs-ledger per SKU, parent-grams-vs-committed-child-grams per
product/site) and a service-role `reconcile_inventory()` that returns only drifting
rows so a scheduled job can alert when the result is non-empty. Left as a snippet on
purpose — it should be reviewed and run on a Supabase branch before becoming a
migration.

**Remaining:** add one explicit "a parent-grams movement enqueues nothing"
assertion; review + promote the reconciliation draft and wire a route + schedule;
enable `sync_inventory_outbound` on the **dev store** and confirm the invariant live
before any real store.

## UAT — MOSTLY SIGNED OFF

Passing already: manual order → pick → pack → ship → fulfill; the combined-order
case (box/label once per group, consumables summed); post-dated and hold; and
layaway **payments/installments** (`tests/03_payments.sql`). The intake/allocation
flow followed the UAT and loaded cleanly.

**Remaining:** a manual layaway **end-to-end** run (stock removed now, paid later);
the one-location, one-day shadow run alongside the current process; and recording
results for the remaining `INTAKE-ALLOCATION-UAT.md` steps.

---

## What I could not do from here (owner/infra actions)

These need the live environments and are not code:

- Set the Upstash/QStash env vars in Vercel and point a QStash schedule at the
  outbound drain (checklist §1).
- Promote the first admin user and create staff accounts (§1).
- Tag the `v0.1.0-rc1` release as a rollback point (§0).
- The prod SQL confirmations for RLS / secrets, and the live webhook 401 check (§6).
- Enable outbound on the dev store, then the first live store (§4).

## How to reproduce the green baseline

```
pnpm install
pnpm test        # 81 unit tests
pnpm typecheck
pnpm lint
```

The database (pgTAP) and migration tests run in CI via `supabase test db` (they need
Docker locally).
