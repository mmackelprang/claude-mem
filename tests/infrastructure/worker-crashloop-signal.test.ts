// tests/infrastructure/worker-crashloop-signal.test.ts
import { describe, it, expect } from 'bun:test';
import { buildCrashLoopDiagnosis } from '../../src/shared/worker-utils.js';

describe('buildCrashLoopDiagnosis (#17)', () => {
  it('returns null below the fail-loud threshold', () => {
    expect(buildCrashLoopDiagnosis(1, true, 37777)).toBeNull();
    expect(buildCrashLoopDiagnosis(2, true, 37777)).toBeNull();
  });

  it('names the orphaned-socket cause once the threshold is crossed and the port is held', () => {
    const msg = buildCrashLoopDiagnosis(3, true, 37777);
    expect(msg).not.toBeNull();
    expect(msg).toContain('37777');
    expect(msg!.toLowerCase()).toContain('orphan');
    expect(msg).toContain('claude-mem-'); // real log file, not worker-<date>.log
  });

  it('gives a generic-but-loud message when the port is not held', () => {
    const msg = buildCrashLoopDiagnosis(3, false, 37777);
    expect(msg).not.toBeNull();
    expect(msg!.toLowerCase()).not.toContain('orphan');
    expect(msg).toContain('claude-mem-');
  });

  it('honors a configured threshold below the default (fires at 2 when threshold=2)', () => {
    // CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD can be set to 1 or 2; the diagnosis
    // must fire at the CONFIGURED crossing, not the hardcoded default of 3.
    expect(buildCrashLoopDiagnosis(1, true, 37777, 2)).toBeNull();
    const msg = buildCrashLoopDiagnosis(2, true, 37777, 2);
    expect(msg).not.toBeNull();
    expect(msg).toContain('37777');
  });
});
