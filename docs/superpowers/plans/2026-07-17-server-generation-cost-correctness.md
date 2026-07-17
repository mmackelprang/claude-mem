# Unit A — Server generation cost/correctness (Backlog #19 + #21 + #22)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Close three server-generation cost/correctness gaps that share the *same code neighborhood*
(providers + `prompt-builder.ts` + `create-server-service.ts`) and are all **unit-testable without Postgres**:
- **#19 [cost]** — the resolved server generation model was invisible at startup, and the un-overridden default was
  `claude-sonnet-4-6` at ~3× the Haiku-tier cost. **Decision (Mark, 2026-07-17): change the default instead of just
  warning.** The Claude server default is now `claude-haiku-4-5-20251001` (cheap-by-default); Sonnet becomes an
  explicit `CLAUDE_MEM_SERVER_MODEL` opt-in. The Haiku id is the same one the worker path already defaults to
  (`SettingsDefaultsManager.ts`), so it is a known-valid model id and the prior default-change 404 risk (#2554) does
  not apply. A one-line INFO startup log still surfaces the resolved model so it is never a silent surprise (the loud
  WARN the plan originally proposed is moot now that the default is the cheap tier).
- **#21 [cost/correctness]** — a summary job with **zero** unprocessed events still bills a live Anthropic call whose
  body is `<!-- empty after privacy stripping -->`. Short-circuit the empty batch.
- **#22 [reliability]** — the summary lane has no aggregate size cap (only a per-event 16 KiB cap), so a large backlog
  can build a ~8 MB prompt that classifies `unrecoverable` → non-retryable → permanently `failed`. Add a total-size
  cap (design: `docs/superpowers/specs/2026-07-17-summary-lane-size-cap-design.md`, Option A).

**Architecture:** All three changes live in the **server generation provider layer**, which
`tests/server/generation/providers.test.ts` exercises **directly with a mock context and no Postgres**. That is the
whole reason these three are batched: they are testable together in one non-gated suite, unlike the
`ProviderObservationGenerator` / `processGeneratedResponse` paths that are Postgres-gated (`#5/#8` silent-skip
pattern). #21 and #22 are one-file changes in `prompt-builder.ts`; #19 adds a public `modelId` accessor to the
provider interface + a pure resolution-describer logged once at worker start.

**Tech stack:** TypeScript, **Bun** test runner (`import { describe, it, expect } from 'bun:test'`), Node-compat
`fetch`. No new dependencies.

## Global constraints

- **Change the default model to the cheap tier (Mark's override, 2026-07-17).** `DEFAULT_SERVER_CLAUDE_MODEL`
  (`ClaudeObservationProvider.ts`) is now `claude-haiku-4-5-20251001` — the same id the worker path defaults to
  (`SettingsDefaultsManager.ts:109`), so it is a known-valid model id. Sonnet is an explicit opt-in via
  `CLAUDE_MEM_SERVER_MODEL` (**not** `CLAUDE_MEM_MODEL`, which is the worker path). #19 also keeps an INFO startup log
  of the resolved model for observability; the originally-planned loud WARN is dropped (moot once the default is cheap).
- **Pricing rationale (for the default choice), no hardcoded dollar amounts in code.** Confirmed via the claude-api
  skill against the current table: `claude-sonnet-4-6` $3/$15 per MTok, `claude-haiku-4-5` $1/$5 per MTok = exactly
  3.00× on both — which is *why* the default flips to Haiku. No dollar figure or ratio is emitted at runtime; the INFO
  log names only the resolved model id (price-drift-proof).
- **No billed calls in tests.** Every provider test injects a `fetchImpl` stub or asserts the pre-call short-circuit —
  never hits `api.anthropic.com`. The #21 test asserts the provider returns the synthetic skip **without** invoking the
  injected fetch.
- **Regression gate = "no new failures."** The full suite has ~18 pre-existing failures (Backlog #7); gate on the
  targeted suites below being green and typecheck clean, not on a fully-green suite. The Postgres-gated generation
  tests (`process-generated-response.test.ts`, `provider-observation-generator.test.ts`) **silently skip** without
  `CLAUDE_MEM_TEST_POSTGRES_URL` (#5/#8) — do not add this unit's assertions there; they belong in the non-gated
  `providers.test.ts`.
- **Branch + PR policy (CLAUDE.md):** branch from `main`; PR targets **`fork/main`**
  (`gh pr create --repo mmackelprang/claude-mem --base main`). **Never push `origin`** — confirm
  `git remote get-url --push origin` reads `DISABLED_UPSTREAM_DO_NOT_PUSH` before any push. One PR for this unit.
- **Do not edit `CHANGELOG.md`** (auto-generated) or `docs/BUILDER_QUEUE.md` (coordinator owns it).
- **Rebuild note:** these are worker/server runtime files, not the viewer bundle. Run `npm run build-and-sync` at the
  end and let it assert plugin delivery; do not hand-edit any built artifact.

---

### Task 1: #21 — short-circuit empty summary batches (prompt-builder)

`skippedAll` is `context.events.length > 0 && allEventsScrubbedToEmpty` (`prompt-builder.ts:64`). For a **zero-event**
job the `.length > 0` conjunct fails, so `skippedAll` is `false`, the prompt falls through with a
`<!-- empty after privacy stripping -->` body, and `ClaudeObservationProvider.generate` calls `postMessages` — a live
billed request. Fix: treat a genuinely empty batch as a skip too, with an accurate reason.

**Files:**
- Edit: `src/server/generation/providers/shared/prompt-builder.ts`

**Interfaces:**
- `BuildServerPromptResult` gains `skipReason?: 'no_events' | 'all_private'` so the provider's synthetic skip response
  and logging can be accurate. `skippedAll` semantics widen to cover the empty batch.

- [ ] **Step 1: widen `skippedAll` and add `skipReason`.** Replace the `skippedAll` computation
  (`prompt-builder.ts:64`) and the result interface.

```ts
// prompt-builder.ts — BuildServerPromptResult (add skipReason)
export interface BuildServerPromptResult {
  readonly prompt: string;
  readonly hadPrivateContent: boolean;
  readonly skippedAll: boolean;
  readonly skipReason?: 'no_events' | 'all_private';
}
```

```ts
// prompt-builder.ts — replace the single `const skippedAll = ...` line (:64)
const noEvents = context.events.length === 0;
const allPrivate = !noEvents && allEventsScrubbedToEmpty;
const skippedAll = noEvents || allPrivate;
const skipReason: 'no_events' | 'all_private' | undefined = noEvents
  ? 'no_events'
  : allPrivate
    ? 'all_private'
    : undefined;
```

```ts
// prompt-builder.ts — return statement (:96): thread skipReason through
return { prompt, hadPrivateContent, skippedAll, ...(skipReason ? { skipReason } : {}) };
```

- [ ] **Step 2: make the provider skip loud + reason-accurate.** In `ClaudeObservationProvider.generate`
  (`ClaudeObservationProvider.ts:62-71`), use the reason. (Apply the identical change to the Gemini and OpenRouter
  providers where they check `skippedAll`.)

```ts
// ClaudeObservationProvider.ts generate() — replace the skippedAll block (:62-71)
const { prompt, skippedAll, skipReason } = buildServerGenerationPrompt(context);
if (skippedAll) {
  const reason = skipReason ?? 'all_private';
  logger.info('SDK', 'server generation skipped without billing provider', {
    provider: this.providerLabel,
    jobId: context.job.id,
    reason,
  });
  return {
    rawText: `<skip_summary reason="${reason}" />`,
    providerLabel: this.providerLabel,
    modelId: this.modelId,
  };
}
```

> Note: `this.modelId` is added in Task 3. If Task 3 is done after Task 1, temporarily reference `this.model` and
> update in Task 3, or sequence Task 3 first. The parser accepts `<skip_summary reason="no_events" />` — `parseAgentXml`
> matches any `reason="..."` (`parser.ts:48`).

- [ ] **Step 3: apply the same skip-reason wiring to Gemini and OpenRouter providers** at their `skippedAll` checks
  (`GeminiObservationProvider.ts:148-149`, `OpenRouterObservationProvider.ts:72-73`) — same three fields
  (provider/jobId/reason), same synthetic `<skip_summary reason="..." />` return.

---

### Task 2: #22 — total-size cap on the summary lane (prompt-builder)

Per the spec (Option A): add an aggregate character budget, fill oldest-first, emit a truncation marker. Runs after the
per-event scrub loop, over non-empty `eventBlocks`, so it never manufactures a spurious skip.

**Files:**
- Edit: `src/server/generation/providers/shared/prompt-builder.ts`

- [ ] **Step 1: add the budget constant** next to `MAX_PAYLOAD_CHARS` (`prompt-builder.ts:41`).

```ts
const MAX_PAYLOAD_CHARS = 16 * 1024;
// #22 — aggregate cap across ALL event blocks (the per-event cap above is the inner bound).
// Character budget (not tokens) to keep this function pure/dependency-free; ~256 KiB sits well
// under any current model context window even after scaffolding + char->token inflation.
const MAX_TOTAL_PAYLOAD_CHARS = 256 * 1024;
```

- [ ] **Step 2: enforce the budget while collecting blocks.** Replace the per-event push loop (`:53-62`) so it stops
  adding once the running total would exceed the budget, and counts omissions.

```ts
// prompt-builder.ts — replace the for-loop over context.events (:53-62)
let totalPayloadChars = 0;
let omittedForBudget = 0;
for (const event of context.events) {
  const block = buildEventBlock(event);
  if (block.hadPrivate) {
    hadPrivateContent = true;
  }
  if (block.body.length === 0) {
    continue;
  }
  allEventsScrubbedToEmpty = false;
  // Always include at least the first surviving block (bounded by the per-event
  // 16 KiB cap), so a non-empty batch never becomes a spurious skip.
  if (eventBlocks.length > 0 && totalPayloadChars + block.body.length > MAX_TOTAL_PAYLOAD_CHARS) {
    omittedForBudget += 1;
    continue;
  }
  eventBlocks.push(block.body);
  totalPayloadChars += block.body.length;
}
if (omittedForBudget > 0) {
  logger.warn('SDK', 'summary prompt truncated to total-size cap', {
    omitted: omittedForBudget,
    capBytes: MAX_TOTAL_PAYLOAD_CHARS,
    included: eventBlocks.length,
  });
  eventBlocks.push(
    `    <!-- ${omittedForBudget} events omitted: summary payload exceeded ${MAX_TOTAL_PAYLOAD_CHARS / 1024} KiB cap -->`,
  );
}
```

> Ordering note: events arrive oldest-first (`server-sessions.ts:327` `ORDER BY e.occurred_at ASC`); the cap keeps that
> order and fills from the oldest forward, so a truncated summary covers a contiguous early slice. The marker block is
> pushed into `eventBlocks`, so it renders inside `<agent_events>` via the existing `eventBlocks.join('\n')` (`:81`).

- [ ] **Step 3: confirm the skip interaction.** The cap runs after `allEventsScrubbedToEmpty` is set and always keeps
  the first surviving block, so `skippedAll` (Task 1) is unaffected. No code change — assert this in Task 4.

---

### Task 3: #19 — cheap-by-default + surface the resolved server model at startup

**Shipped (Mark's override, 2026-07-17):** change `DEFAULT_SERVER_CLAUDE_MODEL` to `claude-haiku-4-5-20251001` so
server generation is cheap-by-default; Sonnet is an explicit `CLAUDE_MEM_SERVER_MODEL` opt-in. Expose `modelId` on the
provider, add a pure resolution-describer, and log the resolved model once (INFO) when the active worker manager is
built. The originally-planned loud WARN on the un-overridden default is dropped — it is moot once the default is the
cheap tier.

**Files:**
- Edit: `src/server/generation/providers/shared/types.ts` (interface)
- Edit: `src/server/generation/providers/ClaudeObservationProvider.ts`
- Edit: `src/server/generation/providers/GeminiObservationProvider.ts`
- Edit: `src/server/generation/providers/OpenRouterObservationProvider.ts`
- Edit: `src/server/runtime/create-server-service.ts`

- [ ] **Step 1: add `modelId` to the provider interface** (`types.ts:30-33`).

```ts
export interface ServerGenerationProvider {
  readonly providerLabel: 'claude' | 'gemini' | 'openrouter';
  /** Resolved model id this provider will call — surfaced so startup can log it (#19). */
  readonly modelId: string;
  generate(context: ServerGenerationContext, signal?: AbortSignal): Promise<ServerGenerationResult>;
}
```

- [ ] **Step 2: expose `modelId` on each provider.** All three store `private readonly model: string` set from
  `options.model ?? DEFAULT_MODEL`. Add a public getter to each (no internal rename needed):

```ts
// Add inside ClaudeObservationProvider, GeminiObservationProvider, OpenRouterObservationProvider
get modelId(): string {
  return this.model;
}
```

  Then use `this.modelId` in the synthetic skip response added in Task 1 Step 2 (Claude), and — for consistency —
  the existing `modelId: this.model` result fields may stay as-is (same value).

- [ ] **Step 3: add a pure resolution-describer** in `create-server-service.ts`. Because the default is now the cheap
  Haiku tier, there is no silent-expensive-default to WARN about — the describer always returns an INFO-level message
  (no `level` field, no dead WARN branch, no need to import `DEFAULT_SERVER_CLAUDE_MODEL` here).

```ts
export function describeServerModelResolution(input: {
  providerLabel: string;
  modelId: string;
  envOverride: string | undefined;
}): { message: string; overridden: boolean } {
  const overridden = !!(input.envOverride && input.envOverride.trim());
  return {
    overridden,
    message:
      `server generation model resolved to '${input.modelId}' (provider=${input.providerLabel}, ` +
      `${overridden ? 'set via CLAUDE_MEM_SERVER_MODEL' : 'provider default'})`,
  };
}
```

- [ ] **Step 4: log it once when the active manager is built.** In `buildGenerationWorkerManager`
  (`create-server-service.ts:219-240`), after the `if (!provider) { ... }` null-guard and before returning the
  `ActiveServerGenerationWorkerManager`:

```ts
// create-server-service.ts buildGenerationWorkerManager, after the `if (!provider)` guard
const resolution = describeServerModelResolution({
  providerLabel: provider.providerLabel,
  modelId: provider.modelId,
  envOverride: process.env.CLAUDE_MEM_SERVER_MODEL,
});
logger.info('SYSTEM', resolution.message, {
  provider: provider.providerLabel,
  model: provider.modelId,
  overridden: resolution.overridden,
});

return new ActiveServerGenerationWorkerManager({
  pool,
  queueManager,
  provider,
});
```

> `logger` is already imported in `create-server-service.ts` (used at `:251`). This logs exactly once at
> worker-manager construction — the startup moment — not per job.

---

### Task 4: tests (non-Postgres, in `providers.test.ts`)

Add to `tests/server/generation/providers.test.ts` (pure unit tests; the `makeContext(...)` helper already exists).

**Files:**
- Edit: `tests/server/generation/providers.test.ts`
- Edit (new tiny test): `tests/server/generation/server-model-resolution.test.ts` (for the pure describer)

- [ ] **Step 1: #21 — empty batch is skipped without billing.**

```ts
it('skips a zero-event batch without calling the provider API (#21)', async () => {
  let fetchCalls = 0;
  const provider = new ClaudeObservationProvider({
    apiKey: 'k',
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
  });
  const ctx = makeContext();
  ctx.events = []; // zero-event summary batch (see makeContext override or construct directly)
  const result = await provider.generate(ctx);
  expect(fetchCalls).toBe(0);
  expect(result.rawText).toContain('skip_summary');
  expect(result.rawText).toContain('no_events');
});

it('build result reports skipReason=no_events for an empty batch (#21)', () => {
  const ctx = makeContext();
  ctx.events = [];
  const built = buildServerGenerationPrompt(ctx);
  expect(built.skippedAll).toBe(true);
  expect(built.skipReason).toBe('no_events');
});
```

> If `makeContext` returns a readonly `events`, construct the context inline or extend the helper to accept
> `{ events: [] }`. The existing `all-private` case (events present, all scrubbed) must still report
> `skipReason: 'all_private'` — add that assertion to lock the distinction.

- [ ] **Step 2: #22 — total-size cap truncates with a marker; small batches unchanged.**

```ts
it('caps total summary payload and emits a truncation marker (#22)', () => {
  const big = 'x'.repeat(20 * 1024); // 20 KiB payload each -> per-event cap trims to 16 KiB
  const events = Array.from({ length: 40 }, (_, i) => makeEvent({ id: `e${i}`, payload: big }));
  const ctx = makeContext();
  ctx.events = events;
  const built = buildServerGenerationPrompt(ctx);
  // Concatenated event region stays within the cap (+ marker slack).
  const region = built.prompt.split('<agent_events>')[1].split('</agent_events>')[0];
  expect(region.length).toBeLessThanOrEqual(256 * 1024 + 200);
  expect(built.prompt).toContain('events omitted');
  expect(built.skippedAll).toBe(false); // non-empty-but-truncated is NOT a skip
});

it('does not truncate or add a marker for a small batch (#22)', () => {
  const ctx = makeContext(); // default single small event
  const built = buildServerGenerationPrompt(ctx);
  expect(built.prompt).not.toContain('events omitted');
});
```

> `makeEvent` may need adding to the test file if not present — a minimal `PostgresAgentEvent` factory mirroring the
> `makeContext` job shape (id, eventType, sourceAdapter, occurredAtEpoch, payload). Reuse the existing event shape in
> `makeContext` if it already builds one.

- [ ] **Step 3: #19 — Haiku default + pure describer** (`server-model-resolution.test.ts`). Assert (a) the Claude
  server default is now `claude-haiku-4-5-20251001`, (b) `CLAUDE_MEM_SERVER_MODEL` (the `model` constructor option)
  still overrides, and (c) the INFO-only describer reports the resolved model + `overridden` flag.

```ts
import { describe, expect, it } from 'bun:test';
import { describeServerModelResolution } from '../../../src/server/runtime/create-server-service.js';
import {
  ClaudeObservationProvider,
  DEFAULT_SERVER_CLAUDE_MODEL,
} from '../../../src/server/generation/providers/ClaudeObservationProvider.js';

describe('server generation model default (#19 cheap-by-default)', () => {
  it('the Claude server default is the cheap Haiku tier', () => {
    expect(DEFAULT_SERVER_CLAUDE_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  it('a Claude provider with no model option resolves to the Haiku default', () => {
    expect(new ClaudeObservationProvider({ apiKey: 'k' }).modelId).toBe(DEFAULT_SERVER_CLAUDE_MODEL);
  });

  it('CLAUDE_MEM_SERVER_MODEL still overrides the default', () => {
    expect(new ClaudeObservationProvider({ apiKey: 'k', model: 'claude-sonnet-4-6' }).modelId)
      .toBe('claude-sonnet-4-6');
  });
});

describe('describeServerModelResolution (#19)', () => {
  it('reports the provider default when no env override is set', () => {
    const r = describeServerModelResolution({
      providerLabel: 'claude',
      modelId: DEFAULT_SERVER_CLAUDE_MODEL,
      envOverride: undefined,
    });
    expect(r.overridden).toBe(false);
    expect(r.message).toContain('provider default');
  });

  it('reports an env override when CLAUDE_MEM_SERVER_MODEL is set', () => {
    const r = describeServerModelResolution({
      providerLabel: 'claude',
      modelId: 'claude-sonnet-4-6',
      envOverride: 'claude-sonnet-4-6',
    });
    expect(r.overridden).toBe(true);
    expect(r.message).toContain('CLAUDE_MEM_SERVER_MODEL');
  });
});
```

---

### Task 5: build, typecheck, targeted suites

- [ ] **Step 1:** `bun test tests/server/generation/providers.test.ts tests/server/generation/server-model-resolution.test.ts` → all green.
- [ ] **Step 2:** `npm run typecheck` → no new errors.
- [ ] **Step 3:** `npm run build-and-sync` → completes; worker restarts; plugin-delivery assertion passes.

## Verification (before opening the PR)

- [ ] **#21 no-bill proof:** the empty-batch test proves the injected `fetchImpl` is **never** called and the result is
  a `<skip_summary reason="no_events" />`; the `all_private` case still reports `skipReason: 'all_private'` (distinction
  preserved).
- [ ] **#22 bounded prompt:** the cap test proves the concatenated `<agent_events>` region is ≤ 256 KiB (+marker slack)
  and carries the omitted-count marker; the small-batch test proves byte-behavior is unchanged (no marker) and
  `skippedAll` stays `false` for a truncated non-empty batch.
- [ ] **#19 cheap-by-default:** `DEFAULT_SERVER_CLAUDE_MODEL` is now `claude-haiku-4-5-20251001`
  (`grep DEFAULT_SERVER_CLAUDE_MODEL`); a Claude provider with no `model` option resolves to it; `CLAUDE_MEM_SERVER_MODEL`
  still overrides; `provider.modelId` is exposed; the INFO describer reports the resolved model + `overridden` flag.
- [ ] **No new regressions:** targeted suites green; typecheck clean; the ~18 pre-existing failures (#7) are unchanged
  (do not attempt to fix them here). No assertions were added to the Postgres-gated files (#5/#8).
- [ ] **Boundary:** no billed API calls in tests; the default model **changed to Haiku** per Mark's override; no edit to
  `docs/BUILDER_QUEUE.md`.

### Test Plan (live UAT — optional, for the Tester)

Server-runtime behavior; a live server-beta is host/billed and not required for merge. If a server-beta is available:
start the generation worker **without** `CLAUDE_MEM_SERVER_MODEL` → confirm the startup INFO line naming the resolved
model as `claude-haiku-4-5-20251001` with `provider default`; set `CLAUDE_MEM_SERVER_MODEL=claude-sonnet-4-6` → confirm
the INFO line names Sonnet with `set via CLAUDE_MEM_SERVER_MODEL`. (Flag: live server-beta is billed — coordinator gate.)

## Cross-references

- #22 design (cap vs chunk): `docs/superpowers/specs/2026-07-17-summary-lane-size-cap-design.md`.
- Findings: `docs/BUILDER_QUEUE.md` Backlog #19, #21, #22.
- Related (do not fold in): #14 (empty-key `??` bug), #20 (obs-drop — Unit B), #30 (enable server-side generation).

## Queue

**The coordinator files the `docs/BUILDER_QUEUE.md` row for this item.** Do not edit `docs/BUILDER_QUEUE.md`.
