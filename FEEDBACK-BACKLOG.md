# Feedback Backlog

Running list of operator/client feedback and the implementation plan for each.
Add new items at the top of "Open items". Status: 🆕 new · 🔍 needs decision · 🛠 ready to build · 🚧 in progress · ✅ done.

**Decisions locked (J, 2026-07-07)**
- **FB-1:** central pool is **per parent SKU only**; **migrate existing site-scoped balances into the central model**; **delegation is reversible** (pull back to central to re-delegate).
- **FB-2:** packaging/consumables are **written off** on a return (not restocked); the **pick fee / postage stands** (no reversal); **only the returned order bounces** (not the whole combined group, if easy); **whole-order returns first** (partial later); a returned order **can be re-opened**.
- **FB-3:** rule is **3.5g → jar, anything > 3.5g → 1 Mylar bag** (no lookup map); **3.5 is the threshold**; rules are **global**; seed our own defaults; auto-calc **always editable** (override at pack + edit in Settings → Packaging); offer both a per-jar **jar label** and the per-order **box + label** as editable defaults.
- **FB-4:** record shake against **product + central pool**, with an **optional site tag** for analytics and a **batch_no** for traceability; must be **reversible**; uses the central pool ([[FB-1]]).

---

## Open items

### FB-9 — Central packaging intake (move out of Settings, no per-site) + types-not-visible bug ✅
**Feedback (J, 2026-07-08):** Need a better way to record **packaging intake**. Put it somewhere more visible than Settings, and it should **not be per site — one pool for every site** (no allocation). Make **Intake** a dropdown that reveals **Product** or **Packaging**; the Packaging screen is the same "stock on hand" as Settings but relocated and without the per-site setup. Also: packaging **types still aren't visible** on the stock-on-hand / packaging-types screen.

**Decisions (J, 2026-07-08):** central packaging counts **start at zero** (existing per-site counts cleared, not summed). Types-visibility symptom confirmed: the list is **completely empty**.

**Build log — 2026-07-08 — shipped ✅ (round-trip PASS)**
- **Migration 0047** (`central_packaging_stock`): `packaging_levels` collapses to PK `(packaging_type_id)` — `site_id` (+ FK + index) dropped, existing rows cleared (start-at-zero). `packaging_ledger.site_id` made **nullable** (history kept; central movements write NULL). Primitives + writers lose the site arg: `_pkg_lock(type)`, `_pkg_write(type,…)`, `receive_packaging(type,qty,note)`, `adjust_packaging(type,delta,note)`, `set_packaging_reorder_point(type,point)`, now **ops-only** (`app_role in (admin,operator)`) since packaging is a central warehouse resource, not client-managed. Consumption trigger decrements the **central** pool (per-order `packaging_usage` unchanged → packaging cost report + per-brand billing unaffected). RLS reads open to any signed-in user; `packaging_stock_report` view now per-type. **Re-seeds the canonical shared types** (same fixed ids as 0046, `on conflict do nothing`) so the list can't come back empty — the fix for "types not visible". Reversible down restores the full per-site 0025/0039 shape; **round-trip verifier PASS** (55 migrations forward + reverse, schema clean).
- **App:** new **Intake → Packaging** screen `app/(app)/inventory/packaging/` (page + `packaging-stock.tsx` central card + `actions.ts`); nav **Intake** is now a group → **Product** (`/inventory/intake`) + **Packaging** (`/inventory/packaging`) (`components/nav-items.ts`). Settings → Packaging keeps type CRUD + rules; its per-site stock card is removed and links to the new screen; stock actions dropped from `settings/packaging/actions.ts`. Added `mylar_bag` to the kind label/list in the manager + settings actions.
- **Tests:** `17_packaging_stock.sql` rewritten central (plan 12); `24_client_scoped_packaging_merge.sql` packaging-stock sub-tests → central + ops-only (client refused 42501, operator receives; plan 16). `tsc`/`pnpm test` not runnable in-sandbox → run in CI before merge.
- **Incidental fix:** `supabase/migrations/20260707000041_order_returns.sql` and its `.down.sql` were **truncated in the working tree** (unterminated string / missing `commit;`) — restored from HEAD; they were blocking the whole migration chain (and any deploy).

### FB-5 — Intake flow: allocate-later, skip-to-allocate, fix history display ✅
**Feedback (J, 2026-07-08):** After intaking, let the team either (a) go **straight to allocation** when a product already has central inventory, or (b) go to an **intake history page** and **allocate later**. Also: the **intake / allocation history isn't displaying properly**.

**Current behaviour**
- Intake is a linear stepper (`intake-flow.tsx`): Select → Receive → Allocate → Done. You can't jump straight to Allocate for a product that already has central stock; you must run a receive first. "Done for now" exits, but re-entering restarts at Select.
- History lives in two places: `inventory/intake/receipts` (bulk intakes = `parent_inventory_ledger` reason `intake`) and `inventory/intake/history` (allocations). Both **join `sites`** on `parent_inventory_ledger.site_id` / `allocations.site_id` — which are **NULL for central rows since [[FB-1]]**, so the Site column renders "—" and, depending on the "not displaying" symptom, rows may look empty/broken.

