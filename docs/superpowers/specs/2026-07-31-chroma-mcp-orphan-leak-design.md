# Design: chroma-mcp orphan leak on every worker restart

**Status:** Approved for planning · **Date:** 2026-07-31 · **Owner:** Planner
**Follows:** Queue `~~17~~` ([PR #21](https://github.com/mmackelprang/claude-mem/pull/21)) — the recovery-only
defense-in-depth that shipped `orphan-reaper.ts`. This spec explains why that reaper **structurally cannot** fire on
the leak reported here, and fixes the actual funnel.
**Reported by:** Mark, 2026-07-31 — reproduced live **twice** in one session.

> **Planner note on process.** This spec was produced in a single non-interactive run, so the usual
> one-question-at-a-time brainstorm did not happen. Every judgement call that would normally have been a question is
> recorded explicitly in **§8 Assumptions** or **§9 Open questions**. Nothing in §8 is load-bearing enough to block
> Builder; everything in §9 is a genuine decision that Mark should make (§9 items are mirrored into the queue row).

---

## 1. Problem

Every worker restart leaks an orphaned `chroma-mcp` process **pair** (a `uv tool uvx` wrapper + its Python child,
~45 MB + ~92 MB RSS). The pair survives the outgoing worker, reparents, and is then referenced by nothing — not by
`supervisor.json`, not by any process tree. Over days these accumulate silently until the box is out of RAM.

`npm run build-and-sync` ends in a worker restart, so **every build leaks a pair.**

### 1.1 Live evidence (measured on Mark's WSL box, 2026-07-31)

Before any action, two pairs were alive: `5753 → 5778` (tracked) and `16095 → 16116` (**untracked**, from the previous
evening). `supervisor.json` held exactly one `chroma-mcp` slot, pointing at the newer pid — `16095`'s pair was owned by
nothing.

After killing the untracked pair and running `npm run build-and-sync` (worker `5588` → `7127`), **the leak reproduced
immediately**: new pair `7241 → 7264` spawned and took over the `supervisor.json` slot, while the old pair `5753/5778`
stayed alive with its parent gone.

### 1.2 The measured shutdown log — this is the load-bearing evidence

Correlating every shutdown in `~/.claude-mem/logs/claude-mem-2026-07-{30,31}.log`:

| Time | reason | Graceful chain outcome | `Stopping Chroma MCP connection...` logged? | Leak? |
|---|---|---|---|---|
| 07-30 20:50:25.141 | stop | *(succeeded)* | **YES** — 1 ms later, completed in 511 ms | no |
| 07-30 20:59:22.346 | stop | *(succeeded)* | **YES** — same millisecond, completed in 515 ms | no |
| 07-30 21:09:10.910 | `stop` | **FAILED** — `Server is not running.` | **NO** | yes |
| 07-31 08:05:15.020 | `restart` | **FAILED** — `Server is not running.` | **NO** | yes → pair `5753/5778` |
| 07-31 08:18:44.936 | `restart` | **FAILED** — `Server is not running.` | **NO** | yes → pair `7241/7264` |

Two facts fall straight out, and both are **corrections to the obvious hypotheses**:

- **This is NOT the 10-second graceful deadline.** The elapsed time from `Shutdown initiated` to
  `Graceful shutdown failed — proceeding` is **1 millisecond** (`08:18:44.935` → `08:18:44.936`). The successor was
  spawned **3 ms** later (`08:18:44.939`). `Graceful shutdown deadline exceeded` appears **nowhere** in either log.
  A reviewer reading `worker-shutdown.ts:19-21` (*"session drain has been observed at 35-40s"*) against
  `gracefulDeadlineMs: getPlatformTimeout(10000)` (`worker-service.ts:787`) will reasonably conclude the deadline is
  the culprit. **It is not, for these reproductions.** It remains a real *second* bypass (§2, D1b) and the fix must
  close it too — but Builder must not "fix the deadline" and declare victory.
- **`ChromaMcpManager.stop()` is fast and correct.** When it runs, it completes in ~510 ms. The teardown code is not
  broken; **it is simply never called.**

---

## 2. Root cause — a five-link chain, all links verified in source

### D1 — the graceful chain forfeits chroma teardown when any earlier step throws *(primary)*

`performGracefulShutdown` (`src/services/infrastructure/GracefulShutdown.ts:30-58`) is an **unguarded sequential
`await` chain** of six steps:

1. `closeHttpServer(config.server)` (`:34`)
2. `config.sessionManager.shutdownAll()` (`:38`)
3. `config.mcpClient.close()` (`:41`)
4. **`config.chromaMcpManager.stop()` (`:45-49`)** ← the tree-kill
5. `config.dbManager.close()` (`:52`)
6. `getSupervisor().stop()` (`:55`)

There is no `try`/`catch` anywhere in the function. **A rejection at step *N* forfeits steps *N+1..6*.**

Step 1 rejects. `closeHttpServer` (`:60-75`) calls `server.closeAllConnections()` then
`server.close(err => err ? reject(err) : resolve())`; Node rejects with `ERR_SERVER_NOT_RUNNING` — message exactly
`"Server is not running."` — when the server is not listening. That is the string in the log, 3 times out of 5.

The rejection is then swallowed by design: `runShutdownSequence` (`src/services/worker-shutdown.ts:96-119`) races
`performGracefulShutdown()` against the deadline and maps a rejection to `'graceful-error'`, whose own comment says it
should *"proceed exactly like the deadline path"*. It proceeds → spawns the successor → returns → the HTTP admin route's
`flushResponseThen` (`src/services/server/flushResponseThen.ts:8-14`) runs `finally { process.exit(0) }`.

**`process.exit(0)` runs no further microtasks and no `finally` blocks in the abandoned chain.** Steps 2–6 never
execute. The chroma pair survives.

> **D1b — the same forfeiture via the deadline.** Independently of the throw, `Promise.race` **abandons** the
> in-flight `performGracefulShutdown` promise on deadline expiry. Because chroma teardown is step 4, *behind* a session
> drain the codebase itself documents at 35–40 s (`worker-shutdown.ts:19-21`) against a 10 s budget, a busy box leaks
> by this route too. Not observed in these logs, but structurally guaranteed. **The fix must close D1 and D1b
> together** — closing only one leaves the other.

### D2 — nothing at successor startup reclaims the orphan; the last handle is then destroyed

The successor's `ProcessRegistry.initialize()` (`src/supervisor/process-registry.ts:196-232`) loads the persisted
records and calls `pruneDeadEntries()` (`:227`). That prune removes **only records whose pid is dead**
(`:284`, `if (isPidAlive(info.pid)) continue;`). The leaked chroma pid **is alive**, so the stale record survives the
prune and is carried into the new worker's map — un-reaped and unexamined.

Then the successor's own chroma connects and calls `registerProcess('chroma-mcp', …)`
(`src/services/sync/ChromaMcpManager.ts:1361`, key `CHROMA_SUPERVISOR_ID = 'chroma-mcp'` at `:29`), which is
`this.entries.set(id, processInfo)` (`process-registry.ts:236`) — **a plain `Map.set` on a fixed key**. `persist()`
(`:400-407`) then rewrites the whole file from memory.

`chroma-mcp` is a **single keyed slot, not a list.** The overwrite is the moment the last handle to a live orphan is
destroyed. (Contrast `spawnSdkProcess`, which keys per-pid: `` `sdk:${sessionDbId}:${pid}` `` at `:661`.)

### D3 — the recorded `pgid` is fabricated, and it is wrong

`ChromaMcpManager.ts:1368` records `pgid: chromaProcess.pid`. The comment immediately above it (`:1355-1356`) already
concedes the premise is false:

> *"Note: MCP SDK's StdioClientTransport does NOT use `detached:true`, so the child shares our process group"*

**Verified live via `/proc`:**

```
pid=7127 comm=(bun)    ppid=15952  pgrp=7127  session=7127   ← the worker
pid=7241 comm=(uv)     ppid=7127   pgrp=7127  session=7127   ← recorded as pgid 7241
pid=7264 comm=(python) ppid=7241   pgrp=7127  session=7127   ← the 92 MB leaker, recorded NOWHERE
```

`ps -eo pid,pgid | awk '$2==7241'` returns **empty**: process group 7241 does not exist.

Consequences, both bad:

- The supervisor cascade's `process.kill(-pgid, signal)` (`src/supervisor/shutdown.ts:160-162`) gets `ESRCH` and falls
  through to a **single-PID kill** — which signals only the `uv` wrapper and **orphans the 92 MB Python grandchild**.
  So the cascade is not a safety net; it is a *half*-kill that manufactures a lone orphan.
- The report's framing — *"the record already carries `pgid`, so the information needed to kill the whole group is
  present and simply appears unused"* — is **the one part of the report that is wrong, and it is a trap**. The value is
  present, it is *used* (`supervisor/shutdown.ts:160`), and it is **false**. The *true* pgid is the worker's own group,
  so "just group-kill the recorded pgid, properly this time" would either no-op (`-7241`) or **kill the worker itself**
  (`-7127`). Group-kill is not available here.

`StdioClientTransport` hard-codes its spawn options and exposes **no** `detached` option
(`node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js:65-75`), so "spawn chroma into its own process
group" is not reachable without patching the SDK. The correct primitive is the **`pgrep -P` descendant walk** that
`ChromaMcpManager.killProcessTree` (`:969-1047`) already implements and gets right.

### D4 — the existing orphan reaper is double-gated out of this scenario

`src/services/infrastructure/orphan-reaper.ts` cannot fire here, for **two independent, each-sufficient** reasons:

1. **Windows-only.** `listChromaOrphanCandidates()` opens with `if (process.platform !== 'win32') return [];` (`:60`).
   On WSL/Linux `reapOrphanedChroma()` returns `{ killed: [] }` unconditionally. Enumeration is PowerShell
   `Get-CimInstance`; the kill is `taskkill`.
2. **Only reachable from the dead-but-bound `EADDRINUSE` branch.** Its sole call site is `worker-service.ts:1464`,
   inside `if (isPortConflict)` *and* after `waitForHealth` fails (`:1447-1464`). A normal restart binds the port
   cleanly, so that branch is never entered. **A leaked chroma pair holds RSS but binds nothing** — in this install it
   speaks MCP over stdio and talks HTTP to a *remote* Chroma — so it can never itself produce the `EADDRINUSE` that is
   the reaper's only trigger.

To answer the report's question directly — *"does it only run at a lifecycle point the restart path bypasses? does it
only reap what's in supervisor.json? does it match by pid rather than pgid?"* — the answers are: **yes** to the
lifecycle point; **no**, it never reads `supervisor.json` at all (its only imports are `child_process`, `logger`,
`env-sanitizer`); and it matches by **cmdline + age**, never by pid, pgid, or PPID.

> **Note on the WSL `/init` caveat.** The report's warning that a `PPID === 1` heuristic would be wrong on WSL is
> **correct and confirmed** — orphans reparent to a non-1 `/init` subreaper (this box has `/init` at pids 1, 9, 10,
> 7235, 7236, 15952; the healthy worker `7127` itself has `ppid=15952`). It happens not to bite the *existing* reaper,
> which never looks at parentage. It **must** constrain any new code (§4, Task 4): no ownership test may key on
> `PPID === 1`.

### D5 — restart verification cannot see the leak

`verifyRestartedWorker` (`src/services/restart-verify.ts:86-93`) asserts only that `/api/health` reports a **different
pid** and a **matching version**. A restart that leaks a 137 MB pair verifies as fully successful. This is why the leak
went unnoticed long enough to accumulate.

---

## 3. Fork-vs-upstream ownership constraint (ADR 0002 §9)

The operative rule is the **byte-identity test** (`docs/BUILDER_QUEUE.md:42`, `:73`): a file byte-identical to upstream
`f5633c1f` is *upstream-owned*, and editing it manufactures permanent divergence plus a conflict surface on every
future sync — ADR 0002's explicitly "accepted cost" (`:427-428`), but a cost that requires a decision, not a default.
Files already diverged or fork-created are free to edit; that cost is sunk.

| File | Status vs `f5633c1f` | Free to edit? |
|---|---|---|
| `src/services/infrastructure/orphan-reaper.ts` | **fork-created** (`ce276b13`) | **yes** |
| `scripts/restart-installed-worker.cjs` | **fork-created** (`399c28e1`) | **yes** |
| `src/services/worker-service.ts` | **fork-diverged** (+77/−8) | **yes** |
| `src/services/infrastructure/GracefulShutdown.ts` | **upstream-identical** | no — §9 decision |
| `src/services/worker-shutdown.ts` | **upstream-identical** | no — §9 decision |
| `src/services/sync/ChromaMcpManager.ts` | **upstream-identical** | no — §9 decision |
| `src/services/infrastructure/ProcessManager.ts` | **upstream-identical** | no — §9 decision |
| `src/services/restart-verify.ts` | **upstream-identical** | no — §9 decision |

**This shapes the design decisively.** The three files where the bug most obviously "lives" — `GracefulShutdown.ts`,
`worker-shutdown.ts`, `ChromaMcpManager.ts` — are all upstream-owned. The two entry points we control —
`worker-service.ts` (already diverged) and new fork-created files — are enough to fix it, because `worker-service.ts`
is what **constructs and invokes** the whole shutdown sequence (`:757-803`). **The design below achieves a complete fix
with zero upstream-owned edits**, matching the "zero upstream files edited" rule the test-gate work (`~~37~~`) held to.

---

## 4. Design decision — three options

### Option A — prevention only: fault-isolate the teardown chain

Wrap the six teardown steps so each runs in its own `try`/`catch`, and guarantee chroma teardown runs even on the
deadline/error path.

- **Pro:** fixes the actual root cause (D1 + D1b); smallest conceptual change; no new background behavior.
- **Con:** recovers **nothing** already leaked on Mark's box (the report says these accumulate over days). Cannot
  defend against paths that bypass shutdown handlers entirely — `SIGKILL`, OOM-kill, a crash. Notably, PR #21's
  prevention half was **dropped as non-reproducible**, and its recovery half is what actually shipped; the project's own
  precedent favors recovery.

### Option B — recovery only: reconcile the stale record at startup

At worker startup, before any chroma can register, read the persisted `chroma-mcp` record; if its pid is alive, it is
stale by definition (a freshly-booted worker owns no chroma), so tree-kill it and unregister.

- **Pro:** deterministic; fully fork-ownable; robust against **every** bypass including SIGKILL and crash, which
  prevention can never cover; self-heals on the first restart after deploy.
- **Con:** does not stop the leak being *created*; leaves a window where two pairs are alive. Blind to orphans whose
  record was already overwritten (D2) — i.e. exactly the historical backlog now on Mark's box.

### Option C — layered: prevention + recovery + a bounded POSIX sweep *(recommended)*

A (fix the funnel) + B (reconcile the record) + extend `orphan-reaper.ts` with a POSIX enumerator so the
already-accumulated orphans — the ones with no record left — get swept at startup.

- **Pro:** the only option that both stops the bleeding and cleans up what already leaked. Each layer is independently
  small and independently testable. The three layers fail independently, which is the point of defense in depth.
- **Con:** largest surface; the machine-wide sweep inherits PR #21's documented **SCOPE CAVEAT** (a chroma-mcp
  invocation cannot be scoped by data-dir, because remote `--client-type http` installs carry no `--data-dir`), so on a
  hypothetical two-worker box it could kill a sibling's chroma.

### Recommendation: **Option C**, with the sweep constrained

Take C, but bound the sweep so the caveat is materially narrower than PR #21's:

- Reconciliation (layer B) is **record-scoped** and needs no heuristics — it is exact, and it is the primary net.
- The sweep (layer C) runs **only at worker startup**, only against processes **older than this worker**, and **never**
  against this worker's own descendants. Ownership is determined by **subtree walk + start time**, explicitly
  **not** by `PPID === 1` (D4 note). It ships behind a settings/env kill-switch.

Rationale: layer B alone would leave Mark's existing orphans to be killed by hand forever, and the whole point of the
report is that manual cleanup is the pain. Layer A alone leaves the box dirty and re-leaks on the next SIGKILL.

---

## 5. Fix shape (detail lives in the plan)

All five items are **fork-only**. Literal code for each is in
`docs/superpowers/plans/2026-07-31-chroma-mcp-orphan-leak.md`.

1. **Diagnose the `ERR_SERVER_NOT_RUNNING` trigger** *(diagnostic, gates the rest)*. Establish **why** step 1 rejects
   on 3 of 5 shutdowns. Two named candidates: (a) a Bun `node:http` shim race — `closeAllConnections()` at
   `GracefulShutdown.ts:61` tears down the last socket and the subsequent `close()` observes a non-listening server;
   (b) a genuine double-close. Its intermittency and the fact that it also hit one `reason=stop` shutdown both point at
   (a). **Record the finding in the PR.** If it turns out to be trivially preventable, say so — but **do not** let that
   replace the fix: the design defect is that *one failing step forfeits five others*, and that must be fixed
   regardless of which step failed today.
2. **`resilient-shutdown.ts`** (new, fork-created) — runs the same six steps, each fault-isolated, preserving upstream's
   ordering invariant (chroma before `dbManager.close`, asserted at `tests/infrastructure/graceful-shutdown.test.ts:249`).
   `worker-service.ts:780-786` calls it instead of upstream's `performGracefulShutdown`. **Zero edits to
   `GracefulShutdown.ts`.**
3. **A guaranteed post-sequence chroma teardown** in `worker-service.ts.shutdown()` — after `runShutdownSequence`
   returns and before `flushResponseThen`'s `process.exit(0)`, best-effort tree-kill any chroma still tracked. This is
   what closes **D1b**: it runs even when the raced promise was abandoned.
4. **`reconcileStaleChromaRecord()`** at startup — layer B. Exact, record-scoped.
5. **POSIX enumerator in `orphan-reaper.ts`** — layer C, constrained per §4, behind a kill-switch.

Plus **`process-tree.ts`** (new, fork-created): an exported `killProcessTree(pid)` implementing the `pgrep -P`
descendant walk (POSIX) / `taskkill /T /F` (win32). Needed because `ChromaMcpManager.killProcessTree` is
`private static` and `ChromaMcpManager.ts` is upstream-owned, so it cannot be called or exported without divergence.

---

## 6. Test strategy — no live Chroma, no live remote

**Confirmed:** nothing in `tests/` requires a live Chroma. `fw.appserver.lan` appears exactly once, as an inert fixture
string in `tests/infrastructure/orphan-reaper.test.ts:35`. The one test that could touch real Chroma
(`tests/integration/chroma-vector-sync.test.ts`) self-skips and uses a local temp dir. The regression tests here add no
new external dependency.

**Hard constraint — do not put the regression test in the obvious file.**
`tests/services/worker-shutdown-sequence.test.ts` is quarantined in `tests/known-failures.json` as `nonRunnable`
(`kind: "hang"`), so it contributes **zero observed tests** and the gate never runs it. A regression test added there
would be silently dead. Use a **new file**.

Reusable prior art, both already in-tree:

- `FakeChildProcess` — `tests/services/sync/chroma-mcp-manager-singleton.test.ts:57-86` (fake child with
  `PassThrough` stdio and a controllable `kill()`), together with that file's snapshot-then-restore discipline around
  `mock.module` (`:8-20`, `:280-300`) — bun's `mock.module` is process-global and `mock.restore()` does not undo it.
- The **`process.kill` swap with an `alive: Set<number>`** that throws `ESRCH` on signal 0 —
  `tests/supervisor/shutdown.test.ts:84-101`. This is the cleanest template for asserting a kill cascade with no real
  process, and it records `{pid, signal}` in order.

`tests/preload.ts` already pins `CLAUDE_MEM_DATA_DIR` to a per-run temp dir before any module loads, so
`paths.supervisorRegistry()` can never resolve to the real `~/.claude-mem/supervisor.json` during tests. **Do not
weaken that** — `tests/infrastructure/graceful-shutdown.test.ts:82-96` documents that before this isolation existed,
the test suite SIGTERM'd the developer's own live worker and chroma-mcp.

Required assertions:

1. Chroma teardown **still runs** when step 1 rejects with `ERR_SERVER_NOT_RUNNING` — the direct D1 regression.
2. Chroma teardown **still runs** when `sessionManager.shutdownAll()` rejects — proves isolation is general, not
   special-cased to step 1.
3. Upstream's ordering invariant preserved: chroma teardown strictly before `dbManager.close`.
4. Startup reconciliation tree-kills a **live** stale `chroma-mcp` record and unregisters it.
5. Startup reconciliation is a **no-op** for a dead pid (prune already handles it) and never signals pid ≤ 1.
6. The POSIX orphan filter excludes the current worker's own subtree and anything younger than the worker, and does
   **not** key on `PPID === 1`.

**Live UAT (Mark's box, the acceptance criterion from the report):** capture `ps` before, run
`npm run build-and-sync`, capture `ps` after — **exactly one `chroma-mcp` pair must survive**, and it must be the new
one (its pid must match the `supervisor.json` slot).

---

## 7. Invariant this design protects

> **At most one `chroma-mcp` process tree exists per host per worker, and the `supervisor.json` `chroma-mcp` slot always
> refers to it.** A worker may not exit — by any path, including a failed teardown step, an exceeded deadline, or a
> signal — while leaving a chroma-mcp descendant alive that nothing references.

`ChromaMcpManager.ts:820-830` already states the per-worker half of this as its "singleton invariant". What is missing
is that the invariant is **not enforced across the restart boundary**, which is precisely where it matters.

---

## 8. Assumptions (made without Mark, because this ran non-interactively)

1. **Single-worker box.** Mark runs one claude-mem worker per host, so the machine-wide sweep's SCOPE CAVEAT is
   acceptable — the same call PR #21 already made and Mark already accepted. The kill-switch exists for the day it
   isn't true.
2. **Fork-only is the default.** Zero upstream-owned edits, matching `~~37~~`'s rule. Where that forces a slightly less
   direct implementation (a wrapper rather than a patch to `GracefulShutdown.ts`), the wrapper wins. §9(b) lets Mark
   overrule.
3. **Killing a stale chroma at startup is safe.** A just-booted worker owns no chroma, so a live `chroma-mcp` record is
   unambiguously stale. Chroma is a stateless MCP front-end to a remote store here — killing it loses no data.
4. **Correctness beats reordering.** Chroma teardown stays at step 4 (after the session drain) rather than being
   hoisted to step 1, because in-flight session finalization may still write through chroma. D1b is closed by the
   guaranteed post-sequence teardown (§5 item 3) instead — which is strictly safer than reordering.
5. **The sweep is default-on.** Otherwise the accumulated orphans on Mark's box are never cleaned and the reported pain
   persists. §9(c) flags this for confirmation.
6. **One PR.** The five items are small and interlocking (they share `process-tree.ts` and one test file); splitting
   them would ship a half-fix that still leaks.

## 9. Open questions (for Mark — recorded, not blocking)

- **(a) The `ERR_SERVER_NOT_RUNNING` trigger.** Task 1 identifies it. If it is a Bun shim race, is a targeted
  workaround (e.g. skip `close()` when `server.listening` is already false) worth adding *on top of* the isolation fix,
  or is isolation enough? Planner's view: isolation is the fix; a workaround is optional polish.
- **(b) §9 divergence.** May Builder edit `GracefulShutdown.ts` / `ChromaMcpManager.ts` if the fork-only wrapper proves
  contorted in practice? Planner's recommendation: **no** — stay fork-only; revisit only if Builder reports the wrapper
  is genuinely worse code.
- **(c) Sweep default.** Should the POSIX startup sweep default **on** (cleans Mark's backlog, inherits the SCOPE
  CAVEAT) or **off** (opt-in, safer, leaves the backlog)? Planner's recommendation: **on**, with the kill-switch
  documented.
- **(d) `pgid` (D3).** Should the fabricated `pgid: chromaProcess.pid` be corrected or dropped? It lives in
  upstream-owned `ChromaMcpManager.ts`, and fixing D1 means `stop()` runs so the half-killing cascade becomes
  unreachable in practice. Planner's recommendation: **leave it, document it here, and revisit if the cascade ever
  becomes load-bearing** — it is defense-in-depth, not the leak. Deliberately NOT in scope below.

---

## 10. Explicitly out of scope

- Editing any upstream-owned file (§3) — including "fixing" `pgid` (§9d) or patching `GracefulShutdown.ts` directly.
- Patching or forking `@modelcontextprotocol/sdk` to spawn chroma `detached` (§ D3). Real, but a much larger change.
- The two quarantined test hangs, including `worker-shutdown-sequence.test.ts` — that is **Backlog #39**. This work
  routes *around* the quarantine (§6); it does not lift it.
- Making `restart-verify.ts` assert process hygiene (D5). Tempting, but it is upstream-owned and the live UAT covers
  it.
- Any change to the `EADDRINUSE` dead-but-bound recovery path from `~~17~~`, which is working as designed.
