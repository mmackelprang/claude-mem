# [P0] Windows Orphaned Listening-Socket Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Windows worker's listening socket (`127.0.0.1:37777`) from being inherited by the `chroma-mcp`/`uvx` child chain — so a worker death no longer leaves a dead-PID process holding the port `LISTENING`, killing every subsequent worker start with `EADDRINUSE`; and add the defense-in-depth (real bind probe, orphan reaper, visible bind error, crash-loop liveness) that would have surfaced this in seconds instead of a day.

**Architecture:** Root-cause first — mark the HTTP listen socket non-inheritable at `Server.listen()` time on Windows/Bun (spike-gated because Bun's socket-inheritance behavior is unverified, so a reproduction harness is built first and gates the fix behaviorally). Then four independent defense-in-depth layers: (1) delete the win32 special-case in `isPortInUse()` so all platforms use a real `net` bind probe; (2) surface the real bind error (and fix the `worker:logs` script pointing at the wrong log file); (3) reap orphaned `chroma-mcp`/`python`/`uv`/`uvx` descendants by **image + command-line + age** (not by PPID tree, which cannot reach re-parented/orphaned grandchildren) when a bind fails on a dead-but-bound port, then retry the bind once; (4) a local crash-loop liveness signal that fails loud after repeated dead starts.

**Tech Stack:** TypeScript, **Bun** runtime (`worker-wrapper.cjs` → `bun.exe` → `worker-service.cjs`), Node-compat `http`/`net`, `child_process`/`Bun.spawnSync`, `powershell.exe` + `Get-CimInstance Win32_Process` for Windows process introspection (wmic is removed on Windows 11), `bun test` (`bun:test`).

## ⚖️ RE-SCOPED to recovery-only (2026-07-16, Mark's call) — Task 2 DROPPED

**What shipped is Tasks 3–6 (defense-in-depth recovery), NOT Task 2 (prevention).** Task 1's harness (retained) ran the reproduction across **12 runs / 4 spawn configs** escalating to production fidelity — including production's exact `cross-spawn` `stdio:['pipe','pipe','inherit']` path — and returned **`RESULT: PORT_FREE` every time**: the "Bun leaks the listening socket to the chroma-mcp child" premise does **not** reproduce on this box / **Bun 1.3.5**. A grandchild can only inherit a handle the *direct* child received, so the deep `uvx→uv→chroma-mcp→python` chain cannot leak what the worker→uvx spawn provably does not. That makes **Task 2 (`makeListenSocketNonInheritable`) unverifiable and it is DROPPED** — not implemented, not stubbed. If the leak is ever reproduced on a future Bun, re-open Task 2 with the harness as the gate.

**Shipped (recovery-only, this PR):**
- **Task 3** — delete the win32 `isPortInUse` HTTP branch → real `net` bind probe on all platforms. Also **greens the 4 failing `HealthMonitor > isPortInUse` tests (Backlog #7)** — they mock `net.createServer`, which the win32 branch never called.
- **Task 4** — surface the real bind error on `worker start` (`describeStartFailure`) + fix `package.json` `worker:logs`/`worker:tail` (they tailed `worker-<date>.log`, which the logger never writes; real errors go to `claude-mem-<date>.log`).
- **Task 5** — orphan reaper (`reapOrphanedChroma`) by **image + command-line + age** (NOT PPID tree) on a dead-but-bound `EADDRINUSE`, then retry the bind once. Win32-only; only reachable after the live-worker-healthy path has exited, so a healthy worker's chroma is never touched. Validated against a **synthetic** orphan (spawn → enumerate via CIM → match → `taskkill /F` → port freed), never against the live chroma.
- **Task 6** — local crash-loop liveness signal (`buildCrashLoopDiagnosis`), emitted once per streak at the fail-loud threshold. (The docker-compose worker `healthcheck:` remains **Backlog #11's** deliverable, not this PR.)

**Merge posture:** the reaper kills processes (a risk trigger), so this PR is **opened and left for Mark to merge** — NOT auto-merged.

**Task 2 below is retained for the record but marked DROPPED.** Tasks 1, 3, 4, 5, 6 shipped as written.

## Global Constraints

- **This bug reproduces ONLY on real Windows under Bun.** Upstream CI fakes `platform:'win32'` on Linux, which is precisely the blind spot that hid it. Every fix that changes Windows behavior gets a **real-Windows UAT step** (run on Mark's box) in addition to any `bun test` unit test. Unit tests that would bind real ports or shell to PowerShell are `describe`/`it`-gated to `process.platform === 'win32'` and skipped elsewhere, mirroring the project's "`.skip` off-platform, run locally pre-merge" convention.
- **The worker runs under Bun, not Node.** `plugin/scripts/worker-wrapper.cjs` is `#!/usr/bin/env bun` and spawns the inner worker with `process.execPath` (= `bun.exe`) and `stdio:["inherit","inherit","inherit","ipc"]`. Node's own listening sockets are already non-inheritable on Windows (libuv sets `WSA_FLAG_NO_HANDLE_INHERIT`); **Bun's are the unknown** — Task 1's harness settles it empirically before Task 2 trusts any mechanism.
- **Runtime path is exact:** `Server.listen(port, host)` (`src/services/server/Server.ts:140-157`) calls `http.createServer(this.app)` (`:142`) then `server.listen(port, host)` (`:155`). `WorkerService.start()` (`src/services/worker-service.ts:398-431`) binds the port at `:417` **before** `initializeBackground()` (`:437`) ever constructs `ChromaMcpManager` (`:496`, "connects on first use") — so the socket is open and inheritable well before, and on every reconnect after, chroma is spawned.
- **The port default is `37777`** via `getWorkerPort()` (`src/shared/worker-utils.ts:126`, reads `CLAUDE_MEM_WORKER_PORT`). Never hardcode `37777` in product code — call `getWorkerPort()`. The harness (a standalone script) MAY hardcode it.
- **`Server` is shared by two runtimes.** `Server.listen()` runs under Bun in the local worker AND under Node in the server runtime (`src/server/runtime/ServerService.ts:212`). Any Windows/Bun-only code MUST be a strict no-op on non-win32 and MUST NOT `import 'bun:ffi'` at module top level (that import does not exist under Node) — lazy-load it inside a `process.platform === 'win32'` guard wrapped in try/catch.
- **Reuse the established Windows process-introspection seam.** `src/supervisor/process-registry.ts:75-93` already shells `spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', '(Get-CimInstance Win32_Process ...)'], { windowsHide:true, timeout:5000, env:{...sanitizeEnv(process.env), LC_ALL:'C', LANG:'C' } })`. The orphan reaper follows this exact pattern. Do not reintroduce `wmic`.
- **Test runner is `bun test`** (`import { describe, it, expect } from 'bun:test'`). Run a single file with `bun test tests/path/file.test.ts`.
- **Branch + PR policy (CLAUDE.md):** Builder branches from `main`; the implementation PR targets **`fork/main`** (`gh pr create --repo mmackelprang/claude-mem --base main`). **Never push to `origin`** — `git remote get-url --push origin` must read `DISABLED_UPSTREAM_DO_NOT_PUSH` before any push. One PR for this queue row (#17); the tasks below are individually committable within it.
- **Do not edit `CHANGELOG.md`** (auto-generated, per project CLAUDE.md).
- **Coordination:** Task 3 removes the win32 branch that the 4 failing `HealthMonitor > isPortInUse` tests trip over (Backlog #7). Land Task 3's test update together with those 4 so the cluster goes green in the same PR. The docker-compose `claude-mem-worker` healthcheck is **Backlog #11's** deliverable, NOT this PR — Task 6 here adds only the *local* worker's crash-loop signal.

---

### Task 1: Reproduction harness (empirical anchor + regression gate)

The whole fix hinges on an unverified claim: *Bun's listening socket is inheritable on Windows and leaks to the `chroma-mcp` child.* Build a standalone harness that proves the leak on the current (buggy) build and, with a flag, verifies the Task-2 fix closes it. Every later task's "did it actually work on Windows?" question routes back to this script.

**Files:**
- Create: `scripts/repro/orphaned-socket-repro.ts` (standalone Bun script; subcommands `orchestrate` (default) / `parent` / `child`)
- Create: `docs/ops/2026-07-16-orphaned-socket-repro.md` (run procedure + expected before/after output)

**Interfaces:**
- Consumes: nothing yet. In Task 2 it will import `makeListenSocketNonInheritable` from `src/services/infrastructure/socket-inherit.js` **only when** `process.env.REPRO_APPLY_FIX === '1'` (dynamic `import()` inside the `parent` subcommand, so Task 1 runs before that module exists).
- Produces: exit code `0` + stdout line `RESULT: PORT_FREE` when the port is released after the parent dies (fixed/expected), or exit code `1` + `RESULT: PORT_HELD_BY_ORPHAN pid=<n>` when the leak reproduces. Later tasks assert on these exact tokens.

- [ ] **Step 1: Write the harness script**

```ts
// scripts/repro/orphaned-socket-repro.ts
//
// Windows/Bun listening-socket inheritance reproduction.
// Run: bun scripts/repro/orphaned-socket-repro.ts            (repro the leak)
//      REPRO_APPLY_FIX=1 bun scripts/repro/orphaned-socket-repro.ts   (verify the fix)
//
// Mechanism under test: a parent binds 127.0.0.1:PORT, then spawns a child with
// piped stdio (which forces bInheritHandles=TRUE on Windows). The orchestrator
// kills ONLY the parent (taskkill /PID <parent> /F, NOT /T) to simulate an
// unexpected worker death, then probes the port. If the child kept the inherited
// listening socket alive, the port stays LISTENING held by a process that is not
// accepting -> the exact production failure.
import http from 'http';
import net from 'net';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

const PORT = 37799; // deliberately NOT 37777 so the harness never fights a real worker
const HOST = '127.0.0.1';
const PIDFILE = path.join(os.tmpdir(), 'orphaned-socket-repro.pids.json');
const SELF = path.resolve(process.argv[1]);

function probePortHeld(): Promise<boolean> {
  // Real bind probe: true == something holds the port (EADDRINUSE).
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE'));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(PORT, HOST);
  });
}

async function runParent(): Promise<void> {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve());
    server.listen(PORT, HOST);
  });

  if (process.env.REPRO_APPLY_FIX === '1') {
    // Task 2 target. Dynamic import so Task 1 runs before the module exists.
    const mod = await import('../../src/services/infrastructure/socket-inherit.js');
    mod.makeListenSocketNonInheritable(server);
    console.error('[parent] applied makeListenSocketNonInheritable');
  }

  // Spawn a stand-in "chroma-mcp": a child that sleeps, with PIPED stdio so
  // Windows uses bInheritHandles=TRUE (the condition under which an inheritable
  // socket leaks). Under Bun this mirrors StdioClientTransport's spawn.
  const child: ChildProcess = spawn(process.execPath, [SELF, 'child'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  fs.writeFileSync(PIDFILE, JSON.stringify({ parent: process.pid, child: child.pid }));
  console.error(`[parent] pid=${process.pid} child=${child.pid} listening on ${HOST}:${PORT}`);
  // Hold open until killed by the orchestrator.
  setInterval(() => {}, 1 << 30);
}

function runChild(): void {
  // The inheriting stand-in: do nothing, keep any inherited handles open.
  console.error(`[child] pid=${process.pid} alive`);
  setInterval(() => {}, 1 << 30);
}

async function orchestrate(): Promise<number> {
  if (process.platform !== 'win32') {
    console.error('SKIP: this harness only reproduces on real Windows under Bun');
    return 0;
  }
  try { fs.rmSync(PIDFILE, { force: true }); } catch { /* fine */ }

  const parent = spawn(process.execPath, [SELF, 'parent'], { stdio: 'inherit', windowsHide: true });

  // Wait for the pidfile the parent writes once it is listening + has spawned the child.
  const deadline = Date.now() + 10_000;
  let pids: { parent: number; child: number } | null = null;
  while (Date.now() < deadline) {
    try { pids = JSON.parse(fs.readFileSync(PIDFILE, 'utf-8')); if (pids?.child) break; } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!pids?.child) { console.error('FATAL: parent never became ready'); parent.kill(); return 2; }

  // Kill ONLY the parent (simulate unexpected worker death). /F not /T: the child survives.
  spawnSync('taskkill', ['/PID', String(pids.parent), '/F'], { windowsHide: true });
  await new Promise((r) => setTimeout(r, 1500)); // let the OS settle

  const held = await probePortHeld();
  let result: string;
  let code: number;
  if (held) {
    result = `RESULT: PORT_HELD_BY_ORPHAN pid=${pids.child}`;
    code = 1;
  } else {
    result = 'RESULT: PORT_FREE';
    code = 0;
  }
  console.log(result);

  // Cleanup: always kill the surviving child so the harness leaves nothing behind.
  spawnSync('taskkill', ['/PID', String(pids.child), '/T', '/F'], { windowsHide: true });
  try { fs.rmSync(PIDFILE, { force: true }); } catch { /* fine */ }
  return code;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'orchestrate';
  if (mode === 'parent') return runParent();
  if (mode === 'child') return runChild();
  process.exit(await orchestrate());
}

void main();
```

- [ ] **Step 2: Run it against the current (buggy) build on Windows**

Run (on Mark's Windows box): `bun scripts/repro/orphaned-socket-repro.ts`
Expected on the buggy build: last stdout line is `RESULT: PORT_HELD_BY_ORPHAN pid=<n>`, exit code `1`. **This is the reproduction.** If instead it prints `RESULT: PORT_FREE`, STOP and report — the root-cause premise (Bun leaks the socket) is wrong for this build, and Task 2 must be re-scoped before proceeding.

- [ ] **Step 3: Write the run procedure doc**

Create `docs/ops/2026-07-16-orphaned-socket-repro.md` documenting: the command, the two modes (`REPRO_APPLY_FIX` unset vs `=1`), the expected `RESULT:` line in each state, that it uses port `37799` (not `37777`) so it never disturbs a live worker, and the manual cleanup fallback (`taskkill /PID <child> /T /F`) if the harness is interrupted.

```markdown
# Orphaned listening-socket reproduction (Windows/Bun)

## Reproduce the leak (buggy build)
`bun scripts/repro/orphaned-socket-repro.ts`
Expected: `RESULT: PORT_HELD_BY_ORPHAN pid=<n>` (exit 1).

## Verify the fix (Task 2 applied)
`REPRO_APPLY_FIX=1 bun scripts/repro/orphaned-socket-repro.ts`
Expected: `RESULT: PORT_FREE` (exit 0).

Notes: uses 127.0.0.1:37799 (never 37777). On non-Windows it prints `SKIP` and exits 0.
If interrupted, clean up any leftover child: `taskkill /PID <child> /T /F`.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/repro/orphaned-socket-repro.ts docs/ops/2026-07-16-orphaned-socket-repro.md
git commit -m "test(win): add orphaned listening-socket reproduction harness"
```

---

### Task 2: Root cause — mark the listen socket non-inheritable (Windows/Bun) — ⛔ DROPPED (not reproducible on Bun 1.3.5; see the re-scope banner above)

> **DROPPED 2026-07-16.** Task 1's harness proved the prevention premise does not reproduce (12 runs / 4 configs = `PORT_FREE`). This section is retained for the record only — none of it was implemented. Recovery (Tasks 3–6) makes the symptom self-healing regardless.

Prevent every `chroma-mcp`/`uvx` spawn (initial and every reconnect) from inheriting the HTTP listen socket. **Reordering "bind after spawning children" is NOT sufficient and is explicitly rejected as the primary fix:** chroma is spawned lazily on first search and re-spawned on every transport reconnect (`ChromaMcpManager` `RECONNECT_BACKOFF_MS = 10_000`, `connectInternal`), each time while the server socket is open — so it would re-inherit on every reconnect. Only clearing the handle's inherit flag closes it for good.

**Files:**
- Create: `src/services/infrastructure/socket-inherit.ts`
- Modify: `src/services/server/Server.ts:148-152` (call the helper inside `onListening`, before `resolve()`)
- Test: `tests/infrastructure/socket-inherit.test.ts`
- Regression gate: `scripts/repro/orphaned-socket-repro.ts` from Task 1 (behavioral)

**Interfaces:**
- Produces: `export function makeListenSocketNonInheritable(server: import('http').Server): void` — strict no-op on non-win32 and on any error (never throws; logs at debug/warn). Consumed by `Server.listen()` and by the Task-1 harness.

- [ ] **Step 1 (SPIKE — required before trusting the implementation): discover the socket handle under Bun/Windows**

The one thing not verifiable off-Windows: how to reach the OS socket handle from a Node-compat `http.Server` under Bun. Add a throwaway probe to the top of `runParent()` in the harness (temporarily), run it on Windows, and record the shape:

```ts
// TEMP spike probe — delete after recording output.
const h = (server as any)._handle;
console.error('[spike] _handle keys:', h && Object.keys(h));
console.error('[spike] _handle.fd:', h && h.fd);
console.error('[spike] typeof Bun:', typeof (globalThis as any).Bun);
```

Run: `bun scripts/repro/orphaned-socket-repro.ts parent` (Ctrl-C after the spike lines print).
Record which accessor yields a usable Windows `HANDLE`/`SOCKET` value (commonly `server._handle.fd`; under Bun it may be a different key). Use that accessor in Step 3's `getListenSocketHandle`. **If no accessor exposes a usable handle**, do NOT fabricate one — record it, skip to the fallback in Step 6, and proceed to Tasks 3-5 which guarantee recovery even when prevention is impossible.

- [ ] **Step 2: Write the test (win32-gated unit + behavioral harness gate)**

```ts
// tests/infrastructure/socket-inherit.test.ts
import { describe, it, expect } from 'bun:test';
import http from 'http';
import { makeListenSocketNonInheritable } from '../../src/services/infrastructure/socket-inherit.js';

describe('makeListenSocketNonInheritable', () => {
  it('is a no-op that never throws on a listening server (all platforms)', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    expect(() => makeListenSocketNonInheritable(server)).not.toThrow();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('never throws when handed a server with no handle', () => {
    const server = http.createServer(); // not listening -> _handle is null
    expect(() => makeListenSocketNonInheritable(server)).not.toThrow();
  });
});
```

The *behavioral* proof is the Task-1 harness, asserted in Step 5 — a unit test cannot observe handle inheritance across a process kill.

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/infrastructure/socket-inherit.test.ts`
Expected: FAIL — `Cannot find module '.../socket-inherit.js'`.

- [ ] **Step 4: Implement the helper**

```ts
// src/services/infrastructure/socket-inherit.ts
import type http from 'http';
import { logger } from '../../utils/logger.js';

// Windows constant: SetHandleInformation(hObject, HANDLE_FLAG_INHERIT, 0)
// clears the inherit bit so child processes spawned with bInheritHandles=TRUE
// do NOT receive this socket. See MSDN SetHandleInformation.
const HANDLE_FLAG_INHERIT = 0x00000001;

// Extract the raw OS handle from a Node-compat http.Server's TCP handle.
// The exact accessor is confirmed by the Task 2 Step 1 spike on Bun/Windows.
function getListenSocketHandle(server: http.Server): number | null {
  const handle = (server as unknown as { _handle?: { fd?: number } })._handle;
  const fd = handle?.fd;
  if (typeof fd === 'number' && Number.isFinite(fd) && fd >= 0) return fd;
  return null;
}

export function makeListenSocketNonInheritable(server: http.Server): void {
  // Node/libuv already creates listening sockets non-inheritable on Windows
  // (WSA_FLAG_NO_HANDLE_INHERIT); this targets Bun, whose socket is inheritable.
  // Strict no-op everywhere else so the shared Server runtime is unchanged.
  if (process.platform !== 'win32') return;

  const handle = getListenSocketHandle(server);
  if (handle === null) {
    logger.debug('SYSTEM', 'makeListenSocketNonInheritable: no reachable socket handle; skipping', {});
    return;
  }

  try {
    // bun:ffi only exists under Bun; lazy-require inside the win32 guard.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { dlopen, FFIType } = require('bun:ffi') as typeof import('bun:ffi');
    const kernel32 = dlopen('kernel32.dll', {
      SetHandleInformation: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32],
        returns: FFIType.i32,
      },
    });
    // handle value -> pointer-width arg. On Win32 SOCKET/HANDLE fits the ptr slot.
    const ok = kernel32.symbols.SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
    if (ok === 0) {
      logger.warn('SYSTEM', 'SetHandleInformation returned 0 (failed) for listen socket', { handle });
    } else {
      logger.info('SYSTEM', 'Listen socket marked non-inheritable (Bun/Windows)', { handle });
    }
    kernel32.close();
  } catch (error) {
    // Not Bun, no bun:ffi, or the call failed — never fatal. Tasks 3-5 recover.
    logger.warn('SYSTEM', 'makeListenSocketNonInheritable failed (best-effort; reaper still guards)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
```

- [ ] **Step 5: Wire it into `Server.listen()` and prove it with the harness**

In `src/services/server/Server.ts`, import the helper and call it inside `onListening` before `resolve()`:

```ts
// top of file, with the other imports:
import { makeListenSocketNonInheritable } from '../infrastructure/socket-inherit.js';
```

```ts
// inside listen(), replace the existing onListening (currently lines 148-152):
      const onListening = () => {
        server.off('error', onError);
        // Windows/Bun: clear the socket's inherit flag so the chroma-mcp child
        // chain cannot keep :37777 LISTENING after the worker dies (#17).
        makeListenSocketNonInheritable(server);
        logger.info('SYSTEM', 'HTTP server started', { host, port, pid: process.pid });
        resolve();
      };
```

Run the unit test: `bun test tests/infrastructure/socket-inherit.test.ts` → Expected: PASS.
Run the behavioral gate on Windows:
`REPRO_APPLY_FIX=1 bun scripts/repro/orphaned-socket-repro.ts` → Expected: `RESULT: PORT_FREE` (exit 0).
Re-run without the flag to confirm the harness still reproduces the leak (`RESULT: PORT_HELD_BY_ORPHAN`), proving the harness discriminates fixed vs unfixed.

- [ ] **Step 6 (fallback, only if the Step-1 spike found no reachable handle):** leave `getListenSocketHandle` returning `null` (helper becomes a logged no-op), file a Bun upstream issue titled "listening socket inheritable on Windows (missing WSA_FLAG_NO_HANDLE_INHERIT)", and rely on Tasks 3-5 for guaranteed recovery. Note this outcome in the PR description so reviewers know prevention is deferred to reaping.

- [ ] **Step 7: Commit**

```bash
git add src/services/infrastructure/socket-inherit.ts src/services/server/Server.ts tests/infrastructure/socket-inherit.test.ts
git commit -m "fix(win): mark worker listen socket non-inheritable so chroma-mcp cannot orphan :37777 (#17)"
```

---

### Task 3: Real bind probe on all platforms (delete the win32 special case)

`isPortInUse()` on win32 currently does an HTTP `/api/health` check instead of a real bind probe (`src/services/infrastructure/HealthMonitor.ts:35-48`), so a dead-but-bound port reads as **free** on Windows — the one platform this bug bites — making the "port in use but worker not responding → dead" diagnosis unreachable there. Delete the branch; use `net.createServer()` on all platforms. This ALSO fixes the 4 failing `HealthMonitor > isPortInUse` tests in Backlog #7: those tests mock `net.createServer` and assert it was called, but the win32 branch never calls it (it takes the `fetch` path), so the assertions fail on Windows. Removing the branch makes the mocks intercept again.

**Files:**
- Modify: `src/services/infrastructure/HealthMonitor.ts:35-48` (remove the `if (process.platform === 'win32')` block)
- Test: `tests/infrastructure/health-monitor.test.ts` (existing `isPortInUse` block goes green; add one win32-intent assertion)

**Interfaces:**
- Produces: `isPortInUse(port: number): Promise<boolean>` — unchanged signature; now returns `true` for a dead-but-bound port on every platform.

- [ ] **Step 1: Add a test asserting win32 uses the bind probe**

Add to the `describe('isPortInUse', ...)` block in `tests/infrastructure/health-monitor.test.ts`:

```ts
    it('uses the net bind probe on all platforms (no win32 HTTP special-case)', async () => {
      // A dead-but-bound port must read as IN USE everywhere. The mock reports
      // EADDRINUSE; if a win32 HTTP branch existed it would never call createServer.
      const createServerMock = mock(() => ({
        once: mock((event: string, cb: Function) => {
          if (event === 'error') setTimeout(() => cb({ code: 'EADDRINUSE' }), 0);
        }),
        listen: mock(() => {}),
      }));
      const spy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const result = await isPortInUse(37777);

      expect(result).toBe(true);
      expect(net.createServer).toHaveBeenCalled(); // fails today on win32 (fetch path)
      spy.mockRestore();
    });
```

- [ ] **Step 2: Run the test to verify it fails (on win32)**

Run: `bun test tests/infrastructure/health-monitor.test.ts`
Expected on Windows: the new test (and the 4 pre-existing `isPortInUse` tests) FAIL because the win32 branch bypasses `net.createServer`.

- [ ] **Step 3: Delete the win32 branch**

In `src/services/infrastructure/HealthMonitor.ts`, replace the body of `isPortInUse` (currently lines 35-65, the `if (process.platform === 'win32') { ... }` block plus the `return new Promise(...)` below it) with just the bind probe:

```ts
export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const workerHost = getWorkerHost();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, workerHost);
  });
}
```

(The `formatHostForUrl` import is still used by the health/readiness/shutdown paths below, so leave it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/infrastructure/health-monitor.test.ts`
Expected: PASS — the new test plus all 4 previously-failing `isPortInUse` tests are green.

- [ ] **Step 5: Commit**

```bash
git add src/services/infrastructure/HealthMonitor.ts tests/infrastructure/health-monitor.test.ts
git commit -m "fix(win): use real net bind probe in isPortInUse on all platforms; re-enable dead-port diagnosis (#17, closes HealthMonitor cluster of #7)"
```

---

### Task 4: Surface the real bind error + fix the log-file split

Today a port-conflict start returns the fixed string `Failed to start worker` (`src/services/worker-service.ts:1026`) while the real error — `logger.failure('SYSTEM', 'Worker failed to start', ...)` with the `EADDRINUSE` — goes to `~/.claude-mem/logs/claude-mem-<date>.log` (`src/utils/logger.ts:116`; the daemon is spawned detached with `stdio:['ignore','ignore','ignore']` at `src/shared/worker-utils.ts:482-483`, so that log is the *only* record). Worse, `package.json:67-68` (`worker:logs`/`worker:tail`) tail `worker-$(date).log` — a filename the logger never writes — so the obvious diagnostic command shows an empty file. Fix both.

**Files:**
- Modify: `src/services/worker-service.ts` (the `case 'start':` block, currently `:1023-1031`)
- Modify: `package.json:67-68` (`worker:logs`, `worker:tail`)
- Modify: `src/services/worker-service.ts:1409` (enrich the daemon-side failure message)
- Test: `tests/cli/worker-start-error-message.test.ts`

**Interfaces:**
- Consumes: `isPortInUse` (Task 3), `getWorkerPort`, `paths.logsDir()`.
- Produces: helper `export async function describeStartFailure(port: number): Promise<string>` in `src/services/worker-service.ts` — returns an actionable message. Consumed by the `start` case.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/worker-start-error-message.test.ts
import { describe, it, expect } from 'bun:test';
import { describeStartFailure } from '../../src/services/worker-service.js';

describe('describeStartFailure', () => {
  it('names the held port and points at the real log file when the port is occupied', async () => {
    // Occupy the port with a real listener so isPortInUse() sees it in use.
    const net = await import('net');
    const holder = net.createServer();
    const port = 37788;
    await new Promise<void>((r) => holder.listen(port, '127.0.0.1', () => r()));
    try {
      const msg = await describeStartFailure(port);
      expect(msg).toContain(String(port));
      expect(msg.toLowerCase()).toContain('in use');
      expect(msg).toContain('claude-mem-'); // points at the correct log file name
    } finally {
      await new Promise<void>((r) => holder.close(() => r()));
    }
  });

  it('falls back to a generic-but-logged message when the port is free', async () => {
    const msg = await describeStartFailure(37787);
    expect(msg).toContain('claude-mem-'); // still points at the log
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/cli/worker-start-error-message.test.ts`
Expected: FAIL — `describeStartFailure` is not exported.

- [ ] **Step 3: Implement `describeStartFailure` and use it in the `start` case**

Add near the other exported helpers in `src/services/worker-service.ts`:

```ts
export async function describeStartFailure(port: number): Promise<string> {
  const today = new Date().toISOString().slice(0, 10); // yyyy-mm-dd, matches logger.ts
  const logHint = `see ~/.claude-mem/logs/claude-mem-${today}.log`;
  try {
    if (await isPortInUse(port)) {
      return `Worker failed to start: port ${port} is in use but not responding to health checks — ` +
        `likely an orphaned chroma-mcp/python process holding the inherited socket. ` +
        `Run \`claude-mem worker stop\` (or kill the chroma-mcp chain), then retry. ${logHint}.`;
    }
  } catch {
    // fall through to the generic message
  }
  return `Failed to start worker — ${logHint}.`;
}
```

Replace the `start` case (`src/services/worker-service.ts:1023-1031`):

```ts
    case 'start': {
      const result = await ensureWorkerStarted(port);
      if (result === 'dead') {
        exitWithStatus('error', await describeStartFailure(port));
      } else {
        exitWithStatus('ready', result === 'warming' ? 'Worker started; still warming up' : undefined);
      }
      break;
    }
```

Enrich the daemon-side failure log (`src/services/worker-service.ts:1409`) so the log file itself names the port:

```ts
        logger.failure('SYSTEM', `Worker failed to start (port ${port})`, {}, error as Error);
```

- [ ] **Step 4: Fix the log-file names in `package.json`**

Change lines 67-68 from `worker-$(date +%Y-%m-%d).log` to `claude-mem-$(date +%Y-%m-%d).log`:

```json
    "worker:logs": "tail -n 50 ~/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log",
    "worker:tail": "tail -f ~/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log",
```

(Also corrects the pre-existing `tail -f 50` typo — `-f` takes no count.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/cli/worker-start-error-message.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/worker-service.ts package.json tests/cli/worker-start-error-message.test.ts
git commit -m "fix: surface real bind error on worker start + point worker:logs at claude-mem-<date>.log (#17)"
```

---

### Task 5: Reap the orphan on a dead-but-bound `EADDRINUSE`, then retry the bind

When bind fails with `EADDRINUSE` and the port is held by a non-responsive (dead-but-bound) process, kill the surviving `chroma-mcp`/`python`/`uv`/`uvx` orphans **by image + command-line + age**, not by PPID tree. `ChromaMcpManager.killProcessTree` uses `taskkill /PID <pid> /T /F` (`src/services/sync/ChromaMcpManager.ts:969-986`), which walks the *live* parent→child tree; once the worker (and/or uvx) has exited, that chain is broken (Windows does not re-parent orphans to a reaper — the PPID becomes a dangling reference), so `/T` provably cannot reach the surviving grandchildren. Enumerate them independently and kill by PID.

**Files:**
- Create: `src/services/infrastructure/orphan-reaper.ts`
- Modify: `src/services/worker-service.ts:1400-1408` (the daemon `worker.start().catch` EADDRINUSE branch)
- Test: `tests/infrastructure/orphan-reaper.test.ts`

**Interfaces:**
- Consumes: `isPortInUse` (Task 3), `waitForHealth`, `waitForPortFree` (existing, `HealthMonitor`).
- Produces:
  - `export interface ChromaProcess { pid: number; name: string; commandLine: string; createdEpochMs: number }`
  - `export function listChromaOrphanCandidates(nowMs?: number): ChromaProcess[]` — win32-only; `[]` elsewhere.
  - `export async function reapOrphanedChroma(): Promise<{ killed: number[] }>`

- [ ] **Step 1: Write the failing test (win32-gated for the live path, portable for the filter)**

The PowerShell enumeration is win32-only, so unit-test the **pure filter** by exporting it separately, and gate the live call.

```ts
// tests/infrastructure/orphan-reaper.test.ts
import { describe, it, expect } from 'bun:test';
import { filterChromaOrphans, type ChromaProcess } from '../../src/services/infrastructure/orphan-reaper.js';

const rows: ChromaProcess[] = [
  { pid: 1001, name: 'python.exe', commandLine: 'python ... chroma-mcp --client-type persistent --data-dir C:/Users/x/.claude-mem/chroma', createdEpochMs: 1_000 },
  { pid: 1002, name: 'uv.exe',     commandLine: 'uv run --from chroma-mcp==0.2.6 chroma-mcp', createdEpochMs: 1_000 },
  { pid: 1003, name: 'python.exe', commandLine: 'python my_unrelated_script.py', createdEpochMs: 1_000 },
  { pid: 1004, name: 'node.exe',   commandLine: 'node something', createdEpochMs: 1_000 },
];

describe('filterChromaOrphans', () => {
  it('selects only chroma-mcp processes by command-line signature', () => {
    const picked = filterChromaOrphans(rows).map((p) => p.pid).sort();
    expect(picked).toEqual([1001, 1002]); // NOT the unrelated python or node
  });

  it('returns empty for no matches', () => {
    expect(filterChromaOrphans([rows[2], rows[3]])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/infrastructure/orphan-reaper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reaper (modeled on `process-registry.ts:75-93`)**

```ts
// src/services/infrastructure/orphan-reaper.ts
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
// launcher signature. Matching by command line (not PPID tree) is the point:
// the tree is already broken once the worker/uvx died.
const CHROMA_SIGNATURE = /chroma-mcp/i;

export function filterChromaOrphans(rows: ChromaProcess[]): ChromaProcess[] {
  return rows.filter((p) => CHROMA_SIGNATURE.test(p.commandLine));
}

export function listChromaOrphanCandidates(_nowMs: number = Date.now()): ChromaProcess[] {
  if (process.platform !== 'win32') return [];
  // Emit pid|name|commandline|creation-epoch-ms for every process, JSON per line.
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
  const candidates = filterChromaOrphans(listChromaOrphanCandidates());
  const killed: number[] = [];
  for (const proc of candidates) {
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
```

- [ ] **Step 4: Run the filter test to verify it passes**

Run: `bun test tests/infrastructure/orphan-reaper.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the reaper + one-shot bind retry into the daemon start-failure path**

In `src/services/worker-service.ts`, replace the EADDRINUSE branch of `worker.start().catch(...)` (currently `:1400-1408`). Import the reaper at the top of the file:

```ts
import { reapOrphanedChroma } from './infrastructure/orphan-reaper.js';
```

```ts
      worker.start().catch(async (error) => {
        const isPortConflict = error instanceof Error && (
          (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ||
          /port.*in use|address.*in use/i.test(error.message)
        );
        if (isPortConflict) {
          // A live successor already owns the port -> we are the duplicate; exit clean.
          if (await waitForHealth(port, 3000)) {
            logger.info('SYSTEM', 'Duplicate daemon exiting — another worker already claimed port', { port });
            process.exit(0);
          }
          // Dead-but-bound: the port is held but nothing answers health. Reap the
          // orphaned chroma-mcp chain (by image+cmdline, since taskkill /T cannot
          // reach the re-parented grandchildren) and retry the bind ONCE.
          logger.warn('SYSTEM', 'Port bound but unhealthy — reaping orphaned chroma-mcp before retry', { port });
          const { killed } = await reapOrphanedChroma();
          if (killed.length > 0 && await waitForPortFree(port, 5000)) {
            logger.info('SYSTEM', 'Orphan reaped; retrying worker start once', { port, killed });
            const retry = new WorkerService();
            await retry.start().catch((retryError) => {
              logger.failure('SYSTEM', `Worker failed to start after reaping orphan (port ${port})`, {}, retryError as Error);
              removePidFileIfOwner(process.pid);
              process.exit(1);
            });
            return; // retry.start() succeeded — keep the daemon alive
          }
        }
        logger.failure('SYSTEM', `Worker failed to start (port ${port})`, {}, error as Error);
        removePidFileIfOwner(process.pid);
        process.exit(1);
      });
```

Confirm `waitForHealth` and `waitForPortFree` are already imported in this file (they are used elsewhere in the start path); if not, add them to the existing `HealthMonitor`/`infrastructure` import.

- [ ] **Step 6: Real-Windows UAT**

On Mark's box: with a worker running, kill it uncleanly (`taskkill /PID <worker> /F`) so chroma orphans, confirm `bun scripts/repro/orphaned-socket-repro.ts`-style breakage (port held), then run `claude-mem worker start` and confirm the log shows `Orphan reaped; retrying worker start once` and the worker comes up healthy. Confirm `Get-CimInstance Win32_Process -Filter "Name='python.exe'"` no longer lists a chroma-mcp process.

- [ ] **Step 7: Commit**

```bash
git add src/services/infrastructure/orphan-reaper.ts src/services/worker-service.ts tests/infrastructure/orphan-reaper.test.ts
git commit -m "fix(win): reap orphaned chroma-mcp by image+cmdline on dead-but-bound EADDRINUSE and retry bind once (#17)"
```

---

### Task 6: Local worker crash-loop liveness signal (fail loud)

A repeated dead start (the EADDRINUSE loop) currently reports "worker unreachable" to hooks forever, indistinguishable from a transient miss — ~950 consecutive failed hooks went unnoticed for a day. Add a loud, throttled signal after N consecutive dead starts that names the likely orphan and the log file. **Scope note:** the docker-compose `claude-mem-worker` `healthcheck:` block is Backlog #11's deliverable and is explicitly NOT in this PR; this task is the *local* worker analogue only. Reuse the existing `hook-failures.json` mechanism (`src/shared/worker-utils.ts`, `FAIL_LOUD_DEFAULT_THRESHOLD = 3`, `readHookFailureState`/`getHookFailuresPath`).

**Files:**
- Modify: `src/shared/worker-utils.ts` (extend the existing fail-loud path to emit the orphan-specific diagnosis)
- Test: `tests/infrastructure/worker-crashloop-signal.test.ts`

**Interfaces:**
- Consumes: `isPortInUse` (Task 3), the existing `HookFailureState` (`consecutiveFailures`, `lastFailureAt`) and `FAIL_LOUD_DEFAULT_THRESHOLD`.
- Produces: `export function buildCrashLoopDiagnosis(consecutiveFailures: number, portInUse: boolean, port: number): string | null` — returns a message once the threshold is crossed, else `null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/infrastructure/worker-crashloop-signal.test.ts
import { describe, it, expect } from 'bun:test';
import { buildCrashLoopDiagnosis } from '../../src/shared/worker-utils.js';

describe('buildCrashLoopDiagnosis', () => {
  it('returns null below the fail-loud threshold', () => {
    expect(buildCrashLoopDiagnosis(1, true, 37777)).toBeNull();
    expect(buildCrashLoopDiagnosis(2, true, 37777)).toBeNull();
  });

  it('names the orphaned-socket cause once the threshold is crossed and the port is held', () => {
    const msg = buildCrashLoopDiagnosis(3, true, 37777);
    expect(msg).not.toBeNull();
    expect(msg).toContain('37777');
    expect(msg!.toLowerCase()).toContain('orphan');
    expect(msg).toContain('claude-mem-');
  });

  it('gives a generic-but-loud message when the port is not held', () => {
    const msg = buildCrashLoopDiagnosis(3, false, 37777);
    expect(msg).not.toBeNull();
    expect(msg!.toLowerCase()).not.toContain('orphan');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/infrastructure/worker-crashloop-signal.test.ts`
Expected: FAIL — `buildCrashLoopDiagnosis` is not exported.

- [ ] **Step 3: Implement and emit it**

Add to `src/shared/worker-utils.ts` (near the existing fail-loud helpers):

```ts
export function buildCrashLoopDiagnosis(
  consecutiveFailures: number,
  portInUse: boolean,
  port: number,
): string | null {
  if (consecutiveFailures < FAIL_LOUD_DEFAULT_THRESHOLD) return null;
  const today = new Date().toISOString().slice(0, 10);
  const logHint = `see ~/.claude-mem/logs/claude-mem-${today}.log`;
  if (portInUse) {
    return `claude-mem worker has failed to start ${consecutiveFailures}× in a row while port ${port} is held ` +
      `but unresponsive — likely an orphaned chroma-mcp process holding the inherited socket. ` +
      `Run \`claude-mem worker stop\` or kill the chroma-mcp chain, then retry. ${logHint}.`;
  }
  return `claude-mem worker has failed to start ${consecutiveFailures}× in a row. ${logHint}.`;
}
```

At the site that records a hook/start failure (where `readHookFailureState()` is consulted and the counter increments), after computing the incremented `consecutiveFailures`, emit the diagnosis loudly once per crossing:

```ts
const diagnosis = buildCrashLoopDiagnosis(nextState.consecutiveFailures, await isPortInUse(getWorkerPort()), getWorkerPort());
if (diagnosis) {
  logger.failure('SYSTEM', diagnosis);
}
```

(Place this where the failure counter is persisted; `isPortInUse` and `getWorkerPort` are already in scope in this module.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/infrastructure/worker-crashloop-signal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/worker-utils.ts tests/infrastructure/worker-crashloop-signal.test.ts
git commit -m "feat(win): fail loud on worker crash-loop with orphaned-socket diagnosis (#17; local analogue of #11)"
```

---

## Verification

Run all gates before opening the PR. **The Windows-only items (marked 🪟) must run on Mark's real Windows box** — CI cannot reproduce them.

1. **Unit suite (all platforms):** `bun test tests/infrastructure/ tests/cli/` — Task 2/3/4/5/6 unit tests green; the 4 previously-failing `HealthMonitor > isPortInUse` tests (Backlog #7) now green.
2. **Typecheck:** `npm run typecheck` — no new errors.
3. **Build:** `npm run build` — bundles regenerate cleanly (the fixes are in `src/`; the built `plugin/scripts/*.cjs` are regenerated, never hand-edited).
4. 🪟 **Repro discriminates (Task 1/2):** `bun scripts/repro/orphaned-socket-repro.ts` → `RESULT: PORT_HELD_BY_ORPHAN`; `REPRO_APPLY_FIX=1 bun scripts/repro/orphaned-socket-repro.ts` → `RESULT: PORT_FREE`.
5. 🪟 **End-to-end (the original failure):** after `npm run build-and-sync`, kill the running worker uncleanly (`taskkill /PID <worker> /F`), confirm the port is held by an orphan, then run `claude-mem worker start` — it must reap the orphan, retry, and come up healthy (`/api/health` responds). Before Task 2 landed this needed a manual chroma-chain kill; after, it must self-recover.
6. 🪟 **No manual kill needed on clean restart:** run `claude-mem worker restart` three times; every cycle ends healthy, `/api/health` pid changes, no `EADDRINUSE` in `claude-mem-<date>.log`, and `Get-CimInstance Win32_Process` shows at most one chroma-mcp chain afterward.
7. **Diagnostics point at the right place:** `npm run worker:logs` tails `claude-mem-<date>.log` (not the empty `worker-<date>.log`); a forced start failure prints the port-named, log-pointing message rather than the bare `Failed to start worker`.

## Self-Review (completed by Planner)

- **Spec coverage:** Root cause (Task 2) + all four defense-in-depth items from the queue row (real bind probe = Task 3; reaper by image+age = Task 5; surfaced bind error + log split = Task 4; local crash-loop liveness = Task 6). Repro harness (required by the row) = Task 1 and gates Tasks 2/5.
- **Placeholders:** none — every code step is literal. The single genuine unknown (Bun's socket-handle accessor) is isolated to Task 2 Step 1 as an explicit, output-recorded spike with a behavioral acceptance gate and a documented fallback, not a `TBD`.
- **Type consistency:** `makeListenSocketNonInheritable(server: http.Server)`, `isPortInUse(port): Promise<boolean>`, `ChromaProcess`/`filterChromaOrphans`/`reapOrphanedChroma`, `describeStartFailure(port): Promise<string>`, `buildCrashLoopDiagnosis(...)` are used consistently across tasks and call sites.
