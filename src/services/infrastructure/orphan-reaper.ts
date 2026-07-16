// src/services/infrastructure/orphan-reaper.ts
//
// Reap orphaned chroma-mcp descendants that survive a worker death and keep
// :37777 bound (#17). Identification is by IMAGE + COMMAND-LINE + AGE via a CIM
// enumeration, NOT by walking the PPID tree: once the worker (and/or uvx) has
// exited, Windows leaves the surviving grandchildren with a dangling PPID, so
// `taskkill /PID <worker> /T` provably cannot reach them. We enumerate every
// process, match the chroma-mcp launcher signature on its command line, and kill
// the matches by PID.
import { spawnSync } from 'child_process';
import { logger } from '../../utils/logger.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';

export interface ChromaProcess {
  pid: number;
  name: string;
  commandLine: string;
  createdEpochMs: number;
}

// A process is a chroma-mcp orphan if its command line carries the chroma-mcp
// name AND looks like an actual chroma-mcp *invocation* — either the uvx
// launcher form (`--from chroma-mcp==<v>`) or the running-server form
// (`--client-type <persistent|http>`), both of which claude-mem always emits
// (buildCommandArgs in ChromaMcpManager). Requiring the second token keeps an
// incidental mention (e.g. `rg chroma-mcp`, an editor, a shell that merely has
// the string in its arguments) from ever matching. Matching by command line —
// not PPID tree — is the point: the tree is already broken once the worker/uvx
// died, so we identify the surviving chain members by their own argv.
const CHROMA_NAME = /chroma-mcp/i;
const CHROMA_INVOCATION = /--client-type\b|--from\s+chroma-mcp/i;

// Age guard (the "age" dimension): never reap a process younger than this. In
// the dead-but-bound scenario the orphan was spawned by the *previous* worker
// and has been alive for seconds-to-hours; a sub-second-old chroma is almost
// certainly a legitimate in-flight spawn (e.g. a concurrent healthy start), so
// skipping it avoids racing/killing a process that isn't actually an orphan.
// Unknown age (createdEpochMs <= 0, e.g. a null CreationDate under low
// privilege) fails OPEN — we still reap, since a real orphan must not be missed.
const MIN_ORPHAN_AGE_MS = 2_000;

// SCOPE CAVEAT (reviewed, accepted for single-worker installs): this matches
// EVERY chroma-mcp invocation on the machine, not only the one that inherited
// THIS worker's port. On a box running a second, healthy claude-mem worker with
// a different data-dir/port, a dead-but-bound reap on one worker's port could
// also kill the other's chroma. It cannot be scoped by data-dir because remote
// (`--client-type http`) installs carry no `--data-dir` at all. The reaper only
// fires after the same-worker `waitForHealth` path has already exited, so it
// never touches ITS OWN healthy chroma; the residual risk is strictly a
// second, independent worker on the same host. Flagged for the maintainer.
export function filterChromaOrphans(rows: ChromaProcess[], nowMs: number = Date.now()): ChromaProcess[] {
  return rows.filter((p) => {
    if (!CHROMA_NAME.test(p.commandLine) || !CHROMA_INVOCATION.test(p.commandLine)) return false;
    if (p.createdEpochMs > 0 && nowMs - p.createdEpochMs < MIN_ORPHAN_AGE_MS) return false;
    return true;
  });
}

export function listChromaOrphanCandidates(_nowMs: number = Date.now()): ChromaProcess[] {
  if (process.platform !== 'win32') return [];
  // Emit pid/name/commandline/creation-epoch-ms for every process, JSON per line.
  // Mirrors the established process-registry.ts CIM seam (Get-CimInstance, not
  // wmic — removed on Windows 11 — with sanitizeEnv + LC_ALL/LANG=C).
  const ps =
    'Get-CimInstance Win32_Process | ForEach-Object { ' +
    '$e = 0; if ($_.CreationDate) { $e = [int64](($_.CreationDate).ToUniversalTime() - [datetime]"1970-01-01").TotalMilliseconds }; ' +
    "[pscustomobject]@{ pid=$_.ProcessId; name=$_.Name; cmd=$_.CommandLine; created=$e } | ConvertTo-Json -Compress }";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf-8',
    timeout: 5000,
    windowsHide: true,
    env: { ...sanitizeEnv(process.env), LC_ALL: 'C', LANG: 'C' },
  });
  if (result.status !== 0 || !result.stdout) return [];
  const out: ChromaProcess[] = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const o = JSON.parse(trimmed) as { pid: number; name: string; cmd: string | null; created: number };
      if (typeof o.pid === 'number' && o.cmd) {
        out.push({ pid: o.pid, name: o.name ?? '', commandLine: o.cmd, createdEpochMs: o.created ?? 0 });
      }
    } catch {
      // Skip unparseable lines (e.g. processes with null CommandLine under low privilege).
    }
  }
  return out;
}

export async function reapOrphanedChroma(): Promise<{ killed: number[] }> {
  const now = Date.now();
  const candidates = filterChromaOrphans(listChromaOrphanCandidates(now), now);
  const killed: number[] = [];
  for (const proc of candidates) {
    // Kill by PID (/F, no /T): the surviving grandchildren are enumerated
    // independently, so we do not rely on the (broken) process tree.
    const r = spawnSync('taskkill', ['/PID', String(proc.pid), '/F'], { windowsHide: true });
    if (r.status === 0) {
      killed.push(proc.pid);
      logger.warn('SYSTEM', 'Reaped orphaned chroma-mcp process holding the worker socket', {
        pid: proc.pid, name: proc.name,
      });
    }
  }
  return { killed };
}
