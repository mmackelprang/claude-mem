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

const PREVIOUS_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR;
const OWN_TMP_DATA_DIR = mkdtempSync(join(tmpdir(), 'cmem-failopen-'));
process.env.CLAUDE_MEM_DATA_DIR = OWN_TMP_DATA_DIR;
// The threshold crossing awaits captureCliEvent, whose consent chain defaults
// to ON (opt-out). A unit test must never POST a real analytics event.
process.env.CLAUDE_MEM_TELEMETRY = '0';

const REPO_ROOT = join(import.meta.dir, '..', '..');

// HARD SAFETY GATE — evaluated before any test and before the first write.
// src/shared/paths.ts freezes DATA_DIR at FIRST evaluation, so the override
// above only wins when this file is the first to import it (a solo run, and how
// scripts/test-gate.mjs always runs it — one bun process per file). Under a
// shared-process run (`bun test tests/cli/`) a sibling file may have imported
// paths.ts first, in which case the frozen value is whatever tests/preload.ts
// pinned — also a throwaway temp dir, and perfectly safe to use. So: ADOPT
// whatever DATA_DIR actually resolved to, and hard-fail only if it is not a
// throwaway. A test that silently clobbers the developer's real counter is
// worse than no test.
const { DATA_DIR: TMP_DATA_DIR } = await import('../../src/shared/paths.js');
const REAL_DATA_DIR = join(homedir(), '.claude-mem');
if (TMP_DATA_DIR === REAL_DATA_DIR || !TMP_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(
    `#44 test safety: DATA_DIR resolved to ${TMP_DATA_DIR}, which is not a ` +
    `throwaway temp dir. Refusing to run — these tests would clobber the real ` +
    `hook-failure counter at ${REAL_DATA_DIR}.`,
  );
}

const STATE_PATH = join(TMP_DATA_DIR, 'state', 'hook-failures.json');

// Threshold 3, decay 30m, cooldown 10m. Only written when we own the dir: under
// a shared-process run this directory belongs to every other test file too, and
// dropping a settings.json into it could change their behaviour. Not writing it
// costs nothing — these three values are exactly the shipped defaults
// (SettingsDefaultsManager), so the assertions below hold either way. Written
// BEFORE the first loadFromFileOnce(), which caches once per process
// (hook-settings.ts:10-14).
if (TMP_DATA_DIR === OWN_TMP_DATA_DIR) {
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
}

type WorkerUtils = typeof import('../../src/shared/worker-utils.js');
type Notice = typeof import('../../src/shared/hook-degraded-notice.js');

let workerUtils: WorkerUtils;
let notice: Notice;

beforeAll(async () => {
  workerUtils = await import('../../src/shared/worker-utils.js');
  notice = await import('../../src/shared/hook-degraded-notice.js');
});

afterAll(() => {
  // Restore the env so a combined `bun test <dir>` run cannot leak this temp
  // data dir into sibling test files that import paths.ts after us.
  if (PREVIOUS_DATA_DIR === undefined) {
    delete process.env.CLAUDE_MEM_DATA_DIR;
  } else {
    process.env.CLAUDE_MEM_DATA_DIR = PREVIOUS_DATA_DIR;
  }
  // Only ever delete the dir we created. When TMP_DATA_DIR is the preload's
  // shared per-run dir, removing it would rip the directory out from under the
  // frozen module constants of every later test file in this process.
  rmSync(OWN_TMP_DATA_DIR, { recursive: true, force: true });
  if (TMP_DATA_DIR !== OWN_TMP_DATA_DIR) rmSync(STATE_PATH, { force: true });
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
    const src = readFileSync(join(REPO_ROOT, 'src', 'cli', 'hook-command.ts'), 'utf-8');
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
    const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
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
    const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
    const fn = src.slice(src.indexOf('export async function ensureWorkerAliveOnce'), src.indexOf('interface HookFailureState'));
    expect(fn).toContain('resetWorkerFailureCounter()');
  });

  it('`worker start` and a verified `worker restart` reset the counter', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'services', 'worker-service.ts'), 'utf-8');
    expect(src).toContain('resetWorkerFailureCounter');
    const startCase = src.slice(src.indexOf("case 'start': {"), src.indexOf("case 'stop': {"));
    expect(startCase).toContain('resetWorkerFailureCounter()');
  });

  it('threshold 0 is a real off switch, not a silent fallback to 3', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
    expect(src).toContain('NOTICES_DISABLED');
    // The pre-#44 guard that made 0 mean 3 must be gone.
    expect(src).not.toContain('parsed >= 1');
  });
});

describe('#44 (5) REGRESSION — the counter can never again ratchet while blocking', () => {
  it('worker-utils cannot end the process by any route', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
    expect(src).not.toContain('emitBlockingError(');
    expect(src).not.toContain('process.exit(');
  });

  it('the graceful-degrade sentinel is reachable — recordWorkerUnreachable returns', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
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
    const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
    expect(src).toContain(
      "const TELEMETRY_HOOK_TYPES = ['context', 'session-init', 'observation', 'summarize', 'file-context'] as const;",
    );
  });

  it('adds no telemetry property (spec 7.3 — keeps scrub.ts and its 3 cross-references untouched)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
    const call = src.slice(src.indexOf("captureCliEvent('hook_failed'"), src.indexOf('Crash-loop liveness'));
    expect(call).toContain('error_mode:');
    expect(call).toContain('consecutive_failures:');
    expect(call).toContain('threshold_tripped:');
    // exactly the four whitelisted keys — hook_type is conditional, the rest fixed
    expect(call.match(/^\s+\w+:/gm)?.length).toBeLessThanOrEqual(4);
  });
});
