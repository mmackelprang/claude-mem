# Design: the worker-unreachable hook must never block a prompt

**Status:** Approved for planning · **Date:** 2026-07-31 · **Owner:** Planner
**Severity:** **P1** — a healthy Claude Code session becomes unusable (the user cannot submit prompts at all)
whenever the claude-mem worker is down.
**Reported by:** Mark, 2026-07-31 — observed live: `claude-mem worker unreachable for 298 consecutive hooks.`
**Adjacent to:** Queue `#41` (capture outage — the reason the warning must stay LOUD) and `#40`
(worker-restart lifecycle — a common source of the transient failures that seed the streak).

> **Planner note on process.** The behaviour was decided by Mark before this spec was written (§4) and the root
> cause was already investigated, so this ran as a single non-interactive pass rather than the usual
> one-question-at-a-time brainstorm. Every judgement call that would normally have been a question is recorded in
> **§9 Assumptions** or **§10 Open questions**. Nothing in §9 blocks Builder; §10 is mirrored into the queue row.
>
> **Two corrections to the originating brief are recorded in §7.3 and §7.4** — one file the brief expected to
> change does **not** need to, and one enum the brief flagged as a hazard is **structurally avoided**. Read §7
> before touching telemetry.

---

## 1. Problem

When the claude-mem worker is unreachable, `recordWorkerUnreachable()` calls `emitBlockingError()`, which does an
unconditional `process.exit(2)`. Claude Code's hook contract reads exit 2 as **"operation blocked"**. On
`UserPromptSubmit` that means the user's prompt is rejected — **the session cannot proceed at all**, mid-work,
until the user notices, diagnoses a memory plugin, and restarts a background daemon.

A memory plugin that is unable to record a session must not be able to *end* one. The blast radius of "claude-mem
is degraded" should be "claude-mem is degraded", never "you can no longer type".

### 1.1 The fail-open machinery already exists and is already honored — it is simply unreachable

Every one of the seven handlers already implements graceful degradation for the worker-unreachable sentinel:

| Handler | Fallback site | Behaviour |
|---|---|---|
| `session-init` | `session-init.ts:126-128` | `{continue, suppressOutput, exitCode: SUCCESS}` |
| `context` | `context.ts:91` | returns `emptyResult` |
| `observation` | `observation.ts:33` | `{continue, suppressOutput, exitCode: SUCCESS}` |
| `summarize` | `summarize.ts:147` | `{continue, suppressOutput, exitCode: SUCCESS}` |
| `file-edit` | `file-edit.ts:44` | `{continue, suppressOutput, exitCode: SUCCESS}` |
| `file-context` | `file-context.ts:233` | returns `null` |
| `user-message` | `user-message.ts:42` | `{exitCode: SUCCESS}` |

The sentinel that feeds all seven is produced at `src/shared/worker-utils.ts:741-745`:

```ts
const alive = await ensureWorkerAliveOnce();
if (!alive) {
  await recordWorkerUnreachable();   // ← exits(2) past the threshold
  return { continue: true, reason: 'worker_unreachable', [WORKER_FALLBACK_BRAND]: true };  // ← DEAD CODE
}
```

`recordWorkerUnreachable()` is `await`ed **one line before** the sentinel is returned. Past the threshold it never
returns. **Seven correct fallback paths are unreachable because of one `process.exit(2)`.**

The same poisoning kills the second fail-open site, `src/cli/hook-command.ts:139-150`: the
`isWorkerUnavailableError` branch logs, awaits `recordWorkerUnreachable()`, and *then* calls
`exitGraceful(options)` — lines 148-149 are dead past the threshold, so the branch whose entire purpose is
"transient worker errors exit 0" exits 2 instead.

### 1.2 Three aggravating factors turned 3 real failures into 298

1. **The gate is `>=`, not `===`** (`worker-utils.ts:669`). Every hook past the threshold both blocks *and*
   increments. Each blocked prompt is itself a hook invocation, so the counter feeds itself: **3 genuine failures +
   295 self-inflicted = 298.** The counter is a ratchet with no pawl.
