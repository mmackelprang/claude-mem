# Unit — Postgres test-harness hardening (Backlog #5 [P0] + #8)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Close two source-verified defects in the **Postgres integration test harness** — they share one file
(`tests/server/runtime/server-session-runtime.test.ts`), one root cause family (a pooled connection that isn't pinned
to the test's isolated schema), and one verification path (a live throwaway Postgres):

- **#5 [P0] — the privacy safety-net silently runs at 2/3.** The `if (!testDatabaseUrl) { it.skip(...); return; }`
  gate's **bare `return`** exits the `describe` callback, so all 7 `it()` blocks below it (`:105–:280`) — including the
  **P0** `markPrivateSession persists privateSession=true` guard (`:239`) — **never register**. Without
  `CLAUDE_MEM_TEST_POSTGRES_URL` a run is green while only 2 of 3 R2 privacy tests actually ran. **Fix (design:
  `docs/superpowers/specs/2026-07-17-postgres-privacy-guard-fail-loud-design.md`, Option C):** register the 7 as
  honest skips **and** add a pure, always-on privacy sentinel that fails loud when the URL is unset.
- **#8 — `SET search_path` applied to `client`, but the test hands `pool` to product code.** The
  `processSessionSummaryResponse persists kind=summary observation idempotently` test (`:280`) passes **`pool`**
  (`:311, :325`) to product code that opens **its own** connection
  (`processGeneratedResponse.ts:244` `withPostgresTransaction(input.pool, …)`) — a fresh pooled connection still
  pointed at `public`, so it fails `relation "observation_generation_jobs" does not exist`. **Fix:** pin
  `search_path` at the **pool** level (every pooled connection) via the existing blessed helper
  `poolForSchema` in `tests/sdk/pg-isolation.ts`. **Audit** the suite for the same client-vs-pool pattern.

**Architecture / why these two are bundled:** both live in one test file and both are the *same* isolation bug seen
from two angles — #5 is the P0 test that never runs; #8 is a sibling test in the same file that runs but fails because
its pooled connection isn't in the schema. Fixing #8 by migrating the file to `poolForSchema` and fixing #5 by
rewriting the gate are edits to the **same `describe` block** — splitting them into two PRs would race on the same
file. This is **test-harness-only** work: no production `src/` change.

**The blessed helper already exists and is used by zero test files.** `tests/sdk/pg-isolation.ts` provides
`createIsolatedSchema`, `poolForSchema` (pins `search_path` via the libpq `-c search_path=` **startup packet** — every
pooled connection lands in the schema deterministically), and `dropSchema`. Its own header (`:10–:15`) documents that
it *replaces* the fire-and-forget `pool.on('connect', c => c.query('SET search_path…'))` listener, "not awaited …
intermittently failing with `3F000: no schema has been selected`." Yet `grep -rln poolForSchema tests/` matches only
the helper file itself — **no suite imports it.** This unit is the first adoption.

**Tech stack:** TypeScript, **Bun 1.3.5** test runner (`import { describe, it, expect } from 'bun:test'`), `pg`.
`describe.skipIf` is available (already used at `tests/plugin-version-check-ensure-deps.test.ts:118`). No new
dependencies. No `src/` production change.

## Global constraints

- **Test-harness only.** Every edit is under `tests/`. Do **not** change product code in `src/`
  (`processGeneratedResponse.ts` is correct — it opens its own connection from the pool it is given; the bug is the
  test handing it a non-pinned pool).
- **Never billed / never network-AI.** These tests exercise Postgres only; `processSessionSummaryResponse` is driven
  with a canned `rawText` XML (no provider call). No `api.anthropic.com`.
- **Live Postgres required to verify — use a throwaway scratch DB only.** The affected tests are Postgres-gated. The
  Builder verifies against a **scratch DB/schema** on Mark's `:37778` server-beta stack (docker project
  `claude-mem-local-uat`, container `claude-mem-local-uat-postgres-1`), with `CLAUDE_MEM_TEST_POSTGRES_URL` pointed at
  it — **never the server-beta's real tables; a disposable database, dropped after.** See Verification.
