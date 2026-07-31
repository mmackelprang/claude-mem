# Unit — The worker-unreachable hook must never block a prompt (Queue #44)

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) tracking.

**Goal:** When the claude-mem worker is unreachable, **every hook, on every platform, at every streak length,
exits 0** — the user's prompt always submits. The outage stays LOUD via a per-turn in-band warning, a durable log
line, and a rate-limited stderr diagnostic, and the failure counter gains decay + real reset paths so a stale
streak can never arm a fresh session.

Design + full evidence: `docs/superpowers/specs/2026-07-31-hook-fail-open-never-block-design.md`.

---

## The one-line bug (read this before writing any code)

`src/shared/worker-utils.ts:704-706` calls `emitBlockingError()`, and `emitBlockingError`
(`src/shared/hook-io.ts:138-147`) ends in an unconditional `process.exit(2)`. Claude Code reads exit 2 as
**"operation blocked"**, so on `UserPromptSubmit` the user cannot submit prompts at all.

It is awaited **one line before** the graceful-degrade sentinel:

```ts
// src/shared/worker-utils.ts:741-745
const alive = await ensureWorkerAliveOnce();
if (!alive) {
  await recordWorkerUnreachable();   // ← exits(2) past the threshold
  return { continue: true, reason: 'worker_unreachable', [WORKER_FALLBACK_BRAND]: true };  // ← DEAD CODE
}
```

All seven handlers already honour that sentinel correctly. **The fail-open machinery is complete and correct; it
is simply unreachable.** Same poisoning kills `exitGraceful()` at `src/cli/hook-command.ts:139-150` (lines 148-149
are dead past the threshold).

**Do NOT "fix" this by deleting the warning.** Fail-loud exists because a silently-broken claude-mem is exactly
open issue **#41** (an 11-day capture outage nobody noticed). The fix changes the **channel**, not the volume.

---

## Global constraints

- **Never introduce a non-zero exit on the worker-unreachable path.** Not exit 1, not exit 2, on any platform.
  `emitBlockingError` remains correct — and untouched — for the *unrecoverable handler error* path at
  `hook-command.ts:167`. Only the fail-loud counter stops calling it.
- **Do NOT touch the hook shell template or anything under the byte-for-byte drift assertion:**
  `src/build/hook-shell-template.ts`, `scripts/build-hooks.js`, `plugin/hooks/*.json`, `plugin/.mcp.json`
  (`tests/infrastructure/plugin-distribution.test.ts:336-425`). Fail-open needs none of it.
- **Do NOT add any telemetry property and do NOT widen `TELEMETRY_HOOK_TYPES`.** See "Telemetry: hands off",
  below. This is the single easiest way to blow this PR's blast radius from 2 upstream files to 6.
- **Upstream-owned files are off-limit by default** (ADR 0002 §9). Verify with
  `git diff --name-only f5633c1f HEAD -- <file>` — **empty output means upstream-owned**. This plan deliberately
  edits exactly **two** upstream-owned files, both named and justified below; anything else upstream-owned means
  **stop and surface it** rather than editing.

  | File | Owner (verified) | Edit? |
  |---|---|---|
  | `src/shared/worker-utils.ts` | fork (+39/−0) | ✅ free |
  | `src/services/worker-service.ts` | fork (+77/−8) | ✅ free |
  | `src/shared/SettingsDefaultsManager.ts` | fork (+14/−0) | ✅ free |
  | `src/shared/hook-degraded-notice.ts` | **new** | ✅ create |
  | `tests/cli/hook-fail-open.test.ts` | **new** | ✅ create |
  | `src/cli/hook-command.ts` | **upstream-identical** | ⚠️ **deliberate — Task 4** |
  | `tests/cli/hook-stream-discipline.test.ts` | **upstream-identical** | ⚠️ **deliberate — Task 7** |
  | `src/npx-cli/commands/doctor.ts` | **upstream-identical** | ⚠️ **Task 6 — CUTTABLE, see open question (d)** |
  | `src/shared/hook-io.ts` | upstream-identical | ❌ **no edit** |
  | `src/services/telemetry/scrub.ts`, `src/npx-cli/commands/telemetry.ts`, `docs/public/telemetry.mdx`, `tests/telemetry/scrub.test.ts` | upstream-identical | ❌ **no edit** |
  | `src/cli/adapters/*`, all 7 handlers | mixed | ❌ **no edit** |

- **`plugin/` is build output.** Real edits go in `src/`, then `npm run build-and-sync`. The working tree already
  carries an uncommitted rebuild of `plugin/` — that is expected, not hand-edits.
- **Gate is `npm run test:gate`, NOT raw `bun test`** (CLAUDE.md). Do **not** add entries to
  `tests/known-failures.json` to paper over anything this PR breaks.
- **Branch + PR** per Mark's global CLAUDE.md. Suggested branch: `fix/hook-fail-open-never-block`.

### Telemetry: hands off

`scrub.ts:113` (`hook_type`, `error_mode`, `consecutive_failures`, `threshold_tripped`) is a **closed whitelist**
cross-referenced by `src/npx-cli/commands/telemetry.ts:80` and `docs/public/telemetry.mdx`, with an in-source
comment saying never to widen one without the others. All four files are upstream-owned.

This plan adds **zero** telemetry properties, removes none, and keeps the one-shot `=== threshold` emit and its
exact payload **verbatim**. Consequently `tests/telemetry/scrub.test.ts:187-201` **stays green and must not be
edited** — this corrects the originating brief, which listed it as a test that would fail.

`threshold_tripped: true` changes *meaning* (from "escalated to exit 2" to "surfaced a visible notice") but not
shape; `telemetry.mdx`'s wording — *"whether the fail-loud threshold was reached"* — remains accurate.

Likewise `TELEMETRY_HOOK_TYPES` / `setActiveHookType` (`worker-utils.ts:606-632`) is **not used** by this design
and must stay a closed 5. Notice eligibility keys on the raw `event` string that `hookCommand(platform, event)`
already receives (`hook-command.ts:103`) — which includes `user-message`, the very event the telemetry enum drops
to `null`. See spec §7.4.

### Test-safety constraint (read before writing any test)

The failure counter lives at `<DATA_DIR>/state/hook-failures.json`, and `DATA_DIR` defaults to
`~/.claude-mem` — **Mark's live install**. `DATA_DIR` is a module-level `const` evaluated at import time
(`src/shared/paths.ts:38`), overridable only via `process.env.CLAUDE_MEM_DATA_DIR`.

Therefore every test that exercises the counter **must** set `CLAUDE_MEM_DATA_DIR` to a temp dir **before the
first import of `worker-utils.js`** (use `await import(...)`, never a top-level static import), and **must assert
the override took effect** before writing anything. A test that silently clobbers Mark's real counter is worse
than no test. Task 8's harness does this; do not skip the assertion.

`loadFromFileOnce()` reads `<DATA_DIR>/settings.json` and caches once per process
(`hook-settings.ts:10-14`), so a test needing a specific threshold must write that file into the temp data dir
**before** the first settings read.

