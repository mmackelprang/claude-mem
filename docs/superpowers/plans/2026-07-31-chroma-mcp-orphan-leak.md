# Unit — Stop the chroma-mcp orphan leak on worker restart (Queue #40)

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) tracking.

**Goal:** A worker restart must leave **exactly one** `chroma-mcp` process tree alive — the new one — and
`supervisor.json`'s `chroma-mcp` slot must point at it. Today every restart leaks a `uv` + `python` pair (~137 MB
combined) that nothing references, and they accumulate until the box runs out of RAM.

Design + the full evidence trail: `docs/superpowers/specs/2026-07-31-chroma-mcp-orphan-leak-design.md`.

**Three layers, all fork-only (zero upstream-owned file edits):**

1. **Prevention** — fault-isolate the teardown chain so one failing step cannot forfeit chroma teardown (closes D1),
   plus a guaranteed post-sequence teardown that runs even when the raced promise was abandoned (closes D1b).
2. **Recovery** — reconcile the stale `chroma-mcp` record at startup and tree-kill it (closes D2; robust against
   SIGKILL/crash, which prevention can never cover).
3. **Sweep** — a POSIX enumerator so orphans whose record was already overwritten — the backlog now on Mark's box —
   get cleaned up too.

---

## The load-bearing measured fact (read this before writing any code)

**The leak is NOT caused by the 10-second graceful-shutdown deadline.** It is caused by
`performGracefulShutdown` **rejecting at step 1**, one millisecond in, which forfeits steps 2–6 including chroma
teardown at step 4.

From `~/.claude-mem/logs/claude-mem-2026-07-31.log`:

```
[2026-07-31 08:18:44.812] [INFO ] [SYSTEM] Restarting worker
[2026-07-31 08:18:44.935] [INFO ] [SYSTEM] Shutdown initiated
[2026-07-31 08:18:44.936] [ERROR] [SYSTEM] Graceful shutdown failed — proceeding {reason=restart} Server is not running.
[2026-07-31 08:18:44.939] [INFO ] [SYSTEM] Restart successor spawned {pid=7126, ...}
```

`Graceful shutdown deadline exceeded` appears **nowhere** in either log file. When the chain *does* succeed,
`Stopping Chroma MCP connection...` is logged within 1 ms and completes in ~510 ms — so `ChromaMcpManager.stop()` is
fast and correct; **it is simply never called.**

`"Server is not running."` is Node's `ERR_SERVER_NOT_RUNNING` message, raised by `server.close()` at
`src/services/infrastructure/GracefulShutdown.ts:68`.

**Do not "fix the deadline" and stop.** The deadline is a real second bypass (spec D1b) and Task 4 closes it, but it is
not what reproduced.

## Global constraints

- **Zero upstream-owned file edits.** Byte-identical-to-`f5633c1f` files are off-limits (ADR 0002 §9; the same rule
  `~~37~~` held to). **Off-limits:** `GracefulShutdown.ts`, `worker-shutdown.ts`, `ChromaMcpManager.ts`,
  `ProcessManager.ts`, `restart-verify.ts`. **Free to edit:** `worker-service.ts` (already +77/−8 diverged),
  `orphan-reaper.ts` (fork-created), and any new file.
  Verify before editing anything not listed: `git diff --name-only f5633c1f HEAD -- <file>` — empty output means
  upstream-owned, so **stop and surface it** rather than editing.
- **Never signal `pid <= 1`.** Every kill path must guard this. `process.kill(0, …)` signals the caller's whole process
  group and `process.kill(-1, …)` signals every process the user owns; both would be catastrophic on a dev box.
- **No `PPID === 1` ownership heuristics.** This box is WSL: orphans reparent to a non-1 `/init` subreaper
  (`/init` exists at pids 1, 9, 10, 7235, 7236, 15952 here, and the *healthy* worker `7127` itself has `ppid=15952`).
  Any such test is wrong in both directions.
- **Do not touch `plugin/*` build artifacts as a source edit.** They are ADR §4.1 Class-A REGEN output. The working
  tree arrives with `plugin/scripts/{mcp-server,server-service,worker-service}.cjs` and `plugin/ui/viewer-bundle.js`
  already modified — **that state is intentional; do not revert it.** Regenerate via `npm run build-and-sync` as the
  normal post-change step and commit the regenerated output with the rest.
