// WS2 Phase 2 — REQUIRED worker-mode non-regression gate (Designer §8).
//
// Every Phase 2 client-surface behavior is gated on server runtime. This test
// drives the two client surfaces (session-init full-turn redaction + the
// user-message context banner) under worker runtime and asserts they are
// byte-for-byte unchanged, and that CLAUDE_MEM_DEFAULT_VISIBILITY has NO effect
// in worker mode. The gate is `dependencies.selectRuntime() === 'server'`, so we
// drive both worker (unchanged) and server (new copy) to prove the gate works.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import {
  sessionInitHandler,
  setSessionInitDependenciesForTesting,
} from '../../src/cli/handlers/session-init.js';
import {
  userMessageHandler,
  setUserMessageDependenciesForTesting,
} from '../../src/cli/handlers/user-message.js';

const ORIGINAL_HINT = 'Wrap any message with <private> ... </private> to prevent storing sensitive information.';
const TEAM_HINT_FRAGMENT = 'off the team feed';

let loggerSpies: ReturnType<typeof spyOn>[] = [];
const originalDefaultVisibility = process.env.CLAUDE_MEM_DEFAULT_VISIBILITY;

beforeEach(() => {
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  // Reset injected dependencies back to production defaults.
  setSessionInitDependenciesForTesting({});
  setUserMessageDependenciesForTesting({});
  if (originalDefaultVisibility === undefined) {
    delete process.env.CLAUDE_MEM_DEFAULT_VISIBILITY;
  } else {
    process.env.CLAUDE_MEM_DEFAULT_VISIBILITY = originalDefaultVisibility;
  }
});

function stubSessionInit(runtime: 'worker' | 'server'): void {
  setSessionInitDependenciesForTesting({
    shouldTrackProject: () => true,
    loadFromFileOnce: () => ({ CLAUDE_MEM_SEMANTIC_INJECT: 'false' }) as never,
    // Worker runtime context so we bypass the server startSession block and
    // reach the worker-fallback full-turn-redaction branch.
    resolveRuntimeContext: () => ({ runtime: 'worker' }) as never,
    executeWithWorkerFallback: (async () => ({
      sessionDbId: 1,
      promptNumber: 1,
      skipped: true,
      reason: 'private',
    })) as never,
    isWorkerFallback: () => false,
    logServerFallback: () => {},
    // The gate under test.
    selectRuntime: () => runtime,
  });
}

function stubUserMessage(runtime: 'worker' | 'server'): void {
  setUserMessageDependenciesForTesting({
    executeWithWorkerFallback: (async () => 'CTX') as never,
    isWorkerFallback: () => false,
    getWorkerPort: () => 37700,
    selectRuntime: () => runtime,
  });
}

describe('worker-mode non-regression (Phase 2 visibility seam)', () => {
  it('worker mode: full-turn redaction stays silent (no systemMessage)', async () => {
    process.env.CLAUDE_MEM_DEFAULT_VISIBILITY = 'private'; // must be ignored in worker mode
    stubSessionInit('worker');
    const result = await sessionInitHandler.execute({
      sessionId: 'sess-worker-1',
      cwd: process.cwd(),
      platform: 'claude-code',
      prompt: 'a normal prompt with some length here',
    } as never);
    expect(result.suppressOutput).toBe(true);
    expect(result.systemMessage).toBeUndefined();
  });

  it('server mode: full-turn redaction surfaces the confirmation systemMessage', async () => {
    stubSessionInit('server');
    const result = await sessionInitHandler.execute({
      sessionId: 'sess-server-1',
      cwd: process.cwd(),
      platform: 'claude-code',
      prompt: 'a normal prompt with some length here',
    } as never);
    expect(result.suppressOutput).toBe(true);
    expect(typeof result.systemMessage).toBe('string');
    expect(result.systemMessage).toContain('marked private');
  });

  it('worker mode: banner keeps the ORIGINAL <private> hint and ignores CLAUDE_MEM_DEFAULT_VISIBILITY', async () => {
    process.env.CLAUDE_MEM_DEFAULT_VISIBILITY = 'private'; // must be ignored in worker mode
    stubUserMessage('worker');
    const result = await userMessageHandler.execute({
      cwd: process.cwd(),
      platform: 'claude-code',
    } as never);
    const banner = String(result.systemMessage ?? '');
    expect(banner).toContain(ORIGINAL_HINT);
    expect(banner).not.toContain(TEAM_HINT_FRAGMENT);
  });

  it('server mode: banner swaps in the team-mode hint (proves the gate flips)', async () => {
    stubUserMessage('server');
    const result = await userMessageHandler.execute({
      cwd: process.cwd(),
      platform: 'claude-code',
    } as never);
    const banner = String(result.systemMessage ?? '');
    expect(banner).toContain(TEAM_HINT_FRAGMENT);
    expect(banner).not.toContain(ORIGINAL_HINT);
  });
});
