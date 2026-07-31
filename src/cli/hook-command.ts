import { readJsonFromStdin } from './stdin-reader.js';
import { getPlatformAdapter } from './adapters/index.js';
import { AdapterRejectedInput } from './adapters/errors.js';
import { getEventHandler } from './handlers/index.js';
import type { HookResult } from './types.js';
import { HOOK_EXIT_CODES } from '../shared/hook-constants.js';
import {
  installHookStderrBuffer,
  emitModelContext,
  emitBlockingError,
  exitGraceful,
  resetHookIoState,
  type HookStderrBuffer,
} from '../shared/hook-io.js';
import {
  recordWorkerUnreachable,
  setActiveHookType,
  getActiveHookType,
} from '../shared/worker-utils.js';
import { attachDegradedNotice, getWorkerDegraded } from '../shared/hook-degraded-notice.js';
import { captureCliEvent } from '../services/telemetry/cli-telemetry.js';
import { logger } from '../utils/logger.js';

export interface HookCommandOptions {
  skipExit?: boolean;
}

/**
 * No-op result for hooks that must exit before their handler ran (adapter
 * rejected input, transcript path missing). `context` is the sole handler
 * key that produces SessionStart output on every platform; a bare
 * `{continue:true}` fallback for it — with no hookSpecificOutput — is what
 * Codex's strict SessionStart validator rejects as "invalid session start
 * JSON output" (issue #2972). Attaching the minimal valid payload keeps the
 * no-op harmless everywhere else too.
 */
export function buildNoOpResult(event: string): HookResult {
  const result: HookResult = { continue: true, suppressOutput: true };
  if (event === 'context') {
    result.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: '' };
  }
  return result;
}

export function isWorkerUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  const transportPatterns = [
    'econnrefused',
    'econnreset',
    'epipe',
    'etimedout',
    'enotfound',
    'econnaborted',
    'enetunreach',
    'ehostunreach',
    'fetch failed',
    'unable to connect',
    'socket hang up',
  ];
  if (transportPatterns.some(p => lower.includes(p))) return true;

  if (lower.includes('timed out') || lower.includes('timeout')) return true;

  if (/failed:\s*5\d{2}/.test(message) || /status[:\s]+5\d{2}/.test(message)) return true;

  if (/failed:\s*429/.test(message) || /status[:\s]+429/.test(message)) return true;

  if (/failed:\s*4\d{2}/.test(message) || /status[:\s]+4\d{2}/.test(message)) return false;

  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
    return false;
  }

  return false;
}

export function isNonBlockingHookInputError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  return lower.includes('transcript path') &&
    (lower.includes('missing') || lower.includes('does not exist'));
}

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
  const exitCode = finalResult.exitCode ?? HOOK_EXIT_CODES.SUCCESS;
  exitGraceful(options);
  return exitCode;
}

export async function hookCommand(platform: string, event: string, options: HookCommandOptions = {}): Promise<number> {
  resetHookIoState();
  // Register the hook event for the threshold-gated hook_failed telemetry
  // (closed enum enforced inside; non-enum events just omit hook_type).
  setActiveHookType(event);

  // Hook IO Discipline (issue #2292):
  // We BUFFER stderr during handler execution so that unsolicited writes from
  // third-party libraries don't leak into model context. The buffer is FLUSHED
  // only when we choose to surface (logger errors at the catch-all branch, the
  // blocking-error path, and — since #44 — the two degraded-worker sites below,
  // which flush explicitly because exitGraceful drops the buffer). Successful
  // exits drop the buffer — preserving the original "quiet on success" behavior.
  //
  // To bypass the buffer for a specific write, use emitDiagnostic /
  // emitBlockingError from src/shared/hook-io.ts. Direct process.stderr.write
  // calls are buffered.
  const stderrBuffer = installHookStderrBuffer();

  const adapter = getPlatformAdapter(platform);
  const handler = getEventHandler(event);

  try {
    return await executeHookPipeline(adapter, handler, platform, event, options, stderrBuffer);
  } catch (error) {
    if (error instanceof AdapterRejectedInput) {
      logger.warn('HOOK', `Adapter rejected input (${error.reason}), skipping hook`);
      emitModelContext(adapter, buildNoOpResult(event));
      exitGraceful(options);
      return HOOK_EXIT_CODES.SUCCESS;
    }
    if (isNonBlockingHookInputError(error)) {
      logger.warn('HOOK', `Hook input unavailable, skipping hook: ${error instanceof Error ? error.message : error}`);
      emitModelContext(adapter, buildNoOpResult(event));
      exitGraceful(options);
      return HOOK_EXIT_CODES.SUCCESS;
    }
    if (isWorkerUnavailableError(error)) {
      logger.warn('HOOK', `Worker unavailable, skipping hook: ${error instanceof Error ? error.message : error}`);
      // EXIT_SIGNAL per CLAUDE.md: worker errors exit 0 — always. Pre-#44 these
      // two lines were DEAD past the fail-loud threshold, because
      // recordWorkerUnreachable() escalated to a blocking exit 2. It now
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

    logger.error('HOOK', `Hook error: ${error instanceof Error ? error.message : error}`, {}, error instanceof Error ? error : undefined);
    // hook_failed telemetry MUST be awaited BEFORE emitBlockingError — it
    // calls process.exit(2), which would kill a fire-and-forget POST
    // mid-flight. captureCliEvent never throws and is hard-capped at 2s.
    // Closed-enum props only: the error message itself is never sent.
    {
      const hookType = getActiveHookType();
      await captureCliEvent('hook_failed', {
        ...(hookType !== null ? { hook_type: hookType } : {}),
        error_mode: 'blocking_error',
        threshold_tripped: false,
      });
    }
    // BLOCKING_FEEDBACK: flush the buffered logger.error line to stderr and
    // exit 2 so the model receives it per Claude Code's hook contract.
    emitBlockingError(
      `Hook error: ${error instanceof Error ? error.message : String(error)}`,
      options,
    );
    return HOOK_EXIT_CODES.BLOCKING_ERROR;
  } finally {
    stderrBuffer.restore();
  }
}