- **The test gate is `npm run test:gate`**, never raw `bun test` (which does not complete on this fork).
- **Do not add the regression test to `tests/services/worker-shutdown-sequence.test.ts`.** It is quarantined in
  `tests/known-failures.json` as `nonRunnable` (`kind: "hang"`) and contributes zero observed tests — a test added
  there would be silently dead. Use the new file in Task 6.

---

### Task 1: Diagnose the `ERR_SERVER_NOT_RUNNING` trigger (diagnostic — gates nothing, informs everything)

**This task writes no production code.** It answers *why* step 1 rejects, so the PR records a real root cause rather
than an inferred one.

- [ ] Reproduce: `npm run build-and-sync`, then check the log for the failure line.

```bash
grep -ahE "Shutdown initiated|Graceful shutdown (failed|deadline)|Stopping Chroma|Restart successor" \
  ~/.claude-mem/logs/claude-mem-$(date +%F).log | tail -20
```

- [ ] Determine which of the two candidates holds:
  - **(a) Bun `node:http` shim race** — `server.closeAllConnections()` (`GracefulShutdown.ts:61`) tears down the last
    socket, and the subsequent `server.close()` observes an already-non-listening server. Supported by the
    intermittency (3 of 5) and by the fact that it also hit a `reason=stop` shutdown.
  - **(b) Genuine double-close** — something closed the server earlier in the same shutdown.
- [ ] Cheap discriminator — log `server.listening` immediately before the `close()` call in a scratch build, or add a
      one-off `console.error` in the built `plugin/scripts/worker-service.cjs` and restart. If `listening === false` at
      that point, it is (a).
- [ ] **Record the finding in the PR description.** One paragraph. If it turns out to be trivially preventable, say so
      — but do **not** let that replace Tasks 2–5. The design defect is that *one failing step forfeits five others*,
      and that must be fixed regardless of which step failed today.

**Do not skip this task.** If the trigger turns out to be (b), a double-close is a separate latent bug worth its own
Backlog row, and only this task will surface it.

---

### Task 2: New fork-owned tree-kill primitive — `src/services/infrastructure/process-tree.ts`

`ChromaMcpManager.killProcessTree` is `private static` inside an upstream-owned file, so it can be neither called nor
exported without manufacturing divergence. This is a fork-owned equivalent, used by Tasks 3, 4 and 5.

- [ ] Create `src/services/infrastructure/process-tree.ts`:

```ts
// src/services/infrastructure/process-tree.ts
//
// Fork-only process-tree teardown primitive (#40).
//
// Why this exists as a separate module: ChromaMcpManager.killProcessTree() is a
// `private static` on an upstream-owned file (ChromaMcpManager.ts is
// byte-identical to f5633c1f), so it cannot be called or exported without
// manufacturing permanent fork divergence (ADR 0002 §9). This is a fork-owned
// equivalent with the same semantics.
//
// Group signalling (kill(-pgid)) is deliberately NOT used. The MCP SDK's
// StdioClientTransport does not spawn detached, so chroma-mcp shares the
// WORKER's process group — verified live: worker 7127, uv 7241 and python 7264
// all report pgrp=7127. Killing that group would kill the worker itself, and
// killing the pid-as-pgid value recorded in supervisor.json is an ESRCH no-op
// because no such group exists. The descendant walk below is the only correct
// primitive here.
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

/** Grace period between the SIGTERM sweep and the SIGKILL sweep. */
const TERM_GRACE_MS = 500;

/** Signalling pid 0 hits the caller's whole process group; -1 hits every process the user owns. Never allow either. */
function isSafeTarget(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1;
}

/** Liveness probe. EPERM means the pid exists but belongs to another user — still alive. */
export function isPidRunning(pid: number): boolean {
  if (!isSafeTarget(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Breadth-first descendant walk via `pgrep -P`. Returns descendants only (never
 * `rootPid` itself), nearest-first. `pgrep` exits 1 when a pid has no children,
 * which execFile surfaces as a rejection — that is the normal leaf case, not an
 * error.
 */
export async function collectDescendantPids(rootPid: number): Promise<number[]> {
  if (!isSafeTarget(rootPid)) return [];

  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];

  while (queue.length > 0) {
    const parent = queue.shift() as number;
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync('pgrep', ['-P', String(parent)], { timeout: 5_000 }));
    } catch {
      continue; // exit 1 === no children
    }
    for (const line of stdout.split('\n')) {
      const pid = Number.parseInt(line.trim(), 10);
      if (!isSafeTarget(pid) || seen.has(pid)) continue;
      seen.add(pid);
      descendants.push(pid);
      queue.push(pid);
    }
  }

  return descendants;
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    if (!isSafeTarget(pid)) continue;
    try {
      process.kill(pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        logger.debug('SHUTDOWN', `Failed to ${signal} pid ${pid}`, { code });
      }
    }
  }
}

/**
 * Kill `pid` and every descendant. Best-effort: swallows ESRCH (already dead).
 *
 * POSIX: SIGTERM leaves-first then the root, wait TERM_GRACE_MS, then SIGKILL
 * the UNION of the pre-TERM and post-wait descendant sets. The union matters —
 * a descendant that re-parents during the grace window disappears from the
 * second walk but was definitely a child before SIGTERM, and would otherwise
 * never receive SIGKILL.
 *
 * Windows: `taskkill /T /F`.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (!isSafeTarget(pid)) {
    logger.warn('SHUTDOWN', 'Refusing to tree-kill an unsafe pid', { pid });
    return;
  }

  logger.debug('SHUTDOWN', `Killing process tree rooted at PID ${pid}`);

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 5_000,
        windowsHide: true
      });
    } catch (error) {
      // taskkill exits non-zero when the process is already gone — expected.
      logger.debug('SHUTDOWN', 'taskkill tree-kill finished (may already be dead)', {
        pid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  const before = await collectDescendantPids(pid);
  signalAll([...before].reverse(), 'SIGTERM');
  signalAll([pid], 'SIGTERM');

  await new Promise<void>((resolve) => { setTimeout(resolve, TERM_GRACE_MS); });

  const after = await collectDescendantPids(pid);
  const union = Array.from(new Set([...before, ...after]));
  signalAll(union.reverse(), 'SIGKILL');
  signalAll([pid], 'SIGKILL');
}
```

