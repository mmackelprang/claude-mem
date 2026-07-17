# Design: Summary-lane total-size cap (Backlog #22)

**Status:** Approved for planning · **Date:** 2026-07-17 · **Owner:** Planner
**Follows:** Backlog #22 (source-verified finding). This spec exists solely to record the one **genuine design
choice** in Unit A — *cap vs. chunk* for the server summary lane. #19 and #21 are mechanical and live only in
their plan.

## Problem (verified against current `main`)

`buildServerGenerationPrompt` (`src/server/generation/providers/shared/prompt-builder.ts`) concatenates **every**
event with `eventBlocks.join('\n')` (`:81`). The only bound is a **per-event** 16 KiB character cap
(`MAX_PAYLOAD_CHARS = 16 * 1024`, `:41`; applied `:110-112`). There is **no aggregate/total cap**. The summary lane
(`ProviderObservationGenerator.loadEvents` → `listUnprocessedEvents`, `src/storage/postgres/server-sessions.ts:311`)
returns up to `LIMIT 500` events and the summary caller passes **no** `limit`
(`ProviderObservationGenerator.ts:569-573`), so the 500 default always applies. Worst case ≈ `500 × ~16 KiB ≈ ~8 MB`
of prompt text.

An oversize prompt classifies as `unrecoverable` (`ClaudeObservationProvider.ts:207-216`; also 400/413 →
`unrecoverable` via `shared/error-classification.ts`) → **non-retryable** (only `transient`/`rate_limit` retry,
`ProviderObservationGenerator.ts:234-237`) → terminal `failed` (`processGeneratedResponse.ts:151-152`). So a large
backlog produces a **permanently lost** summary, not a deferred one.

*Proven:* the unbounded concatenation and the non-retryable classification. *Inferred:* whether real event
sizes/counts actually reach the model's context limit. The fix targets the proven gap.

## The decision: total-size cap vs. chunking

| | **Option A — total-size cap (RECOMMENDED)** | **Option B — chunk into multiple summary jobs** |
|---|---|---|
| Mechanism | Enforce an aggregate character budget inside `buildServerGenerationPrompt`; stop adding event blocks once the budget is reached; emit a truncation marker. | Split a large unprocessed-event set into N sub-batches, enqueue N summary jobs, and (optionally) summarize the summaries. |
| Blast radius | One function (`prompt-builder.ts`), pure, unit-testable with no Postgres. | New job-splitting + enqueue machinery in `ProviderObservationGenerator` + the queue; touches the Postgres-gated path (silently skipped locally per #5/#8); changes summary semantics (multiple partial summaries per session). |
| Correctness | A summary is generated from a bounded, representative slice; nothing is permanently lost to a 400/overflow. | No event dropped from consideration, but far more moving parts and more provider calls (cost). |
| Cost | Same one call, bounded input. | More calls (one per chunk, plus a possible roll-up) — cuts against the project's "prefer fewer AI calls" guidance. |
| Risk | Low — degrades gracefully; a genuinely-oversize single event still truncates per-event at 16 KiB as today. | High — reorders/duplicates summaries; interacts with `generation_key` idempotency and the outbox. |

**Decision: Option A (total-size cap).** It fixes the *proven* failure (non-retryable overflow) with a small, pure,
unit-testable change and no new AI calls. Option B is deferred: it only matters if operators later decide a truncated
summary is unacceptable and want *every* event represented — a product call, not a reliability fix. Record B as the
documented alternative; do not build it now.

## Cap design (Option A specifics)

- **Budget constant:** `MAX_TOTAL_PAYLOAD_CHARS = 256 * 1024` (256 KiB of concatenated event-block text). Rationale:
  comfortably below any current model's context window even after prompt scaffolding + the ~1.35× char→token
  inflation of the current tokenizer, while large enough that realistic sessions are never truncated. It is a
  **character** budget (matching the existing per-event `MAX_PAYLOAD_CHARS`), not a token budget — no tokenizer call,
  keeping the function pure and dependency-free.
- **Ordering / which events survive:** events arrive **oldest-first** (`ORDER BY e.occurred_at ASC`,
  `server-sessions.ts:327`). Keep that order and fill the budget from the **oldest** forward, so a truncated summary
  covers a contiguous early slice of the session (chronological, matches how summaries read). Stop adding blocks once
  the running total would exceed the budget.
- **Truncation marker:** when at least one event is dropped for budget, append a single literal block
  `    <!-- N events omitted: summary payload exceeded 256 KiB cap -->` inside `<agent_events>` so the model (and any
  log reader) knows the batch was truncated. `N` = dropped count.
- **Interaction with `skippedAll` / empty-batch (#21):** the cap runs **after** the per-event scrub loop, over the
  non-empty `eventBlocks` only. It never turns a non-empty batch into an empty one (at least the first event's block
  is always included, even if that single block is itself 16 KiB-truncated). So it cannot manufacture a spurious skip.
- **Per-event cap unchanged:** the existing 16 KiB `MAX_PAYLOAD_CHARS` per-event truncation stays as the inner bound;
  the new cap is the outer bound. A single pathological event is still bounded by the inner cap.
- **Applies to both lanes safely:** `buildServerGenerationPrompt` is shared by per-event (1 event) and summary
  (≤500 events) jobs. A per-event job's single ≤16 KiB block is far under 256 KiB, so the cap is a no-op there and
  only ever engages on the summary lane — no lane-specific branching needed.

## Explicitly out of scope

- **Reclassifying overflow as retryable.** With the cap in place a normal backlog no longer overflows; a prompt that
  *still* 400s is a genuine `unrecoverable`. Do not weaken the classifier.
- **Token-accurate budgeting.** A character budget is deliberately conservative and dependency-free; a
  `count_tokens`-based budget is unnecessary precision for a safety cap.
- **Chunking (Option B).** Deferred; documented above.

## Verification intent (full steps live in the plan)

Unit-testable in `tests/server/generation/providers.test.ts` (no Postgres): build a context with many oversized
synthetic events, assert (1) the produced prompt's concatenated-event region ≤ the budget + marker slack,
(2) the truncation marker appears with the correct omitted count, (3) a small batch is byte-identical to today
(no marker, no truncation), (4) `skippedAll` stays `false` for a non-empty-but-truncated batch.
