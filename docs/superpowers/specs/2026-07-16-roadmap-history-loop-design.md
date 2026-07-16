# Design — Roadmap × History Loop for claude-mem

- **Date:** 2026-07-16
- **Status:** Approved (brainstorm complete; Phase 1 to be planned next)
- **Author:** Coordinator (with Mark)
- **Consumers:** Planner (Phase 1 implementation plan), Builder
- **Related:** `docs/BUILDER_QUEUE.md`, `docs/architecture/2026-07-02-distributed-team-onboarding-roadmap.md`, the existing viewer (`src/services/worker/http/routes/ViewerRoutes.ts`, `plugin/ui/viewer-bundle.js`)

---

## 1. Problem

claude-mem already captures the raw material for a roadmap-driving feedback loop, but the loop is only half-built and the forward-looking half is inert:

- **`session_summaries.next_steps` is written every session and read by nothing.** Verified: **670 / 670** session summaries carry a populated `next_steps` field. It is generated (and paid for) every session, aggregated nowhere, surfaced in no UI.
- **Observations are already typed and attributed.** `observations.type` ∈ {discovery, bugfix, change, feature, decision, refactor, security_*}; every row carries `agent_type` / `agent_id` (**14** distinct agent types, **243** distinct agent IDs today) and `files_read` / `files_modified`.
- **The roadmap is hand-maintained and drifts.** `docs/BUILDER_QUEUE.md` is 17 curated, high-signal rows — but it goes stale by hand. On 2026-07-15, PR #10 filed row #9 as *open* work that PR #11 had already *shipped*; the drift was caught only during a manual conflict resolution.

So there are two disconnected halves of a roadmap: a **generated** stream (`next_steps`, typed observations) that evaporates, and a **curated** list (`BUILDER_QUEUE.md`) maintained by hand. Nothing connects them.

### 1.1 The four pains (Mark's ranking)

| Pain | Rank | What it is |
|---|---|---|
| **B** — teams don't know what's next | **must** | Each agent team starts cold, re-derives context, may pick work that ladders up to nothing. |
| **C** — roadmap goes stale | **must** | `BUILDER_QUEUE.md` drifts from reality; shipped work stays queued, new findings don't land. |
| **A** — can't see what happened | close 2nd | No time-bound, per-person (per-agent) summary of progress. |
| **D** — can't tell if we're moving | close 2nd | Lots of activity, no sense of delivered velocity against the roadmap. |

**Key reframe:** these are not four features. They are **four views of one loop**. A and D are *read views*; B and C are the *write-back* that closes it.

---

