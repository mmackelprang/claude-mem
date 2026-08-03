import { describe, expect, it, beforeEach, afterAll } from 'bun:test';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performResilientShutdown } from '../../src/services/infrastructure/resilient-shutdown.js';
import {
  filterPosixChromaOrphans,
  collectSubtree,
  listPosixProcesses,
  sweepPosixChromaOrphans,
  sweepPosixChromaOrphansFrom,
  type PosixProcRow
} from '../../src/services/infrastructure/orphan-reaper.js';
import {
  reconcileStaleChromaRecord,
  ensureChromaTornDown,
  type ChromaRegistryView
} from '../../src/services/infrastructure/chroma-reconcile.js';
import { killProcessTree, isChromaMcpProcess } from '../../src/services/infrastructure/process-tree.js';
import { createProcessRegistry } from '../../src/supervisor/process-registry.js';
import { USER_SETTINGS_PATH } from '../../src/shared/paths.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

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

  // POSIX-only: on win32 killProcessTree takes the taskkill branch and really
  // spawns taskkill, so the SIGTERM/SIGKILL assertion below cannot hold there.
  it.skipIf(process.platform === 'win32')('tree-kills a LIVE stale chroma-mcp record and unregisters it', async () => {
    const registry = tempRegistry();
    registry.register('chroma-mcp', {
      pid: STALE_PID,
      type: 'chroma',
      startedAt: '2026-07-31T08:05:15.020Z'
    });
    alive.add(STALE_PID);

    // STALE_PID is a fiction, so the real /proc identity check would (correctly)
    // fail closed. Inject a passing one to reach the kill path.
    const reaped = await reconcileStaleChromaRecord(process.pid, registry, { verifyIdentity: () => true });

    expect(reaped).toBe(STALE_PID);
    expect(signals.filter((s) => s.pid === STALE_PID).map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(registry.getAll().find((entry) => entry.id === 'chroma-mcp')).toBeUndefined();
  });

  it('refuses to kill a live record whose pid is no longer a chroma-mcp process (pid reuse, fails closed)', async () => {
    const registry = tempRegistry();
    registry.register('chroma-mcp', {
      pid: STALE_PID,
      type: 'chroma',
      startedAt: '2026-07-31T08:05:15.020Z'
    });
    alive.add(STALE_PID);

    const reaped = await reconcileStaleChromaRecord(process.pid, registry, { verifyIdentity: () => false });

    expect(reaped).toBeNull();
    expect(signals).toEqual([]);
    // The stale record is still dropped so it cannot shadow the single slot.
    expect(registry.getAll().find((entry) => entry.id === 'chroma-mcp')).toBeUndefined();
  });

  it('fails closed by DEFAULT — the real identity check cannot confirm a fictional pid', async () => {
    const registry = tempRegistry();
    registry.register('chroma-mcp', {
      pid: STALE_PID,
      type: 'chroma',
      startedAt: '2026-07-31T08:05:15.020Z'
    });
    alive.add(STALE_PID);

    // No seams injected: isChromaMcpProcess cannot read /proc/999001/cmdline.
    const reaped = await reconcileStaleChromaRecord(process.pid, registry);

    expect(reaped).toBeNull();
    expect(signals).toEqual([]);
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

    // ageSeconds === 0 under `ps etimes` means "younger than one second" — a
    // REAL age, and the most dangerous one. It must be SKIPPED, not swept.
    // (The previous predicate had a `> 0` escape hatch copied from the win32
    // sibling, where createdEpochMs === 0 unambiguously means "unknown"; under
    // etimes that hatch let a chroma spawned <1s ago through to SIGKILL.)
    const justSpawned: PosixProcRow[] = [{ pid: 901, ppid: 15952, ageSeconds: 0, commandLine: UV }];
    expect(filterPosixChromaOrphans(justSpawned, 7127)).toEqual([]);

    // null === "ps could not supply an age" (the no-etimes fallback) → fail OPEN.
    const unknownAge: PosixProcRow[] = [{ pid: 902, ppid: 15952, ageSeconds: null, commandLine: UV }];
    expect(filterPosixChromaOrphans(unknownAge, 7127).map((r) => r.pid)).toEqual([902]);
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

describe('#40 chroma-mcp orphan leak — the enumerator must not be width-truncated', () => {
  // THE defect unit tests structurally could not catch: every test above hands
  // filterPosixChromaOrphans hand-written rows, so a broken `ps` invocation is
  // invisible to them. The worker daemon inherits COLUMNS=108 from the hook that
  // spawns it; without `-ww` (and without dropping COLUMNS from the child env)
  // `ps` cuts the args column at ~88 chars — BEFORE the `chroma-mcp` token — and
  // the whole sweep silently finds nothing. Measured on WSL2, 2026-07-31:
  //   COLUMNS=108 ps     -eo '...,args=' | grep -c chroma-mcp -> 0
  //   COLUMNS=108 ps -ww -eo '...,args=' | grep -c chroma-mcp -> 11
  // This test asserts the property directly: a very long argv must round-trip.
  const children: number[] = [];

  afterAll(() => {
    for (const pid of children) {
      try { realKill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it.skipIf(process.platform === 'win32')('returns full command lines even when $COLUMNS is small', async () => {
    // `sh -c 'sleep 30' <marker>` keeps the marker in sh's OWN argv (it becomes
    // $0) without sh trying to execute it, and sh stays alive for the probe.
    const marker = `claude-mem-40-width-probe-${'x'.repeat(400)}`;
    const child = spawn('sh', ['-c', 'sleep 30', marker], { stdio: 'ignore' });
    if (typeof child.pid === 'number') children.push(child.pid);
    expect(typeof child.pid).toBe('number');

    const previousColumns = process.env.COLUMNS;
    process.env.COLUMNS = '80';
    try {
      let row: PosixProcRow | undefined;
      for (let attempt = 0; attempt < 40 && !row; attempt += 1) {
        row = listPosixProcesses().find((r) => r.pid === child.pid);
        if (row) break;
        await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
      }

      expect(row).toBeDefined();
      expect(row!.commandLine.length).toBeGreaterThan(200);
      expect(row!.commandLine).toContain(marker);
    } finally {
      if (previousColumns === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previousColumns;
      if (typeof child.pid === 'number') {
        try { realKill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  }, 15_000);

  it.skipIf(process.platform === 'win32')('never returns a pid twice, so a phantom row cannot feed the kill loop', () => {
    const rows = listPosixProcesses();
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.pid)).size).toBe(rows.length);
  });
});

describe('#40 chroma-mcp orphan leak — the sweep kill path', () => {
  const UV = '/home/m/.local/bin/uv tool uvx --from chroma-mcp==0.2.6 chroma-mcp --client-type http --host h --port 8000';
  const PY = '/home/m/.cache/uv/x/bin/python /home/m/.cache/uv/x/bin/chroma-mcp --client-type http --host h --port 8000';

  const ROWS: PosixProcRow[] = [
    { pid: 7127, ppid: 15952, ageSeconds: 30, commandLine: 'bun worker-service.cjs --daemon' },
    { pid: 7241, ppid: 7127, ageSeconds: 29, commandLine: UV },  // ours — must survive
    { pid: 7264, ppid: 7241, ageSeconds: 28, commandLine: PY },  // ours — must survive
    { pid: 5753, ppid: 15952, ageSeconds: 600, commandLine: UV }, // orphan
    { pid: 5778, ppid: 5753, ageSeconds: 600, commandLine: PY },  // orphan
    { pid: 4242, ppid: 15952, ageSeconds: 600, commandLine: 'rg chroma-mcp src/' } // incidental
  ];

  const previousEnv = process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP;

  beforeEach(() => { alive.clear(); signals.length = 0; });

  afterAll(() => {
    if (previousEnv === undefined) delete process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP;
    else process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP = previousEnv;
  });

  /**
   * Run `fn` against a chosen ~/.claude-mem/settings.json body, restoring
   * whatever was there before. `body === null` means "no settings file at all",
   * which also exercises loadFromFile's create-with-defaults path — hence the
   * unconditional cleanup in `finally`. paths.ts freezes USER_SETTINGS_PATH
   * under the test data dir (tests/preload.ts), so this never touches a real
   * user's file.
   */
  async function withSettingsFile(body: string | null, fn: () => Promise<void>): Promise<void> {
    const backup = existsSync(USER_SETTINGS_PATH) ? readFileSync(USER_SETTINGS_PATH, 'utf-8') : null;
    try {
      if (body === null) rmSync(USER_SETTINGS_PATH, { force: true });
      else writeFileSync(USER_SETTINGS_PATH, body);
      await fn();
    } finally {
      if (backup !== null) writeFileSync(USER_SETTINGS_PATH, backup);
      else rmSync(USER_SETTINGS_PATH, { force: true });
    }
  }

  it.skipIf(process.platform === 'win32')('SIGKILLs exactly the orphaned pids once explicitly opted in', async () => {
    process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP = 'true';

    const result = await sweepPosixChromaOrphansFrom(ROWS, 7127);

    expect(result.killed.sort((a, b) => a - b)).toEqual([5753, 5778]);
    expect(signals).toEqual([
      { pid: 5753, signal: 'SIGKILL' },
      { pid: 5778, signal: 'SIGKILL' }
    ]);
  });

  it.skipIf(process.platform === 'win32')('is a no-op when the env switch is set to false', async () => {
    process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP = 'false';

    const result = await sweepPosixChromaOrphansFrom(ROWS, 7127);

    expect(result.killed).toEqual([]);
    expect(signals).toEqual([]);
  });

  // --- default OFF / opt-IN (the sweep must not run unless asked) ------------
  //
  // The sweep SIGKILLs machine-wide on a command-line match alone, so "nobody
  // said anything" must mean OFF. These are the tests that pin that: each one
  // is a way of saying nothing, and every one of them must leave `signals`
  // empty. ROWS deliberately contains two matching orphans, so a regression to
  // default-ON turns every one of them red rather than silently passing.

  it.skipIf(process.platform === 'win32')('does NOT run when neither the env var nor the settings key is set', async () => {
    delete process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP;
    await withSettingsFile(JSON.stringify({ CLAUDE_MEM_CHROMA_ENABLED: 'true' }), async () => {
      const result = await sweepPosixChromaOrphansFrom(ROWS, 7127);

      expect(result.killed).toEqual([]);
      expect(signals).toEqual([]);
    });
  });

  it.skipIf(process.platform === 'win32')('does NOT run on a virgin install with no settings file at all', async () => {
    delete process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP;
    await withSettingsFile(null, async () => {
      const result = await sweepPosixChromaOrphansFrom(ROWS, 7127);

      expect(result.killed).toEqual([]);
      expect(signals).toEqual([]);
    });
  });

  it.skipIf(process.platform === 'win32')('does NOT run when the settings file is corrupt — a read failure fails CLOSED', async () => {
    delete process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP;
    await withSettingsFile('{ not json', async () => {
      const result = await sweepPosixChromaOrphansFrom(ROWS, 7127);

      expect(result.killed).toEqual([]);
      expect(signals).toEqual([]);
    });
  });

  it.skipIf(process.platform === 'win32')('does NOT run when the settings key is explicitly false', async () => {
    delete process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP;
    await withSettingsFile(JSON.stringify({ CLAUDE_MEM_CHROMA_ORPHAN_SWEEP: 'false' }), async () => {
      const result = await sweepPosixChromaOrphansFrom(ROWS, 7127);

      expect(result.killed).toEqual([]);
      expect(signals).toEqual([]);
    });
  });

  // 'true' is the ONE affirmative token (trimmed, case-folded), matching every
  // other boolean setting in the codebase. Anything else fails safe to OFF —
  // for a process-killing feature an unrecognised "yes" must not arm it.
  it.skipIf(process.platform === 'win32')('does NOT treat 1 / yes / on / blank as an opt-in', async () => {
    for (const value of ['1', 'yes', 'on', 'enabled', '   ', 'TRUE_ISH', 'false']) {
      process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP = value;
      signals.length = 0;

      const result = await sweepPosixChromaOrphansFrom(ROWS, 7127);

      expect({ value, killed: result.killed, signals }).toEqual({ value, killed: [], signals: [] });
    }
  });

  it.skipIf(process.platform === 'win32')('accepts a trimmed, case-folded TRUE as the opt-in', async () => {
    for (const value of ['true', ' true ', 'TRUE', 'True']) {
      process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP = value;
      alive.clear();
      signals.length = 0;

      const result = await sweepPosixChromaOrphansFrom(ROWS, 7127);

      expect({ value, killed: result.killed.sort((a, b) => a - b) }).toEqual({ value, killed: [5753, 5778] });
    }
  });

  // --- explicit opt-in, and precedence --------------------------------------

  // M3: an env var is not a usable control for a detached daemon (the successor
  // worker inherits the OLD worker's environment), so the settings key is the
  // real switch — it must be able to arm the sweep on its own.
  it.skipIf(process.platform === 'win32')('runs when the settings key opts in, with no env var set', async () => {
    delete process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP;
    await withSettingsFile(JSON.stringify({ CLAUDE_MEM_CHROMA_ORPHAN_SWEEP: 'true' }), async () => {
      const result = await sweepPosixChromaOrphansFrom(ROWS, 7127);

      expect(result.killed.sort((a, b) => a - b)).toEqual([5753, 5778]);
    });
  });

  it.skipIf(process.platform === 'win32')('lets an explicit env var override the settings key in both directions', async () => {
    await withSettingsFile(JSON.stringify({ CLAUDE_MEM_CHROMA_ORPHAN_SWEEP: 'false' }), async () => {
      process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP = 'true';
      expect((await sweepPosixChromaOrphansFrom(ROWS, 7127)).killed.sort((a, b) => a - b)).toEqual([5753, 5778]);
    });

    alive.clear();
    signals.length = 0;

    await withSettingsFile(JSON.stringify({ CLAUDE_MEM_CHROMA_ORPHAN_SWEEP: 'true' }), async () => {
      process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP = 'false';
      expect((await sweepPosixChromaOrphansFrom(ROWS, 7127)).killed).toEqual([]);
      expect(signals).toEqual([]);
    });
  });

  // A blank env var is NOT an opt-in and is NOT an override — it falls through
  // to the settings key, which is where the real switch lives.
  it.skipIf(process.platform === 'win32')('falls through a blank env var to the settings key', async () => {
    process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP = '';
    await withSettingsFile(JSON.stringify({ CLAUDE_MEM_CHROMA_ORPHAN_SWEEP: 'true' }), async () => {
      const result = await sweepPosixChromaOrphansFrom(ROWS, 7127);

      expect(result.killed.sort((a, b) => a - b)).toEqual([5753, 5778]);
    });
  });

  // The top-level entry point gates too, so a disabled sweep never forks `ps`.
  it.skipIf(process.platform === 'win32')('gates sweepPosixChromaOrphans itself, not just the ...From helper', async () => {
    delete process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP;
    await withSettingsFile(JSON.stringify({}), async () => {
      const result = await sweepPosixChromaOrphans(7127, ROWS);

      expect(result.killed).toEqual([]);
      expect(signals).toEqual([]);
    });
  });
});

// The shipped default is itself part of the contract: nothing may quietly flip
// it back by editing the DEFAULTS map alone.
describe('#40 chroma-mcp orphan sweep — the shipped default', () => {
  it('ships CLAUDE_MEM_CHROMA_ORPHAN_SWEEP as false', () => {
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_CHROMA_ORPHAN_SWEEP).toBe('false');
  });
});

describe('#40 chroma-mcp orphan leak — killProcessTree safety + ordering', () => {
  beforeEach(() => { alive.clear(); signals.length = 0; });

  const explode = async (): Promise<number[]> => { throw new Error('descendant walk must not run'); };

  it('refuses pid <= 1 without signalling or walking', async () => {
    for (const pid of [-1, 0, 1]) {
      await killProcessTree(pid, explode);
    }
    expect(signals).toEqual([]);
  });

  it('refuses to tree-kill this very process (recycled pid)', async () => {
    await killProcessTree(process.pid, explode);
    expect(signals).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('holds the TERM -> grace -> KILL-union order', async () => {
    const ROOT = 999101;
    let walk = 0;
    // The second walk drops 999103 (it re-parented) and adds 999104. The SIGKILL
    // sweep must cover the UNION, or 999103 would never be force-killed.
    const collect = async (): Promise<number[]> => (walk++ === 0 ? [999102, 999103] : [999102, 999104]);

    await killProcessTree(ROOT, collect);

    expect(signals).toEqual([
      // TERM: descendants leaves-first (reversed), then the root.
      { pid: 999103, signal: 'SIGTERM' },
      { pid: 999102, signal: 'SIGTERM' },
      { pid: ROOT, signal: 'SIGTERM' },
      // KILL: union of both walks, reversed, then the root.
      { pid: 999104, signal: 'SIGKILL' },
      { pid: 999103, signal: 'SIGKILL' },
      { pid: 999102, signal: 'SIGKILL' },
      { pid: ROOT, signal: 'SIGKILL' }
    ]);
  }, 10_000);

  it.skipIf(process.platform === 'win32')('never signals this process even when the descendant walk names it', async () => {
    // The pid-reuse hazard in miniature: a recycled root whose `pgrep -P` output
    // includes the freshly-booted worker itself.
    const collect = async (): Promise<number[]> => [process.pid, 999105];

    await killProcessTree(999106, collect);

    expect(signals.some((s) => s.pid === process.pid)).toBe(false);
    expect(signals.map((s) => s.pid)).toEqual([999105, 999106, 999105, 999106]);
  }, 10_000);

  it('isChromaMcpProcess fails closed on an unreadable / self pid', () => {
    expect(isChromaMcpProcess(process.pid)).toBe(false);
    expect(isChromaMcpProcess(999107)).toBe(false);
    expect(isChromaMcpProcess(1)).toBe(false);
  });
});

describe('#40 chroma-mcp orphan leak — the post-shutdown guarantee', () => {
  const CHROMA_PID = 999201;

  beforeEach(() => { alive.clear(); signals.length = 0; });

  function registryWith(records: Array<{ id: string; pid: number }>): ChromaRegistryView {
    const unregistered: string[] = [];
    const view = {
      getAll: () => records.map((r) => ({
        id: r.id,
        pid: r.pid,
        type: 'chroma' as const,
        startedAt: '2026-07-31T08:05:15.020Z'
      })),
      unregister: (id: string) => { unregistered.push(id); }
    } as unknown as ChromaRegistryView;
    return Object.assign(view, { unregistered });
  }

  function trackingKill() {
    const killed: number[] = [];
    return { killed, kill: async (pid: number) => { killed.push(pid); } };
  }

  it('does nothing when chroma was already torn down cleanly', async () => {
    const { killed, kill } = trackingKill();

    const result = await ensureChromaTornDown({
      alreadyTornDown: true,
      snapshotPid: CHROMA_PID,
      registry: registryWith([{ id: 'chroma-mcp', pid: CHROMA_PID }]),
      kill,
      verifyIdentity: () => true
    });

    expect(result).toBeNull();
    expect(killed).toEqual([]);
  });

  it('tree-kills the registry record when it is still there', async () => {
    const { killed, kill } = trackingKill();

    const result = await ensureChromaTornDown({
      alreadyTornDown: false,
      snapshotPid: null,
      registry: registryWith([{ id: 'chroma-mcp', pid: CHROMA_PID }]),
      kill,
      verifyIdentity: () => true
    });

    expect(result).toBe(CHROMA_PID);
    expect(killed).toEqual([CHROMA_PID]);
  });

  // THE H2 case: the chain completed (so step 6 -> runShutdownCascade ran and
  // unregistered every non-worker record, src/supervisor/shutdown.ts:78-80) but
  // chroma teardown itself threw. Without the pre-sequence snapshot the lookup
  // is empty and the guarantee is a no-op in exactly the case it exists for.
  it('falls back to the pre-sequence snapshot when the cascade already unregistered the record', async () => {
    const { killed, kill } = trackingKill();

    const result = await ensureChromaTornDown({
      alreadyTornDown: false,
      snapshotPid: CHROMA_PID,
      registry: registryWith([{ id: 'worker', pid: process.pid }]),
      kill,
      verifyIdentity: () => true
    });

    expect(result).toBe(CHROMA_PID);
    expect(killed).toEqual([CHROMA_PID]);
  });

  it('fails closed when the snapshotted pid is no longer a chroma-mcp process', async () => {
    const { killed, kill } = trackingKill();

    const result = await ensureChromaTornDown({
      alreadyTornDown: false,
      snapshotPid: CHROMA_PID,
      registry: registryWith([]),
      kill,
      verifyIdentity: () => false
    });

    expect(result).toBeNull();
    expect(killed).toEqual([]);
  });

  it('never targets this process, pid <= 1, or nothing at all', async () => {
    const { killed, kill } = trackingKill();
    const common = { alreadyTornDown: false, kill, verifyIdentity: () => true };

    expect(await ensureChromaTornDown({ ...common, snapshotPid: null, registry: registryWith([]) })).toBeNull();
    expect(await ensureChromaTornDown({ ...common, snapshotPid: 1, registry: registryWith([]) })).toBeNull();
    expect(await ensureChromaTornDown({ ...common, snapshotPid: 0, registry: registryWith([]) })).toBeNull();
    expect(await ensureChromaTornDown({
      ...common,
      snapshotPid: null,
      registry: registryWith([{ id: 'chroma-mcp', pid: process.pid }])
    })).toBeNull();

    expect(killed).toEqual([]);
  });

  // L3: unregisterProcess() persists the DYING worker's whole in-memory map,
  // and the restart successor has already written its own supervisor.json by
  // this point — so the corpse would clobber it. The successor's
  // pruneDeadEntries + reconcileStaleChromaRecord clean up instead.
  it('does NOT write to the registry — the successor already owns supervisor.json', async () => {
    const { kill } = trackingKill();
    const registry = registryWith([{ id: 'chroma-mcp', pid: CHROMA_PID }]);

    await ensureChromaTornDown({
      alreadyTornDown: false,
      snapshotPid: CHROMA_PID,
      registry,
      kill,
      verifyIdentity: () => true
    });

    expect((registry as unknown as { unregistered: string[] }).unregistered).toEqual([]);
  });

  it('survives a registry that throws, using the snapshot instead', async () => {
    const { killed, kill } = trackingKill();
    const exploding = {
      getAll: () => { throw new Error('supervisor.json is gone'); },
      unregister: () => {}
    } as unknown as ChromaRegistryView;

    const result = await ensureChromaTornDown({
      alreadyTornDown: false,
      snapshotPid: CHROMA_PID,
      registry: exploding,
      kill,
      verifyIdentity: () => true
    });

    expect(result).toBe(CHROMA_PID);
    expect(killed).toEqual([CHROMA_PID]);
  });
});
