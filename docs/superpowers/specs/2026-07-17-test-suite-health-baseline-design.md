# Design: Test-suite health — expected-failure baseline + the #6 fork-divergence decision

**Status:** Approved for planning · **Date:** 2026-07-17 · **Owner:** Planner
**Follows:** Backlog #7 (triage the pre-existing failures / restore auto-gating) + Backlog #6 (the upstream-owned test
defects), both traced to the v13.11.0 merge (ADR 0002 §9). Bundles the two because they share one root cause (the suite
cannot auto-gate) and one mechanism (a fork-only expected-failure baseline).

This spec records the two **genuine design choices**: **(A)** how the suite is made to auto-gate again despite a
standing set of pre-existing failures (the baseline mechanism), and **(B)** the #6 fork-divergence decision — surfaced
as a **Mark decision** because "fix the upstream-owned test defects" trades permanent fork divergence against a red
test, and that is a judgement call, not a mechanical fix. The per-cluster fix-vs-quarantine calls and the literal code
live in the plan (`docs/superpowers/plans/2026-07-17-test-suite-health.md`).

---

## Problem (re-measured against the current `fork/main`, 2026-07-17)

The auto-merge policy's gate 2 ("the full unit suite is green") is **structurally unmeetable** on this fork, so every
PR this session has ridden a hand-computed "no *new* regressions vs the ~18 pre-existing failures" delta. That
hand-computed delta is the recurring manual cost this unit exists to kill. Two blockers, both **re-measured** here
(the Backlog #6/#7 snapshots were stale — PR #21 and PR #37 both moved the set):

### Blocker 1 — the suite never completes (2 hard hangs + 1 crash-file)

A single-process `bun test` never runs to completion. Re-measured via a per-file classification sweep (253 test files,
each run in its own `bun test` process under a 75 s wall-clock + `--timeout 20000` per-test cap):

| File | Symptom | Detail |
|---|---|---|
| `tests/services/stale-abort-controller-guard.test.ts` | **HANG** (75 s, `pass=0 fail=0`) | Emits only the `bun test` banner — no file header, no test result. Hangs **during bun initialization** (the file itself is pure: no imports beyond `bun:test`, no live-service dependency). Reproduces deterministically in isolation. |
| `tests/services/worker-shutdown-sequence.test.ts` | **HANG** (75 s, `pass=0 fail=0`) | Same signature. Reproduces in isolation. |
| `tests/utils/project-name.test.ts` | **CRASH** (exit code 3) | Does not merely fail — bun exits **3** and the **JUnit reporter never writes its XML**. Excluding this one file, the same run exits 1 and writes a complete XML. So it breaks the machine-readable output the gate depends on. |

The two hangs are the reason the combined run dies at a wall-clock cap (the single process reaches the first hang under
`tests/services/` — after the slow `tests/server/` block — and blocks until an external ~10-min cap kills it; that is
the reported "~7-10 min then wall-clock death"). **Auto-gating requires the suite to first RUN to completion**, so
these three files must be made non-blocking (quarantined at the file level) before any baseline check is even possible.
**None respects `--timeout`** — a per-test timeout does not tame them, so they must be *excluded from the run*, not
merely time-boxed.

### Blocker 2 — a standing set of pre-existing failures (re-measured: **32 failing tests across 13 files**, not "~18")

With the 3 non-runnable files excluded and a per-test timeout applied, the run completes and reports **32 failing
testcases across 13 files** on this box (Windows 11, Bun 1.3.5, `CLAUDE_MEM_TEST_POSTGRES_URL` **unset**). The stale
Backlog #7 snapshot ("~18") **under-counted the Windows surface** — it never itemised `claude-md-utils` (7),
`cursor-extraction` (4), `timeline-formatting` (2), `find-claude-executable` (1), or `project-name`. Re-measured set:

| Cluster / file | Fails | Root cause (verified) | Owner vs upstream `f5633c1f` | Conditioning |
|---|---|---|---|---|
| `services/integrations/spawn-contract-windows.test.ts` | 3 | `toBe('cmd.exe')` while `spawn.ts:74` returns `process.env.ComSpec ?? 'cmd.exe'`; this box's `ComSpec = C:\WINDOWS\system32\cmd.exe` | **upstream-identical** | win32 + ComSpec set |
| `infrastructure/cleanup-v12_4_3.test.ts` | 5 | `afterEach` `rmSync` throws `EBUSY: resource busy or locked` — an open SQLite DB handle under the temp dir is not released before delete (Windows file-locking) | **upstream-identical** | win32 |
| `utils/claude-md-utils.test.ts` | 7 | relative-path resolution via OS separator (`\` vs injected `/`) in folder-CLAUDE.md handling | **upstream-identical** | win32 |
| `transcripts/cursor-extraction.test.ts` | 4 | `deriveCursorTranscriptPath` path derivation uses `\` on Windows | **upstream-identical** | win32 |
| `shared/timeline-formatting.test.ts` | 2 | `extractFirstFile` relative-path computation (Windows separators) | **upstream-identical** | win32 |
| `shared/find-claude-executable.test.ts` | 1 | Windows install-location fallback differs from the fixture | **upstream-identical** | win32 |
| `infrastructure/process-manager.test.ts` | 1 | `resolveWorkerRuntimePath` builds a candidate with `path.join` (→ `\` on Windows); the injected `pathExists` only matches the forward-slash string | **upstream-identical** | win32 |
| `write-json-file-atomic.test.ts` | 1 | `expect(mode).toBe(0o600)` — Windows does not represent POSIX mode | **upstream-identical** | win32 |
| `services/sync/chroma-mcp-manager-singleton.test.ts` | 4 | `killProcessTree` spy does not intercept (`killTreeCalls` stays `[]`) — same *mock-does-not-intercept-on-this-box* class PR #21 hit for `net.createServer`; also slow (~7-30 s) | **upstream-identical** | env/mock (win32) |
| `logger-usage-standards.test.ts` | 1 | source-standard assertion: **26 upstream-owned src files** use `console.log`/`console.error` outside `src/hooks/` | **upstream-identical** | platform-independent |
| `hook-lifecycle.test.ts` | 1 | source-standard assertion: hook stderr-discipline (`hookCommand` must route IO through `hook-io.ts`) | **upstream-identical** | platform-independent |
| `infrastructure/plugin-distribution.test.ts` | 1 | Rule-A shell resolution: `_P` from the cache dir when `CLAUDE_PLUGIN_ROOT` unset | **FORK-DIVERGED** (fork already maintains this file) | win32 |
| `server/runtime/server-session-runtime.test.ts` | 1 | the **#35 privacy sentinel** — fails *by design* when `CLAUDE_MEM_TEST_POSTGRES_URL` is unset; **green when set** | fork-owned | env-conditional |

**Two facts dominate the design:**

1. **15 of the 16 failing/non-runnable files are byte-identical to upstream `f5633c1f`.** Only
   `plugin-distribution.test.ts` is fork-owned. So *editing any of the other 15* — even to add a one-line `it.skipIf`
   — manufactures the exact permanent fork divergence + per-sync conflict surface ADR 0002 §9 names as the deliberate
   cost to avoid ("the alternative … upstreaming our fixes so they stop being divergence … is explicitly excluded").
2. **Almost every failure is environment-specific, not a product defect.** ComSpec absolute paths, Windows `\`
   separators, POSIX file-mode, Windows file-locking, and a mock that does not intercept on this Bun build — these are
   *test-vs-environment* mismatches that pass on upstream's Linux CI (which is exactly why upstream shipped them green).
   The two source-standard assertions (`logger`, `hook-lifecycle`) *are* platform-independent and would be red on
   Linux too — they flag a real, long-standing house-rule violation in upstream source.

### What already got fixed (why the snapshots are stale)

- **PR #21 (Queue ~~17~~)** rewrote `HealthMonitor.isPortInUse` to a real `net` bind probe on all platforms →
  `health-monitor.test.ts` is now **21 pass / 0 fail**. That greened the **4** `isPortInUse` failures *and* the
  **1** `HealthMonitor > honor configured worker host` test that Backlog #6 counted as one of its four upstream
  defects. **So #6 is now only the 3 `spawn-contract-windows` tests** — the HealthMonitor quarter of #6 is already
  resolved. Re-verified: `bun test tests/infrastructure/health-monitor.test.ts` → 21/0.
- **PR #37 (Queue ~~35~~)** added the always-on `#35` privacy sentinel: one **intentional** red when
  `CLAUDE_MEM_TEST_POSTGRES_URL` is unset, green when set. The baseline **must model this as env-conditional**, not
  hard-fail it.

---

## Decision A — the expected-failure baseline mechanism

**Goal:** the suite auto-gates (exit 0 / non-0) on a normal dev box **despite** the standing failures — flagging a
**new** failure *and* an **unexpected pass** (a baselined test that has since been fixed but not removed), while
modelling the #35 env-conditional sentinel. Zero edits to upstream-owned files.

### Shape: a fork-only baseline JSON + a fork-only gate script (no test-file edits)

Because 15/16 files are upstream-owned, the mechanism lives **entirely outside the test files**:

- **`tests/known-failures.json`** — the encoded baseline. Three sections:
  - `nonRunnable[]` — files **excluded from the run** because they hang or crash the reporter (the 2 hangs + the
    `project-name` crash). File-level, because a hung/crashed file produces **no** per-test result to key on.
  - `expectedFailures[]` — the standing per-test failures, each `{ file, name, platforms?, reason }`. `platforms`
    scopes an entry (e.g. `["win32"]`) so the same baseline is correct on a Linux CI, where the Windows-path entries
    are **not** expected and the source-standard entries **are**.
  - `conditionalFailures[]` — env-conditioned entries, e.g. the #35 sentinel
    `{ file, name, expectFailWhenUnset: "CLAUDE_MEM_TEST_POSTGRES_URL", reason }`: expected-fail when the var is unset,
    expected-**pass** when set.
- **`scripts/test-gate.mjs`** — the check. Algorithm:
  1. `excluded = nonRunnable[].file`; `fileList = glob("tests/**/*.test.ts") − excluded`.
  2. Run `bun test <fileList> --timeout <ms> --reporter=junit --reporter-outfile=<tmp.xml>` under a **wall-clock
     watchdog**. Passing an explicit file list is how the hangers are excluded **without editing them**.
  3. **Watchdog fires / no XML ⇒ GATE FAIL** ("suite did not complete — a NEW hang exists outside the quarantine").
     This is the "runs-to-completion" guarantee, enforced every run.
  4. Parse the XML → `actualFail = {file,name}` with a `<failure>`/`<error>` child.
  5. `expected = ` platform-filtered `expectedFailures` ∪ env-evaluated `conditionalFailures`.
  6. `newFailures = actualFail − expected` → **GATE FAIL** (lists them).
  7. `unexpectedPasses = expected − actualFail` → **GATE FAIL** ("a baselined test now passes — remove it from
     `known-failures.json`"). This is the ratchet: a fixed test cannot silently rot the baseline.
  8. Sanity: every `expected`/`conditional` entry must match a testcase that actually ran, and every `nonRunnable`
     file must still exist — a rename/typo surfaces as "baseline entry matched nothing," not a silent pass.
  9. Exit 0 **iff** watchdog OK ∧ `newFailures` empty ∧ `unexpectedPasses` empty.
- **`npm run test:gate`** wires it up; this becomes the auto-merge "unit suite" gate.
- A `--update-baseline` mode writes the current `actualFail` back into `expectedFailures` (used once to seed, and later
  only under review when a change *legitimately* alters the expected set).

### Why JSON + external gate, not `it.skip` / `test.failing` in the files

| Option | New fork divergence | Models #35 env-conditional | Detects unexpected pass | Detects new hang |
|---|---|---|---|---|
| Edit each upstream test (`it.skipIf` / `test.failing`) | **15 upstream files diverge** → per-sync conflicts (ADR §9 cost) | Hard (env logic per file) | `test.failing` does (Bun) — but only where edited | No |
| **Fork-only `known-failures.json` + `test-gate.mjs` (CHOSEN)** | **Zero** — no test/src file touched | Yes (`conditionalFailures`) | Yes (set difference) | Yes (watchdog) |

The external gate is the only option that touches **zero** upstream-owned files while still ratcheting on both a new
failure and an unexpected pass, and it is the only one that also catches a **new hang** (the watchdog) — the failure
mode that actually breaks auto-gating today.

### Env-conditional requirement (the #35 sentinel) — modelled, not hard-failed

`conditionalFailures` evaluates the named env var at gate time:
- `CLAUDE_MEM_TEST_POSTGRES_URL` **unset** → the sentinel `... actually executed this run` is in `expected` → its red
  is **not** a new failure (gate stays green on the standing set). The 7 Postgres integration tests report as
  `skipped` — confirmed 7 skips in the JUnit XML.
- `CLAUDE_MEM_TEST_POSTGRES_URL` **set** → the sentinel is **not** in `expected`; it must **pass** (and the 7
  integration tests run). If it were red with the URL set, that is a genuine new failure → gate fails. This is exactly
  the #35 invariant, now machine-checked by the gate.

---

## Decision B — the #6 fork-divergence decision (**Mark's call at plan-review**)

Re-scoped by the re-measurement: **#6 is now 3 tests**, all in the upstream-identical
`tests/services/integrations/spawn-contract-windows.test.ts`, asserting `toBe('cmd.exe')` while `src/shared/spawn.ts:74`
returns `process.env.ComSpec ?? 'cmd.exe'`. The assertion can only pass where `ComSpec` is unset — i.e. upstream's
Linux CI faking `platform:'win32'`. On real Windows `ComSpec` is the absolute `cmd.exe` path, which is arguably
*safer* than a bare PATH lookup (Backlog #10's watch-item). The HealthMonitor quarter of #6 is already fixed (PR #21).

**The tradeoff (this is what Mark decides — do not assume):** fixing an upstream-owned test buys a green test at the
price of **permanent fork divergence** in a file that upstream will keep editing → a recurring conflict on every future
sync (ADR 0002 §9).

| Option | What it is | Divergence cost | Green on this box | Green on upstream Linux CI |
|---|---|---|---|---|
| **(a) Fix in-fork** | change `toBe('cmd.exe')` → `toBe(process.env.ComSpec ?? 'cmd.exe')` | **High** — edits an upstream-identical file; conflicts every sync | Yes | Yes |
| **(b) Upstream the fix + wait** | PR the assertion fix to `thedotmack/claude-mem` | **Zero** long-term (it stops being divergence) | No, until merged | No, until merged |
| **(c) Skip-with-reason on Windows** | `it.skipIf(process.platform==='win32')` in the file | **Medium** — still edits the upstream file | N/A (skipped) | Yes |
| **(d) Leave red, encode as expected-failure (RECOMMENDED, now)** | 3 entries in `known-failures.json`, `platforms:["win32"]` | **Zero** — no test file touched | Gated (expected) | Not expected → passes (ComSpec unset) |

**Recommendation: (d) now + (b) as the durable resolution.** (d) restores auto-gating immediately with **zero**
divergence — the 3 tests become fork-only baseline entries, invisible to upstream, and the baseline's platform-scoping
means they are *not* expected on a Linux CI (where they correctly pass). (b) is the only option that permanently
*removes* the red rather than carrying it: file the one-line assertion fix upstream, and when it merges through a
future sync, the gate's **unexpected-pass** detector will flag the 3 baseline entries for removal — the ratchet closes
the loop for free. Reject (a)/(c): both edit an upstream-identical file for a test that is *correct* on the platform it
was written for, manufacturing exactly the divergence ADR §9 tells us to avoid, to fix a non-bug (the runtime behaviour
is fine — arguably better — per #10).

**This decision is Mark's at plan-review.** The plan implements (d) by default (it is a pure baseline-entry, reversible
in one line) and notes (b) as a follow-up; if Mark prefers (a) or (c), only the 3 baseline entries change.

---

## Per-cluster fix-vs-quarantine (summary; full rationale + literal code in the plan)

Default, given 15/16 files are upstream-identical: **quarantine into the fork-only baseline** (zero divergence).
**Fix** only where it costs no divergence or closes a real product bug cheaply.

- **Fix (fork-owned, no divergence):** `plugin-distribution.test.ts` (1) — the fork already maintains this file, so
  green it at source rather than baselining it.
- **Quarantine as `nonRunnable` (must, to let the suite complete):** the 2 hangs + the `project-name` crash-file.
  Each gets a `reason` + a follow-up pointer for root-cause (esp. the `stale-abort` bun-init hang, which is a genuine
  runtime mystery worth its own investigation).
- **Quarantine as `expectedFailures` (Windows-env, upstream-owned):** `spawn-contract-windows` (3, = Decision B),
  `cleanup-v12_4_3` (5), `claude-md-utils` (7), `cursor-extraction` (4), `timeline-formatting` (2),
  `find-claude-executable` (1), `process-manager` (1), `write-json-file-atomic` (1), `chroma-mcp-manager-singleton`
  (4). All `platforms:["win32"]`.
- **Quarantine as `expectedFailures` (platform-independent, upstream source):** `logger-usage-standards` (1),
  `hook-lifecycle` (1). No `platforms` scope (red on Linux too). Fixing means editing 26+ upstream src files — out of
  scope; a follow-up could pursue it (or upstream it).
- **Model as `conditionalFailures`:** the #35 sentinel.

**Fixing is preferred where cheap** — but here "cheap" collides with "upstream-owned." The cheap-looking Windows fixes
(gate a POSIX-mode test, close a DB handle, normalise a path separator) all require editing an upstream-identical test
*or* upstream-owned `src/`, so each would add divergence to green a non-product-bug. The plan therefore baselines them
now and lists **source-fix / upstream-the-fix** as an explicit, optional follow-up row that the gate's unexpected-pass
ratchet makes safe (fix it, the gate tells you to drop the entry).

---

## Invariant (the thing this design protects)

> **On any dev box, `npm run test:gate` runs the suite to completion and exits non-zero iff the actual failing set
> differs from the encoded, platform-and-env-conditioned baseline.** A new failure, a new hang, or a silently-fixed
> baselined test each flips the gate red. There is no state where "the suite hangs" or "18 pre-existing reds" forces a
> human to hand-compute a no-new-regressions delta.

## Explicitly out of scope

- **Fixing the underlying product/environment defects** (Windows path separators, the EBUSY DB-handle leak, the
  chroma kill-tree mock, the 26 `console.log` source files). Each is a separate judgement (mostly upstream-owned);
  baselining restores the gate now, and a follow-up row can retire entries one at a time with the ratchet proving each.
- **Root-causing the two hangs.** Quarantining unblocks the gate; the `stale-abort` bun-init hang in particular is a
  deep runtime question deferred to a follow-up.
- **Auto-provisioning Postgres.** The #35 sentinel's env-conditioning is modelled, not eliminated; supplying
  `CLAUDE_MEM_TEST_POSTGRES_URL` is an ops choice.

## Verification intent (full steps in the plan)

Prove three things: **(1)** with the 3 non-runnable files quarantined, `npm run test:gate` **runs to completion** and
exits **0** on a clean tree (Windows, URL unset) — the standing 32 + sentinel all matched by the baseline; **(2)**
injecting a fake new failure (`expect(true).toBe(false)` in a passing test) trips the gate with that test named as a
**new failure**; **(3)** a baseline entry pointed at a now-passing test trips the gate as an **unexpected pass** — and,
with `CLAUDE_MEM_TEST_POSTGRES_URL` **set**, the sentinel entry flips to expected-pass and the gate stays green (7
integration tests run), proving the env-conditional path.