---

### Task 3: Startup reconciliation — `src/services/infrastructure/chroma-reconcile.ts`

Layer 2 (recovery). Exact and record-scoped: a freshly-booted worker owns no chroma, so **any live `chroma-mcp` record
is unambiguously stale.**

- [ ] Create `src/services/infrastructure/chroma-reconcile.ts`:

```ts
// src/services/infrastructure/chroma-reconcile.ts
//
// Fork-only startup reconciliation for the leaked chroma-mcp pair (#40).
//
// supervisor.json holds ONE `chroma-mcp` slot keyed by name, not a list
// (process-registry.ts:236 is a plain Map.set on a fixed key). Two things
// follow, and together they are the leak:
//
//   1. initialize() -> pruneDeadEntries() removes only records whose pid is
//      DEAD (process-registry.ts:284). A leaked chroma pid is ALIVE, so the
//      stale record survives the prune untouched.
//   2. The successor's own chroma then overwrites that slot, destroying the
//      last handle to a still-running process tree.
//
// Reconciling between those two moments closes the gap. Because a just-booted
// worker owns no chroma, a live record here is stale by definition — no
// heuristics, no PPID tests (which would be wrong on WSL anyway, where orphans
// reparent to a non-1 /init subreaper).
import { getProcessRegistry } from '../../supervisor/process-registry.js';
import { isPidRunning, killProcessTree } from './process-tree.js';
import { logger } from '../../utils/logger.js';

/** Must match CHROMA_SUPERVISOR_ID in ChromaMcpManager.ts:29. */
const CHROMA_SUPERVISOR_ID = 'chroma-mcp';

/**
 * Tree-kill a live `chroma-mcp` record left behind by a previous worker.
 *
 * MUST be called after startSupervisor() (so the registry is initialized and
 * dead entries are already pruned) and before anything can connect chroma.
 *
 * @returns the reaped pid, or null when there was nothing to reap.
 */
export async function reconcileStaleChromaRecord(selfPid: number = process.pid): Promise<number | null> {
  let record;
  try {
    record = getProcessRegistry().getAll().find((entry) => entry.id === CHROMA_SUPERVISOR_ID);
  } catch (error) {
    logger.warn('SYSTEM', 'Could not read the supervisor registry for chroma reconciliation', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  if (!record) return null;

  const { pid } = record;

  // Guard the impossible-but-catastrophic cases explicitly.
  if (!Number.isInteger(pid) || pid <= 1 || pid === selfPid) {
    logger.warn('SYSTEM', 'Ignoring an implausible chroma-mcp registry record', { pid, selfPid });
    return null;
  }

  if (!isPidRunning(pid)) {
    // Already dead; pruneDeadEntries normally handles this, but a record
    // written between initialize() and here would not have been pruned.
    getProcessRegistry().unregister(CHROMA_SUPERVISOR_ID);
    return null;
  }

  logger.warn('SYSTEM', 'Reaping a stale chroma-mcp tree left behind by a previous worker', {
    pid,
    startedAt: record.startedAt
  });

  try {
    await killProcessTree(pid);
  } catch (error) {
    logger.warn('SYSTEM', 'Stale chroma-mcp tree-kill failed (best-effort)', {
      pid,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  getProcessRegistry().unregister(CHROMA_SUPERVISOR_ID);
  return pid;
}
```