- **Regression gate = "no new failures."** The full suite has ~18 pre-existing failures (Backlog #7); gate on the
  targeted suites below plus typecheck, not on a fully-green suite. **This unit intentionally adds exactly one new red
  on a box with the URL *unset*** — the P0 privacy sentinel (spec §"Interaction with #7"). That +1 is by design; record
  it against #7's baseline. With the URL **set**, the sentinel is green and there are **fewer** failures than before
  (the #8 idempotency test now passes).
- **Branch + PR policy (CLAUDE.md):** branch from `main`; PR targets **`fork/main`**
  (`gh pr create --repo mmackelprang/claude-mem --base main`). **Never push `origin`** — confirm
  `git remote get-url --push origin` reads `DISABLED_UPSTREAM_DO_NOT_PUSH` before any push. One PR for this unit.
- **Do not edit `docs/BUILDER_QUEUE.md`** (coordinator owns it) or `CHANGELOG.md` (auto-generated).
- **Rebuild note:** this unit touches only `tests/` — no viewer/worker bundle change. `npm run build-and-sync` is
  **not** required for correctness; run `npm run typecheck` + the targeted `bun test` suites instead. (If the Builder's
  checklist mandates `build-and-sync`, it will pass unchanged — nothing in `src/` moved.)

---

### Task 1: #8 — migrate `server-session-runtime.test.ts` to the pool-options helper

Replace the file's hand-rolled `new pg.Pool(...)` + per-client `SET search_path` with the blessed `poolForSchema`
helper, so **every** pooled connection (including the one product code opens) is pinned to the isolated schema.

**Files:**
- Edit: `tests/server/runtime/server-session-runtime.test.ts`

- [ ] **Step 1: import the isolation helpers.** Widen the existing import (`:17` currently pulls only
  `quoteIdentifier`).

```ts
// server-session-runtime.test.ts — replace the pg-isolation import (:17)
import {
  createIsolatedSchema,
  poolForSchema,
  dropSchema,
} from '../../sdk/pg-isolation.js';
```

> `quoteIdentifier` is no longer needed in this file once `CREATE SCHEMA` / `SET search_path` / `DROP SCHEMA` move into
> the helpers; drop it from the import. Keep `import pg from 'pg'` only if still referenced elsewhere — after this task
> it is not, so remove it too (typecheck/lint will confirm).

- [ ] **Step 2: create the pool + schema per test via the helpers** (move pool creation *out* of the `describe` body
  and *into* `beforeEach`, so `describe.skipIf(true)` in Task 2 never builds a pool at collection time). Replace the
  describe-body `const pool = new pg.Pool(...)` (`:67`) and the `beforeEach` schema setup (`:75–:88`).

```ts
// server-session-runtime.test.ts — declarations at describe-body level (replace :67–:73)
let pool: pg.Pool;
let client: PostgresPoolClient;
let schemaName: string;
let storage: PostgresStorageRepositories;
let sessions: PostgresServerSessionsRepository;
let teamId: string;
let projectId: string;
```

```ts
// server-session-runtime.test.ts — beforeEach (replace :75–:88)
beforeEach(async () => {
  // createIsolatedSchema opens its own client, CREATE SCHEMAs, and closes it.
  schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_phase6');
  // poolForSchema pins search_path via the libpq startup packet, so EVERY
  // pooled connection — including the one processSessionSummaryResponse opens
  // from `pool` — lands in schemaName. This is the #8 fix.
  pool = poolForSchema(testDatabaseUrl!, schemaName);
  client = await pool.connect();
  await bootstrapServerPostgresSchema(client);
  storage = createPostgresStorageRepositories(client);
  sessions = new PostgresServerSessionsRepository(client);

  const team = await storage.teams.create({ name: 'team' });
  const project = await storage.projects.create({ teamId: team.id, name: 'p' });
  teamId = team.id;
  projectId = project.id;
});
```

> `testDatabaseUrl!` is non-null-asserted because `beforeEach` only runs under `describe.skipIf(false)` (URL set) —
> Task 2 guarantees the hook never executes when the URL is unset. No manual `SET search_path TO …` remains; the pool
> pins it. `bootstrapServerPostgresSchema(client)` now runs on a pinned connection (schema already exists via
> `createIsolatedSchema`).

- [ ] **Step 3: tear down the pool + schema.** Replace `afterEach` (`:90–:99`) and `afterAll` (`:101–:103`).

```ts
// server-session-runtime.test.ts — afterEach (replace :90–:99)
afterEach(async () => {
  if (client) client.release();
  if (pool) await pool.end();
  if (schemaName) await dropSchema(testDatabaseUrl!, schemaName);
});
```

> Drop the now-empty `afterAll` (`:101–:103`) — the pool is per-test now, so there is no describe-scoped pool to
> `.end()`. `dropSchema` opens its own client to `DROP SCHEMA … CASCADE`, mirroring the canonical consumers.

- [ ] **Step 4: leave the two `pool`-passing calls unchanged.** The `processSessionSummaryResponse({ pool, … })` calls
  (`:310`, `:324`) now receive a **schema-pinned** pool, so `withPostgresTransaction(input.pool, …)` finds
  `observation_generation_jobs` in `schemaName`. No edit to the test bodies — the migration alone fixes #8. (Confirm in
  Verification that this test now passes.)

---

### Task 2: #5 — fail-loud gate + pure privacy sentinel

Implements the spec's Option C: honest-skip the 7 integration tests, and add one always-on sentinel that fails loud
when the URL is unset and asserts the real privacy guard ran when it is set.

**Files:**
- Edit: `tests/server/runtime/server-session-runtime.test.ts`

- [ ] **Step 1: module-scoped run flag.** Add near the top, just after the `testDatabaseUrl` constant (`:19`).

```ts
// server-session-runtime.test.ts — after :19
// #5 — flipped true inside the real markPrivateSession test; the always-on
// sentinel below asserts the P0 privacy guard actually executed this run.
let privacyGuardRan = false;
```

- [ ] **Step 2: replace the bare-`return` gate with `describe.skipIf`.** Change the describe opener (`:61–:65`) so the
  7 integration tests **register** (and report as skipped when the URL is unset) instead of vanishing. Remove the whole
  `if (!testDatabaseUrl) { it.skip(...); return; }` block.

```ts
// server-session-runtime.test.ts — replace the describe opener (:61–:65)
describe.skipIf(!testDatabaseUrl)('PostgresServerSessionsRepository + Postgres', () => {
  // ...pool/schema declarations (Task 1 Step 2), beforeEach, afterEach, and the 7 it() blocks...
```

> `describe.skipIf(true)` still runs the callback at collection to register the contained tests as *skipped* — but the
> `beforeEach`/`it` bodies do not execute, so no pool is created (Task 1 moved pool creation into `beforeEach`). All 7
> tests now appear in the runner output as skipped when the URL is unset, fixing the "runner never learns they exist"
> mechanical bug.

- [ ] **Step 3: flip the flag inside the real privacy test.** In the `markPrivateSession …` test body (`:239`), set
  the flag as the **first** line so it records execution even if a later assertion throws.

```ts
// server-session-runtime.test.ts — first line inside the markPrivateSession it() body (:240)
it('markPrivateSession persists privateSession=true on session metadata (summary-lane inheritance)', async () => {
  privacyGuardRan = true; // #5 — record that the P0 privacy net executed this run
  // ...existing body unchanged...
```

- [ ] **Step 4: add the always-on privacy sentinel at the END of the file.** A separate, **never-gated** describe so it
  runs on every box. It must be registered last so it observes `privacyGuardRan` after the gated block ran.

```ts
// server-session-runtime.test.ts — APPEND at the very bottom of the file (after the gated describe closes)
// #5 [P0] — guard-of-the-guard. This test is PURE (no Postgres) and NEVER gated, so a P0 privacy
// safety-net can never silently pass by not running. See
// docs/superpowers/specs/2026-07-17-postgres-privacy-guard-fail-loud-design.md (Option C).
describe('P0 privacy guard-of-the-guard (always runs)', () => {
  it('the R2 summary-lane privacy net (markPrivateSession) actually executed this run', () => {
    if (!testDatabaseUrl) {
      throw new Error(
        'P0 privacy guard did not run: set CLAUDE_MEM_TEST_POSTGRES_URL to execute the R2 ' +
          'summary-lane privacy net (markPrivateSession) in server-session-runtime.test.ts. ' +
          'A P0 privacy test must never silently pass by not running (Backlog #5, ADR 0002 §4.3.3).',
      );
    }
    // URL set: prove the real guard ran. Fails if it was skipped, deleted, or renamed away.
    expect(privacyGuardRan).toBe(true);
  });
});
```

> Ordering: Bun runs tests in registration order, so a describe placed at the bottom runs last — after the gated block
> has (when URL set) run `markPrivateSession` and flipped the flag. When the URL is unset the sentinel throws before it
> reads the flag. Both paths satisfy the invariant.

---

### Task 3: #8 audit — classify the whole Postgres suite; adopt `poolForSchema` on the confirmed offenders

The finding requires auditing the suite for the same client-vs-pool pattern. The classification below is
**source-verified** (this planning pass). The Builder confirms it, records it in the PR description, and migrates the
offenders that hand a pool to product code.

**Audit result (verified 2026-07-17):**

| Class | Files | Symptom | Action |
|---|---|---|---|
| **A — deterministic #8 failure**: raw `new pg.Pool` handed to product code, **no** `search_path` on pooled connections | `server-session-runtime.test.ts` | hard fail `relation … does not exist` | **Fixed in Task 1** (migrate to `poolForSchema`) |
| **B — flaky / anti-pattern**: raw pool + fire-and-forget `pool.on('connect', c => c.query('SET search_path…').catch())` (the exact listener `pg-isolation.ts:10–15` was written to *replace*; not awaited → intermittent `3F000`) | `process-generated-response.test.ts`, `provider-observation-generator.test.ts`, `provider-generator-chroma-index.test.ts`, `scope-enforcement.test.ts`, `paid-readiness.test.ts`, `chroma-recall-route-wiring.test.ts`, `jobs-list-and-operator-routes.test.ts`, `server-mcp-http-routes.test.ts`, `server-mcp-routes.test.ts`, `server-session-routes.test.ts`, `team-project-jobs-routes.test.ts`, `connect-keys.test.ts`, `compat/sessions-observations-adapter.test.ts` (13 files) | intermittent, schema-dependent | **Migrate to `poolForSchema`** — see Step 2 (may split to a follow-up row; see Queue note) |
| **C — already correct (inline pool-options)**: `new pg.Pool({ connectionString, options: '-c search_path=…' })` | `data-deletion.test.ts` (`:54`) | none | Optional: adopt the shared `poolForSchema` for consistency (no behavior change) |
| **D — pinned-client only**: raw pool but product code is never handed the pool; every checked-out client gets an explicit `SET search_path` | `postgres-storage.test.ts`, `server-api-key-actor.test.ts`, `observation-author-scope.test.ts`, `observation-visibility-scope.test.ts` | none today; fragile if a future test reaches for `pool` | Leave as-is (out of scope); note the fragility |

- [ ] **Step 1: fix the highest-value Class-B neighbor — `process-generated-response.test.ts`.** It drives the *same
  product function family* (`processGeneratedResponse`, sibling of `processSessionSummaryResponse`) and carries the
  fire-and-forget workaround its own comment (`:71–:79`) calls a "monkey-patch." Migrate it to `poolForSchema` exactly
  as Task 1: `createIsolatedSchema` in `beforeEach`, `poolForSchema` for the pinned pool, delete the
  `pool.on('connect', …)` listener and the `pool.removeAllListeners('connect')` teardown, `dropSchema` in `afterEach`.
  Its gate (`:21–:24`) gets the same `describe.skipIf(!testDatabaseUrl)` register-as-skipped hygiene (D1) — **no**
  privacy sentinel (it is not a P0 privacy guard).

- [ ] **Step 2: migrate the remaining Class-B files** (the other 12) to `poolForSchema` with the same mechanical
  recipe: swap the hand-rolled pool + `pool.on('connect')` listener for `createIsolatedSchema` + `poolForSchema` +
  `dropSchema`, and convert the bare-`return` URL gate to `describe.skipIf`. This is a pure, repetitive sweep and
  deletes the exact anti-pattern the helper documents.

> **Scope valve (Builder's call, coordinator-visible):** Step 2 touches 12 files, each needing a live-Postgres run to
> prove no regression. If the diff/verification is too large to review confidently in one PR, **split Step 2 into a
> follow-up row (#36, deps #35)** and land #35 with Task 1 (Class A, deterministic) + Task 2 (#5 P0) + Task 3 Step 1
> (Class B neighbor) + the audit table. #35 alone closes both named findings (#5, #8) and demonstrates the pattern on
> the two highest-value files; #36 is the mechanical tail. Do not let the 12-file sweep delay the P0 privacy fix.

- [ ] **Step 3: record the audit in the PR description.** Paste the classification table so the coordinator/reviewer
  sees which files were migrated, which were already correct (Class C), and which were left as fragile-but-safe
  (Class D).

---

### Task 4: typecheck + targeted suites

- [ ] **Step 1:** `npm run typecheck` → no new errors (the removed `pg`/`quoteIdentifier` imports must leave no dangling
  references).
- [ ] **Step 2 (URL set):** with `CLAUDE_MEM_TEST_POSTGRES_URL` pointed at the throwaway scratch DB (see Verification),
  run the migrated suites:
  `bun test tests/server/runtime/server-session-runtime.test.ts tests/server/generation/process-generated-response.test.ts`
  (plus any other files migrated in Task 3 Step 2) → all green, sentinel green, the #8 idempotency test green.
- [ ] **Step 3 (URL unset):** `bun test tests/server/runtime/server-session-runtime.test.ts` with the env var
  **unset** → the 7 integration tests report as **skipped**, and the privacy sentinel is the **single** red with the
  "set CLAUDE_MEM_TEST_POSTGRES_URL" message.

## Verification (before opening the PR)

All three claims are proven against a **throwaway** Postgres on Mark's `:37778` server-beta stack (docker project
`claude-mem-local-uat`, container `claude-mem-local-uat-postgres-1`) — **a disposable scratch database, never the
server-beta's real tables.** Create and point the env var at a scratch DB, e.g.:

```bash
# Create a throwaway DB inside the server-beta Postgres container (scratch only — dropped after).
docker exec claude-mem-local-uat-postgres-1 \
  psql -U postgres -c "CREATE DATABASE cmem_harness_scratch;"
export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://postgres:<pw>@localhost:37778/cmem_harness_scratch"
# ...run the suites (Task 4 Step 2)...
docker exec claude-mem-local-uat-postgres-1 \
  psql -U postgres -c "DROP DATABASE cmem_harness_scratch;"   # tear down
```

> Each test already isolates into its own `cm_phase6_<uuid>` schema and drops it, so even within the scratch DB the
> real server-beta data is never touched. The scratch **database** is a second belt: nothing this unit runs can reach
> the server-beta's application tables. Confirm the connection string targets `cmem_harness_scratch`, not the app DB,
> before running.

- [ ] **(1) The privacy net actually executes + passes (URL set).** With `CLAUDE_MEM_TEST_POSTGRES_URL` set to the
  scratch DB, `bun test tests/server/runtime/server-session-runtime.test.ts` shows the real `markPrivateSession` test
  **run and pass**, and the `P0 privacy guard-of-the-guard` sentinel **green** (`privacyGuardRan === true`). The R2
  privacy net is now 3/3.
- [ ] **(2) The #8 idempotency test passes (URL set).** In the same run, `processSessionSummaryResponse persists
  kind=summary observation idempotently` is **green** — no `relation "observation_generation_jobs" does not exist`.
  This proves the pinned pool hands product code a connection inside the test schema.
- [ ] **(3) The guard fails LOUD when the URL is unset.** `unset CLAUDE_MEM_TEST_POSTGRES_URL` and re-run: the 7
  integration tests report as **skipped** (not absent — proving the `describe.skipIf` register fix), and the privacy
  sentinel is the **single** failure carrying the "set CLAUDE_MEM_TEST_POSTGRES_URL … a P0 privacy test must never
  silently pass by not running" message. Contrast with `main`, where the same run is silently green.
- [ ] **Audit recorded + offenders migrated.** The classification table is in the PR description; Class A
  (`server-session-runtime`) and the Class-B neighbor (`process-generated-response`) are migrated to `poolForSchema`;
  the fire-and-forget `pool.on('connect')` listener is gone from every file this PR touched; Class C/D are noted.
- [ ] **No new regressions vs #7.** With the URL **set**, the targeted suites are green and there is one **fewer**
  failure than `main` (the #8 test now passes). With the URL **unset**, exactly **one** new red exists — the
  intentional P0 privacy sentinel — and it is recorded against #7's baseline. Typecheck clean. No `src/` production
  change.

### Test Plan (live UAT — for the Tester)

Postgres-harness change; no running-app UI surface. UAT = the live-Postgres run above against the throwaway scratch
DB. The Tester (or Builder) executes Verification (1)–(3) and captures the runner output showing: the sentinel green
with the URL set, and the sentinel as the single named red with it unset. No billed provider calls; no server-beta app
data touched (scratch DB, dropped after).

## Cross-references

- Design decision (#5 fail-loud): `docs/superpowers/specs/2026-07-17-postgres-privacy-guard-fail-loud-design.md`.
- Findings: `docs/BUILDER_QUEUE.md` Backlog #5 (P0), #8.
- The privacy net context: ADR 0002 §4.3.3 / §6.1 (`docs/architecture/decisions/2026-07-14-upstream-v13.11.0-fork-merge.md`)
  — the three R2 privacy tests; `markPrivateSession` is the Postgres-gated third.
- Blessed helper: `tests/sdk/pg-isolation.ts` (`createIsolatedSchema` / `poolForSchema` / `dropSchema`; header
  `:10–:15` documents the fire-and-forget listener it replaces).
- Related (do **not** fold in): #7 (the ~18 pre-existing failures / auto-gate — this unit adds one intentional
  URL-unset red, documented above); the Class-B sweep tail (candidate follow-up row #36).

## Queue

**The coordinator files the `docs/BUILDER_QUEUE.md` row(s) for this item.** Do not edit `docs/BUILDER_QUEUE.md`.
Proposed shape (rationale in the PR/report): **one bundled row #35** — "[P0] Postgres test-harness hardening
(Backlog #5 + #8)" covering Task 1 (Class A / #8 deterministic), Task 2 (#5 P0 fail-loud), Task 3 Step 1 (Class-B
neighbor `process-generated-response`), and the audit table — with an **optional follow-up #36 (deps #35)** for the
Class-B migration tail (Task 3 Step 2) if the Builder splits it to keep #35 focused on the P0 fix.
