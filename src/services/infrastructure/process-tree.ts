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
import { execFile, execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { CHROMA_NAME, CHROMA_INVOCATION, listChromaOrphanCandidates } from './orphan-reaper.js';

const execFileAsync = promisify(execFile);

/** Grace period between the SIGTERM sweep and the SIGKILL sweep. */
const TERM_GRACE_MS = 500;

/** Signalling pid 0 hits the caller's whole process group; -1 hits every process the user owns. Never allow either. */
function isSafeTarget(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1;
}

/**
 * Never signal OURSELVES. Kept separate from isSafeTarget so isPidRunning()
 * stays an honest liveness probe (our own pid IS running).
 *
 * This is not paranoia. Every caller hands this module a pid read from
 * persisted state (supervisor.json) or from a pre-shutdown snapshot, and pids
 * are recycled. If a recorded `chroma-mcp` pid has been reused by an ANCESTOR
 * of the freshly-booted worker, `pgrep -P <recycled>` returns the worker's own
 * pid and the tree-kill SIGTERM/SIGKILLs the worker mid-boot.
 */
function isSignalTarget(pid: number): boolean {
  return isSafeTarget(pid) && pid !== process.pid;
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
      // isSignalTarget, not isSafeTarget: a recycled root pid can make `pgrep
      // -P` name US as a child. Dropping our own pid here keeps it out of both
      // the returned set and the BFS queue (which would otherwise walk our own
      // real children).
      if (!isSignalTarget(pid) || seen.has(pid)) continue;
      seen.add(pid);
      descendants.push(pid);
      queue.push(pid);
    }
  }

  return descendants;
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    if (!isSignalTarget(pid)) continue;
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
 *
 * `collectDescendants` is injectable so tests can exercise the TERM → grace →
 * KILL-union ordering without a live `pgrep`.
 */
export async function killProcessTree(
  pid: number,
  collectDescendants: (rootPid: number) => Promise<number[]> = collectDescendantPids
): Promise<void> {
  if (!isSafeTarget(pid)) {
    logger.warn('SHUTDOWN', 'Refusing to tree-kill an unsafe pid', { pid });
    return;
  }
  if (pid === process.pid) {
    // A recycled pid from supervisor.json / a shutdown snapshot can land on us.
    logger.warn('SHUTDOWN', 'Refusing to tree-kill this very process', { pid });
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

  const before = await collectDescendants(pid);
  signalAll([...before].reverse(), 'SIGTERM');
  signalAll([pid], 'SIGTERM');

  await new Promise<void>((resolve) => { setTimeout(resolve, TERM_GRACE_MS); });

  const after = await collectDescendants(pid);
  const union = Array.from(new Set([...before, ...after]));
  signalAll(union.reverse(), 'SIGKILL');
  signalAll([pid], 'SIGKILL');
}

/**
 * Is `pid` REALLY a chroma-mcp process, right now?
 *
 * Every tree-kill in this fork targets a pid recovered from persisted state (a
 * supervisor.json record) or from a pre-shutdown snapshot. Both are stale
 * handles, and pids are recycled — so the pid must be re-identified against its
 * LIVE command line before anything is signalled, using the same two tokens the
 * sweep uses (CHROMA_NAME + CHROMA_INVOCATION, imported so there is exactly one
 * definition).
 *
 * FAILS CLOSED: an unreadable cmdline returns false, i.e. "do not kill". A
 * missed reap is recovered by the next startup sweep; a wrong kill is not
 * recoverable.
 */
export function isChromaMcpProcess(pid: number): boolean {
  if (!isSignalTarget(pid)) return false;

  let commandLine: string;
  try {
    if (process.platform === 'linux') {
      // NUL-delimited argv. Authoritative and untruncated — unlike `ps`, whose
      // args column is cut to the terminal width (see orphan-reaper.ts).
      commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
    } else if (process.platform === 'win32') {
      // No /proc and no `ps`. Reuse the CIM enumeration the win32 reaper
      // already relies on and look the pid up in it. One powershell call, only
      // ever on the reconcile path (worker startup, stale record present).
      const row = listChromaOrphanCandidates().find((p) => p.pid === pid);
      commandLine = row?.commandLine ?? '';
    } else {
      // `-ww` for the same reason listPosixProcesses uses it: never let $COLUMNS
      // truncate the argv out from under the match. stderr is discarded — `ps -p`
      // on a dead pid exits 1, which is a normal answer here, not noise.
      commandLine = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'args='], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    }
  } catch (error) {
    logger.debug('SHUTDOWN', 'Could not read a command line to verify chroma identity — failing closed', {
      pid,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }

  if (!commandLine) return false;
  return CHROMA_NAME.test(commandLine) && CHROMA_INVOCATION.test(commandLine);
}
