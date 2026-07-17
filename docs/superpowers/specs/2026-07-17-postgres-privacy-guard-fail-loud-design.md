# Design: P0 privacy guard fail-loud (Backlog #5)

**Status:** Approved for planning · **Date:** 2026-07-17 · **Owner:** Planner
**Follows:** Backlog #5 (source-verified finding), ADR 0002 §4.3.3 / §6.1 (the R2 summary-lane privacy net).
This spec records the one **genuine design choice** in the Postgres test-harness hardening unit: *how* the P0 privacy
guard fails loud when `CLAUDE_MEM_TEST_POSTGRES_URL` is unset, without simply relocating the silent skip and without
swamping every unconfigured box with the whole Postgres suite going red. The #8 `search_path` fix is mechanical and
lives only in the plan.

## Problem (verified against current `main`)

`tests/server/runtime/server-session-runtime.test.ts` guards its Postgres-backed `describe` with:

```ts
describe('PostgresServerSessionsRepository + Postgres', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;            // <-- exits the describe CALLBACK, not just an it()
  }
  // ... const pool = ...; beforeEach(...); + 7 it() blocks (:105–:280) ...
});
```

The bare `return` (`:64`) exits the **`describe` callback body**, so the 7 `it()` blocks registered *below* it
(`:105, :120, :146, :182, :239, :262, :280`) **never register at all**. The runner cannot even report them as
skipped — it never learns they exist. One of the seven is the **P0 privacy safety-net** test,
`markPrivateSession persists privateSession=true on session metadata` (`:239`).

ADR 0002 §6.1 lists **three** unit tests as the R2 privacy net (§4.3.3). Two are *pure* and live in the
always-run `SessionGenerationPolicy (pure)` describe (`:35`, `:48`) — they run everywhere. The third is the
Postgres-backed `markPrivateSession` test. So on any box **without** `CLAUDE_MEM_TEST_POSTGRES_URL`, the privacy net
runs at **2 of 3** and the run still reports green.

