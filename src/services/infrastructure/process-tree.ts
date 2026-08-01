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