2. **There is no decay.** The state file `~/.claude-mem/state/hook-failures.json` has shape
   `{consecutiveFailures, lastFailureAt}` (`:538-541`). `lastFailureAt` is written (`:664`) and parsed
   (`:559-560`) — and **read by no logic anywhere in the codebase**. There is no TTL, no window, no backoff. A
   streak from last week is indistinguishable from a streak from this second.
3. **The only reset is a successful worker HTTP round-trip.** `resetWorkerFailureCounter()` (`:711-715`) is
   module-private with exactly two call sites (`:759`, `:776`), both inside `executeWithWorkerFallback` *after* a
   response arrives. There is no `doctor` reset, no CLI reset, no worker-start reset. If the worker is fixed but
   the next hook takes a path that never issues worker HTTP (e.g. the Codex MCP context path), the stale count
   survives.
4. **There is no off switch.** `getFailLoudThreshold()` (`:594-604`) guards `parsed >= 1`, so setting
   `CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD=0` silently falls back to the default `3`
   (`FAIL_LOUD_DEFAULT_THRESHOLD`, `:543`; key declared at `SettingsDefaultsManager.ts:47,147`). A user hitting
   this bug cannot turn it off.

Factors 2–4 mean that even after the blocking is removed, a stale streak would keep a **warning** pinned on
forever. All four must be fixed together or the fix is half a fix.

### 1.3 Blast radius: four integrations, not one

`UserPromptSubmit`-equivalent hooks across the shipped integrations:

| Integration | Prompt-gating hook | Internal event(s) | Source |
|---|---|---|---|
| Claude Code | `UserPromptSubmit` | `session-init` | `plugin/hooks/hooks.json` |
| Codex | `UserPromptSubmit` | `session-init` | `plugin/hooks/codex-hooks.json`; the Windows shell variant propagates the child exit code **verbatim** (`hook-shell-template.ts:229-264`) |
| Cursor | `beforeSubmitPrompt` | **`session-init` AND `context`** — two hooks per prompt | `CursorHooksInstaller.ts:147-166` |
| Antigravity | `BeforeAgent` | `session-init` | `AntigravityCliHooksInstaller.ts:66-74` |

Cursor runs **two** hooks on every prompt submit, so it hits the ratchet twice as fast as everyone else.

---

## 2. Root cause

One line: `src/shared/hook-io.ts:138-147`.

```ts
export function emitBlockingError(msg: string, options: ExitOptions = {}): void {
  if (bufferedChunks && bufferedChunks.length > 0) { bypassWrite(bufferedChunks.join('')); bufferedChunks = []; }
  bypassWrite(msg.endsWith('\n') ? msg : `${msg}\n`);
  if (!options.skipExit) {
    process.exit(2);          // ← unconditional
  }
}
```

`skipExit` is documented as *"the test seam that mirrors `HookCommandOptions.skipExit`"* — it is not a production
control. So `emitBlockingError` is, by construction, "surface **and** block". The fail-loud counter at
`worker-utils.ts:704-706` calls it, and therefore inherits the block it never wanted:

```ts
emitBlockingError(
  `claude-mem worker unreachable for ${next.consecutiveFailures} consecutive hooks.`
);
```

**The intent was "make the outage loud". The implementation conflated loud with fatal.**

---

## 3. The design tension this fix must not resolve by deleting

Fail-loud exists for a reason, and the reason is currently an open P1 of its own. Queue **#41** is an **11-day
capture outage that nobody noticed** — claude-mem silently stopped recording and the only reason anyone found out
was a manual database query eleven days later.

So the fix has two hard requirements that pull against each other:

- **R1 — never block.** No hook may return a non-zero exit code on the worker-unreachable path.
- **R2 — stay loud.** A degraded claude-mem must remain continuously visible to the human, every turn, for as long
  as it is degraded.