**Proposed change**
1. **Skip-to-allocate:** on the intake landing (or a product's page), if `parent_inventory.on_hand_grams > 0`, offer "Allocate now" that jumps straight into the allocate step (`loadAllocationTargets(productId)`) without a receive. Effectively make Allocate reachable standalone, seeded from the central pool.
2. **Allocate-later from history:** an intake history/receipts row (or a "central stock on hand" list) gets an **Allocate** action that opens the allocate step for that product later.
3. **Fix history display:** investigate the "not displaying properly" report — most likely the `sites` join now yields "—" for central rows (cosmetic) but confirm it isn't returning empty/erroring. Drop the Site column on the central intake receipts + allocation-history *list* pages (it's meaningless post-central; the allocation *detail* page keeps per-child "Client site"), and verify RLS/paging still returns rows. (This absorbs the FB-1 cosmetic follow-up.)

**Decisions (J, 2026-07-08):** "central stock on hand + Allocate later" lives in a **dedicated "Awaiting allocation" list** (not folded into by-parent). History symptom confirmed: **both the receipts and allocation-history lists show "no rows"** (not just the "—") — i.e. the lists came back empty, so this was a real regression, not cosmetic.

**Build log — 2026-07-08 — shipped ✅ (code only, no migration)**
- **Fix history display (empty lists) — ROOT CAUSE found:** the lists came back empty because the `actor:profiles(...)` embed was **ambiguous**. Migration 0034 added a second FK from both `parent_inventory_ledger` and `allocations` to `profiles` (`reversed_by`, alongside the original `actor`), so PostgREST errored with *"more than one relationship was found for … and 'profiles'"* (PGRST201) and returned no rows. Fix: hint the FK column — `actor:profiles!actor(full_name)` — on both list pages and the allocation-detail header. **Also stopped swallowing the query error** (both list pages now read `error` and render it): that surfaced the real PGRST201 message and is what pinned the cause. Separately dropped the now-meaningless `site:sites(name)` embed + Site column (central rows are siteless post-[[FB-1]]); the detail page keeps the per-child "Client site."
- **Skip-to-allocate:** the intake landing now loads each parent's central `on_hand_grams` (`page.tsx`); the Select step shows a **"X g already in central inventory · Allocate now"** panel when the chosen parent has undelegated stock, jumping straight to the Allocate step with no receive (`intake-flow.tsx`, new `allocateOnly` flow — stepper drops "Receive", Back returns to Select, the done screen hides "Received" and reads "Allocation complete"). Also supports **`?allocate=<productId>`** deep-linking straight to the allocate step (runs once on mount).
- **Awaiting-allocation list:** new page `/inventory/intake/awaiting` — reads `parent_inventory_report` (central per-product view from 0043) where `available_grams > 0`, one row per parent SKU with central-available / allocated-to-date / last-movement + an **Allocate** button → `/inventory/intake?allocate=<product_id>`. Linked from the intake landing header alongside Intake receipts / Allocation history.
- **Files:** `app/(app)/inventory/intake/{page,intake-flow}.tsx`, `.../receipts/page.tsx`, `.../history/page.tsx`, `.../history/[id]/page.tsx`, new `.../awaiting/page.tsx`.
- **Verification:** `pnpm build` (Next 16 / Turbopack) compiles + type-checks clean after the two fixes below; empty-list fix confirmed against the running app (the surfaced PGRST201 error led to the disambiguation fix, after which receipts + allocation-history populate). Two build fixes made during verification: (a) `onClick={() => doLoadAllocation()}` on the receive-step button (bare handler passed the click event as the `pid` arg); (b) the `actor:profiles!actor` disambiguation above.
- **Remaining / optional:** no DB migration was needed. Any other page embedding `actor`/`reversed_by` on these tables would need the same `!actor` (or `!reversed_by`) hint.

---

