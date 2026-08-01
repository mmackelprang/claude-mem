import { describe, expect, it, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performResilientShutdown } from '../../src/services/infrastructure/resilient-shutdown.js';
import { filterPosixChromaOrphans, collectSubtree, type PosixProcRow } from '../../src/services/infrastructure/orphan-reaper.js';
import { reconcileStaleChromaRecord } from '../../src/services/infrastructure/chroma-reconcile.js';
import { createProcessRegistry } from '../../src/supervisor/process-registry.js';

// --- process.kill swap (template: tests/supervisor/shutdown.test.ts:84-101) ---
const realKill = process.kill.bind(process);
const alive = new Set<number>();
const signals: Array<{ pid: number; signal: string | number }> = [];

(process as unknown as { kill: (pid: number, signal?: string | number) => true }).kill = (pid, signal) => {
  if (signal === 0) {
    if (!alive.has(pid)) {
      const error = new Error('ESRCH') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    }
    return true;
  }
  signals.push({ pid, signal: signal ?? 'SIGTERM' });
  if (signal === 'SIGKILL') alive.delete(pid);
  return true;
};

afterAll(() => {
  (process as unknown as { kill: typeof realKill }).kill = realKill;
});

function makeConfig(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const config = {
    server: null,
    sessionManager: { shutdownAll: async () => { calls.push('sessionManager'); } },
    mcpClient: { close: async () => { calls.push('mcpClient'); } },
    dbManager: { close: async () => { calls.push('dbManager'); } },
    chromaMcpManager: { stop: async () => { calls.push('chroma'); } },
    ...overrides
  };
  return { config, calls };
}

describe('#40 chroma-mcp orphan leak — teardown fault isolation', () => {
  beforeEach(() => { alive.clear(); signals.length = 0; });

  it('still stops chroma when closeHttpServer rejects with ERR_SERVER_NOT_RUNNING', async () => {
    // The exact measured failure: server.close() calls back with
    // ERR_SERVER_NOT_RUNNING ("Server is not running."), 1 ms into shutdown.
    const fakeServer = {
      listening: true,
      closeAllConnections: () => {},
      close: (cb: (err?: Error) => void) => {
        const error = new Error('Server is not running.') as NodeJS.ErrnoException;
        // Deliberately NOT tagged ERR_SERVER_NOT_RUNNING, so this proves generic
        // isolation rather than the targeted guard in closeHttpServer.
        error.code = 'ERR_SOMETHING_ELSE';
        cb(error);
      }
    };
    const { config, calls } = makeConfig({ server: fakeServer });

    const result = await performResilientShutdown(config as never);

    expect(calls).toContain('chroma');
    expect(result.chromaStopped).toBe(true);
    expect(result.failedSteps).toContain('closeHttpServer');
  });

  it('skips close() entirely when Bun has already stopped the listener', async () => {
    // Measured on Bun 1.3.14: closeAllConnections() ALSO stops the listener, so
    // server.listening flips true -> false across that one call and upstream's
    // unconditional close() deterministically calls back ERR_SERVER_NOT_RUNNING.
    // Node 24.18.1 keeps the listener up and resolves. The !listening guard is
    // therefore the actual fix for step 1 on Bun, not just belt and braces.
    let closeCalls = 0;
    const bunServer = {
      listening: true,
      closeAllConnections() { bunServer.listening = false; },
      close: (cb: (err?: Error) => void) => {
        closeCalls += 1;
        const error = new Error('Server is not running.') as NodeJS.ErrnoException;
        error.code = 'ERR_SERVER_NOT_RUNNING';
        cb(error);
      }
    };
    const { config, calls } = makeConfig({ server: bunServer });

    const result = await performResilientShutdown(config as never);

    expect(closeCalls).toBe(0);
    expect(result.failedSteps).not.toContain('closeHttpServer');
    expect(calls).toContain('chroma');
  });

  it('tolerates an ERR_SERVER_NOT_RUNNING callback on the still-listening (Node) path', async () => {
    const nodeServer = {
      listening: true,
      closeAllConnections: () => {},
      close: (cb: (err?: Error) => void) => {
        const error = new Error('Server is not running.') as NodeJS.ErrnoException;
        error.code = 'ERR_SERVER_NOT_RUNNING';
        cb(error);
      }
    };
    const { config, calls } = makeConfig({ server: nodeServer });

    const result = await performResilientShutdown(config as never);

    expect(result.failedSteps).not.toContain('closeHttpServer');
    expect(calls).toContain('chroma');
  });

  it('still stops chroma when the session drain rejects', async () => {
    const { config, calls } = makeConfig({
      sessionManager: { shutdownAll: async () => { throw new Error('drain exploded'); } }
    });

    const result = await performResilientShutdown(config as never);

    expect(calls).toContain('chroma');
    expect(result.chromaStopped).toBe(true);
    expect(result.failedSteps).toContain('sessionManager.shutdownAll');
  });

  it('preserves the upstream ordering invariant: chroma stops before the database closes', async () => {
    const { config, calls } = makeConfig();

    await performResilientShutdown(config as never);

    expect(calls.indexOf('chroma')).toBeGreaterThan(-1);
    expect(calls.indexOf('chroma')).toBeLessThan(calls.indexOf('dbManager'));
  });

  it('reports chromaStopped=false when stop() itself throws, so the caller can force-kill', async () => {
    const { config } = makeConfig({
      chromaMcpManager: { stop: async () => { throw new Error('stop exploded'); } }
    });

    const result = await performResilientShutdown(config as never);

    expect(result.chromaStopped).toBe(false);
    expect(result.failedSteps).toContain('chromaMcpManager.stop');
  });
});