Deleting the warning satisfies R1 and re-creates #41. Keeping `exit(2)` satisfies R2 and is the bug. **The fix is
to change the channel, not the volume.**

---

## 4. Decided behaviour (Mark, 2026-07-31 — not re-litigated here)

> **Never block prompt-gating hooks; warn in-band.**
> - 1st–2nd consecutive failure → exit 0, silent (transient).
> - 3rd+ consecutive failure → **exit 0, ALWAYS** — plus a visible warning injected into the session context, so
>   the outage is visible every turn without ever blocking the prompt.
> - **Add decay + a reset path** — this is what let 3 failures become 298.

This spec designs *how*, not *whether*.

---

## 5. Design decision: where the in-band warning surfaces

This is the load-bearing decision of the whole change and it is stated here explicitly, because the codebase offers
several channels and most of them are wrong.

### 5.1 What each channel actually does (verified against every adapter)

`HookResult` (`src/cli/types.ts:22-36`) offers two model-/user-bound fields. What reaches the surface depends
entirely on `PlatformAdapter.formatOutput`, and the adapters differ sharply:

| Adapter | `systemMessage` | `hookSpecificOutput.additionalContext` | Source |
|---|---|---|---|
| `claude-code` | **passed through, unconditionally** | only when the handler already set `hookSpecificOutput` | `claude-code.ts:27-41` |
| `codex` | **passed through** (`buildBaseOutput`) | only for a recognized non-`Stop` event | `codex.ts:46-53, 105-137` |
| `antigravity-cli` | **passed through** (ANSI-stripped) | passed through | `antigravity-cli.ts:58-79` |
| `raw` | passed through (identity) | passed through | `raw.ts:23-25` |
| **`cursor`** | **DROPPED** — returns `{continue}` only | **DROPPED** | `cursor.ts:54-56` |
| **`windsurf`** | **DROPPED** — returns `{continue}` only | **DROPPED** | `windsurf.ts:68-70` |

A third channel exists and is platform-independent: `emitDiagnostic()` (`hook-io.ts:105-107`) writes to **real**
stderr through the pinned bypass channel, escaping the hook stderr buffer. A fourth is `logger.failure()`, which
writes a structured line to `~/.claude-mem/logs/claude-mem-<date>.log` and **no console** (`logger.ts:373` →
`error()` → file only).

### 5.2 Decision

> **Primary channel: `HookResult.systemMessage`, attached only on turn-boundary hooks
> (`context`, `session-init`, `user-message`).**
> **Secondary, always-on channels: `logger.failure()` to the log file (every degraded hook), and a
> cooldown-rate-limited `emitDiagnostic()` to real stderr (all platforms, including the two that drop
> `systemMessage`).**
> **Explicitly NOT `hookSpecificOutput.additionalContext`.**

### 5.3 Why `systemMessage` and not `additionalContext`

1. **The human is the only actor who can fix this.** Restarting a background daemon is not something the model can
   do, and #41's failure mode is *a human not noticing*. `systemMessage` is the codebase's declared USER_HINT
   channel (`hook-io.ts:13`, `context.ts:1-3`); `additionalContext` is the declared MODEL_CONTEXT channel. The
   warning is addressed to the human, so it belongs on the human's channel.
2. **`additionalContext` would burn model context every turn, forever.** A degraded worker can stay degraded for
   days. Injecting a warning into the model's context on every `UserPromptSubmit` is an unbounded, permanent token
   tax on a condition the model cannot act on.
3. **It would actively derail work.** A model told "memory capture is OFF" on every single turn will eventually
   stop doing the user's task and start trying to fix claude-mem. The old `exit 2` behaviour was *already*
   model-facing (stderr on exit 2 is fed to the model) and hijacking the session is precisely the complaint.
4. **It is not a uniform channel.** Only `context` (and `session-init` on some platforms) produce a
   `hookSpecificOutput` envelope at all; the claude-code adapter emits the key only when the handler set it
   (`claude-code.ts:29`). Attaching the notice there would surface on some events and vanish on others, for
   reasons invisible to the user. `systemMessage` is emitted by the claude-code adapter unconditionally.