---

### Task 4: Fault-isolated teardown — `src/services/infrastructure/resilient-shutdown.ts`

Layer 1 (prevention). Same six steps, same order, but each isolated. `closeHttpServer` is re-implemented here rather
than imported because upstream's copy is module-private (`GracefulShutdown.ts:60`) — copying into a fork-owned file
creates no merge conflict, whereas exporting it from the upstream file would.

**Ordering is deliberately unchanged.** Chroma teardown stays at step 4, behind the session drain, because in-flight
session finalization may still write through chroma. D1b (the deadline abandoning the chain) is closed by Task 5's
guaranteed post-sequence teardown instead, which is strictly safer than reordering.

- [ ] Create `src/services/infrastructure/resilient-shutdown.ts`:

```ts
// src/services/infrastructure/resilient-shutdown.ts
//
// Fork-only fault-isolated teardown (#40).
//
// Upstream's performGracefulShutdown (GracefulShutdown.ts:30-58) is an
// UNGUARDED sequential await chain of six steps. There is no try/catch in the
// function, so a rejection at step N forfeits steps N+1..6.
//
// Measured on 2026-07-31: step 1 (closeHttpServer) rejects with
// ERR_SERVER_NOT_RUNNING ("Server is not running.") on 3 of 5 observed
// shutdowns, ~1 ms in — so step 4, chromaMcpManager.stop(), never runs and a
// ~137 MB chroma-mcp pair leaks on every worker restart. The deadline is NOT
// involved: "Graceful shutdown deadline exceeded" appears nowhere in the logs.
//
// This runs the same steps in the same order, each in its own try/catch, so no
// single failure can forfeit subprocess teardown. GracefulShutdown.ts is
// byte-identical to upstream f5633c1f and is deliberately NOT edited
// (ADR 0002 §9).
import http from 'http';
import { logger } from '../../utils/logger.js';
import { getSupervisor } from '../../supervisor/index.js';
import type { GracefulShutdownConfig } from './GracefulShutdown.js';

export interface ResilientShutdownResult {
  /** True when chromaMcpManager.stop() ran to completion (or there was no manager). */
  chromaStopped: boolean;
  /** Names of the steps that threw. Empty on a fully clean shutdown. */
  failedSteps: string[];
}

async function runStep(name: string, fn: () => Promise<void>, failed: string[]): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    failed.push(name);
    logger.warn('SHUTDOWN', 'Teardown step failed — continuing with the remaining steps', {
      step: name,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

export async function performResilientShutdown(
  config: GracefulShutdownConfig
): Promise<ResilientShutdownResult> {
  logger.info('SYSTEM', 'Shutdown initiated');

  const failedSteps: string[] = [];
  const server = config.server;

  if (server) {
    await runStep('closeHttpServer', async () => {
      await closeHttpServer(server);
      logger.info('SYSTEM', 'HTTP server closed');
    }, failedSteps);
  }

  await runStep('sessionManager.shutdownAll', () => config.sessionManager.shutdownAll(), failedSteps);

  const mcpClient = config.mcpClient;
  if (mcpClient) {
    await runStep('mcpClient.close', async () => {
      await mcpClient.close();
      logger.info('SYSTEM', 'MCP client closed');
    }, failedSteps);
  }

  // Step 4 — the one the leak is about. Reached unconditionally now.
  let chromaStopped = true;
  const chromaMcpManager = config.chromaMcpManager;
  if (chromaMcpManager) {
    logger.info('SHUTDOWN', 'Stopping Chroma MCP connection...');
    chromaStopped = await runStep('chromaMcpManager.stop', () => chromaMcpManager.stop(), failedSteps);
    if (chromaStopped) {
      logger.info('SHUTDOWN', 'Chroma MCP connection stopped');
    }
  }

  const dbManager = config.dbManager;
  if (dbManager) {
    await runStep('dbManager.close', () => dbManager.close(), failedSteps);
  }

  await runStep('supervisor.stop', () => getSupervisor().stop(), failedSteps);

  if (failedSteps.length > 0) {
    logger.warn('SYSTEM', 'Worker shutdown complete with failed steps', { failedSteps });
  } else {
    logger.info('SYSTEM', 'Worker shutdown complete');
  }

  return { chromaStopped, failedSteps };
}

/**
 * Fork-owned copy of GracefulShutdown.ts:60-75, plus the ERR_SERVER_NOT_RUNNING
 * guard. An already-closed server is the goal state, not a failure — treating it
 * as one is what forfeited steps 2-6.
 */
async function closeHttpServer(server: http.Server): Promise<void> {
  server.closeAllConnections();

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => { setTimeout(resolve, 500); });
  }

  if (!server.listening) {
    logger.info('SYSTEM', 'HTTP server already closed — skipping close()');
  } else {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => { setTimeout(resolve, 500); });
    logger.info('SYSTEM', 'Waited for Windows port cleanup');
  }
}
```