describe('#40 chroma-mcp orphan leak — startup reconciliation', () => {
  // A temp registry path, never the real ~/.claude-mem/supervisor.json.
  // tests/preload.ts already pins CLAUDE_MEM_DATA_DIR, and this adds a second
  // layer: reconcileStaleChromaRecord takes an injected registry, so the
  // module-level singleton is never touched here.
  // tests/infrastructure/graceful-shutdown.test.ts:82-96 records why this
  // matters — the suite once SIGTERM'd the developer's own live worker.
  const tempDirs: string[] = [];

  function tempRegistry() {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-40-reconcile-'));
    tempDirs.push(dir);
    return createProcessRegistry(join(dir, 'supervisor.json'));
  }

  // A pid that is never signalled for real: every process.kill above is the
  // swapped fake, and the only real subprocess killProcessTree runs is a
  // read-only `pgrep -P`.
  const STALE_PID = 999001;

  beforeEach(() => { alive.clear(); signals.length = 0; });

  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('tree-kills a LIVE stale chroma-mcp record and unregisters it', async () => {
    const registry = tempRegistry();
    registry.register('chroma-mcp', {
      pid: STALE_PID,
      type: 'chroma',
      startedAt: '2026-07-31T08:05:15.020Z'
    });
    alive.add(STALE_PID);

    const reaped = await reconcileStaleChromaRecord(process.pid, registry);

    expect(reaped).toBe(STALE_PID);
    expect(signals.filter((s) => s.pid === STALE_PID).map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(registry.getAll().find((entry) => entry.id === 'chroma-mcp')).toBeUndefined();
  });

  it('unregisters a DEAD record without signalling anything', async () => {
    const registry = tempRegistry();
    registry.register('chroma-mcp', {
      pid: STALE_PID,
      type: 'chroma',
      startedAt: '2026-07-31T08:05:15.020Z'
    });
    // STALE_PID deliberately NOT in `alive`.

    const reaped = await reconcileStaleChromaRecord(process.pid, registry);

    expect(reaped).toBeNull();
    expect(signals).toEqual([]);
    expect(registry.getAll().find((entry) => entry.id === 'chroma-mcp')).toBeUndefined();
  });

  it('never signals a pid <= 1', async () => {
    const registry = tempRegistry();
    registry.register('chroma-mcp', {
      pid: 1,
      type: 'chroma',
      startedAt: '2026-07-31T08:05:15.020Z'
    });
    alive.add(1);

    const reaped = await reconcileStaleChromaRecord(process.pid, registry);

    expect(reaped).toBeNull();
    expect(signals).toEqual([]);
  });

  it('never signals the worker itself', async () => {
    const registry = tempRegistry();
    registry.register('chroma-mcp', {
      pid: process.pid,
      type: 'chroma',
      startedAt: '2026-07-31T08:05:15.020Z'
    });
    alive.add(process.pid);

    const reaped = await reconcileStaleChromaRecord(process.pid, registry);

    expect(reaped).toBeNull();
    expect(signals).toEqual([]);
  });

  it('is a no-op when there is no chroma-mcp record at all', async () => {
    const registry = tempRegistry();
    registry.register('worker', {
      pid: process.pid,
      type: 'worker',
      startedAt: '2026-07-31T08:05:15.020Z'
    });

    expect(await reconcileStaleChromaRecord(process.pid, registry)).toBeNull();
    expect(signals).toEqual([]);
  });
});

describe('#40 chroma-mcp orphan leak — POSIX orphan filter', () => {
  const UV = '/home/m/.local/bin/uv tool uvx --python 3.13 --from chroma-mcp==0.2.6 chroma-mcp --client-type http --host fw.appserver.lan --port 8000';
  const PY = '/home/m/.cache/uv/archive-v0/x/bin/python /home/m/.cache/uv/archive-v0/x/bin/chroma-mcp --client-type http --host fw.appserver.lan --port 8000';

  it('matches both members of a leaked pair by their own argv', () => {
    const rows: PosixProcRow[] = [
      { pid: 5753, ppid: 15952, ageSeconds: 600, commandLine: UV },
      { pid: 5778, ppid: 5753, ageSeconds: 600, commandLine: PY }
    ];
    expect(filterPosixChromaOrphans(rows, 7127).map((r) => r.pid)).toEqual([5753, 5778]);
  });

  it('never matches the current worker’s own chroma subtree', () => {
    const rows: PosixProcRow[] = [
      { pid: 7127, ppid: 15952, ageSeconds: 30, commandLine: 'bun worker-service.cjs --daemon' },
      { pid: 7241, ppid: 7127, ageSeconds: 29, commandLine: UV },
      { pid: 7264, ppid: 7241, ageSeconds: 28, commandLine: PY }
    ];
    expect(filterPosixChromaOrphans(rows, 7127)).toEqual([]);
  });

  it('does not use a PPID === 1 heuristic — WSL reparents to a non-1 /init subreaper', () => {
    // ppid 15952 is an /init shim, NOT pid 1. A PPID===1 test would miss this.
    const rows: PosixProcRow[] = [{ pid: 5753, ppid: 15952, ageSeconds: 600, commandLine: UV }];
    expect(filterPosixChromaOrphans(rows, 7127).map((r) => r.pid)).toEqual([5753]);
  });

  it('skips a sub-2s process (a racing legitimate spawn) but fails OPEN on unknown age', () => {
    const young: PosixProcRow[] = [{ pid: 900, ppid: 15952, ageSeconds: 1, commandLine: UV }];
    expect(filterPosixChromaOrphans(young, 7127)).toEqual([]);

    const unknownAge: PosixProcRow[] = [{ pid: 900, ppid: 15952, ageSeconds: 0, commandLine: UV }];
    expect(filterPosixChromaOrphans(unknownAge, 7127).map((r) => r.pid)).toEqual([900]);
  });

  it('ignores an incidental mention of chroma-mcp', () => {
    const rows: PosixProcRow[] = [
      { pid: 4242, ppid: 15952, ageSeconds: 600, commandLine: 'rg chroma-mcp src/' },
      { pid: 4243, ppid: 15952, ageSeconds: 600, commandLine: 'vim orphan-reaper.ts # chroma-mcp' }
    ];
    expect(filterPosixChromaOrphans(rows, 7127)).toEqual([]);
  });

  it('never targets pid <= 1', () => {
    const rows: PosixProcRow[] = [{ pid: 1, ppid: 0, ageSeconds: 9999, commandLine: UV }];
    expect(filterPosixChromaOrphans(rows, 7127)).toEqual([]);
  });

  it('collectSubtree walks transitively', () => {
    const rows: PosixProcRow[] = [
      { pid: 10, ppid: 1, ageSeconds: 1, commandLine: 'a' },
      { pid: 11, ppid: 10, ageSeconds: 1, commandLine: 'b' },
      { pid: 12, ppid: 11, ageSeconds: 1, commandLine: 'c' },
      { pid: 20, ppid: 1, ageSeconds: 1, commandLine: 'd' }
    ];
    expect([...collectSubtree(rows, 10)].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });
});
