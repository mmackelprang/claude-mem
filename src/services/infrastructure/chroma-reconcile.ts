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
import { isPidRunning, killProcessTree } from './process-tree.js';
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
  registry?: ChromaRegistryView
): Promise<number | null> {
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
  if (!Number.isInteger(pid) || pid <= 1 || pid === selfPid) {
    logger.warn('SYSTEM', 'Ignoring an implausible chroma-mcp registry record', { pid, selfPid });
    return null;
  }

  if (!isPidRunning(pid)) {
    // Already dead; pruneDeadEntries normally handles this, but a record
    // written between initialize() and here would not have been pruned.
    resolvedRegistry.unregister(CHROMA_SUPERVISOR_ID);
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

  resolvedRegistry.unregister(CHROMA_SUPERVISOR_ID);
  return pid;
}
