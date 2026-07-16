# Design — Mission Control for claude-mem

- **Date:** 2026-07-16
- **Status:** Approved (brainstorm complete; Phase 1 to be planned next)
- **Author:** Coordinator (with Mark)
- **Consumers:** Planner (Phase 1 implementation plan), Builder
- **Related:** `docs/BUILDER_QUEUE.md`, `docs/architecture/2026-07-02-distributed-team-onboarding-roadmap.md`, the existing viewer (`src/services/worker/http/routes/ViewerRoutes.ts`, `plugin/ui/viewer-bundle.js`), claude-mem MCP surface (`observation_add`, `memory_add`, …)

---

## 1. Purpose

**Mission Control** is a human-in-the-loop console for driving multiple agent teams. Its job is to **minimize the latency between an agent team needing the human and the human acting** — and, alongside that, to keep the roadmap honest and progress visible.

It has **two axes**:

```
 ATTENTION  (what needs you now)      OBSERVABILITY  (what's happening)
 ──────────────────────────────      ───────────────────────────────────
 • reviews    — PRs, specs, designs   • progress by agent/human × time   (A)
 • questions  — decisions pending      • velocity / delivered-vs-roadmap  (D)
 • escalations— blockers, API errors   • suggested next-steps             (B)
                                        • roadmap freshness / stale-flags  (C)
         │                                          │
         └──────────────── one console ─────────────┘
```

Roadmap drift costs *drift*; an unsurfaced escalation costs a *blocked team burning cycles* — strictly more expensive. The 2026-07-15 session made this concrete: a dead worker blocked three agent teams for a day (950 failed hooks) while the human had to *notice* it rather than being *told*, and that same session generated a scattered backlog of PRs to review, ~7 decisions to make, and two security flags — none of it collected anywhere.

---

## 2. The pains (Mark's ranking)

**Observability axis** — retrospective/prospective on *work*:

| Pain | Rank | What it is |
|---|---|---|
| **B** — teams don't know what's next | must | Each agent team starts cold, may pick work that ladders up to nothing. |
| **C** — roadmap goes stale | must | `BUILDER_QUEUE.md` drifts; shipped work stays queued (2026-07-15: PR #10 filed row #9 as open, shipped by PR #11). |
| **A** — can't see what happened | 2nd | No time-bound, per-agent summary of progress. |
| **D** — can't tell if we're moving | 2nd | Activity without a sense of delivered velocity against the roadmap. |

**Attention axis** — what gates the human (added on review; this reframed the tool):

| Pain | What it is |
|---|---|
| **Reviews** | PRDs / specs / design docs / PRs waiting on the human's review. |
| **Questions** | Decisions from docs, brainstorms, or dev-process issues that need a human answer. |
| **Escalations** | API errors and other blockers that stop an agent team until the human acts. |

**Reframe:** these are not seven features. They are **two axes over one loop**. The tool captures what happens (Observability) and routes what needs a human (Attention) — both from the same underlying history, plus one small new signal.

---

## 3. Decisions (locked in brainstorm)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Advisory authority.** claude-mem writes a *derived layer* beside `BUILDER_QUEUE.md` and never mutates it. A human/Planner **promotes** items across a one-way gate. | The curated queue is the one trustworthy list; generated output is noisy (~47% of emitted observations don't even persist). Keep the canonical layer hand-owned. |
| D2 | **"Who" = both axes, switchable** (agent **or** human). Agent axis populated now (14 types / 243 ids); human axis fills once the NAS pilot has users (WS2 `actor_id`). One `groupBy` abstraction. | Mark is one human driving several agent teams; the human column self-populates later, cheaply. |
| D3 | **Synthesis cadence = on-demand + daily.** Read views stay live; the LLM synthesis (ranked suggestions, stale-flags, new-row proposals) runs daily + on explicit refresh — not per session. | A roadmap moves on the order of days; re-synthesizing every session (~14/day) burns tokens re-ranking 17 rows. |
| D4 | **Roadmap linkage = hybrid.** Explicit `#N` references = **fact**; semantic (Chroma) matches = **suggestion** a human confirms. | Mirrors the advisory theme; explicit refs already exist in practice; semantic matching is confidently wrong often enough to stay advisory. |
| D5 | **Surface = extend the existing viewer**, not a new app. Add the Mission Control views to the worker's SSE viewer at `/`. | One surface, one worker, no new hosting. |
| D6 | **Attention sourcing = hybrid (mine + lightweight emit).** Mine what's inferable (open PRs/specs → reviews; error observations → escalations; docs' Open-Questions + captured AskUserQuestion → questions) **and** give agents one structured way to *raise* an item (`attention_raise`). | Mining is a free floor; the emit channel catches the case mining can't see — an agent deliberately stuck-and-waiting — and lets importance be *declared*, not guessed. |
| D7 | **Attention items auto-resolve.** Mining closes an item when its underlying cause resolves (PR merges → review clears; answered-question session ends → clears). Human can also clear manually. | Prevents the attention queue from becoming its own stale mess — the exact `BUILDER_QUEUE.md` failure mode that motivated this design. |