### FB-6 — Packaging costs by weight AND dimension (extends [[FB-3]]) 🚧
**Feedback (J, 2026-07-08):** Every order is inside a **vacuum sealed bag** — always, one per order. **Jars and Mylar bags are what changes** by weight. For now, **every weight over 3.5g gets a Mylar bag**. Costs differ by **weight AND bag dimension**, so weight-only (today's model) isn't enough. It should calculate for **every order automatically, no button**, and be configurable on the **packaging settings** screen. Box included by default but **editable per order**.

**Confirmed cost table (J, 2026-07-08):**
- **Vacuum sealed bag:** $0.50 — **1 per order, always**.
- **Mylar bag 7g** (4×6×2): **$0.12**.
- **Mylar bag 14g & 28g** (6×9×3): **$0.20**.
- **Box:** $0.45 — default 1 per order, editable/removable.
- **Label paper:** $0.03 each.
- (3.5g still → **jar**, not a Mylar bag.)

**Why the current model isn't enough**
- [[FB-3]] modelled a single global threshold (`JAR_MAX_GRAMS = 3.5`: ≤3.5g → jar, >3.5g → one `vacuum_bag`) with one cost per `kind`. Now: (a) the **vacuum bag is a per-ORDER constant**, not the per-item "heavier" bag; (b) the per-item heavier packaging is a **Mylar bag whose size/cost depends on the weight** (7g vs 14g/28g → different dimensions/costs). So we need a **weight → specific packaging type** map with **per-size costs**, not a single threshold + single bag cost.

**Proposed change**
1. **Packaging types** gain the real SKUs with their own costs + a dimension label: `Vacuum bag $0.50`, `Mylar 4×6×2 $0.12`, `Mylar 6×9×3 $0.20`, `Box $0.45`, `Label $0.03`, `Jar` (+ jar label). (Depends on [[FB-7]] — types must be listable/editable first.)
2. **Weight→packaging map** (replaces FB-3's single threshold): a config table mapping `grams_per_unit` (or band) → packaging type + qty per unit. Seed: `3.5 → jar (+ label)`, `7 → Mylar 4×6×2`, `14 → Mylar 6×9×3`, `28 → Mylar 6×9×3`. Editable in **Settings → Packaging**.
3. **Per-order defaults:** `1 vacuum bag (always) + 1 box (editable) + label(s)`, applied to every order automatically.
4. **Fully automatic, no button:** compute + record packaging cost per order/group from the map on entering pack (drop the "Apply suggested" click), while still letting the packer override any line (esp. the box). Guard the combined-order "count once" for box/label/vacuum bag.
5. Feeds the existing packaging-cost report unchanged (now with per-size Mylar accuracy).

**Decisions (J, 2026-07-08):** **exact-weight** match (not bands); **vacuum bag is per ORDER** (still open: whether "per order" means once per combined group too — assume per order for now).
**Remaining open questions:** any weights beyond 3.5/7/14/28 to map? Jar label still $0.03 (same as label paper)?

**Build log — 2026-07-08 — Slice 1 shipped ✅ (data model + calc engine)**
- **Migration 0046** (`weight_packaging_config`): new `mylar_bag` kind; `packaging_weight_rule` (exact `grams_per_unit` → packaging type + qty) and `packaging_order_default` (per-order packaging) tables; RLS read=any signed-in, manage=operator ([[FB-7]]); audit + updated_at triggers. **Canonical config baked in** (fixed ids, idempotent) so every client instance gets it: types Box $0.45, Label $0.03, 3.5g Jar $0.40, Jar Label $0.03, Vacuum Sealed Bag $0.50, Mylar 4×6×2 $0.12, Mylar 6×9×3 $0.20; rules 3.5→jar+label, 7→small Mylar, 14/28→large Mylar; per-order defaults box + label + vacuum bag. Reversible down; **round-trip PASS** (54 migrations) and **DB config check PASS**.
- **Calc engine** (`lib/packing/packaging-rules.ts` → `computeOrderPackaging(units, weightRules, orderDefaults)`): exact-weight match per unit + per-order defaults once, aggregated by type with line/total cost, flags unknown-weight units. **6/6 unit tests** incl. a mixed 3.5/7/28g order pricing to **$3.14** and 7g vs 14g Mylar at $0.12 vs $0.20.
- **Slice 2 shipped ✅ (2026-07-08) — per-order pack screen auto-applies:**
  - `lib/packing/load-packaging-config.ts` — loads the weight rules + per-order defaults (joined to type costs, active only) for `computeOrderPackaging`.
  - Pack detail page (`packing/[id]/page.tsx`) now computes packaging from the DB config (dropped the old single-threshold `derivePackagingForGroup`/`packaging_rule` fetch).
  - `PackagingEditor` gains `autoApply`: on load, when nothing's recorded, it **records the computed packaging automatically — no button** (guarded so it fires once and never double-counts). Every line stays editable (esp. the box); Mylar sizes show by type name; `mylar_bag` kind labelled. `recordPackaging` snapshots authoritative costs.
- **Slice 3 shipped ✅ (2026-07-08) — Settings editor:**
  - Server actions (`settings/packaging/actions.ts`): add/update-qty/delete for both `packaging_weight_rule` and `packaging_order_default`, operator-gated with friendly errors (duplicate weight+type, permission).
  - `PackagingRulesMapEditor` + a new **"Weight → packaging"** card on Settings → Packaging: a "Per unit, by weight" table (weight | packaging type | qty, add/edit/delete) and an "Every order gets" table (type | qty). Read-only for non-ops. Editing revalidates `/packing` so the auto-calc picks it up.
  - Verified on real Postgres: an **operator** can add/update/delete weight rules + per-order defaults; a **client** is blocked by RLS.
- **Slice 2b shipped ✅ (2026-07-08) — wave (batch) screen now config-driven:**
  - `packing/wave/page.tsx`: dropped the `packaging_rule` / `JAR_MAX_GRAMS` fetch; now loads `loadPackagingConfig` and passes `weightRules` + `orderDefaults` to the view (same config as the per-order pack screen).
  - `packing/wave/wave-view.tsx`: replaced the single-threshold `derivePackagingForGroup` seed with `computeOrderPackaging`. Each group's inline packaging entry is now a list of **per-type editable lines** seeded from the config (exact-weight jar / Mylar size + one vacuum bag / box / label per order), each with a qty + remove, plus an add-type control and a per-group packaging-cost subtotal. The existing-packaging **zero-seed guard** (never double-count a group already packed on its own screen) and the confirm / "confirm all packed" mass-pack flow are unchanged. The printable **"Packaging needed"** summary now lists real per-type totals across the wave (defaults counted once per group) and flags units with no matching weight rule.
  - **FB-6 fully delivered.** Behaviour rests on the already-tested `computeOrderPackaging` engine (6/6). `next build` type-checks clean; `pnpm test` locally before merge as usual.

---

### FB-7 — Packaging types not visible / not editable in Settings (bug) ✅
**Feedback (J, 2026-07-08):** The packaging types list looks **empty on the Settings → Packaging screen**, and even on an **admin** account they **can't be edited** — possibly because all our types are shared (all-sites).

**Current behaviour / hypotheses**
- RLS (migration 0039): shared types (`site_id IS NULL`) are readable by anyone signed in and **editable by admins**; site-owned types need site access. So an admin *should* see and edit shared defaults. Candidates for the bug:
  1. **No rows** — the DB may simply have no `packaging_types` seeded (esp. after a `db reset` if seed omits them), so the list is genuinely empty.
  2. **Account isn't actually `admin`** — `is_admin()` / `app_role()` returns non-admin for this login (role wiring), so the update policy blocks edits.
  3. **UI/action bug** on the settings screen (the manager component or `updatePackagingType`).
- Investigate in order: check `select count(*) from packaging_types;` and `select app_role();` for the logged-in user, then the `PackagingManager` render + update action.

**Proposed change:** confirm root cause, then fix — seed the standard packaging types (ties into [[FB-6]]'s cost table), and/or fix the role/RLS/UI path so admins can view + edit shared defaults. **Blocks [[FB-6]]** (which needs editable types).

**Build log — 2026-07-08 — shipped ✅**
- **Root cause:** shared packaging defaults were **admin-only to edit** (migration 0039, a multi-tenant safeguard). Your account is almost certainly `operator`, not `admin`, so the edit controls were hidden — the "can't edit even on an admin account" symptom. Since the model is now **one Supabase per client**, that safeguard is obsolete.
- **Migration 0045** (`operator_manage_packaging`): `packaging_types` insert/update/delete shared branch and the `packaging_rule` write policy loosened from `is_admin()` → `is_operator()` (admin OR operator). Site-owned types + reads unchanged. Reversible down; round-trip **PASS** (53 migrations).
- **UI:** `settings/packaging` now fetches `is_operator` and passes a `canManage` flag; `PackagingManager` (prop `isAdmin` → `canManageShared`) and `PackagingRuleEditor` (prop `isAdmin` → `canEdit`) show edit / add-shared / rule controls for operators too.
- **Verified on real Postgres:** operator edits a shared packaging type + the jar/bag rule (previously blocked); a **client** still cannot edit shared types.
- **If the list is genuinely EMPTY on a fresh client Supabase:** that's a seeding gap, not this permission bug — `seed.sql` does insert the standard types, so a proper `supabase db reset` seeds them; otherwise add them via the (now-working) UI. [[FB-6]] will bake the standard cost-table types into a migration so every client instance gets them automatically.

---

### FB-8 — Editable parent SKU (product) name 🔍
**Feedback (J, 2026-07-08):** For all parent SKUs, let us edit the **actual parent name**. E.g. a child SKU is `TSU-AF3.5G`; the parent should just be `AF`.

**Current behaviour**
- The "parent" is a `products` row; its identity is `products.name` (products have no SKU code — only `child_skus.sku`). Catalog already has a product edit form (`catalog/[id]` + `product-form.tsx` + `catalog/actions.ts`) — need to confirm it lets you rename `products.name` and that the rename surfaces everywhere the parent is shown (intake combobox, by-parent screen, allocation).
- Parent names are often auto-derived from store product titles on sync (weight-grouping, migration 0030), which is why they read like a child SKU. They want a **manual, sticky override**.

**Proposed change:** ensure parent name is editable (in catalog and/or inline on `/inventory/by-parent`) and that a manual rename is **not overwritten by the next store sync** (a "name locked / manual" flag). Confirm where they most want the edit control.

---

### FB-9 — Parent SKU + store label when it spans multiple sites 🔍
**Feedback (J, 2026-07-08):** When a parent SKU on inventory intake is labeled with a store, what happens once one parent SKU has **multiple sites**?

**Current behaviour / answer**
- Post-[[FB-1]], intake itself no longer picks a store (central pool). The only place a store appears on intake is the **parent-SKU combobox label**, which lists **every site the product's child SKUs live in** (for telling duplicate-named parents apart) — so a parent spanning MAIN + EAST shows "AF · MAIN, EAST". Allocation then delegates the central grams to child SKUs at each of those sites.
- So "labeled with a store" is just a disambiguation hint, not a binding — a multi-site parent is expected and fine. Worth confirming this is the intended UX, and whether the label should show all sites, a count ("3 sites"), or be tied to the editable parent name from [[FB-8]].

**Proposed change:** mostly a clarification; if the multi-site label is confusing, switch it to a site **count** or show it alongside the (editable) parent name. Decide with [[FB-8]].

---

### FB-4 — "Shake" as a tracked loss at the allocation step ✅
**Feedback (J, 2026-07-07):** At the allocation step, add another section — **not a storefront/site**, but for **"Shake"** measured in **grams**. When the team allocates later in the day (after intaking pounds into central parent SKUs earlier), they record how much shake there is as a **loss**. In analytics this counts as a **loss**. *Shake = pieces of flower that fall off during packing and never reach the customer.*

**Current behaviour**
- Allocation (`allocate_parent_stock`) debits the central/parent pool by `Σ(units × grams_per_unit)` and credits each child SKU. Every gram out of the pool currently must land on a child SKU at a site.
- `parent_inventory_ledger.reason` is constrained to `('intake','allocation','transfer','correction')` — **no loss/shake reason exists**.
- There's no place to record grams that leave the pool as waste rather than as sellable stock.

**Proposed change**
1. **Ledger reason:** add `'shake'` (or `'loss'` with a sub-type) to the `parent_inventory_ledger.reason` check constraint. Debits the parent pool in grams, credits **no** child SKU / no store — pure loss.
2. **Allocation UI:** on the allocation screen, add a Shake input alongside the per-site allocation lines — a grams field, visually distinct (it's a loss bucket, not a site). Its grams count against the same central-pool available total, so `Σ(allocated) + shake ≤ parent available` (extend the existing over-allocation guard to include shake).
3. **Save path:** fold shake into the `allocate_parent_stock` RPC (or a sibling call in the same transaction) so it's atomic with the allocation and idempotent under the same key — pool debited once, one `reason='shake'` ledger row with the acting employee + timestamp + optional note.
4. **Analytics/reporting:** surface shake as a **loss** line — grams lost per product / per day / per date-range, per site or rolled up. Ties into the inventory/valuation report (shake × parent cost-per-gram = dollar loss). New "loss" metric, distinct from returns ([[FB-2]]).

**Open questions (confirm — cost attribution + model)**
- Is shake attributed to a **site/brand** (whose packing produced it) or purely to the **central pool / product**? The feedback says "not a storefront," but analytics may still want to know which team's packing shed it. (Recommend: record against the product + central pool, with an optional site tag for analytics.)
- Does shake reduce a specific **batch/lot** (`batch_no`) for traceability, or just the product pool?
- Should shake be **reversible/correctable** (fat-finger a gram count) via the existing correction path?
- Depends on [[FB-1]]: this assumes the central-pool model. If we keep site-scoped pools for now, shake attaches to the intake site's pool instead.

**Risk / size:** small, additive — one new ledger reason + one UI field + one analytics line. Extend the over-allocation guard and add a test that `allocated + shake` can't exceed the pool. Sequence **after / with [[FB-1]]** since it lives on the same allocation screen and pool model.

**Build log — 2026-07-07 — shipped ✅ (built on the central pool from [[FB-1]])**
- **Migration 0043** (`shake_loss`): `'shake'` added to the `parent_inventory_ledger` reason constraint; partial unique index on `reference_id where reason='shake'` for idempotency. `record_shake(product, grams, ref, site?, batch?, note?)` — idempotent on the ref uuid, debits the **central** pool as a loss (no child credit), optional **site tag** (analytics only, not a pool site) + **batch_no** (traceability); blocked if the pool lacks the grams. `reverse_shake(ledger_id)` credits it back (admin/operator). `shake_report` view (one row per shake: product, site tag, batch, grams lost, reversed flag) for loss analytics. Reversible down migration; pgTAP test `tests/27_shake.sql`.
- **App layer:** `saveAllocation` records shake after the allocation (idempotent, so a retry never double-debits); the allocation summary gains a **Shake / loss (grams)** input folded into the over-allocation guard (`allocated + shake ≤ available`), a live Shake row, and a completion-screen figure.
- **Verification:** round-trip verifier **PASS** (52 migrations forward + reverse, schema clean). Real-Postgres e2e **PASS**: intake 448 g → record 50 g shake → pool 398 g + one `shake` ledger row + `shake_report` shows 50 g lost; idempotent replay no double-debit; over-pool shake blocked; `reverse_shake` restores 448 g. `tsc` not runnable in-sandbox → `pnpm typecheck && pnpm test` before merge.
- **Follow-up (optional):** a dedicated Shake analytics page (like the Returns report) — the `shake_report` view is queryable/exportable now; a UI page + nav link is a fast follow. Shake-only (no accompanying allocation) is not exposed in the UI yet (record_shake supports it standalone).

---

### FB-3 — Wave printout: weight breakdown + auto-calculated packaging ✅
**Feedback (J, 2026-07-07):** The wave printout needs a section breaking down how many **28g** vs **3.5g** (etc.) products are in the wave. And the system should **auto-calculate packaging** from weight — e.g. a 3.5g product = 1 jar, a 28g product = a Mylar/vacuum bag (not a jar). This must not collide with the plan to keep stock in **central inventory** and delegate to child SKUs only later ([[FB-1]]).

**Current behaviour**
- Wave pick (`packing/wave/wave-view.tsx` + `lib/packing/aggregate.ts`) aggregates order lines into one row per child SKU with name/sku/bin/qty. **No weight is carried** and there's **no weight breakdown**.
- Packaging is **entered by hand** per group at pack time: box + label default to 1/group, jars/bags default to 0 (vary per order). Packaging `kind`s already exist: `box, shipping_label, jar, jar_label, vacuum_bag, custom`.
- Child SKUs carry `grams_per_unit` (populated by store sync + weight-variant migration 0030). That's the weight signal we'd key on.

**Why point 2 doesn't conflict with central inventory (the resolution)**
Packaging is derived from an **order line → child SKU → `grams_per_unit`**. `grams_per_unit` is a *product/variant attribute*, not an inventory balance. Orders are always placed against a child SKU (they carry a price + store variant), so the weight is known the moment the order exists — **before, during, or independent of** parent-pool delegation. So auto-packaging keys on variant weight, never on where the stock currently sits. Central-vs-delegated ([[FB-1]]) is about *supply*; packaging is about *what's being shipped*. They don't touch. (Only caveat: if orders were ever placed against the central/parent SKU directly with no variant, weight would be unknown — recommend orders stay child-SKU-level, which they are today.)

**Confirmed rule (J, 2026-07-07):** **Only 3.5g products go in a jar. Every other variant (any weight > 3.5g) = 1 Mylar/vacuum bag, not a jar.** So the map is effectively binary: `grams_per_unit == 3.5 → jar ×1`, `else → vacuum_bag ×1`. We'll **seed our own sensible defaults** rather than wait on the client; J will also ask them for their own map. Auto-calc is **seed + override, never a hard lock** — whatever's calculated must be editable if it's wrong. Editing lives in **Settings → Packaging** (we'll input the initial rules for them there).

**Proposed change**
1. **Weight→packaging rules (new config, editable in Settings → Packaging):** a small `packaging_rules` table mapping a weight (exact `grams_per_unit`, or a band) → packaging `kind`/type + qty per unit. Seed with our default: `3.5g → jar ×1` (+ `jar_label ×1` — confirm), everything else `→ vacuum_bag ×1`. Surface + edit these under the existing **Settings → Packaging** screen (`settings/packaging`). Admin-editable and extensible; respect existing per-site/brand scoping (`packaging_types.site_id`, migration 0039).
2. **Auto-calc at pack/wave:** seed each group's packaging quantities by summing `units × weight-rule` across its lines (e.g. 4×3.5g + 2×28g → jars 4, jar_labels 4, bags 2) on top of the default box 1 + label 1. The seeded numbers stay **fully editable** — operator can override any line before confirming (packaging genuinely varies; keep the current manual-entry escape hatch). Combined orders sum consumables across the group but count box/label once (reuse existing rule).
3. **Wave weight-breakdown section:** add a summary block to the wave view + printable pick list — counts by weight (e.g. "3.5g × 24 · 7g × 8 · 28g × 12") and the derived packaging totals (jars 24, bags 12, boxes N, labels N). Requires carrying `grams_per_unit` into the aggregated pick line (`aggregate.ts` — not selected today). Make it print-friendly.
4. **Fallback:** if a child SKU has no `grams_per_unit` (some manual SKUs), the rule can't fire → fall back to manual entry and flag "weight unknown" so it's visible, not silently zero.

**Open questions (confirm before building — cost attribution)**
- ~~Full weight→packaging map~~ **Resolved:** 3.5g = jar, all other weights = 1 bag. Still confirm: does every jar get exactly 1 jar_label, and does every order still get 1 box + 1 label regardless of weight?
- ~~Hard-lock vs override~~ **Resolved:** seed + always editable, edited in Settings → Packaging.
- **Exact 3.5 vs band:** treat only exact `grams_per_unit == 3.5` as jar, or "≤ threshold"? (Recommend exact 3.5 given the rule as stated.)
- **Rules global or per brand/site?** (Packaging types are already site-scoped — default global, allow per-site override.)
- Client's own map (J to request) may refine our seeded defaults later.

**Risk / size:** additive config table + aggregation change + a print section. No inventory-model change, so lower risk than [[FB-1]]/[[FB-2]]. Guard the weight→packaging math and the combined-order "count once" rule with tests (extend the packaging-cost tests).

**Build log**
- **2026-07-07 — Slice 1 shipped (code only, no migration):**
  - `lib/packing/packaging-rules.ts` — the global rule (`<=3.5g -> jar + jar_label`, `>3.5g -> vacuum_bag`, `1 box + 1 label per group`) + `tallyByWeight` for the breakdown. Pure fn, seed-not-lock. Tested (`packaging-rules.test.ts`, 11 cases incl. mixed weights, box/label-once, unknown-weight, zero/neg qty).
  - `lib/packing/aggregate.ts` — carry `grams_per_unit` through `aggregatePickLines` + `aggregateWave` (new `gramsPerUnit` field + `toGrams` coercion). Verified weight (incl. string/null) survives aggregation.
  - `packing/wave/page.tsx` — select `grams_per_unit`; `wave-view.tsx` — printable **Weight breakdown** section (units per weight + implied jars/bags/boxes/labels, flags unknown-weight units) and packaging inputs now **auto-seeded from the rule**, still fully editable.
  - Tests: 13/13 green via isolated vitest (repo `node_modules` is a Windows install, can't run in the Linux sandbox; `tsc` not run for the same reason — worth a local `pnpm typecheck` before merge).
- **2026-07-07 — Slice 2 shipped (client confirmed: 1 jar label per jar; 1 box + 1 label per order regardless of weight):**
  - **Per-order pack screen auto-seed** (`packing/[id]/page.tsx` + `packaging-editor.tsx`): a "Suggested from weight" panel with one-click **Apply suggested**, shown only when nothing's recorded yet (never double-counts); flags unknown-weight units. New `suggestedPackagingLines` helper (kind→type mapping), tested.
  - **Editable threshold, migration 0040** (`packaging_rule` singleton): admin-editable `jar_max_grams`, RLS (read = any signed-in, write = admin), set_updated_at + audit_row triggers, seeded at 3.5. Reversible down migration + pgTAP test (`tests/25_packaging_rule.sql`). Round-trip verifier: **PASS** (48 migrations forward + reverse, schema clean).
  - **Rule is now config-driven:** `packagingKindForGrams` / `derivePackagingForGroup` take an optional threshold (default = `JAR_MAX_GRAMS` constant); wave + pack screens read the DB value and pass it in. Tested with a custom threshold.
  - **Settings → Packaging** gains a "Packaging rule" card (`packaging-rule-editor.tsx` + `updatePackagingRule` action) — admin edits the threshold; others see it read-only.
  - Tests: 19/19 via isolated vitest. `tsc` still not runnable in-sandbox (Windows `node_modules`) — run `pnpm typecheck` + `pnpm test` locally before merge.
- **FB-3 fully delivered.** Possible future polish (not requested): let the rule pin a *specific* jar/bag packaging type rather than "first active of that kind."

---

### FB-1 — Intake into central inventory, then delegate to sites ✅
**Feedback (J, 2026-07-07):** Don't pick a receiving site at the start of intake. Intake the parent SKU into *central* inventory so the whole pound is logged and tracked in one place. Delegation to sites happens *after*, and to multiple sites at once — so if one store sells faster, the remaining stock can still be sent elsewhere instead of being pre-split into a store where it isn't moving. The "receiving site" option should be removed or changed.

**Current behaviour**
- `inventory/intake` step 1 makes you pick a strain **and a single receiving site** (`intake-flow.tsx`, `siteId`). Error today is literally *"Pick a receiving site."*
- Intake credits `parent_inventory` keyed by **(product_id, site_id)** — i.e. the pool already lives at one site.
- Allocation (`loadAllocationTargets` / save) then draws from *that one site's* pool into child SKUs, which can be at other sites.

So a "central pool" concept doesn't exist yet: the pool is site-scoped from the moment of intake. That's the crux of this change.

**Proposed change**
1. **Schema:** introduce a central (site-less) parent pool. Two options to weigh (needs decision):
   - a) Make `parent_inventory.site_id` nullable and treat `NULL` as the central pool; ledger reason `intake` writes there. Least new surface.
   - b) Add a dedicated `central_inventory` table + ledger, keep `parent_inventory` as the per-site post-delegation view. Cleaner separation, more surface.
2. **Intake UI:** drop the receiving-site selector. Step 1 becomes strain + quantity/UoM only → credits the central pool. Keep the g/oz/lb → grams conversion already in place.
3. **Delegation UI:** the allocation screen draws from the **central** pool and lets you allocate to child SKUs **across multiple sites in one save** (the multi-site save path largely exists — it currently just starts from a site pool). Live "over-allocation blocked" guard stays, measured against the central pool.
4. **Reversal + ledger:** `intake` and delegation reversals (migration 0034 already added reversal) must point at the central pool, not a site pool.
5. **Reporting:** inventory report should show central (undelegated) on-hand as its own line alongside per-site available/reserved.

**Open questions (confirm before building — schema + reservation timing)**
- Central pool per **parent SKU only**, or per (parent, client/brand)? Brands are isolated today — does central sit above brands (admin) or per-brand?
- Migration of existing site-scoped `parent_inventory` balances into the central model — roll up to central, or leave existing pools as-is and only new intake goes central?
- Does delegation to a site need to be **reversible** (pull stock back to central to re-delegate), or is it one-way once sent?

**Risk / size:** schema + migration change to core inventory model → per project rules, confirm the trade-off (option a vs b) before writing migrations. Guard delegation math with tests.

**Build log — 2026-07-07 — shipped ✅ (confirmed: transform in place; central per parent SKU; balances summed into central; delegation reversible; central visible to all authenticated since one Supabase per client)**
- **Migration 0042** (`central_parent_inventory`): `parent_inventory` collapses to PK `(product_id)` — existing per-site balances **summed** into one central pool per product; `site_id` dropped. `parent_inventory_ledger`/`allocations`.`site_id` made **nullable** (history preserved; central movements write NULL). Primitives + RPCs lose the site arg: `_parent_inv_lock(product)`, `_parent_inv_write(product,…)`, `intake_receive(product,qty,uom,…)`, `allocate_parent_stock(product,lines,…)`, `reverse_intake`/`reverse_allocation` (still credit the central pool — delegation stays reversible). RLS reads open to any signed-in user; report view now per-product. Reversible down migration restores the full site-based 0028/0029/0034 shape; **round-trip verifier PASS** (51 migrations forward + reverse, schema clean).
- **pgTAP tests 19 + 20 rewritten** for the central model (same fixtures/numbers, minus the site dimension).
- **Real-Postgres e2e PASS:** intake 1 lb → central 448 g (no site); one `allocate_parent_stock` call delegates to child SKUs at **MAIN and EAST at once** → central 273 g, MAIN +10, EAST +5; idempotent replay no double-debit; over-allocation blocked.
- **App layer:** `intake/actions.ts` (`receiveIntake`/`loadAllocationTargets`/`saveAllocation` drop the site), `intake-flow.tsx` (receiving-site step removed — intake goes to central, then delegate; the allocate step still groups children by their own site), `intake/page.tsx` (stops passing `sites`). `tsc` not runnable in-sandbox → run `pnpm typecheck && pnpm test` before merge.
- **Cosmetic follow-up (optional):** the intake-receipts + allocation-history *list* pages show a Site column that is now "—" for central rows (they don't break); drop that column when convenient. The allocation *detail* page's per-child "Client site" stays correct.
- **FB-4 (Shake) is now unblocked** — it builds on this central pool.

---

### FB-2 — RETURNED order status (bounced orders) ✅
**Feedback (J, 2026-07-07):** Under Orders, be able to look up an order, change status to **RETURNED**; system adds stock back to where it came from and logs it, so reports can tell clients how many orders bounced. Applies only to orders bounced back to us.

**Current behaviour**
- Statuses: `created → picking → packed → fulfilled | cancelled` (`lib/orders/types.ts`). `fulfilled`/`cancelled` are terminal and only reachable via `fulfill_order()` / `cancel_order()` RPCs.
- `fulfill_order()` calls `apply_order_fulfillment` → `consume_stock` (drops on_hand + reserved) and snapshots the pick fee.
- There is no "add stock back after shipping" path — `cancel_order` only *releases a reservation* (pre-fulfilment), it does not restock consumed goods.

**Proposed change**
1. **Status:** add `returned` to `ORDER_STATUSES`, the DB `orders.status` check constraint, `STATUS_BADGE`, and treat as terminal. Reachable **only from `fulfilled`** via a new `return_order()` RPC (never a bare status update).
2. **Inventory:** `return_order()` restocks each line's origin child SKU — add back to `on_hand` (sellable again), **not** reserved. New ledger reason `order_return` so it's auditable and distinct from `order_release`.
3. **Logging / reporting:** record the return (order id, date, lines, site/child SKU, reason/notes) so a **client-facing returns report** can count bounced orders per client/site over a date range. Reuse the existing per-site/per-channel report pattern.
4. **UI:** order lookup + a "Mark returned" action on the fulfilled-order detail, with confirm + optional reason note.

**Open questions (confirm — cost attribution + edge cases)**
- **Packaging/consumables:** box, label, jars, bags were consumed at packing. On a bounce, are any restocked, or all written off? (Likely written off — flag in report, don't restock — confirm.)
- **Billing:** the pick fee / postage reimbursement was charged at fulfilment. Does a return **reverse the charge**, partially credit, or stand? This drives client invoices.
- **Combined orders:** a fulfilment group ships as one box. If one order in the group bounces, does the whole group return or just that order? How does group status reflect it?
- **Partial returns:** whole-order only for v1, or per-line quantities? (Recommend whole-order first, per-line later.)
- Should a returned order be **re-openable** (re-ship) later, or is `returned` fully terminal?

**Risk / size:** new terminal transition + inventory reversal + new report. Guard the restock lifecycle with tests (mirror the reserve/release/consume tests). Additive migration; keep it reversible.

**Build log — 2026-07-07 — shipped ✅**
- **Migration 0041** (`order_returns`): `returned` added to `orders.status`; `returned_at` column; `order_return` inventory-ledger reason. New fns: `return_stock` (restock primitive, SECURITY DEFINER like `receive_stock`), `apply_order_return` (restock every line to on_hand), `return_order` (fulfilled→returned + restock; pick fee/postage stand, consumables written off), `reopen_order` (returned→created via existing `apply_order_creation`, re-reserves). `set_order_status`/`fulfill_order`/`cancel_order` redefined from their latest bodies to refuse a returned order. `returns_report` view (one row per bounced order: site/customer/channel/dates/units/value, RLS-scoped). Reversible down migration; pgTAP test `tests/26_returns.sql`.
- **App layer:** `returned` in `lib/orders/types` (statuses, badge, `isActive`, terminal); `returnOrder`/`reopenOrder` server actions (kick outbound drain); **Mark returned** (on fulfilled) / **Re-open** (on returned) buttons on the order detail; `returned` auto-appears in the orders list filter + badge (driven by `ORDER_STATUSES`). New **Returns report** page (`/reports/returns`) with date/site/channel filter, KPIs (bounced orders, units, value), by-site breakdown, per-order table, CSV export; nav link added.
- **Verification:** round-trip verifier **PASS** (49 migrations forward + reverse, schema clean). **End-to-end functional test on real Postgres + seed PASS:** fulfill→on_hand 190, return→`returned` + on_hand 200 + one `order_return` ledger row + `returned_at` set, reopen→`created` + reserved 10, and the non-fulfilled guard fires. (Standard order path e2e-tested; layaway restock/rebook covered by the symmetric `apply_order_return`/`apply_order_creation` logic.) `tsc` not runnable in-sandbox — run `pnpm typecheck && pnpm test` locally before merge.
- **Deferred (not requested):** partial/per-line returns (whole-order only for now, per decision); reversing billing on return (pick fee stands, per decision).

---

## Done
_(none yet)_