---

### Task 5: Wire all three layers into `worker-service.ts` (fork-owned — free to edit)

Three edits. Verify each anchor before applying — line numbers drift.

- [ ] **5a — imports.** Add alongside the existing `reapOrphanedChroma` import at `worker-service.ts:57`:

```ts
import { reconcileStaleChromaRecord } from './infrastructure/chroma-reconcile.js';
import { performResilientShutdown } from './infrastructure/resilient-shutdown.js';
import { sweepPosixChromaOrphans } from './infrastructure/orphan-reaper.js';
import { killProcessTree } from './infrastructure/process-tree.js';
```

- [ ] **5b — startup reconciliation + sweep.** In `async start()` (anchor: `worker-service.ts:416`), insert
      immediately **after `await startSupervisor();` and before `await this.server.listen(port, host);`**. That
      ordering matters: the registry is initialized (and dead entries pruned) by `startSupervisor()`, and reaping
      before the port bind keeps a reaped orphan from interfering with the listen.

```ts
    await startSupervisor();

    // #40 — reclaim chroma-mcp trees leaked by a previous worker, BEFORE this
    // worker's own chroma can overwrite the single `chroma-mcp` registry slot
    // (process-registry.ts:236) and destroy the last handle to them.
    //
    // Layer 1 (exact): the persisted record. A just-booted worker owns no
    // chroma, so a live record here is stale by definition.
    try {
      const reapedPid = await reconcileStaleChromaRecord(process.pid);
      if (reapedPid !== null) {
        logger.info('SYSTEM', 'Reclaimed a leaked chroma-mcp tree at startup', { pid: reapedPid });
      }
    } catch (error) {
      logger.warn('SYSTEM', 'chroma-mcp startup reconciliation failed (non-fatal)', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Layer 2 (best-effort): orphans whose registry record was already
    // overwritten by an earlier restart, so no handle survives. See the SCOPE
    // CAVEAT in orphan-reaper.ts — disable with CLAUDE_MEM_CHROMA_ORPHAN_SWEEP=false.
    try {
      const swept = await sweepPosixChromaOrphans(process.pid);
      if (swept.killed.length > 0) {
        logger.info('SYSTEM', 'Swept untracked chroma-mcp orphans at startup', { killed: swept.killed });
      }
    } catch (error) {
      logger.warn('SYSTEM', 'chroma-mcp orphan sweep failed (non-fatal)', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    await this.server.listen(port, host);
```

- [ ] **5c — resilient teardown + the guaranteed post-sequence kill.** Replace the `performGracefulShutdown` wiring in
      `shutdown()` (anchor: `worker-service.ts:780-786`) and add the post-sequence guarantee after
      `await runShutdownSequence({...})` returns (anchor: `worker-service.ts:757` … `:803`).

Change the injection site from:

```ts
      performGracefulShutdown: () => performGracefulShutdown({
```

to:

```ts
      performGracefulShutdown: async () => {
        const result = await performResilientShutdown({
          server: this.server.getHttpServer(),
          sessionManager: this.sessionManager,
          mcpClient: this.mcpClient,
          dbManager: this.dbManager,
          chromaMcpManager: this.chromaMcpManager || undefined
        });
        this.chromaTornDown = result.chromaStopped;
      },
```