---

## 4. Architecture

### 4.1 Layers

- **Canonical layer** — `docs/BUILDER_QUEUE.md`. Unchanged: hand-edited, PR-reviewed, source of truth for what agent teams do. Nothing here writes to it automatically (D1).
- **Derived layer** — everything Mission Control generates: read-view query results, the deduped next-steps feed, and (Phase 3) synthesized suggestions. Surfaced in the console; the only thing "promote" moves from.
- **Attention store** — a new `attention_items` table (see §5): open items needing the human, from mining **and** emit, with a lifecycle.

### 4.2 The two engines

- **Read/mine engine** (cheap, live): SQLite queries + `gh`/git + doc parsing. Produces both the Observability read-views (A/D/B-lite) and the mined Attention floor (reviews/escalations/questions). No LLM.
- **Synthesis engine** (Phase 3, daily/on-demand, LLM): dedups and ranks `next_steps` into trustworthy suggestions (B), detects stale rows and proposes new rows (C), using explicit-ref linkage (D4). Writes to the derived layer for a human to **promote** (D1).

### 4.3 Roadmap linkage (D4)

- **Explicit (fact):** parse `#N` / `row #N` / `PR #N` references from commits, PR titles/bodies, and observation text. A row's "activity" = sessions/commits/PRs that explicitly reference it → drives velocity-per-row (D) and stale detection (C).
- **Semantic (suggestion, Phase 4):** embed each row; query Chroma for nearby observations; surface as confirmable suggestions. Never authoritative.

---

## 5. Attention axis mechanics

### 5.1 Emit channel (Phase 2)

A new MCP tool, following claude-mem's existing pattern (`observation_add`, `memory_add`):

```
attention_raise({
  type:       "review" | "question" | "blocker" | "escalation",
  summary:    string,          // one line: what needs the human
  blocked_on: string | null,   // what the agent is waiting for
  urgency:    "low" | "normal" | "high",
  project, agent_type, agent_id, memory_session_id   // provenance
})
```

Backed by a new `attention_items` SQLite table:

| Column | Purpose |
|---|---|
| `id`, `created_at`, `created_at_epoch` | identity / time |
| `type` | review / question / blocker / escalation |
| `summary`, `blocked_on`, `urgency` | the human-facing content |
| `source` | `emit` or `mine` |
| `ref` | link key — PR number, spec path, session id, error signature |
| `status` | `open` / `resolved` |
| `resolved_at`, `resolved_by` | lifecycle (`auto` \| human) |
| `project`, `agent_type`, `agent_id`, `memory_session_id` | provenance / grouping (D2) |

### 5.2 Mining (Phase 1)