5. **Zero adapter changes.** Four of six adapters already forward `systemMessage` with no edit — and all four
   named integrations in §1.3 use one of those four (`claude-code`, `codex`, `antigravity-cli`) or are covered by
   §5.5 (`cursor`).

### 5.4 Why turn-boundary hooks only

Mark's requirement is "visible **every turn**". `observation` fires on **every PostToolUse** — dozens to hundreds
of times per turn. A `systemMessage` on those would emit the same banner after every file read. The turn-boundary
set (`context` = session start, `session-init` = prompt submit, `user-message` = prompt submit on platforms wired
that way) fires **exactly once per turn**, which is precisely the requested cadence.

Background hooks (`observation`, `summarize`, `file-edit`, `file-context`) still exit 0, still record the failure,
still feed decay, and still write the log line — they just do not paint a banner.

**This eligibility test keys on the raw `event` string that `hookCommand(platform, event)` already receives**
(`hook-command.ts:103`) — see §7.4 for why that matters.

### 5.5 Known, accepted gap: Cursor and Windsurf

`cursorAdapter.formatOutput` and `windsurfAdapter.formatOutput` return `{ continue }` and discard everything else.
Those two platforms **cannot** receive an in-band notice without an adapter change.

**They still get the entire P1 fix** — their prompts are no longer blocked, which is the bug. They also get the
log-file line and the stderr diagnostic. They do not get the banner.

Passing `systemMessage` through the Cursor adapter is deliberately **out of scope**: `cursor.ts` is byte-identical
to upstream (§7.1), Cursor's accepted output-key contract is unverified, and shipping a speculative key into a
prompt-gating hook is the same class of risk this row exists to remove. Recorded as open question **(c)**.

### 5.6 Notice text

One line, plus the fix. Must name the state, the duration, the fact that nothing was blocked, and the remedy:

```
⚠️  claude-mem: worker unreachable — memory capture is OFF
   (14 consecutive hooks over 2h 13m). Your prompt was not blocked.
   Fix: `claude-mem worker start`
   Logs: ~/.claude-mem/logs/claude-mem-2026-07-31.log
```

"Your prompt was not blocked" is not filler — it is what stops a user who remembers the old behaviour from
assuming the session is broken again.

Duration is rendered as **elapsed** (`over 2h 13m`), not as a wall-clock start time: the hook process, the log
files and the database disagree about timezone (`#41` lost hours to exactly that — logs UTC−4, DB UTC), and
elapsed time is unambiguous everywhere.

---

## 6. Fix shape (detail lives in the plan)

Four coordinated changes. **F1 is the bug fix; F2–F4 are what stop it from regressing into either failure mode.**

### F1 — Never block

`recordWorkerUnreachable()` stops calling `emitBlockingError()`. In its place, past the threshold it:

- calls a new fork-owned `markWorkerDegraded({streak, since, threshold})`, which records the condition in-process;
- writes the durable `logger.failure('SYSTEM', …)` line;
- writes a **cooldown-rate-limited** `emitDiagnostic()` line to real stderr (all platforms; default one per
  10 min so a 300-hook streak does not produce 300 stderr lines).

It then **returns normally**, which makes `worker-utils.ts:744` and `hook-command.ts:148-149` reachable for the
first time. The existing one-shot `=== threshold` telemetry and the `buildCrashLoopDiagnosis` orphan-socket hint
are preserved verbatim.

### F2 — Warn in-band

`hookCommand` threads `event` into `executeHookPipeline` and applies a pure
`attachDegradedNotice(event, result)` immediately before `emitModelContext`:

- not degraded → returns `result` **unchanged** (byte-identical happy path, no behaviour change when healthy);
- degraded and `event ∈ {context, session-init, user-message}` → returns `{...result, systemMessage: <notice>}`,
  prepended to any existing `systemMessage` rather than replacing it (the `user-message` banner and the `context`
  colored timeline must survive);