## 2. Decisions (locked in brainstorm)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Advisory authority model.** claude-mem writes a *derived layer* that sits **beside** `BUILDER_QUEUE.md` and never mutates it. A human (or Planner) **promotes** items into the canonical queue — a one-way, human-gated step. | The curated artifact is the one trustworthy list; generated output is noisy (e.g. ~47% of emitted observations don't even persist). Keep the canonical layer hand-owned; make claude-mem a high-quality advisor, not an author. |
| D2 | **"Who" = both axes, switchable** (group by agent **or** human). Agent axis is populated now (14 types / 243 ids); human axis lights up once the NAS pilot has real users (WS2 `actor_id`). Build one `groupBy` abstraction; the human column fills itself later. | Mark is one human driving several agent teams. The agent axis is the live parallelism; the human axis is near-empty today but free to support. |
| D3 | **Synthesis cadence = on-demand + daily digest.** Read views (velocity, per-agent progress) are cheap queries and stay live. The **LLM synthesis** (ranked suggestions, stale-flags, new-row proposals) runs once daily and on an explicit "refresh" — not per session. | A roadmap moves on the order of days, not sessions; re-synthesizing every session (~14/day) would burn tokens re-ranking the same 17 rows and churn the suggestion list. |
| D4 | **Linkage = hybrid.** *Explicit references* (`#N` in commit/PR/observation text) are treated as **fact** and drive authoritative read-views. *Semantic matches* (Chroma nearest-neighbour between a row and observations) are treated as **suggestions** a human confirms — never as fact. | Mirrors the advisory theme. Explicit refs already exist in practice (2026-07-15 commits referenced #9/#11/#17). Semantic matching is powerful for discovery but confidently wrong often enough that it must stay advisory. |
| D5 | **Surface = extend the existing viewer**, not a new app. Add an enriched **History** view and a **Roadmap** view to the worker's existing SSE viewer at `/`. | One surface, one worker, no new hosting. The viewer already streams observations. |

---

## 3. Architecture

### 3.1 The loop

```
observations + session_summaries.next_steps      (captured every session; today: inert)
        │
   ┌────┴───────────────────────────────────────────────┐
   │  DERIVED LAYER   (claude-mem writes — NEVER canonical) │
   │                                                       │
   │   read views (cheap queries, live):                   │
   │     • velocity / delivered-vs-roadmap ......... D     │
   │     • per-agent + per-time progress rollup .... A     │
   │                                                       │
   │   synthesis (LLM, daily + on-demand):                 │
   │     • ranked, deduped suggested next-steps .... B     │
   │     • stale-row flags + new-row proposals ..... C     │
   └────┬──────────────────────────────────────────────────┘
        │  PROMOTE  (one-way, human/Planner gate — D1)
        ▼
   BUILDER_QUEUE.md   (canonical, hand-owned)
        │
        └──► informs what agent teams pick up next ...... B
```

### 3.2 Two layers, one boundary

- **Canonical layer** — `docs/BUILDER_QUEUE.md`. Unchanged ownership: hand-edited, PR-reviewed, the source of truth for what agent teams do. Nothing in this design writes to it automatically.
- **Derived layer** — everything claude-mem generates: computed read-view data (from SQLite queries) and synthesized suggestions (from the daily/on-demand LLM job). Written to its own store (see §4.3), surfaced in the viewer, and the *only* thing "promote" moves from.
- **Promote** — the single human-gated edge. A suggestion or new-row proposal is copied into `BUILDER_QUEUE.md` by a human (or a Planner dispatch the human approves). Never automatic.

### 3.3 Linkage (D4) in detail

The join key from history → roadmap row:

- **Explicit (fact):** parse `#N` / `row #N` / `PR #N`-style references out of commit messages, PR titles/bodies, and observation text. A row's "activity" = the set of sessions/commits/PRs that explicitly reference it. Drives: velocity-per-row (D), and stale detection (C — "row #7 has zero explicit activity in N days").
- **Semantic (suggestion):** embed each `BUILDER_QUEUE.md` row; query Chroma for nearby observations. Surfaces "these sessions *look* related to #7" as a confirmable suggestion. Never counts as authoritative activity. **Phase 3.**

---

## 4. Phasing

This is a **multi-PR arc**, not one change. Each phase is its own spec → plan → PR(s), per Mark's one-reviewable-unit-per-change preference. **Only Phase 1 is specced here** for planning; Phases 2–3 are scoped enough to sequence, not to build.

### Phase 1 — Surface what exists (this spec's implementation target)

The honest MVP: deliver immediate value from data already captured and paid for, with **no new LLM cost and no linkage dependency.**

**Delivers:**
- **Per-agent + per-time progress rollup (A):** group `observations` / `session_summaries` by `agent_type` (and `agent_id`), bucketed by day/week. Counts by observation `type`, PRs/commits touched, sessions. `groupBy` abstraction supports a `human` axis (D2) that renders empty until NAS `actor_id` data exists.
- **Velocity read-view (D-lite):** shipped-vs-open counts over time; rows moved to "Recently shipped" in `BUILDER_QUEUE.md` per week. This is *ungrouped* velocity (no per-row linkage yet) — "N items shipped this week," not yet "progress on row #7."
- **Raw suggested-next-steps feed (B-lite):** surface the existing `session_summaries.next_steps` values, most-recent-first, **deduped** (embedding-similarity via existing Chroma, or lexical if simpler). No LLM synthesis — just *show the thing that's currently read by nothing*.

**Explicitly NOT in Phase 1:** LLM synthesis, roadmap-row linkage, stale detection, new-row proposals, semantic matching, any write toward `BUILDER_QUEUE.md`.

**Cost:** effectively free — SQLite queries plus (optionally) reuse of already-computed Chroma embeddings for dedup.

### Phase 2 — Close the loop (advisory synthesis)

- LLM **synthesis** job (daily + on-demand, D3): dedup and **rank** `next_steps` into trustworthy suggestions (B); detect **stale rows** and propose **new rows** (C), using Phase-1's explicit-ref linkage (D4).
- Writes to the derived layer for a human to **promote** (D1). Never edits `BUILDER_QUEUE.md`.
- Cost: one synthesis pass over a day's `next_steps` — a handful of cents at Haiku rates, not a per-session tax.

### Phase 3 — Richer

- Semantic linkage (D4) surfaced as confirmable suggestions.
- Human axis (D2) populated once the NAS pilot ingests real multi-user data.

---

## 5. Components (Phase 1)

Designed as small, independently-testable units:

| Unit | Purpose | Consumes | Produces |
|---|---|---|---|
| `ProgressQuery` | Group history by agent/human × time bucket | SQLite (`observations`, `session_summaries`) | rollup rows (counts by type, sessions, files) |
| `VelocityQuery` | Shipped-vs-open over time | `BUILDER_QUEUE.md` (parse "Recently shipped" + Backlog/Queue tables), git log | per-week shipped/open series |
| `NextStepsFeed` | Deduped recent `next_steps` | `session_summaries.next_steps` + Chroma (dedup) | ranked-by-recency, deduped list |
| Viewer views | Render History (groupable) + Roadmap (queue + feed) | the three queries above, over SSE/HTTP | the two new viewer surfaces (D5) |

**Boundaries:** each query unit is a pure read over existing stores with a typed return shape; the viewer consumes those shapes and owns no business logic. A `BUILDER_QUEUE.md` parser is shared by `VelocityQuery` (and later Phase 2's linkage) — factor it once.

---

## 6. Testing (Phase 1)

- **Query units:** unit tests against a fixture SQLite DB with known observations/summaries → assert grouping, bucketing, and dedup behavior. No live DB, no LLM.
- **Queue parser:** fixture `BUILDER_QUEUE.md` (including the retired-`~~9~~`-tombstone and unnumbered-shipped-row conventions established 2026-07-15) → assert correct shipped/open/backlog extraction. The parser must not choke on the numbering conventions already in the file.
- **Viewer:** render the two views against fixture query output; Tester exercises the live viewer per the plan's Test Plan.

---

## 7. Risks & open questions

| # | Risk / question | Disposition |
|---|---|---|
| R1 | **Dedup quality on the raw feed (B-lite).** Noisy `next_steps` may dedup poorly and read as clutter. | Phase 1 ships dedup-by-similarity; if it's noisy, that's *evidence for* Phase 2's LLM synthesis, not a Phase-1 blocker. Keep the raw feed clearly labeled "unsynthesized." |
| R2 | **Explicit-ref linkage coverage (Phase 2).** Not every session references a row; velocity-per-row will undercount. | Acceptable — explicit=fact, and gaps are exactly where Phase 3's semantic *suggestions* help. Never present linkage as complete. |
| R3 | **`BUILDER_QUEUE.md` is a hand-formatted markdown table.** A brittle parser breaks on format drift. | One shared, tested parser (§5); treat parse failures as loud errors, not silent empty results (the failure mode that bit the worker startup on 2026-07-15). |
| R4 | **Human axis empty (D2).** The `human` grouping renders nothing until NAS has users. | By design — the abstraction is cheap, the column self-populates later. Label it so an empty human view doesn't read as a bug. |
| Q1 | Should "promote" (D1) eventually be a Planner dispatch rather than pure hand-copy? | Out of scope for Phase 1; revisit in Phase 2 when there are synthesized proposals worth promoting. |

---

## 8. Out of scope (YAGNI)

- No automatic writes to `BUILDER_QUEUE.md`, ever (D1).
- No LLM synthesis in Phase 1.
- No semantic linkage in Phase 1.
- No new hosted surface — extend the existing viewer only (D5).
- No multi-user human-axis data work — it arrives with the NAS pilot, not this arc.

---

*Terminal state of this brainstorm: hand Phase 1 to Planner (`superpowers:writing-plans`) for an implementation plan + a `docs/BUILDER_QUEUE.md` row. Phases 2–3 get their own specs when their turn comes.*
