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
//
// Exported so process-tree.ts's identity check (`isChromaMcpProcess`) tests a
// live /proc cmdline against the SAME two tokens — one definition, not two.
export const CHROMA_NAME = /chroma-mcp/i;
export const CHROMA_INVOCATION = /--client-type\b|--from\s+chroma-mcp/i;

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
// PR #21 made); set CLAUDE_MEM_CHROMA_ORPHAN_SWEEP=false (or the same key in
// ~/.claude-mem/settings.json) to disable.
//
// SCOPE CAVEAT, WIDENED (#40 review): the WORKER is not the only claude-mem
// runtime that spawns chroma-mcp. The SERVER runtime spawns it too — see
// src/server/routes/v1/ServerV1PostgresRoutes.ts:149 and
// src/server/generation/ProviderObservationGenerator.ts:75-77. Today that is a
// non-issue only because the server runs in Docker, i.e. in a separate PID
// namespace that host `ps` cannot see. A HOST-RUN server (e.g.
// `plugin/scripts/server-service.cjs` started directly, as the local
// server-beta script does) shares this PID namespace, so every worker restart
// would sweep the server's chroma out from under it. If host-run servers ever
// become normal, this sweep must gain a real ownership signal (an env marker
// stamped on the spawn, or a per-runtime registry) rather than a cmdline match.

export interface PosixProcRow {
  pid: number;
  ppid: number;
  /**
   * Elapsed seconds since start, or `null` when `ps` could not supply it (the
   * no-`etimes` fallback path, e.g. macOS), in which case the age guard fails
   * OPEN.
   *
   * NOT overloaded on 0. Under `ps etimes` a 0 is a REAL, common value meaning
   * "started less than a second ago" — precisely the racing-legitimate-spawn
   * case the age guard exists to protect. (The win32 sibling above may overload
   * 0 on `createdEpochMs` because a null CreationDate is the only way to get
   * one there; this field has no such luxury.)
   */
  ageSeconds: number | null;
  commandLine: string;
}

const MIN_ORPHAN_AGE_SECONDS = 2;

/**
 * Enumerate every process with pid/ppid/age/cmdline. Prefers `etimes` (procps);
 * falls back to a no-age form on platforms lacking it (e.g. macOS), where age
 * reads `null` and therefore fails OPEN.
 *
 * `-ww` IS LOAD-BEARING — DO NOT "SIMPLIFY" IT AWAY.
 *
 * `ps` truncates each row to the terminal width, and when it cannot detect a
 * terminal it believes $COLUMNS. The worker daemon inherits COLUMNS=108 from
 * the hook that spawns it, which cuts the `args` column at ~88 characters —
 * BEFORE the `chroma-mcp` token appears in a uvx/python chroma command line.
 * The whole sweep then silently finds nothing and logs nothing. Measured on
 * WSL2 (procps-ng), 2026-07-31:
 *
 *   COLUMNS=108 ps      -eo 'pid=,ppid=,etimes=,args=' | grep -c chroma-mcp -> 0
 *   COLUMNS=108 ps -ww  -eo 'pid=,ppid=,etimes=,args=' | grep -c chroma-mcp -> 11
 *   longest row: 108 chars without -ww, 1383 with it.
 *
 * Reproduced through this very function: with the live worker's own environ
 * loaded, it returned 80 rows whose chroma command lines were all truncated to
 * exactly 88 chars, and filterPosixChromaOrphans() returned nothing.
 *
 * Belt and braces: `-ww` forces unlimited width regardless of $COLUMNS, AND
 * COLUMNS/LINES are dropped from the child env below (the env object here is
 * fully specified, so they simply are not copied through).
 */