- **Reviews:** `gh pr list` (open PRs) + specs with `Status: Proposed` under `docs/superpowers/specs/` and `docs/architecture/`.
- **Escalations:** observations/log signatures matching error/failure patterns (e.g. the `worker unreachable`, swallowed-startup, `EADDRINUSE` classes from 2026-07-15).
- **Questions:** "Open Questions" / "Open questions" sections in ADRs and specs; captured `AskUserQuestion` tool calls if present in the observation stream.

Mined items are written to `attention_items` with `source = mine` and a stable `ref`, so re-runs update rather than duplicate.

### 5.3 Auto-resolution (D7)

On each mine pass, an open item whose `ref` no longer qualifies is set `status = resolved`, `resolved_by = auto`: PR merged/closed → its review item resolves; spec status flips from `Proposed` → its review resolves; the error signature clears → the escalation resolves. Emit items resolve on a matching `attention_resolve` call or human action. This keeps the queue self-cleaning.

---

## 6. Phasing

Multi-PR arc; each phase is its own spec → plan → PR(s). **Only Phase 1 is specced here** for planning.

### Phase 1 — Surface what exists (both axes, mineable, ~free) ← implementation target

The MVP: immediate value from data already captured, **no new LLM cost, no emit infrastructure, no queue writes.**

- **Attention floor (mined):** reviews (open PRs + `Proposed` specs), escalations (error observations), questions (doc Open-Questions + captured AskUserQuestion). This is the single highest-value-per-effort deliverable — a pane showing *everything gated on you*.
- **Observability floor:**
  - Per-agent + per-time progress rollup (A): group `observations`/`session_summaries` by `agent_type`/`agent_id` × day/week, counts by observation `type`. `groupBy` abstraction supports the `human` axis (D2), empty until NAS data exists.
  - Velocity read-view (D-lite): shipped-vs-open over time from `BUILDER_QUEUE.md` + git. **Ungrouped** ("N shipped this week"), not yet per-row — per-row waits for Phase 3 linkage.
  - Raw suggested-next-steps feed (B-lite): surface existing `session_summaries.next_steps` (670/670 populated, currently read by nothing), deduped via existing Chroma or lexical.
- **Console:** extend the viewer (D5) with a **Mission Control** view — Attention pane (mined items grouped by type/urgency) + Observability panes (progress, velocity, next-steps).

**Explicitly NOT in Phase 1:** the `attention_raise` emit channel, agent-facing `attention_items` writes, LLM synthesis, roadmap-row linkage, stale detection, new-row proposals, semantic matching, any write toward `BUILDER_QUEUE.md`. (Phase 1 may still create the `attention_items` table as the store for *mined* items — but no emit tool and no agent-facing surface.)

**Cost:** effectively free — SQLite queries + `gh`/git + doc parsing, plus optional reuse of existing Chroma embeddings for dedup.

### Phase 2 — Emit channel

`attention_raise` MCP tool + agent-facing `attention_items` writes + `attention_resolve` + auto-resolution (§5.1, §5.3). Completes the Attention axis: catches the silently-stuck agent that mining can't see.

### Phase 3 — Close the loop (advisory synthesis)

Daily + on-demand LLM synthesis (D3): dedup/rank `next_steps` into ranked suggestions (B); stale-row flags + new-row proposals (C) via explicit-ref linkage (D4), written to the derived layer to **promote** (D1). A handful of cents/day at Haiku rates.

### Phase 4 — Richer

Semantic linkage as confirmable suggestions (D4); human grouping axis (D2) once the NAS pilot ingests multi-user data.

---

## 7. Components (Phase 1)

Small, independently-testable units:

| Unit | Purpose | Consumes | Produces |
|---|---|---|---|
| `ProgressQuery` | Group history by agent/human × time | SQLite (`observations`, `session_summaries`) | rollup rows (counts by type, sessions, files) |
| `VelocityQuery` | Shipped-vs-open over time | `BUILDER_QUEUE.md` parse + git log | per-week shipped/open series |
| `NextStepsFeed` | Deduped recent `next_steps` | `session_summaries.next_steps` + Chroma/lexical dedup | ranked-by-recency, deduped list |
| `AttentionMiner` | Detect items needing the human | `gh` (PRs), spec/ADR files (status + Open-Questions), error observations | rows in `attention_items` (`source=mine`), with auto-resolve |
| Console views | Render Attention + Observability | the queries above, over SSE/HTTP | the Mission Control viewer surface (D5) |

**Boundaries:** each query/miner is a pure read (or idempotent upsert into `attention_items`) with a typed return shape; the console owns rendering only. A `BUILDER_QUEUE.md` parser is shared by `VelocityQuery` and (later) Phase 3 linkage — factor it once, test it hard.

---

## 8. Testing (Phase 1)

- **Query units:** unit tests against a fixture SQLite DB → assert grouping, bucketing, dedup.
- **Queue parser:** fixture `BUILDER_QUEUE.md` including the retired-`~~9~~`-tombstone and unnumbered-shipped-row conventions (established 2026-07-15) → assert correct shipped/open/backlog extraction; parse failure is a loud error, never a silent empty result.
- **AttentionMiner:** fixture PRs (via a stubbed `gh` boundary), fixture spec files, fixture error observations → assert correct item creation **and** auto-resolution (merged PR → resolved). Idempotency: two mine passes over the same state produce no duplicates.
- **Console:** render both panes against fixture output; Tester exercises the live viewer per the plan's Test Plan.

---

## 9. Risks & open questions

| # | Risk / question | Disposition |
|---|---|---|
| R1 | Dedup quality on the raw next-steps feed (B-lite) may read as clutter. | If noisy, that's *evidence for* Phase 3 synthesis, not a Phase-1 blocker. Label the feed "unsynthesized." |
| R2 | Explicit-ref linkage undercounts (Phase 3); not every session references a row. | Acceptable — explicit=fact; gaps are where Phase 4 semantic *suggestions* help. Never present linkage as complete. |
| R3 | `BUILDER_QUEUE.md` is a hand-formatted markdown table; a brittle parser breaks on drift. | One shared, tested parser (§7); parse failure = loud error (the 2026-07-15 swallowed-error failure mode). |
| R4 | Human grouping axis (D2) empty until NAS has users. | By design; label it so an empty human view doesn't read as a bug. |
| R5 | `AttentionMiner` depends on `gh` auth in the worker's environment. | Degrade gracefully: if `gh` is unavailable, mine specs/errors only and surface a "PR mining unavailable" state rather than failing the whole pane. |
| R6 | Mined "questions" from doc sections may be low-precision (stale Open-Questions since answered). | Phase 1 mines + auto-resolves best-effort; precision improves with the Phase 2 emit channel where questions are *declared*. |
| Q1 | Should "promote" (D1) eventually be a Planner dispatch rather than hand-copy? | Out of scope for Phase 1; revisit in Phase 3 when there are synthesized proposals worth promoting. |
| Q2 | Should escalations trigger a *notification* (push), not just a console pane? | Out of scope for Phase 1 (surface only); a natural Phase 2+ extension once the emit channel declares urgency. |

---

## 10. Out of scope (YAGNI)

- No automatic writes to `BUILDER_QUEUE.md`, ever (D1).
- No LLM synthesis, roadmap-row linkage, stale detection, or new-row proposals in Phase 1.
- No `attention_raise` emit tool or agent-facing attention writes in Phase 1 (Phase 2).
- No semantic linkage in Phase 1 (Phase 4).
- No push notifications in Phase 1 (surface-only; Q2).
- No new hosted surface — extend the existing viewer only (D5).
- No multi-user human-axis data work — arrives with the NAS pilot.

---

*Terminal state of this brainstorm: hand Phase 1 to Planner (`superpowers:writing-plans`) for an implementation plan + a `docs/BUILDER_QUEUE.md` row. Phases 2–4 get their own specs when their turn comes.*