Do **not** call `hookCommand()` in a test: `readJsonFromStdin()` attaches stdin listeners that never end under the
test runner and only resolves on a **30-second** safety timeout (`stdin-reader.ts:36,82-92`). Use seam-level and
source-contract assertions, exactly as `tests/cli/hook-stream-discipline.test.ts:19-23` already documents.

---

### Task 1: New fork-owned module — `src/shared/hook-degraded-notice.ts`

- [ ] Create `src/shared/hook-degraded-notice.ts` with exactly this content:

```ts
/**
 * Worker-degraded notice (Queue #44).
 *
 * The fail-loud counter used to escalate a worker-unreachable streak to
 * `emitBlockingError()` -> `process.exit(2)`, which Claude Code reads as
 * "operation blocked" — so a down worker made the user unable to submit
 * prompts at all. This module is the replacement channel: the condition is
 * recorded in-process here, and hookCommand folds it into the HookResult as a
 * USER_HINT (`systemMessage`) immediately before the single stdout JSON emit.
 *
 * Design decisions this module encodes (spec sections 5.2-5.5):
 *  - `systemMessage`, never `hookSpecificOutput.additionalContext` — the human
 *    is the only actor who can restart a daemon, and a per-turn model-context
 *    injection would be an unbounded token tax on a condition the model cannot
 *    act on (and would derail it into "fixing" claude-mem).
 *  - Turn-boundary events ONLY. `observation` fires on every PostToolUse
 *    (dozens-to-hundreds of times per turn); a banner there would be unusable.
 *    The three events below fire exactly once per turn, which is the requested
 *    cadence.
 *  - Eligibility keys on the RAW event string, not TELEMETRY_HOOK_TYPES — that
 *    enum is a closed 5 cross-referenced by three other upstream-owned files
 *    and it drops `user-message` to null. See spec section 7.4.
 *
 * Lives in src/shared/ and imports only a TYPE from src/cli — `import type` is
 * erased at runtime, so there is no shared->cli runtime dependency. This is the
 * same arrangement src/shared/hook-io.ts already uses (hook-io.ts:17-20).
 */
import type { HookResult } from '../cli/types.js';

export interface DegradedState {
  /** Consecutive worker-unreachable hooks, post-decay. */
  streak: number;
  /** Wall-clock ms when the current streak began. 0 = unknown. */
  sinceMs: number;
  /** The configured fail-loud threshold this streak crossed. */
  threshold: number;
}

let degraded: DegradedState | null = null;

/** Called by recordWorkerUnreachable() once the streak reaches the threshold. */
export function markWorkerDegraded(state: DegradedState): void {
  degraded = state;
}

/** Called by resetWorkerFailureCounter() when the worker comes back. */
export function clearWorkerDegraded(): void {
  degraded = null;
}

export function getWorkerDegraded(): DegradedState | null {
  return degraded;
}

/**
 * Turn-boundary hook events. `context` = SessionStart, `session-init` =
 * UserPromptSubmit / Cursor beforeSubmitPrompt / Antigravity BeforeAgent,
 * `user-message` = the prompt-banner event. Everything else
 * (observation | summarize | file-edit | file-context) is a background hook and
 * gets no banner.
 */
export const NOTICE_EVENTS: readonly string[] = ['context', 'session-init', 'user-message'];

export function isNoticeEvent(event: string): boolean {
  return NOTICE_EVENTS.includes(event);
}

function formatElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return 'under a minute';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * The user-facing notice. Names the state, the duration, the fact that NOTHING
 * was blocked, and the one-command remedy. "Your prompt was not blocked" is not
 * filler — it is what stops a user who remembers the old exit-2 behaviour from
 * assuming the session is broken again.
 */
export function buildDegradedNotice(state: DegradedState, now: number = Date.now()): string {
  const today = new Date(now).toISOString().slice(0, 10);
  const elapsed = state.sinceMs > 0 && now > state.sinceMs
    ? ` over ${formatElapsed(now - state.sinceMs)}`
    : '';
  return [
    '⚠️  claude-mem: worker unreachable — memory capture is OFF',
    `   (${state.streak} consecutive hooks${elapsed}). Your prompt was not blocked.`,
    '   Fix: `claude-mem worker start`',
    `   Logs: ~/.claude-mem/logs/claude-mem-${today}.log`,
  ].join('\n');
}

/**
 * Pure. Returns `result` UNCHANGED when the worker is healthy or the event is
 * not a turn boundary — so the happy path is byte-identical to pre-#44.
 *
 * When it does attach:
 *  - the notice is PREPENDED to any existing systemMessage, never replaces it
 *    (user-message returns a rich banner and context may return a colored
 *    timeline; both must survive);
 *  - `suppressOutput` is forced false. The claude-code adapter strips the key
 *    entirely, but the antigravity adapter forwards it (antigravity-cli.ts:63-65)
 *    and every worker-unreachable fallback result sets `suppressOutput: true` —
 *    which would suppress the warning on exactly the platform that needs it.
 */
export function attachDegradedNotice(event: string, result: HookResult): HookResult {
  const state = degraded;
  if (state === null || !isNoticeEvent(event)) return result;

  const notice = buildDegradedNotice(state);
  const existing = typeof result.systemMessage === 'string' && result.systemMessage.length > 0
    ? result.systemMessage
    : null;

  return {
    ...result,
    suppressOutput: false,
    systemMessage: existing === null ? notice : `${notice}\n\n${existing}`,
  };
}
```

- [ ] Verify it typechecks in isolation: `npx tsc --noEmit -p tsconfig.json` (full typecheck runs in Task 9).

---

### Task 2: `src/shared/worker-utils.ts` — stop blocking, add decay, add reset paths

**Fork-owned (+39/−0) — free to edit.**

#### 2a. Swap the import

- [ ] Replace line 10:

```ts
import { emitBlockingError } from "./hook-io.js";
```

with:

```ts
import { emitDiagnostic } from "./hook-io.js";
import { markWorkerDegraded, clearWorkerDegraded } from "./hook-degraded-notice.js";
```

- [ ] Confirm `emitBlockingError` had exactly one call site in this file before removing the import:
  `grep -n 'emitBlockingError' src/shared/worker-utils.ts` must return **nothing** after this task.

> `emitDiagnostic` (`hook-io.ts:105-107`) is already the non-exiting sibling the brief anticipated needing: same
> pinned bypass channel, no `process.exit`. **This is why `hook-io.ts` needs no edit at all.**

#### 2b. State shape + constants (replaces lines 538-543)

- [ ] Replace:

```ts
interface HookFailureState {
  consecutiveFailures: number;
  lastFailureAt: number;
}

const FAIL_LOUD_DEFAULT_THRESHOLD = 3;
```

with:

```ts
interface HookFailureState {
  consecutiveFailures: number;
  lastFailureAt: number;
  /**
   * #44 — wall-clock ms when the CURRENT streak began. 0 = unknown (a state
   * file written before #44). Powers the "over 2h 13m" half of the notice.
   */
  streakStartedAt: number;
  /**
   * #44 — wall-clock ms of the last raw-stderr degraded diagnostic. Persisted,
   * not in-process: every hook is a fresh short-lived process, so an in-memory
   * cooldown would be a no-op. 0 = never emitted.
   */
  lastNoticeAt: number;
}

const FAIL_LOUD_DEFAULT_THRESHOLD = 3;
/**
 * #44 — a streak only survives if its failures are consecutive IN TIME. Without
 * decay, `lastFailureAt` is written and read by nothing, and a 298-long streak
 * from last week arrives pre-armed at the first transient failure of the next
 * session. That is how 3 real failures became 298.
 */
const FAIL_DECAY_DEFAULT_MINUTES = 30;
/** #44 — minimum gap between raw-stderr diagnostics. The per-turn banner is NOT rate-limited. */
const NOTICE_COOLDOWN_DEFAULT_MINUTES = 10;
/** #44 — `CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD=0` means "never surface a notice". */
const NOTICES_DISABLED = 0;
```

#### 2c. Parser + default state (replaces lines 553-575)

- [ ] Replace `parseHookFailureState` and `readHookFailureState` with:

```ts
function parseNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function parseHookFailureState(raw: string): HookFailureState {
  const parsed = JSON.parse(raw) as Partial<HookFailureState>;
  // #44: the two new fields default to 0 on a pre-#44 state file, which every
  // consumer below treats as "unknown" — so the shape change is backward
  // compatible and needs no migration.
  return {
    consecutiveFailures: parseNonNegativeNumber(parsed.consecutiveFailures),
    lastFailureAt: parseNonNegativeNumber(parsed.lastFailureAt),
    streakStartedAt: parseNonNegativeNumber(parsed.streakStartedAt),
    lastNoticeAt: parseNonNegativeNumber(parsed.lastNoticeAt),
  };
}

const EMPTY_FAILURE_STATE: HookFailureState = {
  consecutiveFailures: 0,
  lastFailureAt: 0,
  streakStartedAt: 0,
  lastNoticeAt: 0,
};

function readHookFailureState(): HookFailureState {
  try {
    return parseHookFailureState(readFileSync(getHookFailuresPath(), 'utf-8'));
  } catch {
    // [ANTI-PATTERN IGNORED]: the failure-counter state file is optional and
    // absent (ENOENT) on every hook run until the first worker failure, so
    // logging here would fire on effectively every healthy invocation; the
    // recovery is the zeroed default state below.
    return { ...EMPTY_FAILURE_STATE };
  }
}
```

#### 2d. Settings readers (replaces lines 594-604)

- [ ] Replace `getFailLoudThreshold` with:

```ts
function readMinutesSetting(
  key: 'CLAUDE_MEM_HOOK_FAIL_DECAY_MINUTES' | 'CLAUDE_MEM_HOOK_NOTICE_COOLDOWN_MINUTES',
  fallbackMinutes: number,
): number {
  try {
    const parsed = parseInt(loadFromFileOnce()[key], 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  } catch {
    // settings unreadable — fall through to default
  }
  return fallbackMinutes;
}

/**
 * #44 — `0` is now an explicit OFF switch ("never surface a notice"), not a
 * silent fallback to the default. Pre-#44 the guard was `parsed >= 1`, so a
 * user hitting the blocking bug could not turn it off: `0` quietly meant `3`.
 * Negative / non-numeric values still fall back to the default.
 */
function getFailLoudThreshold(): number {
  try {
    const settings = loadFromFileOnce();
    const raw = settings.CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD;
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  } catch {
    // settings unreadable — fall through to default
  }
  return FAIL_LOUD_DEFAULT_THRESHOLD;
}

function getFailDecayMs(): number {
  return readMinutesSetting('CLAUDE_MEM_HOOK_FAIL_DECAY_MINUTES', FAIL_DECAY_DEFAULT_MINUTES) * 60_000;
}

function getNoticeCooldownMs(): number {
  return readMinutesSetting('CLAUDE_MEM_HOOK_NOTICE_COOLDOWN_MINUTES', NOTICE_COOLDOWN_DEFAULT_MINUTES) * 60_000;
}
```

#### 2e. `recordWorkerUnreachable` — the fix (replaces lines 660-709 in full)

- [ ] Replace the entire function with:

```ts
/**
 * #44 — NEVER exits. Records the failure, applies decay, and past the threshold
 * marks the process degraded + writes the loud-but-non-blocking channels.
 * Returns the post-decay streak length.
 *
 * Pre-#44 this called emitBlockingError() -> process.exit(2), which Claude Code
 * reads as "operation blocked" — so a down worker made the user unable to submit
 * prompts, and every blocked prompt was itself a hook that incremented the
 * counter (3 real failures + 295 self-inflicted = 298). The ratchet is dead
 * because nothing blocks; the streak is bounded in TIME by decay.
 */
export async function recordWorkerUnreachable(): Promise<number> {
  const now = Date.now();
  const previous = readHookFailureState();

  // DECAY: `lastFailureAt` has been written since day one and read by NOTHING.
  // This is its first consumer. A streak older than the window is expired and a
  // fresh one starts at 1.
  const expired = previous.consecutiveFailures > 0
    && previous.lastFailureAt > 0
    && (now - previous.lastFailureAt) > getFailDecayMs();
  const priorFailures = expired ? 0 : previous.consecutiveFailures;

  const next: HookFailureState = {
    consecutiveFailures: priorFailures + 1,
    lastFailureAt: now,
    streakStartedAt: priorFailures === 0
      ? now
      : (previous.streakStartedAt || previous.lastFailureAt || now),
    lastNoticeAt: expired ? 0 : previous.lastNoticeAt,
  };
  // Persist the increment BEFORE anything that awaits, so a killed hook process
  // cannot lose it (preserves the pre-#44 ordering).
  writeHookFailureStateAtomic(next);

  const threshold = getFailLoudThreshold();
  if (threshold === NOTICES_DISABLED) return next.consecutiveFailures;
  if (next.consecutiveFailures < threshold) return next.consecutiveFailures;

  // #44: record the condition for hookCommand's attachDegradedNotice(). Done
  // FIRST so a slow telemetry POST below cannot delay it.
  markWorkerDegraded({
    streak: next.consecutiveFailures,
    sinceMs: next.streakStartedAt,
    threshold,
  });

  // hook_failed distress signal. Gated to the failure that JUST reached the
  // threshold (`===`, not `>=`) to bound telemetry volume — the per-turn banner
  // is the repeating channel. Closed-enum/count props only, never error text.
  // Transport is the direct CLI POST, never the worker API (the defining
  // failure here IS "worker unreachable"). captureCliEvent never throws and is
  // hard-capped at 2s.
  if (next.consecutiveFailures === threshold) {
    await captureCliEvent('hook_failed', {
      ...(activeHookType !== null ? { hook_type: activeHookType } : {}),
      error_mode: 'worker_unavailable',
      consecutive_failures: next.consecutiveFailures,
      threshold_tripped: true,
    });
    // Crash-loop liveness (#17): emit the orphaned-socket diagnosis ONCE per
    // streak (same `=== threshold` gate). Probe the port only here, at the
    // crossing — never on the happy path. Lazy-import the canonical bind probe
    // to avoid a shared->services static import cycle; best-effort.
    try {
      const { isPortInUse } = await import('../services/infrastructure/HealthMonitor.js');
      const workerPort = getWorkerPort();
      const diagnosis = buildCrashLoopDiagnosis(next.consecutiveFailures, await isPortInUse(workerPort), workerPort, threshold);
      if (diagnosis) logger.failure('SYSTEM', diagnosis);
    } catch {
      // diagnostic is best-effort — swallow so the notice path still proceeds
    }
  }

  const message = `claude-mem worker unreachable for ${next.consecutiveFailures} consecutive hooks.`;

  // Channel 1 (always): durable structured line in ~/.claude-mem/logs/.
  logger.failure('SYSTEM', message, {
    consecutiveFailures: next.consecutiveFailures,
    threshold,
    streakStartedAt: next.streakStartedAt,
  });

  // Channel 2 (rate-limited, all platforms incl. cursor/windsurf whose adapters
  // drop systemMessage): real stderr via the pinned bypass channel. NOT
  // emitBlockingError — that would exit(2), which is the whole bug.
  if (next.lastNoticeAt === 0 || (now - next.lastNoticeAt) > getNoticeCooldownMs()) {
    emitDiagnostic(`${message}\n`);
    writeHookFailureStateAtomic({ ...next, lastNoticeAt: now });
  }

  // Channel 3 (per turn) is the in-band banner, attached by hookCommand via
  // attachDegradedNotice() — see markWorkerDegraded() above.
  return next.consecutiveFailures;
}
```