Add the backing field next to the other private fields on `WorkerService`:

```ts
  /** #40 — set by the teardown so the post-sequence guarantee can skip a redundant kill. */
  private chromaTornDown = false;
```

And append this immediately **after** the `await runShutdownSequence({ ... });` call closes, still inside
`async shutdown()`:

```ts
    // #40 — the guarantee that closes D1b. runShutdownSequence races
    // performGracefulShutdown against a 10s deadline (worker-service.ts:787)
    // and ABANDONS the in-flight promise on expiry, then returns; its caller
    // flushResponseThen then runs `finally { process.exit(0) }`
    // (flushResponseThen.ts:12), which executes no further microtasks and no
    // `finally` blocks in the abandoned chain. Code here still runs before that
    // exit, so this is the last point at which the leak can be prevented.
    //
    // Task 4 makes a THROWN step survivable; only this makes an ABANDONED one
    // survivable. Both are needed.
    if (!this.chromaTornDown) {
      const tracked = getSupervisor().getRegistry().getAll().find((entry) => entry.id === 'chroma-mcp');
      if (tracked && Number.isInteger(tracked.pid) && tracked.pid > 1) {
        logger.warn('SYSTEM', 'Graceful teardown did not reach chroma — tree-killing before exit', {
          pid: tracked.pid,
          reason
        });
        try {
          await killProcessTree(tracked.pid);
          getSupervisor().unregisterProcess('chroma-mcp');
        } catch (error) {
          logger.warn('SYSTEM', 'Post-sequence chroma tree-kill failed (best-effort)', {
            pid: tracked.pid,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
```

- [ ] Leave the existing `reapOrphanedChroma()` call at `worker-service.ts:1464` **untouched** — that is `~~17~~`'s
      `EADDRINUSE` dead-but-bound recovery and it works as designed.

---

### Task 6: POSIX enumerator + sweep in `orphan-reaper.ts` (fork-created — free to edit)

Layer 3. `listChromaOrphanCandidates()` returns `[]` on non-win32 (`orphan-reaper.ts:60`), which is one of the two
reasons the existing reaper cannot fire here. Add a POSIX sibling — **additive only, do not change the existing
win32 functions or `filterChromaOrphans`**, which `tests/infrastructure/orphan-reaper.test.ts` covers.

- [ ] Append to `src/services/infrastructure/orphan-reaper.ts`:

```ts
// ---------------------------------------------------------------------------
// POSIX sweep (#40)
//
// The win32 path above cannot fire on Linux/WSL (listChromaOrphanCandidates
// returns [] at :60) and is only reachable from the dead-but-bound EADDRINUSE
// branch (worker-service.ts:1447-1464), which a normal restart never enters.
// This sibling runs at worker startup on POSIX and catches orphans whose
// supervisor.json record was already overwritten, so no handle survives.
//
// Ownership is decided by SUBTREE + AGE, never by PPID === 1: on WSL orphans
// reparent to a non-1 /init subreaper (this box has /init at pids 1, 9, 10,
// 7235, 7236, 15952, and the healthy worker itself has ppid=15952), so a
// PPID === 1 test is wrong in both directions.
//
// The SCOPE CAVEAT above applies unchanged: a chroma-mcp invocation cannot be
// scoped by data-dir, because remote (`--client-type http`) installs carry none.
// On a host running a second, independent claude-mem worker this sweep could
// kill that worker's chroma. Accepted for single-worker installs (the same call
// PR #21 made); set CLAUDE_MEM_CHROMA_ORPHAN_SWEEP=false to disable.

export interface PosixProcRow {
  pid: number;
  ppid: number;
  /** Elapsed seconds since start; 0 when `ps` could not supply it (fails OPEN). */
  ageSeconds: number;
  commandLine: string;
}

const MIN_ORPHAN_AGE_SECONDS = 2;

/**
 * Enumerate every process with pid/ppid/age/cmdline. Prefers `etimes` (procps);
 * falls back to a no-age form on platforms lacking it (e.g. macOS), where age
 * reads 0 and therefore fails OPEN, matching filterChromaOrphans' convention.
 */
export function listPosixProcesses(): PosixProcRow[] {
  if (process.platform === 'win32') return [];

  const attempts: Array<{ args: string[]; hasAge: boolean }> = [
    { args: ['-eo', 'pid=,ppid=,etimes=,args='], hasAge: true },
    { args: ['-eo', 'pid=,ppid=,args='], hasAge: false }
  ];

  for (const attempt of attempts) {
    const result = spawnSync('ps', attempt.args, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...sanitizeEnv(process.env), LC_ALL: 'C', LANG: 'C' }
    });
    if (result.status !== 0 || !result.stdout) continue;

    const rows: PosixProcRow[] = [];
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = attempt.hasAge
        ? /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed)
        : /^(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
      if (!match) continue;
      rows.push(attempt.hasAge
        ? {
            pid: Number.parseInt(match[1], 10),
            ppid: Number.parseInt(match[2], 10),
            ageSeconds: Number.parseInt(match[3], 10),
            commandLine: match[4]
          }
        : {
            pid: Number.parseInt(match[1], 10),
            ppid: Number.parseInt(match[2], 10),
            ageSeconds: 0,
            commandLine: match[3]
          });
    }
    if (rows.length > 0) return rows;
  }

  return [];
}

/** Every pid in `rootPid`'s subtree, including rootPid itself. */
export function collectSubtree(rows: PosixProcRow[], rootPid: number): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else childrenByParent.set(row.ppid, [row.pid]);
  }

  const subtree = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of childrenByParent.get(parent) ?? []) {
      if (subtree.has(child)) continue;
      subtree.add(child);
      queue.push(child);
    }
  }
  return subtree;
}

/**
 * Pure predicate — the unit-testable core of the sweep.
 *
 * A row is an orphan when it is a real chroma-mcp INVOCATION (same two-token
 * test as filterChromaOrphans, so an incidental mention never matches), is NOT
 * in `selfPid`'s subtree, and is at least MIN_ORPHAN_AGE_SECONDS old. Both the
 * `uv` wrapper and its python child match the cmdline test independently, which
 * is the point: the tree is already broken, so each member is identified by its
 * own argv rather than by parentage.
 */
export function filterPosixChromaOrphans(rows: PosixProcRow[], selfPid: number): PosixProcRow[] {
  const own = collectSubtree(rows, selfPid);
  return rows.filter((row) => {
    if (!Number.isInteger(row.pid) || row.pid <= 1) return false;
    if (own.has(row.pid)) return false;
    if (!CHROMA_NAME.test(row.commandLine)) return false;
    if (!CHROMA_INVOCATION.test(row.commandLine)) return false;
    if (row.ageSeconds > 0 && row.ageSeconds < MIN_ORPHAN_AGE_SECONDS) return false;
    return true;
  });
}

/** Kill-switch. Default ON — otherwise the already-accumulated backlog is never cleaned. */
function sweepEnabled(): boolean {
  return process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP !== 'false';
}

export async function sweepPosixChromaOrphans(
  selfPid: number = process.pid
): Promise<{ killed: number[] }> {
  if (process.platform === 'win32' || !sweepEnabled()) return { killed: [] };

  const candidates = filterPosixChromaOrphans(listPosixProcesses(), selfPid);
  const killed: number[] = [];

  for (const candidate of candidates) {
    try {
      process.kill(candidate.pid, 'SIGKILL');
      killed.push(candidate.pid);
      logger.warn('SYSTEM', 'Swept an untracked orphaned chroma-mcp process', {
        pid: candidate.pid,
        ageSeconds: candidate.ageSeconds
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        logger.debug('SYSTEM', 'Failed to sweep an orphaned chroma-mcp process', { pid: candidate.pid, code });
      }
    }
  }

  return { killed };
}
```

---

### Task 7: Regression tests — `tests/services/chroma-orphan-leak-regression.test.ts` (NEW FILE)

**Must be a new file.** `tests/services/worker-shutdown-sequence.test.ts` is `nonRunnable` in
`tests/known-failures.json`, so anything added there is never executed by the gate.

No live Chroma, no live remote, no real subprocess. Follow the `process.kill` + `alive: Set` template from
`tests/supervisor/shutdown.test.ts:84-101`.

- [ ] Create `tests/services/chroma-orphan-leak-regression.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterAll } from 'bun:test';
import { performResilientShutdown } from '../../src/services/infrastructure/resilient-shutdown.js';
import { filterPosixChromaOrphans, collectSubtree, type PosixProcRow } from '../../src/services/infrastructure/orphan-reaper.js';

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
```