- degraded and any other event → returns `result` unchanged.

The `isWorkerUnavailableError` catch branch (`hook-command.ts:139-150`) gains the same treatment: it currently
emits **no stdout JSON at all** when the handler throws, so it emits
`attachDegradedNotice(event, buildNoOpResult(event))` before `exitGraceful`. Also, when degraded, the stderr
buffer is **flushed** rather than dropped — recovering the operator context that `emitBlockingError` used to flush
on its way out.

### F3 — Decay

State shape becomes `{consecutiveFailures, lastFailureAt, streakStartedAt}`. The added field is backward
compatible: `parseHookFailureState` already defaults missing numeric fields to `0`, and a `0` `streakStartedAt` is
treated as "unknown, use `lastFailureAt`".

On every `recordWorkerUnreachable()`, if `now - lastFailureAt > decayMs` the prior streak is **expired** and a
fresh streak starts at 1. Default window: `CLAUDE_MEM_HOOK_FAIL_DECAY_MINUTES = 30`. This finally makes
`lastFailureAt` load-bearing.

Decay is what makes a stale 298 harmless: the day after an outage, the first failure starts a new streak at 1
instead of arriving pre-armed at 299.

### F4 — Reset paths + an off switch

- `resetWorkerFailureCounter()` becomes **exported**.
- Called additionally from `ensureWorkerAliveOnce()` when the worker **is** alive — this covers every hook,
  including paths that never issue worker HTTP (the Codex MCP context path). The two existing HTTP-round-trip
  sites stay exactly where they are (`tests/hook-lifecycle.test.ts:8-17` asserts the ordering of the `:759` one).
- Called from `worker start` / `worker restart` success in `worker-service.ts` — "I fixed it" clears the streak
  immediately rather than on the next hook.
- `getFailLoudThreshold()` accepts `0` as an explicit **notices-disabled** value (currently `parsed >= 1` makes
  `0` silently mean `3`). The counter keeps tracking; nothing ever surfaces.
- **`doctor` gains a read-only report** of the streak — it must not reset (the file's own contract is
  *"Read-only: it never mutates state"*, `doctor.ts:3-4`), but a degraded claude-mem showing up in
  `npx claude-mem doctor` is exactly the observability #41 wished it had. See open question **(d)** — this is the
  one piece with a real ownership cost.

---

## 7. Ownership, blast radius, and two corrections to the brief

### 7.1 Upstream-vs-fork ledger (verified: `git diff --name-only f5633c1f HEAD -- <file>`)

| File | Owner | Edited? |
|---|---|---|
| `src/shared/worker-utils.ts` | **fork** (+39/−0) | ✅ free |
| `src/services/worker-service.ts` | **fork** (+77/−8) | ✅ free |
| `src/shared/SettingsDefaultsManager.ts` | **fork** (+14/−0) | ✅ free |
| `src/shared/hook-degraded-notice.ts` | **new fork file** | ✅ create |
| `tests/cli/hook-fail-open.test.ts` | **new fork file** | ✅ create |
| `src/cli/hook-command.ts` | **upstream-identical** | ⚠️ **1 deliberate divergence — unavoidable, see §7.2** |
| `tests/cli/hook-stream-discipline.test.ts` | **upstream-identical** | ⚠️ **1 `it()` rewritten — intentional contract change, see §7.3** |
| `src/shared/hook-io.ts` | upstream-identical | ❌ **no edit** — the existing `emitDiagnostic` export is exactly the non-exiting sibling the brief anticipated needing |
| `src/services/telemetry/scrub.ts` · `tests/telemetry/scrub.test.ts` · `src/npx-cli/commands/telemetry.ts` · `docs/public/telemetry.mdx` | upstream-identical | ❌ **no edit** — see §7.3 |
| `src/cli/adapters/*` | upstream-identical | ❌ no edit |
| all 7 handlers | mixed | ❌ no edit |
| `src/build/hook-shell-template.ts` · `scripts/build-hooks.js` · `plugin/hooks/*.json` · `plugin/.mcp.json` | drift-asserted (`plugin-distribution.test.ts:336-425`) | ❌ **no edit** |