#### 2f. Reset paths

- [ ] Replace `resetWorkerFailureCounter` (lines 711-715) with:

```ts
/**
 * #44 — exported. Pre-#44 this was module-private with exactly two call sites,
 * both AFTER a completed worker HTTP round-trip, so a fixed worker could leave a
 * stale streak armed indefinitely.
 */
export function resetWorkerFailureCounter(): void {
  clearWorkerDegraded();
  const state = readHookFailureState();
  if (state.consecutiveFailures === 0 && state.streakStartedAt === 0 && state.lastNoticeAt === 0) return;
  writeHookFailureStateAtomic({ ...EMPTY_FAILURE_STATE });
}
```

> Deliberately **no** `readWorkerFailureStreak()` accessor: Task 6 (`doctor`) reads the state file directly rather
> than importing `worker-utils`, so such an export would be dead code from the moment it lands. If a future caller
> needs one, add it then.

- [ ] Replace `ensureWorkerAliveOnce` (lines 532-536) with:

```ts
export async function ensureWorkerAliveOnce(): Promise<boolean> {
  if (aliveCache !== null) return aliveCache;
  aliveCache = await ensureWorkerRunning();
  // #44 reset path: a reachable worker clears the streak IMMEDIATELY, including
  // on hook paths that never issue a worker HTTP call (the Codex MCP context
  // path, context.ts:80-85). Pre-#44 the only reset was a completed round-trip,
  // so those paths could never clear a stale count.
  if (aliveCache) resetWorkerFailureCounter();
  return aliveCache;
}
```

- [ ] **Do NOT touch** the two existing `resetWorkerFailureCounter()` call sites at `:759` and `:776`.
  `tests/hook-lifecycle.test.ts:8-17` asserts the `:759` one appears *before* the `429 || >= 500` check inside the
  `if (!response.ok)` region. Moving or removing it breaks that test.

#### 2g. Verify

- [ ] `grep -n 'emitBlockingError\|process\.exit' src/shared/worker-utils.ts` → **no output**.
- [ ] `grep -n 'TELEMETRY_HOOK_TYPES' src/shared/worker-utils.ts` → still the original closed 5, unmodified.

---

### Task 3: `src/shared/SettingsDefaultsManager.ts` — register the two new keys

**Fork-owned (+14/−0) — free to edit.**

- [ ] In the `SettingsDefaults` interface, immediately **after** the existing
  `CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: string;` line (~:47), insert:

```ts
  CLAUDE_MEM_HOOK_FAIL_DECAY_MINUTES: string;
  CLAUDE_MEM_HOOK_NOTICE_COOLDOWN_MINUTES: string;
```

- [ ] In the `DEFAULTS` object, replace line ~147:

```ts
    CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '3',  // Plan 05 Phase 8 — escalate to exit code 2 after N consecutive worker-unreachable hook invocations
```

with:

```ts
    CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '3',  // #44 — consecutive worker-unreachable hooks before the degraded NOTICE surfaces. 0 = notices off. NEVER escalates to a non-zero exit code (it used to exit 2, which blocked prompts).
    CLAUDE_MEM_HOOK_FAIL_DECAY_MINUTES: '30',  // #44 — a streak whose last failure is older than this decays to zero, so a stale count cannot arm the first failure of a new session
    CLAUDE_MEM_HOOK_NOTICE_COOLDOWN_MINUTES: '10',  // #44 — minimum gap between raw-stderr degraded diagnostics; the per-turn in-band banner is not rate-limited
```

- [ ] No Settings-UI / `/api/settings` allow-list change is needed — these are hook-read-only keys resolved via
  `loadFromFileOnce()`, and `getFailLoudThreshold` / `readMinutesSetting` already fall back to their in-code
  defaults if the key is absent.

---

### Task 4: `src/cli/hook-command.ts` — attach the notice at the single stdout funnel

> ⚠️ **This is one of the two deliberate upstream-owned edits.** It is the *minimal*-divergence choice: the
> alternative is attaching the notice inside each handler, and `context.ts`, `observation.ts`, `summarize.ts`,
> `file-edit.ts` and `file-context.ts` are **all five** byte-identical to upstream. `executeHookPipeline`'s
> `emitModelContext` call is the one funnel every handler on every platform passes through, and the only place
> that knows the raw `event` string. See spec §7.2.

#### 4a. Imports

- [ ] Extend the `hook-io` import (lines 7-13) with the buffer type:

```ts
import {
  installHookStderrBuffer,
  emitModelContext,
  emitBlockingError,
  exitGraceful,
  resetHookIoState,
  type HookStderrBuffer,
} from '../shared/hook-io.js';
```

- [ ] Add, after the `worker-utils` import block (line 18):

```ts
import { attachDegradedNotice, getWorkerDegraded } from '../shared/hook-degraded-notice.js';
```

#### 4b. `executeHookPipeline` (replaces lines 85-101)

- [ ] Replace with:

```ts
async function executeHookPipeline(
  adapter: ReturnType<typeof getPlatformAdapter>,
  handler: ReturnType<typeof getEventHandler>,
  platform: string,
  event: string,
  options: HookCommandOptions,
  stderrBuffer: HookStderrBuffer,
): Promise<number> {
  const rawInput = await readJsonFromStdin();
  const input = adapter.normalizeInput(rawInput);
  input.platform = platform;
  const result = await handler.execute(input);

  // #44 USER_HINT: when the worker is degraded, fold the notice into the result
  // on turn-boundary events. Pure — returns `result` unchanged when healthy, so
  // the happy path is byte-identical to pre-#44.
  const finalResult = attachDegradedNotice(event, result);

  // #44: flush BEFORE the stdout emit. emitBlockingError used to flush the
  // buffered diagnostics on its way out; exitGraceful DROPS them. Flushing here
  // recovers the operator context on the degraded path only — healthy runs still
  // drop (quiet-on-success / Windows Terminal tab management). Ordering matters:
  // nothing after emitModelContext may throw, or the worker-unavailable catch
  // branch below could double-emit (console.log EPIPE matches that predicate).
  if (getWorkerDegraded() !== null) {
    stderrBuffer.flush();
  }

  // MODEL_CONTEXT: the only stdout JSON emit, via the platform adapter.
  emitModelContext(adapter, finalResult);
  const exitCode = result.exitCode ?? HOOK_EXIT_CODES.SUCCESS;
  exitGraceful(options);
  return exitCode;
}
```