- [ ] Add a `reconcileStaleChromaRecord` test using a temp registry path via `createProcessRegistry`
      (`src/supervisor/process-registry.ts:419`) — assert a **live** stale record is signalled and unregistered, and a
      **dead** one is unregistered without any signal. Keep `tests/preload.ts`'s `CLAUDE_MEM_DATA_DIR` isolation
      intact; never let the registry path resolve to the real `~/.claude-mem/supervisor.json`
      (`tests/infrastructure/graceful-shutdown.test.ts:82-96` documents why).

---

### Task 8: Build, gate, typecheck

- [ ] `npx tsc --noEmit` (or the repo's typecheck script) — clean.
- [ ] `npm run build-and-sync` — must end with the plugin-delivery content-hash assertion passing.
- [ ] `npm run verify:plugin-delivery` — confirms the hooks resolve the build just made.
- [ ] `npm run test:gate` — **must be green.** The gate ratchets three ways: a new failure, a new hang, **and** an
      unexpected pass. If any `tests/services/sync/chroma-mcp-manager-singleton.test.ts` entry flips green, that is an
      unexpected pass and the matching `tests/known-failures.json` entry must be **removed** in this PR (those 4 are
      `platforms: ["win32"]`, so on Linux they should already be running and green — do not touch them unless the gate
      says so).
- [ ] Do **not** run `npm run test:gate:update` — baseline reseeding is review-only.

---

## Verification (before opening the PR)

- [ ] `npm run test:gate` green; paste the summary line into the PR.
- [ ] `npx tsc --noEmit` clean.
- [ ] `git diff --name-only f5633c1f HEAD -- src/services/infrastructure/GracefulShutdown.ts src/services/worker-shutdown.ts src/services/sync/ChromaMcpManager.ts src/services/infrastructure/ProcessManager.ts src/services/restart-verify.ts`
      → **must be empty.** This is the zero-upstream-edits gate; paste the (empty) output into the PR.
- [ ] Task 1's `ERR_SERVER_NOT_RUNNING` finding written up in the PR description.

### Test Plan (live UAT — the actual acceptance criterion)

This is the reproduction from the report, run in reverse. **Run it on Mark's box.**

- [ ] **Before:** record the baseline.

```bash
ps -eo pid,ppid,pgid,rss,args | grep -i '[c]hroma-mcp'
cat ~/.claude-mem/supervisor.json
```

- [ ] **Act:** `npm run build-and-sync`
- [ ] **After:** re-run both commands.
- [ ] **Assert:**
  - Exactly **one** `chroma-mcp` pair is alive (one `uv`, one `python`).
  - Its `uv` pid equals `supervisor.json`'s `chroma-mcp.pid`.
  - No pair from before the restart survives.
  - The log shows either `Chroma MCP connection stopped` **or**
    `Graceful teardown did not reach chroma — tree-killing before exit` — one of the two must appear.
- [ ] **Repeat the restart 3×.** The pair count must stay at 1 every time. This is the whole point: the report
      reproduced the leak twice in a row, so a single clean restart proves nothing.
- [ ] **Backlog cleanup check:** if untracked orphans were alive before the first restart, confirm
      `Swept untracked chroma-mcp orphans at startup` fired and they are gone.
- [ ] **Kill-switch check:** `CLAUDE_MEM_CHROMA_ORPHAN_SWEEP=false` — confirm the sweep is skipped and the worker still
      starts clean (reconciliation, which is exact, must still run).

---

## Cross-references

- Spec: `docs/superpowers/specs/2026-07-31-chroma-mcp-orphan-leak-design.md`
- Queue `~~17~~` / [PR #21](https://github.com/mmackelprang/claude-mem/pull/21) — shipped `orphan-reaper.ts`; its
  SCOPE CAVEAT and its "match by cmdline, not PPID tree" rationale carry over verbatim to Task 6.
- ADR 0002 §9 (`docs/architecture/decisions/2026-07-14-upstream-v13.11.0-fork-merge.md:427-428`) — the accepted-cost
  rule behind the zero-upstream-edits constraint. §4.1 — `plugin/*` is REGEN output, never hand-edited.
- Backlog #39 — the two quarantined test hangs, one of which is `worker-shutdown-sequence.test.ts`. This work routes
  **around** that quarantine (Task 7); it does not lift it.
- `CLAUDE.md` — build, delivery-verification and test-gate contracts.

## Queue

Row **#40** in `docs/BUILDER_QUEUE.md`.
