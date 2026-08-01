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
import { getProcessRegistry, type ProcessRegistry } from '../../supervisor/process-registry.js';
import { isPidRunning, killProcessTree, isChromaMcpProcess } from './process-tree.js';
import { logger } from '../../utils/logger.js';

/** Must match CHROMA_SUPERVISOR_ID in ChromaMcpManager.ts:29. */
const CHROMA_SUPERVISOR_ID = 'chroma-mcp';

/**
 * The registry surface this module needs. Narrowed to two methods so tests can
 * hand in a `createProcessRegistry(<temp path>)` instance instead of the
 * module-level singleton — the singleton resolves
 * `paths.supervisorRegistry()`, and a test that reached the developer's real
 * `~/.claude-mem/supervisor.json` would tree-kill their live chroma
 * (tests/infrastructure/graceful-shutdown.test.ts:82-96 records the time the
 * suite SIGTERM'd a live worker before that isolation existed).
 */
export type ChromaRegistryView = Pick<ProcessRegistry, 'getAll' | 'unregister'>;

/** Seams that exist so the kill paths are unit-testable without real processes. */
export interface ChromaKillSeams {
  /** Live-cmdline identity check. Defaults to isChromaMcpProcess (fails closed). */
  verifyIdentity?: (pid: number) => boolean;
  /** Tree-kill primitive. Defaults to killProcessTree. */
  kill?: (pid: number) => Promise<void>;
}

/**
 * Tree-kill a live `chroma-mcp` record left behind by a previous worker.
 *
 * MUST be called after startSupervisor() (so the registry is initialized and
 * dead entries are already pruned) and before anything can connect chroma.
 *
 * @returns the reaped pid, or null when there was nothing to reap.
 */