#### 4c. Call site (replaces line 125)

- [ ] Replace:

```ts
    return await executeHookPipeline(adapter, handler, platform, options);
```

with:

```ts
    return await executeHookPipeline(adapter, handler, platform, event, options, stderrBuffer);
```

#### 4d. The worker-unavailable catch branch (replaces lines 139-150)

- [ ] Replace with:

```ts
    if (isWorkerUnavailableError(error)) {
      logger.warn('HOOK', `Worker unavailable, skipping hook: ${error instanceof Error ? error.message : error}`);
      // EXIT_SIGNAL per CLAUDE.md: worker errors exit 0 — always. Pre-#44 these
      // two lines were DEAD past the fail-loud threshold, because
      // recordWorkerUnreachable() called emitBlockingError() -> exit(2). It now
      // returns normally, so this branch finally does what its comment claims.
      // Still awaited: it may send the one-shot hook_failed telemetry, and
      // exitGraceful below would kill a pending POST mid-flight.
      await recordWorkerUnreachable();
      // #44: this branch previously emitted NO stdout JSON at all, so a degraded
      // worker that made the handler THROW was completely invisible. Emit the
      // no-op envelope carrying the notice.
      if (getWorkerDegraded() !== null) {
        stderrBuffer.flush();
      }
      try {
        emitModelContext(adapter, attachDegradedNotice(event, buildNoOpResult(event)));
      } catch {
        // [ANTI-PATTERN IGNORED]: emitModelContext's double-emit guard is the
        // only thing that throws here, and it throwing means the stdout JSON
        // envelope was ALREADY written — there is nothing to recover and nothing
        // to log. Re-throwing would fall through to the generic branch below and
        // reintroduce the exit(2) this row exists to remove.
      }
      exitGraceful(options);
      return HOOK_EXIT_CODES.SUCCESS;
    }
```

#### 4e. Leave alone

- [ ] `setActiveHookType(event)` at line 107 — **unchanged** (spec §7.4).
- [ ] The generic error branch (lines 152-171) with its `captureCliEvent` + `emitBlockingError` —
  **unchanged**. An unrecoverable handler bug is still a blocking error; only the worker-unreachable path changes.

---

### Task 5: `src/services/worker-service.ts` — clear the streak when the operator fixes it

**Fork-owned (+77/−8) — free to edit.**

- [ ] Extend the existing import at line 8:

```ts
import { getWorkerPort, getWorkerHost, fetchWithTimeout, resolveWorkerScriptPath, resetWorkerFailureCounter } from '../shared/worker-utils.js';
```

- [ ] Replace the `case 'start'` block (~line 1065):

```ts
    case 'start': {
      const result = await ensureWorkerStarted(port);
      if (result === 'dead') {
        exitWithStatus('error', await describeStartFailure(port));
      } else {
        // #44: an operator who just fixed the worker must not inherit the streak
        // that accumulated while it was down. Pre-#44 the ONLY reset was a
        // completed hook HTTP round-trip, so `worker start` left the counter
        // armed and the next hook could surface a stale notice.
        resetWorkerFailureCounter();
        exitWithStatus('ready', result === 'warming' ? 'Worker started; still warming up' : undefined);
      }
      break;
    }
```

- [ ] In the `case 'restart'` block, inside the verified-handoff success path (~line 1112-1116), insert the reset
  immediately before `process.exit(0)`:

```ts
        const handoff = await verifyRestartedWorker(port, oldPid, packageVersion, getPlatformTimeout(30000));
        if (handoff.ok) {
          console.log(`Worker restart verified (pid: ${handoff.pid}, version: ${handoff.version})`);
          logger.info('SYSTEM', 'Worker restart verified', { pid: handoff.pid, version: handoff.version });
          // #44: same reset as `worker start` — a verified successor means the
          // outage is over.
          resetWorkerFailureCounter();
          process.exit(0);
        }
```

- [ ] Locate the **fallback** restart path's own success exit (the CLI-spawn branch that follows) and add the
  same `resetWorkerFailureCounter();` immediately before its successful `process.exit(0)`. Do **not** reset on any
  failure path — a failed restart must keep its streak.

---

### Task 6: `src/npx-cli/commands/doctor.ts` — read-only streak report  *(CUTTABLE)*

> ⚠️ **`doctor.ts` is upstream-identical.** This task is deliberately isolated so it can be dropped whole if Mark
> declines the divergence (open question **(d)**) without touching any other task. It is purely additive and
> **read-only** — it must never reset, honouring the file's own contract at `doctor.ts:3-4`
> (*"Read-only: it never mutates state"*).
>
> It reads the state file **directly** rather than importing `worker-utils.js`, deliberately: importing
> `worker-utils` would drag `spawnHidden`, the supervisor, `ProcessManager` and the telemetry client into a small
> read-only CLI. `doctor.ts` already imports `existsSync`, `readFileSync`, `join` and holds `dataDir`.

- [ ] Insert this block immediately after the "5. Worker health" `checks.push({...})` (line 116) and before the
  `// 6. Last recorded install error` comment:

```ts
  // 5b. Hook capture health (#44). Read-only: reports the worker-unreachable
  // streak so a degraded claude-mem is visible WITHOUT a database query — the
  // observability gap that let #41 run silently for 11 days. Never resets.
  const failureStatePath = join(dataDir, 'state', 'hook-failures.json');
  if (existsSync(failureStatePath)) {
    let streak = 0;
    let lastFailureAt = 0;
    try {
      const record = JSON.parse(readFileSync(failureStatePath, 'utf-8'));
      if (record && typeof record === 'object') {
        streak = typeof record.consecutiveFailures === 'number' ? record.consecutiveFailures : 0;
        lastFailureAt = typeof record.lastFailureAt === 'number' ? record.lastFailureAt : 0;
      }
    } catch {
      // corrupt state file — reported as a warn below via the zeroed values
    }
    if (streak > 0) {
      const ageMinutes = lastFailureAt > 0 ? Math.floor((Date.now() - lastFailureAt) / 60_000) : -1;
      const ageDetail = ageMinutes >= 0 ? `, last ${ageMinutes}m ago` : '';
      checks.push({
        name: 'Hook capture',
        status: 'warn',
        detail: `${streak} consecutive worker-unreachable hook(s)${ageDetail} — memory capture may be OFF. Fix: \`claude-mem worker start\``,
        required: false,
      });
    }
  }
