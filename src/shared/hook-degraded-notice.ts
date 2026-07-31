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