export async function reconcileStaleChromaRecord(
  selfPid: number = process.pid,
  registry?: ChromaRegistryView,
  seams: ChromaKillSeams = {}
): Promise<number | null> {
  const verifyIdentity = seams.verifyIdentity ?? isChromaMcpProcess;
  const kill = seams.kill ?? killProcessTree;

  let resolvedRegistry: ChromaRegistryView;
  let record;
  try {
    resolvedRegistry = registry ?? getProcessRegistry();
    record = resolvedRegistry.getAll().find((entry) => entry.id === CHROMA_SUPERVISOR_ID);
  } catch (error) {
    logger.warn('SYSTEM', 'Could not read the supervisor registry for chroma reconciliation', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  if (!record) return null;

  const { pid } = record;

  // Guard the impossible-but-catastrophic cases explicitly.
  if (!Number.isInteger(pid) || pid <= 1 || pid === selfPid || pid === process.pid) {
    logger.warn('SYSTEM', 'Ignoring an implausible chroma-mcp registry record', { pid, selfPid });
    return null;
  }

  if (!isPidRunning(pid)) {
    // Already dead; pruneDeadEntries normally handles this, but a record
    // written between initialize() and here would not have been pruned.
    resolvedRegistry.unregister(CHROMA_SUPERVISOR_ID);
    return null;
  }

  // PID-REUSE GUARD (fails closed). The record is a persisted, possibly stale
  // handle: the pid it names may since have been recycled by an unrelated
  // process — potentially an ancestor of this very worker. Re-identify it
  // against its LIVE command line before signalling anything. When the cmdline
  // cannot be read we do NOT kill: the record is only a heuristic handle and a
  // missed reap is recovered by the startup sweep, whereas a wrong kill is not
  // recoverable. Drop the record either way so it stops shadowing the slot.
  if (!verifyIdentity(pid)) {
    logger.warn('SYSTEM', 'Skipping a chroma-mcp record whose pid is no longer a chroma-mcp process', {
      pid,
      startedAt: record.startedAt
    });
    resolvedRegistry.unregister(CHROMA_SUPERVISOR_ID);
    return null;
  }

  logger.warn('SYSTEM', 'Reaping a stale chroma-mcp tree left behind by a previous worker', {
    pid,
    startedAt: record.startedAt
  });

  try {
    await kill(pid);
  } catch (error) {
    logger.warn('SYSTEM', 'Stale chroma-mcp tree-kill failed (best-effort)', {
      pid,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  resolvedRegistry.unregister(CHROMA_SUPERVISOR_ID);
  return pid;
}

export interface EnsureChromaTornDownOptions extends ChromaKillSeams {
  /** True when performResilientShutdown already ran chromaMcpManager.stop() to completion. */
  alreadyTornDown: boolean;
  /**
   * The `chroma-mcp` pid read BEFORE the shutdown sequence ran. Required: by
   * the time this runs the registry entry is usually already gone (see below).
   */
  snapshotPid?: number | null;
  registry?: ChromaRegistryView;
  reason?: string;
  selfPid?: number;
}

/**
 * Last-chance chroma teardown, run by the OWNER of the shutdown sequence after
 * runShutdownSequence returns. Extracted from worker-service.ts because that
 * module is not importable under `bun test` (worker-shutdown.ts:7-13).
 *
 * WHY A SNAPSHOT IS REQUIRED, not a nicety: teardown step 6
 * (`getSupervisor().stop()` -> runShutdownCascade) unregisters EVERY record
 * whose pid differs from the worker's — `src/supervisor/shutdown.ts:78-80`
 * loops over `childRecords`, which is `getAll().filter(r => r.pid !==
 * currentPid)`, and `chroma-mcp` is always in that set. Fault isolation (#40)
 * made step 6 run unconditionally, where previously a thrown step 4 forfeited
 * it. So in the exact case this guarantee exists for — the chain completed but
 * chroma teardown THREW — the registry lookup here comes back `undefined` and
 * without the snapshot nothing would be killed.
 *
 * @returns the pid that was tree-killed, or null.
 */
export async function ensureChromaTornDown(
  options: EnsureChromaTornDownOptions
): Promise<number | null> {
  const {
    alreadyTornDown,
    snapshotPid = null,
    registry,
    reason,
    selfPid = process.pid
  } = options;
  const verifyIdentity = options.verifyIdentity ?? isChromaMcpProcess;
  const kill = options.kill ?? killProcessTree;

  if (alreadyTornDown) return null;

  let trackedPid: number | null = null;
  try {
    const resolved = registry ?? getProcessRegistry();
    const record = resolved.getAll().find((entry) => entry.id === CHROMA_SUPERVISOR_ID);
    trackedPid = record ? record.pid : null;
  } catch (error) {
    logger.debug('SYSTEM', 'Could not read the supervisor registry during the post-shutdown chroma check', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const pid = trackedPid ?? snapshotPid;
  const fromSnapshot = trackedPid === null && snapshotPid !== null;

  if (pid === null || !Number.isInteger(pid) || pid <= 1 || pid === selfPid || pid === process.pid) {
    return null;
  }

  // Identity check on BOTH paths, snapshot or registry — the snapshotted pid is
  // the one most exposed to reuse (it was read before an arbitrarily long
  // drain), and the cost is one /proc read. Fails closed.
  if (!verifyIdentity(pid)) {
    logger.warn('SYSTEM', 'Skipping the post-shutdown chroma tree-kill — pid is not a chroma-mcp process', {
      pid,
      fromSnapshot,
      reason
    });
    return null;
  }

  logger.warn('SYSTEM', 'Graceful teardown did not reach chroma — tree-killing before exit', {
    pid,
    fromSnapshot,
    reason
  });

  try {
    await kill(pid);
  } catch (error) {
    logger.warn('SYSTEM', 'Post-sequence chroma tree-kill failed (best-effort)', {
      pid,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  // DELIBERATELY NOT unregistering here (#40 review, L3). unregisterProcess()
  // persists the DYING worker's whole in-memory map, and by this point the
  // restart successor has already been spawned and has already initialised its
  // own supervisor.json — so the corpse's write would clobber it. That is the
  // same hazard removeOwnedPidFile (src/supervisor/shutdown.ts:111) guards for
  // the PID file, and there is no equivalent owner guard for supervisor.json.
  // Nothing is lost: the successor's pruneDeadEntries() plus
  // reconcileStaleChromaRecord() clear the record on its next boot.
  return pid;
}