> **A silent skip on a P0 privacy guard is indistinguishable from a pass.** That is the defect — not a test-hygiene
> nicety. (Mark's call: highest priority of Backlog #5–#10.)

*Proven:* the bare-`return` mechanism and the 7-test blast radius (read directly from the file). *Not asserted here:*
that the privacy behavior itself is broken — it is not; the guard simply is not executing to confirm it.

## The decision: how to make it loud

Three options for the fail-loud shape, evaluated against two forces — **(F1)** a P0 privacy test must never silently
pass by not running, and **(F2)** an unconfigured dev box must not turn into a wall of red (which would destroy the
"no *new* failures vs the ~18 pre-existing" gate that Backlog #7 and every other unit depends on).

| | **Option A — whole suite fails loud** | **Option B — each integration test fails loud when unset** | **Option C — honest-skip + a pure always-on "guard-of-the-guard" sentinel (RECOMMENDED)** |
|---|---|---|---|
| Mechanism | When URL unset, register all 7 tests and make each throw "set CLAUDE_MEM_TEST_POSTGRES_URL". | Keep 7 tests, each asserts the URL is set (throws when not). | Register the 7 integration tests as **honest skips** (`describe.skipIf`), and add **one** pure, never-gated sentinel test that fails loud when unset and asserts the real privacy test *actually ran* when set. |
| New red on an unconfigured box | 7 failures | 7 failures | **exactly 1** failure — the P0 privacy sentinel |
| Satisfies F1 (P0 never silent) | ✅ | ✅ | ✅ |
| Satisfies F2 (don't bury the signal) | ❌ 7 reds bury the one that matters; muddies #7's baseline by +7 | ❌ same | ✅ one crisp, self-labeling red |
| Needs Postgres to produce the signal | No | No | No — the sentinel is pure |
| Catches a *future* regression (real test deleted/renamed/re-`.skip`'d) even when URL **is** set | No | No | ✅ the sentinel asserts the guard executed |
| Blast radius | 7 tests loud | 7 tests loud | 1 sentinel + honest skips |

**Decision: Option C.** It is the only option that makes the P0 gap loud with a *single, self-documenting* signal
(satisfying F2), and it is the only one that also guards the guard **when the URL is set** — catching the day someone
deletes, renames, or re-`.skip`s the real `markPrivateSession` test. The real integration test stays Postgres-gated
(it genuinely cannot run without a live DB); the invariant is enforced by a pure sentinel that runs everywhere.

## Option C specifics

Three sub-decisions:

- **D1 — Register, don't silently drop.** Replace the bare-`return` gate with `describe.skipIf(!testDatabaseUrl)`
  (Bun 1.3.5 supports it; already used at `tests/plugin-version-check-ensure-deps.test.ts:118`). All 7 integration
  tests now **register and report as skipped** when the URL is unset, instead of vanishing. This fixes the mechanical
  bug (the runner can finally see them) but is **not sufficient alone** for a P0 privacy test — an honest skip is still
  a non-run.
- **D2 — A pure, always-on privacy sentinel that fails loud.** Add a separate, **never-gated** `describe` at the
  **end** of the file with one test that owns a module-scoped `privacyGuardRan` flag (flipped to `true` inside the real
  `markPrivateSession` test body):
  - **URL unset →** `throw new Error("P0 privacy guard did not run: set CLAUDE_MEM_TEST_POSTGRES_URL to execute the R2 summary-lane privacy net (markPrivateSession) in server-session-runtime.test.ts. A P0 privacy test must never silently pass by not running (Backlog #5, ADR 0002 §4.3.3).")` — the single loud red, and it names the fix.
  - **URL set →** `expect(privacyGuardRan).toBe(true)` — proves the real guard executed this run; fails if the real test
    was skipped, deleted, or renamed away. This is the guard-of-the-guard.
  - It is **pure** (no Postgres), so it runs on every box and produces a crisp, actionable message rather than an opaque
    connection error.
- **D3 — Scope the loudness to the P0 guard only.** The other 6 integration tests honest-skip (D1); they are **not**
  made loud. The other ~14 Postgres-gated suites are unchanged by #5 (they receive only the mechanical `describe.skipIf`
  register-as-skipped hygiene as part of the #8 audit — no sentinel, since none is a P0 privacy guard). Result: this
  unit adds **exactly one** intentional new red on an unconfigured box, and that red *is the point*.

### Ordering note (implementation constraint)

Bun runs tests in registration order across describes. The sentinel must be registered **after** the gated block so it
observes `privacyGuardRan` *after* the real test has run (when the URL is set). Place the sentinel `describe` at the
**bottom** of the file. When the URL is unset, the real test is skipped (flag stays `false`) and the sentinel throws
before it ever reads the flag — both paths are correct. Pool/schema creation must live in `beforeEach` (not at
`describe`-body level), so `describe.skipIf(true)` does not create a pool at collection time.

## Interaction with Backlog #7 (the ~18 pre-existing failures / auto-gate story)

Backlog #7 is why units gate on **"no *new* failures"** rather than "all green": the suite already has ~18
pre-existing failures. Option C **deliberately** converts one silent pass into one loud, well-labeled red on an
**unconfigured** box — so an unconfigured box goes from N to **N+1** reds, and the +1 is the privacy sentinel *by
design*, not a regression. This must be recorded against #7's baseline so future accounting reads the sentinel as
intentional.

The finding asks for **(b)** fail-loud (the invariant) and optionally **(a)** CI/dev supplies the URL. Option C
delivers both as a forcing function: the sentinel is red until someone sets `CLAUDE_MEM_TEST_POSTGRES_URL`, at which
point the real privacy net runs and the sentinel goes green (0 privacy gap). **The desired steady state is a configured
box where the sentinel passes because the real guard ran** — the sentinel exists to make the gap impossible to ignore
on the way there.

## Invariant (the thing this spec protects)

> **A P0 privacy test must never silently pass by not running.** Concretely: on any run,
> `server-session-runtime.test.ts` either (i) executes the real `markPrivateSession` guard (URL set → sentinel green),
> or (ii) fails loud with a single, named privacy sentinel (URL unset → sentinel red). There is no third outcome where
> the privacy net is quietly at 2/3 and the run is green.

## Explicitly out of scope

- **Making the other ~14 Postgres suites fail loud.** They are not P0 privacy guards; a loud sentinel on each would
  violate F2 and bury the one that matters. They get honest-skip hygiene only.
- **Auto-provisioning a Postgres for local runs.** Supplying `CLAUDE_MEM_TEST_POSTGRES_URL` (CI service or Mark's
  throwaway scratch DB) is an ops choice, not a code change; the sentinel just makes the consequence of *not* supplying
  it visible.
- **The #8 `search_path` client-vs-pool fix.** Mechanical; lives in the plan (same file, same PR).

## Verification intent (full steps live in the plan)

Against a **throwaway** Postgres schema on Mark's `:37778` server-beta stack (docker project
`claude-mem-local-uat`, container `claude-mem-local-uat-postgres-1`) — **a scratch DB only, never the server-beta's
real tables** — prove all three: (1) with `CLAUDE_MEM_TEST_POSTGRES_URL` set, the real `markPrivateSession` test
executes and the sentinel is green; (2) with the URL **unset**, the sentinel is the single, named red (and the other
6 integration tests report as *skipped*, not absent); (3) the `describe.skipIf` register-as-skipped behavior shows all
7 tests in the runner output when unset (proving they no longer vanish).
