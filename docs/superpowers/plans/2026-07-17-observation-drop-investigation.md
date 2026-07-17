# Unit B — Observation-drop investigation + instrumentation + contingent fix (Backlog #20)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans (and, for Phase 0, optionally
> agent-teams:team-debug / a `team-debugger`) to work this plan phase-by-phase. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Explain the reported ~47% observation-drop (10,963 emitted vs 5,845 persisted, 2026-07-01→16) **before**
committing to a fix, then make the drop measurable, then fix the dominant site. This is deliberately
**investigate → instrument (shippable) → contingent fix**, per
`docs/superpowers/specs/2026-07-17-observation-drop-investigation-design.md`.

**Architecture:** The counts are a **runtime claim**, not source-derivable. Two dedup keys imply two possible paths
(worker `content_hash` vs server `generation_key`), and the sweep's strongest concrete drop (site **c**) is
**server-path only** — so *which path produced the counts determines which site can be the cause*. Two of the
candidate drop sites (**c** render-empty, **d** scrub-empty) are **silent** today (`continue` with no log), so existing
logs cannot attribute them; the only method that can is **instrument-and-measure**. Phase 1 (instrumentation) is a
safe, non-billed, standalone-valuable PR; Phase 2 (fix) is gated on the Phase 0/1 attribution.

**Tech stack:** TypeScript, Bun test runner. Phase 1 touches `src/sdk/parser.ts` and
`src/server/generation/processGeneratedResponse.ts`. No new dependencies. No AI calls.

## Global constraints

- **Investigate-first is contractual.** Do not ship a #20 *fix* PR before Phase 0/1 attribution, **except** site **c**
  (`renderObservationContent` ignoring `concepts`/`files_*`), which is defensible as a standalone correctness bug and
  is the pre-designated primary fix candidate — but even that ships only after Phase 1 instrumentation lands, so its
  impact is measurable.
- **Phase 0 is data/host-gated — coordinator flag.** Reproducing the 10,963/5,845 counts needs live log/DB access on
  Mark's box (which path? which DB?). The instrumentation PR (Phase 1) does **not** need it and can land first.
- **Instrumentation must be behavior-neutral.** Phase 1 adds structured logging/counters only. It must not change which
  observations persist, must not add AI calls, and must not alter control flow beyond emitting a log at an
  already-existing drop branch.
- **Server path keys on `generation_key`; the upsert is correct.** Site **e** (`observations.ts:112` `ON CONFLICT …
  DO UPDATE SET updated_at … RETURNING *`) returns the existing row and only collapses **re-processed** jobs — it does
  not lose distinct observations. Do not "fix" it.
