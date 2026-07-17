# Design: Observation-drop investigation method (Backlog #20)

**Status:** Approved for planning · **Date:** 2026-07-17 · **Owner:** Planner
**Follows:** Backlog #20 (source-verified candidate drop sites; the 10,963-vs-5,845 counts are a **runtime claim**,
not source-derivable). This spec records the **investigation method** — the genuine decision here is *how we
determine which drop site dominates before designing a fix*, not the fix itself.

## The finding, restated precisely

~47% of generated observations reportedly never persist (10,963 emitted vs 5,845 persisted, 2026-07-01→16). The
finding is **investigate-first**: the fix depends on which path produced the counts and which drop site dominates.
Both are runtime facts we do not yet have.

### Two dedup keys → two possible paths (must disambiguate first)

- **Worker / SQLite path** dedups on **`content_hash`**.
- **Server path** (`src/server/**`) dedups on **`generation_key`** (`observations.ts:112`,
  `ON CONFLICT (team_id, project_id, generation_key) DO UPDATE SET updated_at`).

The finding's framing note flags this: the sweep's strongest concrete drop (site **c**, below) is **server-path
only**. So *which path the 10,963/5,845 counts came from changes which site can even be the cause.* Step 1 of the
investigation is to establish the path; everything downstream is contingent on it.

## Candidate drop sites (re-verified against current `main`)

| Site | Location | Scope | Logged today? |
|---|---|---|---|
| **a** whole-response reject | `src/sdk/parser.ts:42-76` — blank / no `<observation>` root / zero parsed blocks → `{valid:false}` → `processGeneratedResponse.ts:76-77` `parse_error` → `markGenerationFailed(retryable:false)` | Drops the **entire batch** a model emitted | Indirectly (job → `parse_error` + `markGenerationFailed` event); the parser's `{valid:false}` itself is silent |
| **b** empty-field skip | `parser.ts:130-136` — drops an obs with no title AND no narrative AND empty facts AND empty concepts | Per-observation | **Yes** — `logger.warn('PARSER', 'Skipping empty observation …')` `:131` |
| **c** render-empty (server) | `processGeneratedResponse.ts:277-279` — `renderObservationContent` (`:476-485`) builds content from **only** title/subtitle/narrative/facts; it **ignores concepts/files_read/files_modified**, so a concepts-or-files-only obs renders to `''` → dropped by the empty-content guard | Per-observation, **server path only** | **No — silent `continue`** |
| **d** scrub-empty (server) | `processGeneratedResponse.ts:283-286` — `stripTags(content)` empties a privately-tagged obs → dropped | Per-observation, server path | **No — silent `continue`** |
| **e** `generation_key` collapse | `processGeneratedResponse.ts:288-300` + `observations.ts:112-114` upsert | Only collapses a **re-processed** job (same jobId+index+content); within one job `index` differs, so distinct observations do **not** collide | n/a — idempotency, not a distinct-obs loss |

**Ranking after re-verification:** the two **silent** per-observation drops are **c** and **d**; the biggest
single-event multiplier is **a** (whole batch). **e** is idempotency, not loss (the finding already notes this) — it
returns the existing row via `RETURNING *`, so it does not lose distinct observations. Site **c** is a standalone
correctness bug regardless of the counts: an observation whose only signal is `concepts`/`files_*` is silently
discarded.

## Method decision: instrument-and-measure (not log-grep-only, not blind-fix)

Three ways to attribute the 47%:

1. **Blind fix site c** — plausible but unproven it dominates; violates the finding's explicit "confirm which path
   before building a fix."
2. **Pure log/DB archaeology** — sites **c** and **d** are *silent* (`continue` with no log), so existing logs cannot
   attribute them. Archaeology alone cannot close the question.
3. **Instrument-and-measure (CHOSEN)** — add cheap, structured, **non-billed, non-behavioral** drop-reason counters at
   every drop site (including the two silent ones), ship that as an independently valuable PR, then read real drop
   reasons from logs/DB to attribute the gap, *then* fix the dominant site.

**Decision: (3).** It is the only method that can actually attribute silent drops, and the instrumentation is a
standalone win (the pipeline becomes observable) even before any fix. This is why Unit B is planned as
**investigate → instrument (shippable) → contingent fix**, not a single fix PR.

### Optional `team-debugger` phase

The path-attribution question (worker `content_hash` vs server `generation_key`) is a competing-hypotheses problem
well suited to a `team-debugger` pass **if** Mark wants the counts reproduced against live data. It is optional and
**data/host-gated** (needs live log/DB access on Mark's box — flag for the coordinator). The instrumentation PR does
**not** need it and can land first.

## Phasing (drives the plan)

- **Phase 0 — Path + dominant-site determination (investigation, data-gated).** Establish whether the counts are
  worker or server path; form the ranked hypothesis of the dominant drop site. Deliverable: a determination, not code.
  May use `team-debugger`. **Gated on live log/DB access — coordinator flag.**
- **Phase 1 — Drop-reason instrumentation (shippable PR, safe, non-billed).** Structured counters/logs at sites
  **a, c, d** (b already logs); a `parse_error` reason breakdown; no behavioral change. Makes the 47% measurable
  going forward and is worth shipping on its own.
- **Phase 2 — Targeted fix (contingent on Phase 0/1).** Primary candidate: **site c** — make `renderObservationContent`
  represent `concepts`/`files_*` (or, at minimum, stop dropping an observation that has them), since it is a
  standalone correctness bug independent of the counts. If Phase 0/1 points elsewhere (e.g. site **a** whole-batch
  rejects dominate), fix that instead. The fix PR is **gated on the Phase 0/1 finding** — flag for coordinator.

## Explicitly out of scope

- Changing the `generation_key` idempotency (site e) — it is correct.
- The worker/SQLite `content_hash` path — only in scope if Phase 0 shows the counts came from there.
- Any fix before Phase 0/1 attribution (except site c, which is defensible on correctness grounds and is the
  pre-written primary candidate).