**Net: two upstream-owned files touched — one source, one test.** Everything else is fork-owned or new.

### 7.2 Why `hook-command.ts` is the *minimal*-divergence choice, not a shortcut

The alternative to one edit in `hook-command.ts` is attaching the notice inside each handler. That would mean
editing `context.ts`, `observation.ts`, `summarize.ts`, `file-edit.ts` and `file-context.ts` — **all five are
byte-identical to upstream**. The single-site interception is strictly less divergence, strictly less duplicated
logic, and the only place that knows the raw `event` string. `executeHookPipeline`'s `emitModelContext` call
(`hook-command.ts:97`) is the one funnel every handler on every platform passes through.

### 7.3 Correction to the brief: `tests/telemetry/scrub.test.ts` does **not** need to change

The brief listed `scrub.test.ts:191,198` (`consecutive_failures` property shape) as a test that "WILL fail and
must be deliberately updated". **Under this design it will not fail, and it must not be touched.**

`scrubProperties` is a key **whitelist**. The test at `:187-201` asserts that the four hook-failure keys
(`hook_type`, `error_mode`, `consecutive_failures`, `threshold_tripped`) round-trip. This design:

- adds **zero** new telemetry properties,
- removes none,
- keeps the one-shot `=== threshold` emit and its exact payload verbatim.

`threshold_tripped: true` changes *meaning* (from "we escalated to exit 2" to "we surfaced a visible notice") but
not shape, and `docs/public/telemetry.mdx`'s wording — *"whether the fail-loud threshold was reached"* — remains
accurate.

**This is a constraint on Builder, not just an observation.** Adding any new telemetry property here (e.g. a
`notice_surfaced` or `decayed` flag) turns a 2-upstream-file change into a **4-site closed-enum widening**:
`scrub.ts:113` + `scrub.test.ts` + `npx-cli/commands/telemetry.ts:80` + `docs/public/telemetry.mdx`, all four
upstream-owned, all four cross-referenced by an in-source comment that says never to widen one without the
others. **Do not add a telemetry property.** The needed observability is delivered by the log line, the stderr
diagnostic, and the `doctor` report.

### 7.4 Correction to the brief: the `TELEMETRY_HOOK_TYPES` closed enum is structurally avoided

The brief flagged `worker-utils.ts:606-632` (`TELEMETRY_HOOK_TYPES` / `setActiveHookType`) as "the only place the
counter knows which hook it is under", with a ⚠️ on widening a closed 5-enum cross-referenced by three other
files, and noted `hook-command.ts:107` sets it to `null` for `user-message` and `file-edit`.

**That seam is not used by this design, and must not be widened.** Two independent reasons:

1. **Mark's decision is uniform.** "3rd+ consecutive failure → exit 0, **ALWAYS**". There is no per-event
   *severity*; every hook fails open identically. Per-event severity is what would have needed the enum.
2. **Notice eligibility (§5.4) is per-event, but it keys on the raw `event` parameter**, which
   `hookCommand(platform, event)` receives directly at `hook-command.ts:103` and which
   `executeHookPipeline` will now receive too. That string is the full 7-value handler set
   (`handlers/index.ts:13-20`) — including `user-message`, the very event the telemetry enum drops to `null`.

So the telemetry enum stays a closed 5, `setActiveHookType` is untouched, and `user-message` gets its notice
anyway. The hazard the brief correctly identified is real; the design routes around it.

### 7.5 The one test contract that genuinely breaks

`tests/cli/hook-stream-discipline.test.ts:61-66`:

```ts
it('worker-utils recordWorkerUnreachable routes through emitBlockingError (source contract)', () => {
  const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
  expect(src).toContain('emitBlockingError(');
  expect(src).not.toMatch(/process\.stderr\.write\(\s*\n\s*`claude-mem worker unreachable/);
});
```

This is a **source-shape assertion that pins the bug in place**. After F1, `worker-utils.ts` will not contain
`emitBlockingError(` at all, and this test will fail by design. It is rewritten in place to assert the *new*
contract — that the worker-unreachable path routes through the non-exiting notice and that `worker-utils.ts`
contains neither `emitBlockingError(` nor a bare `process.exit(`. The file's other four tests
(`:40-59`, `:70-82`, `:86-97`, `:101-118`) are untouched and must stay green: `emitBlockingError` itself is
**not** being removed — it remains the correct mechanism for the unrecoverable-handler-error path at
`hook-command.ts:167`.

`tests/cli/hook-io.test.ts` (which unit-tests `emitBlockingError` directly) and
`tests/infrastructure/worker-crashloop-signal.test.ts` (pure `buildCrashLoopDiagnosis`) are unaffected — neither
function changes signature or behaviour.

---

## 8. Options considered

### Option A — exit 1 instead of exit 2

Claude Code treats "other exit codes" as a **non-blocking** error and shows stderr to the user, which is almost
exactly the desired semantics with a one-character diff.

**Rejected.** (a) It violates Mark's explicit "exit 0, ALWAYS". (b) It is a Claude-Code-specific reading of a
contract three other integrations do not share; Cursor's `beforeSubmitPrompt` and Antigravity's `BeforeAgent`
treatment of non-zero exits is unverified, and the Codex Windows shell propagates the child code verbatim
(`hook-shell-template.ts:229-264`), so a wrong guess re-creates the P1 on another platform. (c) `CLAUDE.md`'s
standing exit-0-on-error policy exists to stop Windows Terminal tab accumulation; a non-zero exit re-opens it.
Recorded because it is the tempting one-line "fix" and Builder should know why it was passed over.

### Option B — delete the fail-loud escalation entirely

Simplest possible diff: drop the `emitBlockingError` call and ship.

**Rejected.** It satisfies R1 and re-creates #41 — an 11-day silent outage. The originating brief is explicit:
*"Do not simply delete the warning."*

### Option C — add a non-exiting sibling to `hook-io.ts` (`emitNonBlockingWarning`)

The brief anticipated this ("likely needs a non-exiting sibling").

**Not needed.** `emitDiagnostic()` (`hook-io.ts:105-107`) already **is** that sibling: it is the declared
DIAGNOSTIC intent, it writes through the same pinned bypass channel, and it does not exit. The only capability
`emitBlockingError` had that it lacks is flushing the buffered chunks — and `hookCommand` holds the
`HookStderrBuffer` handle directly (`hook-command.ts:119`), so it can call `.flush()` itself on the degraded path.
**This removes `hook-io.ts` from the change surface entirely**, saving one upstream-owned file.

### Option D — never-block + in-band notice + decay + reset *(recommended, = §6)*

Satisfies R1 and R2, fixes all four aggravating factors, touches two upstream-owned files, adds zero telemetry
properties, widens no closed enum, and leaves the hook shell template, all six adapters, and all seven handlers
untouched.

---

## 9. Assumptions (made without Mark, because this ran non-interactively)

1. **"exit 0, ALWAYS" means all seven hooks, not just prompt-gating ones.** The section header says "prompt-gating"
   but the rule says "ALWAYS", and a blocking `PostToolUse` is a bad outcome in its own right. Uniform fail-open is
   also what makes §7.4 possible. Mirrored as open question (a).
2. **30 minutes is a sane default decay window.** Long enough that a genuinely-down worker keeps its streak across
   a slow turn; short enough that yesterday's outage cannot arm today's first failure. Configurable.
3. **10 minutes is a sane stderr-diagnostic cooldown.** The banner is per-turn; the raw stderr line does not need
   to be.
4. **The notice belongs on `context` as well as `session-init`.** `context` is SessionStart — a user resuming into
   a degraded worker should learn that at session start, not one prompt later. It is also half of Cursor's
   `beforeSubmitPrompt` pair.
5. **Prepending, not replacing, an existing `systemMessage` is correct.** `user-message` returns a rich banner and
   `context` may return a colored timeline; the notice must not eat them.
6. **`buildCrashLoopDiagnosis`'s one-shot `=== threshold` emit stays one-shot.** It is a heavy path (it probes the
   port). The repeating channel is the per-turn banner.

---

## 10. Open questions (for Mark — recorded, non-blocking; Planner's recommendation on each)

**(a) Uniform fail-open, or prompt-gating hooks only?** This design never blocks on any of the seven hooks.
*Rec: uniform.* A blocking `PostToolUse` on a degraded memory plugin is also wrong, and uniformity is what lets the
fix avoid widening the telemetry enum (§7.4). If you want `observation`/`summarize` to keep escalating, say so —
it is a small change to F1 but it re-introduces the enum question.

**(b) Should the notice repeat every turn for the entire outage, or back off?** As designed it repeats on every
turn-boundary hook for as long as the worker is down — which is literally what you asked for, and is the direct
antidote to #41. The counter-argument is banner fatigue on a multi-day outage.
*Rec: repeat every turn, no back-off.* #41 is the more expensive failure mode, and the notice carries a one-command
fix. Revisit if it proves annoying.

**(c) Should the Cursor adapter be taught to forward `systemMessage`?** Cursor is the only named integration that
runs **two** prompt-gating hooks and it currently drops all output except `{continue}` (§5.5).
*Rec: not in this row.* `cursor.ts` is upstream-identical, Cursor's accepted output keys are unverified, and this
row's job is to stop blocking. File as a separate small row if you want Cursor parity on the banner.

**(d) May Builder add a read-only streak check to `npx claude-mem doctor`?** `doctor.ts` is **upstream-identical**,
so this costs one more file of permanent fork divergence (ADR 0002 §9's accepted cost). It is genuinely valuable —
it is the only place a human can ask "is claude-mem actually capturing?" without a DB query, which is exactly #41's
gap.
*Rec: yes, include it* — it is ~15 lines, purely additive, read-only (never resets, honouring `doctor.ts:3-4`), and
the observability is the point of the whole R2 half. If you would rather hold the line on divergence, drop it: the
log line and stderr diagnostic still ship, and the plan isolates it as its own task so it can be cut without
touching anything else.

**(e) Should `hook-failures.json` gain the notice-cooldown timestamp, or should the cooldown be in-process only?**
As designed it is persisted (`lastNoticeAt`) so the cooldown survives across the short-lived hook processes — an
in-process cooldown would be useless, since every hook is a fresh process.
*Rec: persist it* (already the design); flagged only because it grows the on-disk state shape a second time.

---

## 11. Invariant this design protects

> **A claude-mem hook may degrade the session's memory. It may never degrade the session.**
>
> Concretely: on the worker-unreachable path, every hook, on every platform, at every streak length, exits 0.
> The regression test in the plan asserts this as a source-and-behaviour contract, so no future "make it loud"
> change can re-acquire the ability to block.

---

## 12. Explicitly out of scope

- **Fixing why the worker is unreachable.** That is #40 (orphan leak / restart lifecycle) and #41 (capture
  outage). This row makes the *symptom* survivable; it does not chase the cause.
- **`hook-io.ts`'s `emitBlockingError`.** It stays exactly as it is and remains correct for the
  unrecoverable-handler-error path (`hook-command.ts:167`). Only the fail-loud counter stops calling it.
- **The hook shell template and anything under the byte-for-byte drift assertion.** Fail-open needs none of it.
- **Cursor/Windsurf adapter output parity** (§5.5, open question (c)).
- **Any telemetry schema change** (§7.3).
- **Server/`server-beta` runtime paths.** This is the local-worker hook path only.