```

- [ ] Confirm `doctor` still exits 0 when the only finding is this warn (`required: false`, so it cannot affect
  the exit code — matches the "Last install error" check's pattern).

---

### Task 7: Update the one contract test that genuinely breaks

**`tests/cli/hook-stream-discipline.test.ts` — upstream-identical. This is the second and last deliberate
upstream-owned edit, and it is an intentional contract change.**

The existing test at `:61-66` is a source-shape assertion that **pins the bug in place**: it requires
`src/shared/worker-utils.ts` to literally contain `emitBlockingError(`. After Task 2 it does not, so this test
fails by design.

- [ ] Replace **only** the `it(...)` at lines 61-66:

```ts
  it('worker-utils recordWorkerUnreachable routes through emitBlockingError (source contract)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
    // The fail-loud branch must NOT call process.stderr.write / process.exit directly.
    expect(src).toContain('emitBlockingError(');
    expect(src).not.toMatch(/process\.stderr\.write\(\s*\n\s*`claude-mem worker unreachable/);
  });
```

with:

```ts
  // #44 CONTRACT CHANGE (deliberate, see docs/superpowers/specs/2026-07-31-hook-fail-open-never-block-design.md).
  // The OLD contract required worker-utils to route the worker-unreachable
  // message through emitBlockingError(). That call ends in an unconditional
  // process.exit(2), which Claude Code reads as "operation blocked" — so a down
  // worker made the user unable to submit prompts at all (298-hook streak, P1).
  // The NEW contract is the inverse: the fail-loud counter must be LOUD and
  // NON-BLOCKING. emitBlockingError itself is unchanged and still correct for
  // the unrecoverable-handler-error path in hook-command.ts.
  it('worker-utils recordWorkerUnreachable is loud but NEVER blocks (source contract)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
    // It must not be able to end the process, by any route.
    expect(src).not.toContain('emitBlockingError(');
    expect(src).not.toContain('process.exit(');
    // It must still surface: the non-exiting bypass channel + the durable log
    // line + the in-band notice hand-off.
    expect(src).toContain('emitDiagnostic(');
    expect(src).toContain("logger.failure('SYSTEM'");
    expect(src).toContain('markWorkerDegraded(');
  });
```

- [ ] Leave the other four tests in this file untouched (`:40-59`, `:70-82`, `:86-97`, `:101-118`). They must
  stay green — `emitBlockingError` is **not** being removed, only unlinked from the fail-loud counter.
- [ ] **Do not touch** `tests/telemetry/scrub.test.ts`, `tests/cli/hook-io.test.ts`,
  `tests/infrastructure/worker-crashloop-signal.test.ts`, or `tests/hook-lifecycle.test.ts` — none of them
  changes behaviour under this design.

---

### Task 8: New regression suite — `tests/cli/hook-fail-open.test.ts`

Covers all five items from the required Test Plan plus the platform matrix and the off switch.

- [ ] Create `tests/cli/hook-fail-open.test.ts`:

```ts
// Queue #44 — the worker-unreachable path must never block a prompt.
//
// SAFETY: these tests exercise the on-disk failure counter, which lives at
// <DATA_DIR>/state/hook-failures.json and DEFAULTS TO THE DEVELOPER'S REAL
// ~/.claude-mem. DATA_DIR is a module-level const evaluated at import time
// (src/shared/paths.ts:38), so CLAUDE_MEM_DATA_DIR is set BEFORE the first
// dynamic import of worker-utils, and the override is asserted before anything
// is written. Never convert these to static top-level imports.
//
// We deliberately do NOT drive hookCommand(): readJsonFromStdin attaches stdin
// listeners that never end under the test runner and only resolve on a 30s
// safety timeout (stdin-reader.ts:36,82-92). Seam-level + source-contract
// assertions are deterministic, per the note in hook-stream-discipline.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), 'cmem-failopen-'));
process.env.CLAUDE_MEM_DATA_DIR = TMP_DATA_DIR;

const STATE_PATH = join(TMP_DATA_DIR, 'state', 'hook-failures.json');

// Threshold 3, decay 30m, cooldown 10m — written BEFORE the first
// loadFromFileOnce(), which caches once per process (hook-settings.ts:10-14).
mkdirSync(TMP_DATA_DIR, { recursive: true });
writeFileSync(
  join(TMP_DATA_DIR, 'settings.json'),
  JSON.stringify({
    CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '3',
    CLAUDE_MEM_HOOK_FAIL_DECAY_MINUTES: '30',
    CLAUDE_MEM_HOOK_NOTICE_COOLDOWN_MINUTES: '10',
  }),
  'utf-8',
);

type WorkerUtils = typeof import('../../src/shared/worker-utils.js');
type Notice = typeof import('../../src/shared/hook-degraded-notice.js');

let workerUtils: WorkerUtils;
let notice: Notice;

beforeAll(async () => {
  workerUtils = await import('../../src/shared/worker-utils.js');
  notice = await import('../../src/shared/hook-degraded-notice.js');
});

afterAll(() => {
  rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

function writeState(state: Record<string, number>): void {
  mkdirSync(join(TMP_DATA_DIR, 'state'), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state), 'utf-8');
}

function readState(): Record<string, number> {
  return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
}

beforeEach(() => {
  notice.clearWorkerDegraded();
  if (existsSync(STATE_PATH)) rmSync(STATE_PATH, { force: true });
});

describe('#44 SAFETY — the temp data dir override is actually in effect', () => {
  it('never touches the real ~/.claude-mem state file', async () => {
    const real = join(homedir(), '.claude-mem', 'state', 'hook-failures.json');
    expect(STATE_PATH).not.toBe(real);
    expect(STATE_PATH.startsWith(TMP_DATA_DIR)).toBe(true);
    await workerUtils.recordWorkerUnreachable();
    // Proof the module resolved the override, not the default: the write landed
    // in the temp dir.
    expect(existsSync(STATE_PATH)).toBe(true);
  });
});

describe('#44 (1) worker down -> the prompt still submits', () => {
  it('recordWorkerUnreachable RETURNS past the threshold instead of exiting', async () => {
    writeState({ consecutiveFailures: 297, lastFailureAt: Date.now(), streakStartedAt: Date.now(), lastNoticeAt: Date.now() });
    // Pre-#44 this call never returned: emitBlockingError -> process.exit(2).
    const streak = await workerUtils.recordWorkerUnreachable();
    expect(streak).toBe(298);
  });

  it('never exits and never throws across a long streak (the 298-hook scenario)', async () => {
    writeState({ consecutiveFailures: 0, lastFailureAt: 0, streakStartedAt: 0, lastNoticeAt: 0 });
    let last = 0;
    for (let i = 0; i < 500; i++) {
      last = await workerUtils.recordWorkerUnreachable();
    }
    expect(last).toBe(500);
    expect(readState().consecutiveFailures).toBe(500);
  });

  it('the hook-command worker-unavailable branch exits 0, not 2 (source contract)', () => {
    const src = readFileSync('src/cli/hook-command.ts', 'utf-8');
    const branch = src.slice(
      src.indexOf('if (isWorkerUnavailableError(error))'),
      src.indexOf('logger.error(\'HOOK\''),
    );
    expect(branch).toContain('exitGraceful(options)');
    expect(branch).toContain('HOOK_EXIT_CODES.SUCCESS');
    expect(branch).not.toContain('emitBlockingError');
    expect(branch).not.toContain('BLOCKING_ERROR');
  });
});

describe('#44 (2) the warning is visible', () => {
  const degraded = { streak: 14, sinceMs: Date.now() - 2 * 60 * 60 * 1000, threshold: 3 };

  it('attaches a systemMessage on turn-boundary events', () => {
    notice.markWorkerDegraded(degraded);
    for (const event of ['context', 'session-init', 'user-message']) {
      const out = notice.attachDegradedNotice(event, { continue: true, suppressOutput: true, exitCode: 0 });
      expect(out.systemMessage).toContain('worker unreachable');
      expect(out.systemMessage).toContain('memory capture is OFF');
      expect(out.systemMessage).toContain('was not blocked');
      expect(out.systemMessage).toContain('claude-mem worker start');
      // suppressOutput must not hide the warning on adapters that forward it.
      expect(out.suppressOutput).toBe(false);
    }
  });

  it('does NOT attach on background events (they fire many times per turn)', () => {
    notice.markWorkerDegraded(degraded);
    for (const event of ['observation', 'summarize', 'file-edit', 'file-context']) {
      const input = { continue: true, suppressOutput: true, exitCode: 0 };
      expect(notice.attachDegradedNotice(event, input)).toBe(input);
    }
  });

  it('is a no-op when healthy — the happy path is unchanged', () => {
    notice.clearWorkerDegraded();
    const input = { continue: true, suppressOutput: true, exitCode: 0 };
    expect(notice.attachDegradedNotice('session-init', input)).toBe(input);
  });

  it('prepends rather than replacing an existing systemMessage', () => {
    notice.markWorkerDegraded(degraded);
    const out = notice.attachDegradedNotice('user-message', { systemMessage: 'ORIGINAL BANNER', exitCode: 0 });
    expect(out.systemMessage).toContain('memory capture is OFF');
    expect(out.systemMessage).toContain('ORIGINAL BANNER');
    expect(out.systemMessage!.indexOf('memory capture is OFF'))
      .toBeLessThan(out.systemMessage!.indexOf('ORIGINAL BANNER'));
  });

  it('reaches the wire on every integration whose adapter forwards systemMessage', async () => {
    const { getPlatformAdapter } = await import('../../src/cli/adapters/index.js');
    notice.markWorkerDegraded(degraded);
    const result = notice.attachDegradedNotice('session-init', { continue: true, suppressOutput: true, exitCode: 0 });

    for (const platform of ['claude-code', 'codex', 'antigravity-cli']) {
      const out = getPlatformAdapter(platform).formatOutput(result) as Record<string, unknown>;
      expect(String(out.systemMessage)).toContain('memory capture is OFF');
    }

    // DOCUMENTED GAP (spec 5.5): cursor + windsurf formatOutput return
    // {continue} only and drop systemMessage. They still get the P1 fix (never
    // blocked) plus the log line and the stderr diagnostic. If this assertion
    // ever fails because an adapter started forwarding systemMessage, that is
    // GOOD NEWS — update the matrix above, do not silence it.
    for (const platform of ['cursor', 'windsurf']) {
      const out = getPlatformAdapter(platform).formatOutput(result) as Record<string, unknown>;
      expect(out.systemMessage).toBeUndefined();
      expect(out.continue).toBe(true);
    }
  });
});

describe('#44 (3) decay clears a stale streak', () => {
  it('expires a streak whose last failure is older than the decay window', async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    writeState({ consecutiveFailures: 298, lastFailureAt: twoHoursAgo, streakStartedAt: twoHoursAgo, lastNoticeAt: twoHoursAgo });
    const streak = await workerUtils.recordWorkerUnreachable();
    expect(streak).toBe(1);
    const state = readState();
    expect(state.consecutiveFailures).toBe(1);
    expect(state.streakStartedAt).toBeGreaterThan(twoHoursAgo);
  });

  it('does NOT expire a streak still inside the window', async () => {
    const oneMinuteAgo = Date.now() - 60 * 1000;
    writeState({ consecutiveFailures: 5, lastFailureAt: oneMinuteAgo, streakStartedAt: oneMinuteAgo, lastNoticeAt: 0 });
    expect(await workerUtils.recordWorkerUnreachable()).toBe(6);
  });

  it('lastFailureAt is now load-bearing (pre-#44 it was written and read by nothing)', () => {
    const src = readFileSync('src/shared/worker-utils.ts', 'utf-8');
    expect(src).toMatch(/now\s*-\s*previous\.lastFailureAt/);
  });
});

describe('#44 (4) reset paths work', () => {
  it('resetWorkerFailureCounter zeroes the file and clears in-process state', () => {
    writeState({ consecutiveFailures: 298, lastFailureAt: Date.now(), streakStartedAt: Date.now(), lastNoticeAt: Date.now() });
    notice.markWorkerDegraded({ streak: 298, sinceMs: Date.now(), threshold: 3 });
    workerUtils.resetWorkerFailureCounter();
    expect(readState().consecutiveFailures).toBe(0);
    expect(notice.getWorkerDegraded()).toBeNull();
  });

  it('a reachable worker resets the counter, including on non-HTTP hook paths', () => {
    const src = readFileSync('src/shared/worker-utils.ts', 'utf-8');
    const fn = src.slice(src.indexOf('export async function ensureWorkerAliveOnce'), src.indexOf('interface HookFailureState'));
    expect(fn).toContain('resetWorkerFailureCounter()');
  });

  it('`worker start` and a verified `worker restart` reset the counter', () => {
    const src = readFileSync('src/services/worker-service.ts', 'utf-8');
    expect(src).toContain('resetWorkerFailureCounter');
    const startCase = src.slice(src.indexOf("case 'start': {"), src.indexOf("case 'stop': {"));
    expect(startCase).toContain('resetWorkerFailureCounter()');
  });

  it('threshold 0 is a real off switch, not a silent fallback to 3', () => {
    const src = readFileSync('src/shared/worker-utils.ts', 'utf-8');
    expect(src).toContain('NOTICES_DISABLED');
    // The pre-#44 guard that made 0 mean 3 must be gone.
    expect(src).not.toContain('parsed >= 1');
  });
});

describe('#44 (5) REGRESSION — the counter can never again ratchet while blocking', () => {
  it('worker-utils cannot end the process by any route', () => {
    const src = readFileSync('src/shared/worker-utils.ts', 'utf-8');
    expect(src).not.toContain('emitBlockingError(');
    expect(src).not.toContain('process.exit(');
  });

  it('the graceful-degrade sentinel is reachable — recordWorkerUnreachable returns', () => {
    const src = readFileSync('src/shared/worker-utils.ts', 'utf-8');
    const fn = src.slice(
      src.indexOf('export async function recordWorkerUnreachable'),
      src.indexOf('export function resetWorkerFailureCounter'),
    );
    // Every exit from the function is a `return`, never a process exit.
    expect(fn).toContain('return next.consecutiveFailures;');
    expect(fn).not.toContain('process.exit');
    expect(fn).not.toContain('emitBlockingError');
  });

  it('does not widen the closed telemetry hook-type enum (spec 7.4)', () => {
    const src = readFileSync('src/shared/worker-utils.ts', 'utf-8');
    expect(src).toContain(
      "const TELEMETRY_HOOK_TYPES = ['context', 'session-init', 'observation', 'summarize', 'file-context'] as const;",
    );
  });

  it('adds no telemetry property (spec 7.3 — keeps scrub.ts and its 3 cross-references untouched)', () => {
    const src = readFileSync('src/shared/worker-utils.ts', 'utf-8');
    const call = src.slice(src.indexOf("captureCliEvent('hook_failed'"), src.indexOf('Crash-loop liveness'));
    expect(call).toContain('error_mode:');
    expect(call).toContain('consecutive_failures:');
    expect(call).toContain('threshold_tripped:');
    // exactly the four whitelisted keys — hook_type is conditional, the rest fixed
    expect(call.match(/^\s+\w+:/gm)?.length).toBeLessThanOrEqual(4);
  });
});
```

- [ ] Run it in isolation first: `bunx bun test tests/cli/hook-fail-open.test.ts`
- [ ] If any source-slice assertion is brittle against your final formatting, **fix the slice, not the
  behaviour** — and never weaken the two "cannot end the process" assertions.

---

### Task 9: Build, gate, typecheck

- [ ] `npx tsc --noEmit -p tsconfig.json` — clean.
- [ ] `npm run build-and-sync` — must end with the content-hash assertion passing.
- [ ] `npm run verify:plugin-delivery` — confirms the hooks resolve the build you just made.
- [ ] `npm run test:gate` — **the gate** (NOT raw `bun test`, per CLAUDE.md). Must be green with **no new
  entries** added to `tests/known-failures.json`. The gate's unexpected-pass ratchet also proves nothing was
  silently baselined.
- [ ] `git diff --name-only f5633c1f HEAD -- src/ tests/ docs/public/` and confirm the only newly-diverged
  upstream-owned files are the ones this plan names: `src/cli/hook-command.ts`,
  `tests/cli/hook-stream-discipline.test.ts`, and (if Task 6 was kept) `src/npx-cli/commands/doctor.ts`.
  **Anything else means stop and surface it.**

---

## Verification (before opening the PR)

- [ ] `grep -rn 'emitBlockingError' src/shared/worker-utils.ts` → empty.
- [ ] `grep -rn 'process.exit' src/shared/worker-utils.ts` → empty.
- [ ] `git diff f5633c1f HEAD --stat -- src/services/telemetry/scrub.ts src/npx-cli/commands/telemetry.ts docs/public/telemetry.mdx tests/telemetry/scrub.test.ts src/shared/hook-io.ts src/cli/adapters/ src/cli/handlers/` → **no new changes from this PR** in any of them.
- [ ] `git diff --stat -- src/build/hook-shell-template.ts scripts/build-hooks.js plugin/hooks/ plugin/.mcp.json` → **empty** (the drift assertion at `tests/infrastructure/plugin-distribution.test.ts:336-425` also proves this, but check it by hand — a template edit is the one change that would silently break all four integrations at once).
- [ ] `npm run test:gate` green, `tests/known-failures.json` byte-unchanged.

---

## Test Plan (live UAT — the actual acceptance criterion)

Run against the real Claude Code app. This is the only thing that proves the P1 is gone.

**Setup**

```bash
cat ~/.claude-mem/state/hook-failures.json 2>/dev/null   # note the current value
claude-mem worker stop
```

**1. Worker down -> the prompt still submits (the P1)**

- [ ] In a live Claude Code session with the worker stopped, submit **five** prompts in a row.
- [ ] **PASS:** all five submit and are answered. **FAIL:** any prompt is rejected / the session stalls.
- [ ] Repeat with the counter pre-poisoned to the observed failure value — the exact reported scenario:

```bash
mkdir -p ~/.claude-mem/state
echo '{"consecutiveFailures":298,"lastFailureAt":'"$(date +%s000)"'}' > ~/.claude-mem/state/hook-failures.json
```

  Submit another prompt. **PASS:** it submits. (Pre-fix this is the exact state that produced
  `claude-mem worker unreachable for 298 consecutive hooks.` and blocked everything.)

**2. The warning is visible**

- [ ] From the 3rd consecutive failure on, every prompt shows the banner: *"claude-mem: worker unreachable —
  memory capture is OFF … Your prompt was not blocked."*
- [ ] It appears **once per turn**, not once per tool call — run a prompt that triggers 10+ tool uses and confirm
  exactly one banner.
- [ ] `~/.claude-mem/logs/claude-mem-<today>.log` contains the `worker unreachable for N consecutive hooks`
  failure lines.

**3. Decay actually clears a stale streak**

```bash
echo '{"consecutiveFailures":298,"lastFailureAt":'"$(( ($(date +%s) - 7200) * 1000 ))"',"streakStartedAt":0,"lastNoticeAt":0}' > ~/.claude-mem/state/hook-failures.json
```

- [ ] Submit one prompt with the worker still down.
- [ ] **PASS:** `hook-failures.json` now reads `consecutiveFailures: 1` (not 299) and **no banner appears** (1 < 3).

**4. The reset path works**

```bash
claude-mem worker start
cat ~/.claude-mem/state/hook-failures.json
```

- [ ] **PASS:** `consecutiveFailures` is `0` immediately after `worker start`, without waiting for a hook.
- [ ] Submit a prompt: no banner, memory capture resumes, `observations` grows.
- [ ] If Task 6 shipped: `npx claude-mem doctor` shows no "Hook capture" warn when healthy, and shows it (exit
  still 0) when a streak is present.

**5. Cross-integration spot check**

- [ ] With the worker stopped, submit a prompt in **Cursor** (whose `beforeSubmitPrompt` runs *two* hooks —
  `session-init` **and** `context`). **PASS:** the prompt submits. The banner is expected to be **absent** —
  documented gap, spec §5.5.
- [ ] If a Codex or Antigravity install is available, repeat: prompt submits, banner present.

**6. Off switch**

```bash
# add "CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD": "0" to ~/.claude-mem/settings.json
```

- [ ] **PASS:** with the worker down, prompts submit and **no** banner ever appears.

**Cleanup**

- [ ] Restore `~/.claude-mem/state/hook-failures.json` (or delete it — it is rebuilt on demand) and remove the
  test threshold override.

---

## Cross-references

- Spec: `docs/superpowers/specs/2026-07-31-hook-fail-open-never-block-design.md`
- Queue `#41` — the capture outage that is the entire reason the warning must stay LOUD.
- Queue `#40` — worker-restart orphan leak; a common source of the transient failures that seed a streak.
- Queue `#42` (dual-stack loopback bind) — **file-disjoint from this row** (`Server.ts`, `middleware.ts`,
  `HealthMonitor.ts`, `ProcessManager.ts`, `env-sanitizer.ts` vs. this row's `worker-utils.ts`,
  `hook-command.ts`, `worker-service.ts` CLI cases). #42's row sequences itself *after* this one; it also
  records an open question (e) asking whether the hook fail-open fix would collide on ID `#42` — **it did, and
  the reconciliation is this row taking `#44`.** #42 keeps its number; nothing needs to move.
- `CLAUDE.md` — test gate (`npm run test:gate`), build-and-sync content-hash assertion, plugin-root resolution.
- ADR 0002 §9 — upstream-vs-fork ownership and the accepted cost of divergence.

## Queue

Row **#44** in `docs/BUILDER_QUEUE.md`, marked **[P1]**.