- **Postgres-gated tests silently skip (#5/#8).** `process-generated-response.test.ts` skips without
  `CLAUDE_MEM_TEST_POSTGRES_URL`. Put parser-level instrumentation tests in the **non-gated** `tests/sdk/parser.test.ts`;
  the server-path render/scrub instrumentation is exercised via a small pure test of `renderObservationContent`
  (extract/export it if needed) rather than the gated integration file.
- **Branch + PR policy:** branch from `main`; PR → **`fork/main`**; never `origin`. **Phase 1 is its own PR.** Phase 2
  is a **separate** PR opened only after Phase 0/1 attribution. Do not edit `docs/BUILDER_QUEUE.md`.

---

## Phase 0 — Path + dominant-site determination (investigation; data-gated)

**Deliverable: a written determination, not code.** Optionally run as a `team-debugger` competing-hypotheses pass.

- [ ] **Step 1: establish the path.** Determine whether the 10,963/5,845 counts came from the **worker/SQLite**
  (`content_hash`) path or the **server** (`generation_key`) path. Evidence sources (with Mark, data-gated):
  - Which store holds 5,845? `observations` in Postgres (server) vs the SQLite `~/.claude-mem/claude-mem.db` (worker).
  - Where did 10,963 "emitted" come from? A generation log line count, a `parse_error`/completed job count, or a
    manual tally? The definition of "emitted" decides whether site **a** (whole-batch reject) is even in scope.
- [ ] **Step 2: rank the candidate sites for that path** using the spec's table:
  - Server path → sites **a** (whole-batch), **c** (render-empty, silent, standalone bug), **d** (scrub-empty, silent)
    are live; **e** is not a distinct-loss.
  - Worker path → the sweep's site **c** does **not** apply (it is server-only); re-scope to the worker's parser drops
    (**a/b**, shared) and its `content_hash` dedup.
- [ ] **Step 3: write the determination** into the final report (path + ranked hypothesis + which Phase-2 fix it
  implies). If live data is unavailable, record that Phase 0 is **blocked on data access** and proceed to Phase 1
  (which is valuable and unblocked) — Phase 2's target then waits on Phase 0.

> **Coordinator flag:** Phase 0 needs live log/DB analysis (host/data-gated). It may also warrant a `team-debugger`
> pass. Neither blocks Phase 1.

---

## Phase 1 — Drop-reason instrumentation (shippable PR; safe, non-billed)

Make every drop site count-able. Site **b** already logs (`parser.ts:131`); add structured logs to the silent sites
and a `parse_error` reason breakdown. **No behavior change.**

**Files:**
- Edit: `src/sdk/parser.ts`
- Edit: `src/server/generation/processGeneratedResponse.ts`

- [ ] **Step 1: name the whole-response reject reason (site a).** `parseAgentXml` returns `{valid:false}` from three
  distinct branches (blank input `:42-44`, no `<observation|summary>` root `:66-69`, zero parsed observation blocks
  `:74-76`). Add a `logger.warn` at each so the `parse_error` rate is attributable by cause. Example for the
  zero-blocks branch:

```ts
// parser.ts — inside parseAgentXml, the observation branch (:72-78)
if (rootName === 'observation') {
  const observations = parseObservationBlocks(raw, correlationId);
  if (observations.length === 0) {
    logger.warn('PARSER', 'Rejecting response: <observation> root but zero parsable blocks', { correlationId });
    return { valid: false };
  }
  return { valid: true, observations, summary: null };
}
```

  Add the analogous one-line `logger.warn('PARSER', 'Rejecting response: <reason>', { correlationId })` at the blank
  (`:42`) and no-root (`:67`) branches. These are the only new lines; return values are unchanged.

- [ ] **Step 2: make the silent server-path drops loud (sites c and d).** In `persistGeneratedObservations`
  (`processGeneratedResponse.ts:274-286`), the two `continue`s are silent. Add a structured log to each, keyed so
  render-empty (**c**) and scrub-empty (**d**) are distinguishable, and include the metadata that would reveal a
  concepts/files-only observation (site c's signature).

```ts
// processGeneratedResponse.ts — replace the two guards at :277-286
if (!content || content.trim().length === 0) {
  logger.warn('SYSTEM', 'dropping observation: rendered content empty', {
    jobId: fresh.id,
    index,
    // site c signature: content rendered empty but concepts/files were present
    hadConcepts: Array.isArray((metadata as any).concepts) && (metadata as any).concepts.length > 0,
    hadFiles:
      (Array.isArray((metadata as any).files_read) && (metadata as any).files_read.length > 0) ||
      (Array.isArray((metadata as any).files_modified) && (metadata as any).files_modified.length > 0),
  });
  continue;
}

const scrubbed = stripTags(content);
if (!scrubbed.stripped || scrubbed.stripped.trim().length === 0) {
  logger.warn('SYSTEM', 'dropping observation: empty after privacy scrub', { jobId: fresh.id, index });
  continue;
}
```

> These logs run inside the already-existing drop branches — no observation that persists today stops persisting, and
> no new branch is added. The `hadConcepts`/`hadFiles` flags are exactly the signal Phase 0/2 needs to confirm site c.

- [ ] **Step 3: add a completed-job drop summary.** At the end of `persistGeneratedObservations` (before the return at
  `:429`), log the render-vs-persist delta so each job's drop count is visible without cross-referencing:

```ts
// processGeneratedResponse.ts — just before `return { kind: 'completed' ... }` (:429)
if (rendered.length !== persisted.length) {
  logger.warn('SYSTEM', 'generation job persisted fewer observations than rendered', {
    jobId: fresh.id,
    rendered: rendered.length,
    persisted: persisted.length,
    dropped: rendered.length - persisted.length,
  });
}
```

- [ ] **Step 4: tests (non-gated).** In `tests/sdk/parser.test.ts`, assert the three reject branches still return
  `{valid:false}` (behavior unchanged) — the logging is incidental, so assert **behavior**, not log text. For the
  server-path render check, add/extend a **pure** test of `renderObservationContent` proving a concepts-only /
  files-only observation renders to `''` (documents site c's exact trigger). If `renderObservationContent` is not
  exported, export it (it is a module-local `function` today) so it is unit-testable without Postgres:

```ts
// tests/sdk/render-observation-content.test.ts (new)
import { describe, expect, it } from 'bun:test';
import { renderObservationContent } from '../../src/server/generation/processGeneratedResponse.js';

describe('renderObservationContent (#20 site c)', () => {
  it('renders empty for a concepts-only observation (documents the drop)', () => {
    const out = renderObservationContent({
      type: 'discovery', title: null, subtitle: null, narrative: null,
      facts: [], concepts: ['auth', 'oauth'], files_read: [], files_modified: [],
    });
    expect(out).toBe(''); // <- current behavior; Phase 2 changes this
  });

  it('renders empty for a files-only observation (documents the drop)', () => {
    const out = renderObservationContent({
      type: 'discovery', title: null, subtitle: null, narrative: null,
      facts: [], concepts: [], files_read: ['a.ts'], files_modified: ['b.ts'],
    });
    expect(out).toBe('');
  });

  it('renders title/facts normally', () => {
    const out = renderObservationContent({
      type: 'discovery', title: 'T', subtitle: null, narrative: null,
      facts: ['f1'], concepts: [], files_read: [], files_modified: [],
    });
    expect(out).toContain('T');
    expect(out).toContain('- f1');
  });
});
```

> To export: change `function renderObservationContent` → `export function renderObservationContent` at
> `processGeneratedResponse.ts:476`. Export-only; no behavior change.

- [ ] **Step 5: build + targeted suites.** `bun test tests/sdk/parser.test.ts tests/sdk/render-observation-content.test.ts`
  → green; `npm run typecheck` → clean; `npm run build-and-sync` → passes delivery assertion. **Open Phase 1 as its own
  PR to `fork/main`.**

### Phase 1 Verification

- [ ] Every `{valid:false}` return path in `parser.ts` now emits a distinct WARN; return values are byte-identical
  (parser tests still pass).
- [ ] Both server-path silent drops now log a distinguishable reason; site c's log carries `hadConcepts`/`hadFiles`.
- [ ] The render test documents that concepts-only / files-only observations render to `''` today (site c's exact
  trigger), locked as a unit test.
- [ ] No observation that persists today is dropped by this PR (instrumentation only); no AI calls; typecheck clean;
  no new regressions vs the ~18 pre-existing failures (#7).

---

## Phase 2 — Targeted fix (contingent on Phase 0/1; separate PR)

**Gated on Phase 0/1 attribution — coordinator flag.** Ship only after the dominant site is identified.

### Primary candidate (pre-designed): fix site c — represent concepts/files in rendered content

Independent of the counts, an observation whose only signal is `concepts`/`files_read`/`files_modified` should not
silently vanish. Extend `renderObservationContent` to include them.

- [ ] **Step 1: include concepts + files in the rendered content.**

```ts
// processGeneratedResponse.ts renderObservationContent (:476-485) — extend
export function renderObservationContent(observation: ParsedObservation): string {
  const parts: string[] = [];
  if (observation.title) parts.push(observation.title);
  if (observation.subtitle) parts.push(observation.subtitle);
  if (observation.narrative) parts.push(observation.narrative);
  if (observation.facts && observation.facts.length > 0) {
    parts.push(observation.facts.map(f => `- ${f}`).join('\n'));
  }
  if (observation.concepts && observation.concepts.length > 0) {
    parts.push(`Concepts: ${observation.concepts.join(', ')}`);
  }
  const files = [...(observation.files_read ?? []), ...(observation.files_modified ?? [])];
  if (files.length > 0) {
    parts.push(`Files: ${files.join(', ')}`);
  }
  return parts.join('\n\n').trim();
}
```

- [ ] **Step 2: flip the render test expectations** (the concepts-only / files-only cases now render non-empty) and add
  a case proving a genuinely-empty observation (no fields at all) still renders `''` (so the empty-content guard still
  catches true noise). Note: the parser's site **b** already drops the *all-empty-including-concepts* case
  (`parser.ts:130-136`) before this point, so this change specifically rescues the **concepts/files present but
  title/narrative/facts absent** observations — exactly the gap.
- [ ] **Step 3 (only if Phase 0 points elsewhere):** if attribution shows site **a** (whole-batch rejects) or a
  worker-path `content_hash` issue dominates instead, replace Step 1/2 with the fix for *that* site and update the
  spec's ranking note. Do not ship the site-c change as the "the fix" if the data says it is a minor contributor —
  ship it as a correctness fix but keep hunting for the dominant cause.

### Phase 2 Verification

- [ ] Render test: concepts-only and files-only observations now persist (render non-empty); a truly empty observation
  still renders `''` and is still guarded.
- [ ] The Phase-1 site-c drop log (with `hadConcepts`/`hadFiles`) now fires far less often against the same input
  (measurable proof the fix engaged) — verify against replayed/seeded data with Mark (data-gated).
- [ ] No new regressions; typecheck clean; `build-and-sync` passes.

## Cross-references

- Investigation-method design: `docs/superpowers/specs/2026-07-17-observation-drop-investigation-design.md`.
- Finding: `docs/BUILDER_QUEUE.md` Backlog #20.
- Related: #30 (validate persistence holds end-to-end once generation is enabled).

## Queue

**The coordinator files the `docs/BUILDER_QUEUE.md` rows.** Do not edit `docs/BUILDER_QUEUE.md`. This unit yields
**two** PRs (Phase 1 instrumentation, then Phase 2 fix) — propose them as two queue rows (see the report).