export function listPosixProcesses(): PosixProcRow[] {
  if (process.platform === 'win32') return [];

  const attempts: Array<{ args: string[]; hasAge: boolean }> = [
    { args: ['-ww', '-eo', 'pid=,ppid=,etimes=,args='], hasAge: true },
    { args: ['-ww', '-eo', 'pid=,ppid=,args='], hasAge: false }
  ];

  const { COLUMNS: _columns, LINES: _lines, ...env } = sanitizeEnv(process.env);

  for (const attempt of attempts) {
    const result = spawnSync('ps', attempt.args, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...env, LC_ALL: 'C', LANG: 'C' }
    });
    if (result.status !== 0 || !result.stdout) continue;

    const rows: PosixProcRow[] = [];
    // Duplicate-pid guard (first wins). The line regex cannot distinguish a
    // real `ps` row from a continuation line synthesised out of an argv that
    // itself contains "\n<digits> <digits> <digits> <text>" — and a fabricated
    // pid here would feed a SIGKILL loop. `ps` never emits a pid twice, so any
    // repeat is by definition an injected phantom and is dropped.
    // RESIDUAL LIMITATION: a phantom whose fabricated pid happens NOT to
    // collide with a real row still survives this filter. Closing that would
    // need a NUL-delimited enumerator (`/proc/<pid>/cmdline`), which is
    // Linux-only; the age guard plus the two-token invocation test keep the
    // blast radius small enough to accept for now.
    const seenPids = new Set<number>();
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = attempt.hasAge
        ? /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed)
        : /^(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
      if (!match) continue;
      const pid = Number.parseInt(match[1], 10);
      if (seenPids.has(pid)) continue;
      seenPids.add(pid);
      rows.push(attempt.hasAge
        ? {
            pid,
            ppid: Number.parseInt(match[2], 10),
            ageSeconds: Number.parseInt(match[3], 10),
            commandLine: match[4]
          }
        : {
            pid,
            ppid: Number.parseInt(match[2], 10),
            ageSeconds: null,
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
    // `null` (age unavailable) fails OPEN; a real 0 does NOT — see PosixProcRow.
    if (row.ageSeconds !== null && row.ageSeconds < MIN_ORPHAN_AGE_SECONDS) return false;
    return true;
  });
}

/**
 * Kill-switch. Default ON — otherwise the already-accumulated backlog is never
 * cleaned.
 *
 * Two sources, because an env var alone is not a usable safety valve for a
 * default-ON process-killing feature: the worker is a DETACHED DAEMON spawned
 * by a hook, so there is no shell in which a user could export anything.
 * Precedence: an explicit env var wins (it is the deliberate, per-invocation
 * override), otherwise ~/.claude-mem/settings.json, otherwise ON.
 *
 * Fails to the DEFAULT (on) on any settings error and never throws — a
 * corrupt/unreadable settings file must not crash worker startup, and must not
 * silently disable a fix the user never opted out of.
 */
async function sweepEnabled(): Promise<boolean> {
  const fromEnv = process.env.CLAUDE_MEM_CHROMA_ORPHAN_SWEEP;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv.trim().toLowerCase() !== 'false';
  }

  try {
    // Dynamic, mirroring worker-service.ts:505-508 — keeps the settings/paths
    // graph off this module's static import chain.
    const { SettingsDefaultsManager } = await import('../../shared/SettingsDefaultsManager.js');
    const { USER_SETTINGS_PATH } = await import('../../shared/paths.js');
    const value = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_CHROMA_ORPHAN_SWEEP;
    return String(value ?? '').trim().toLowerCase() !== 'false';
  } catch (error) {
    logger.debug('SYSTEM', 'Could not read the chroma orphan-sweep setting — defaulting to enabled', {
      error: error instanceof Error ? error.message : String(error)
    });
    return true;
  }
}

/**
 * Kill every row `filterPosixChromaOrphans` selects. Split from
 * sweepPosixChromaOrphans so the kill loop itself is unit-testable without a
 * real `ps` — the enumerator is the only part that needs a live machine.
 */
export async function sweepPosixChromaOrphansFrom(
  rows: PosixProcRow[],
  selfPid: number = process.pid
): Promise<{ killed: number[] }> {
  if (process.platform === 'win32' || !(await sweepEnabled())) return { killed: [] };

  const candidates = filterPosixChromaOrphans(rows, selfPid);
  const killed: number[] = [];

  for (const candidate of candidates) {
    // Belt and braces on top of filterPosixChromaOrphans' pid > 1 test: never
    // signal ourselves, whatever `ps` claimed.
    if (candidate.pid === process.pid) continue;
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

/**
 * Enumerate with `ps`, then sweep. `rows` is injectable for tests.
 *
 * sweepEnabled() is consulted here as well as inside sweepPosixChromaOrphansFrom
 * purely so a disabled sweep does not fork `ps` at all; the authoritative gate
 * is the one in ...From, which is where the unit tests exercise it. Both reads
 * happen at most once per worker boot.
 */
export async function sweepPosixChromaOrphans(
  selfPid: number = process.pid,
  rows?: PosixProcRow[]
): Promise<{ killed: number[] }> {
  if (process.platform === 'win32' || !(await sweepEnabled())) return { killed: [] };
  return sweepPosixChromaOrphansFrom(rows ?? listPosixProcesses(), selfPid);
}
