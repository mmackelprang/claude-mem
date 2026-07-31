# Design: dual-stack loopback bind (`http://localhost:<port>` times out on Windows + WSL2)

- **Status:** Proposed
- **Date:** 2026-07-31
- **Author:** Planner
- **Queue row:** #42 ([P2] bug fix) · follow-up #43
- **Plan:** [`docs/superpowers/plans/2026-07-31-dual-stack-loopback-bind.md`](../plans/2026-07-31-dual-stack-loopback-bind.md)
- **Design handoff:** none — this is a transport/bind defect with no UX surface. `docs/design-handoffs/`
  contains no matching package, and the viewer's markup, layout and copy are untouched.
- **Roadmap:** this repo has **no `docs/ROADMAP.md`**; `docs/BUILDER_QUEUE.md` is the state-of-record and
  was read end-to-end before this spec. Adjacent open rows: **#40** (chroma orphan leak — shares the
  shutdown path), **#41** (capture outage — shares the UID-derived-port hazard, see §8).

---

## 1. Problem

On Windows 11 + WSL2 with **mirrored networking**, opening the claude-mem viewer at
`http://localhost:37777` from a Windows browser fails with `ERR_CONNECTION_TIMED_OUT` after the full TCP
connect timeout. `http://127.0.0.1:37777` works immediately.

### 1.1 Root cause (confirmed empirically — not re-litigated here)

Four facts compose into the symptom:

1. **The worker binds IPv4 loopback only.** `Server.listen()` opens exactly one `http.Server` on the
   single configured host, and `CLAUDE_MEM_WORKER_HOST` defaults to `127.0.0.1`
   (`src/shared/SettingsDefaultsManager.ts:112`). Re-verified on the reporting box while writing this
   spec: `ss -ltn` shows exactly one claude-mem row, `LISTEN 0 512 127.0.0.1:37777`.
2. **Windows resolves `localhost` to `::1` first.** `Resolve-DnsName localhost` returns the `AAAA` record
   (`::1`) ahead of the `A` record (`127.0.0.1`), and Chrome/Edge honour that order.
3. **Nothing listens on `[::1]:37777`**, so the SYN has no acceptor.
4. **The Hyper-V firewall `DefaultInboundAction=Block` *drops* rather than *rejects*.** No RST comes
   back, so the browser cannot fail fast and instead waits out the whole TCP timeout. This is why the
   symptom reads as a hang rather than "connection refused" — and why it looks like a claude-mem outage
   rather than a name-resolution detail.

Verified from Windows: `http://127.0.0.1:37777/health` → 200; `http://[::1]:37777/health` → timeout.

### 1.2 Why this is worth fixing rather than documenting

`http://localhost:<port>` is the URL the installer prints, the docs use, and every user's muscle memory
reaches for. The failure mode is a **silent 30-second hang with no log line on either side** — the worker
never sees a connection, so no amount of worker-side diagnostics can explain it. Telling users "type the
IP instead" leaves a permanently mis-signalling default on the single most common desktop platform.

---

## 2. Scope (decided by Mark — not re-litigated)

**"Core + correctness tail." Automatic when the configured host is loopback; not an opt-in.**

### 2.1 Bind behaviour

| Configured host | Behaviour |
|---|---|
| `127.0.0.1`, `localhost`, `::1` | bind **both** `127.0.0.1` and `::1` |
| `0.0.0.0`, `::`, a LAN address, a hostname | **unchanged** — bind exactly that, nothing added |
| loopback requested but IPv6 unavailable on the box | **WARN and continue on IPv4** — must not fail worker start |

### 2.2 Security invariant (must be enforced by a test, not by inspection)

> `0.0.0.0` and `::` must NEVER be bound as a side effect of this change.

The only way a wildcard address may be bound is if the operator explicitly configured it. The bind-host
resolver is a pure function precisely so this invariant is unit-testable in isolation.

### 2.3 In scope

**Core**

- `src/services/server/Server.ts` — one `http.Server` per bind host over the shared Express app.
- `src/services/worker-service.ts` — log the bound set; hand every listener to shutdown.
- `src/services/infrastructure/GracefulShutdown.ts` — close **all** listeners, not just the first.
- `src/services/worker/http/middleware.ts` — CORS accepts `http://[::1]:<port>`.
- `src/services/worker/http/routes/SettingsRoutes.ts` — host validator accepts `::1`, still rejects `::`.
- `src/services/infrastructure/ProcessManager.ts` — pin the resolved host into the daemon env.
- `src/services/infrastructure/HealthMonitor.ts` — `isPortInUse` probes every bind host.
- `src/shared/SettingsDefaultsManager.ts` — **no change** (see §5, D6: the extra loopback is implicit).

**Correctness tail** — sites that would emit the malformed `http://::1:37777` the moment a host of `::1`
is reachable (which this change makes possible for the first time, because the validator starts accepting
it): `src/services/restart-verify.ts:49`, `src/services/worker-service.ts:1543`,
`src/services/integrations/WindsurfHooksInstaller.ts:269`,
`src/services/integrations/OpenCodeInstaller.ts:183-184`, `src/integrations/opencode-plugin/index.ts:103`,
`src/npx-cli/commands/doctor.ts:37`, `src/npx-cli/commands/runtime.ts:169`, and
`src/services/install/shutdown-helper.ts:10` (which hardcodes `127.0.0.1` and ignores the setting
entirely). Plus the copy-pasted `formatHostForUrl` in `HealthMonitor.ts:15-18`, deduped against the
canonical one.

### 2.4 Out of scope (deliberately deferred → queue row #43)

The ~8 **display-only** hardcoded `localhost` strings: `src/cli/handlers/user-message.ts:62`,
`src/cli/handlers/context.ts:144`, `src/services/worker/http/routes/SearchRoutes.ts:308-309`,
`src/npx-cli/commands/install.ts:1737,1812`, `scripts/export-memories.ts:53`,
`ragtime/ragtime.ts:123,195`, `openclaw/install.sh:1485`, `openclaw/e2e-verify.sh:98,104,111`.

**Justification for deferring — this is the point of the whole change:** every one of those strings is a
URL *printed for a human to open*. They are wrong today **because** nothing listens on `::1`. Once `::1`
is bound they become **correct automatically**, on every platform, with zero edits. Changing them in this
PR would add ~8 files of churn to a change whose entire thesis is that the bind is the single fix. They
are worth a consistency pass later (they still ignore a non-default `CLAUDE_MEM_WORKER_HOST`), which is
what #43 is for — but they are not part of this bug.

Also out of scope: general IPv6 addresses in the host validator (e.g. `fd00::1` for a LAN bind) — this
change adds `::1` only. And issue #41's UID-derived port split-brain (§8).

---

## 3. Corrections to the originating brief

Four claims in the brief were checked against source while writing this spec. Three needed sharpening.
Builder must read this section before coding — two of them change what the tests should assert.

### C1 — CORS is **not** the blocker for the headline symptom

The brief states the CORS gate "currently fails → `CORS not allowed` on every POST/PUT". That is true
only when the browser's origin is literally `http://[::1]:37777`.

A user who types `http://localhost:37777` gets an **origin of `http://localhost:37777`** — the browser
does not rewrite the origin to the resolved address. So `origin.startsWith('http://localhost:')`
(`middleware.ts:47`) passes today and will keep passing after the fix. The bind change alone resolves the
reported bug end-to-end.

The CORS gap is nevertheless **real and in scope**: anyone who types the literal `http://[::1]:37777`
(the obvious thing to try once you know the IPv4 form works) gets a viewer that renders but whose every
`POST`/`PUT` fails, because same-origin non-`GET` requests do carry an `Origin` header. And once the
settings validator accepts `::1` (§2.3), a worker configured that way can generate that origin from its
own links. Fix it — but do not describe it as the cause, and do not write a test that claims the
`localhost` path was ever CORS-blocked.

`requireLocalhost` (`middleware.ts:64-70`) already accepts `::1` and `::ffff:127.0.0.1`, so admin
endpoints need no change. Confirmed.

### C2 — `ProcessManager` is a hardening item, not a live bug

The brief says `spawnDaemon` "propagates `CLAUDE_MEM_WORKER_PORT` into the spawned daemon env but NOT
`CLAUDE_MEM_WORKER_HOST`; a non-default host set only in the parent env is lost."

The premise is wrong: `sanitizeEnv` (`src/supervisor/env-sanitizer.ts:47-59`) is a **denylist**, not an
allowlist — it drops `CLAUDECODE_*` / `CLAUDE_CODE_*` and passes everything else through. `spawnDaemon`
spreads `...process.env` wholesale (`ProcessManager.ts:346`), so an env-set `CLAUDE_MEM_WORKER_HOST`
**already reaches the child**. And a settings-set host is re-read by the child from the same
`settings.json`. Parent and child agree in both cases.

What is genuinely missing is **symmetry with the port**: `port` is an explicit `spawnDaemon` parameter
that is *pinned* into the child env, so the parent's resolved value wins over anything the child would
compute. There is no equivalent for host, which leaves one narrow window — the parent resolves the host,
`~/.claude-mem/settings.json` is edited, the child then reads a different host and binds somewhere the
parent is not looking. Cheap to close, worth closing alongside a change that makes host resolution
load-bearing. **Ship it, but as hardening; do not write a regression test claiming an env-set host was
being dropped, because it was not.**

### C3 — the CORS test tests a copy, not the middleware

`tests/worker/middleware/cors-restriction.test.ts:7-12` defines its **own local** `isAllowedOrigin`
duplicating the production predicate, then asserts against that. The real
`createCorsMiddleware` is imported at `:5` but the origin assertions never touch it.

Adding `[::1]` cases to that file as-is would prove nothing: the test would stay green even if
`middleware.ts` were left untouched. The fix must **export the predicate from `middleware.ts`** and have
the test import the real one. That also permanently closes the divergence.

### C4 — the fork already anticipated `::1` in one place

`HealthMonitor.ts:14-18` carries a **fork-added** `formatHostForUrl` whose comment already reads *"Bracket
IPv6 literals so a `CLAUDE_MEM_WORKER_HOST` of `::1` yields a valid `http://[::1]:port` URL instead of the
malformed `http://::1:port`."* It is a verbatim copy of `worker-utils.ts:166-169`. So the correctness tail
is not new ground — it is finishing a job the fork started in one file and never propagated. Dedupe rather
than add a third copy.

---

## 4. Approaches considered

### A — bind `0.0.0.0` (or `::` with v4-mapped addresses)

One socket, covers every spelling of localhost, zero new lifecycle. **Rejected:** it exposes the worker's
full admin surface to the LAN. `requireLocalhost` guards `/api/admin/*` but not the read APIs or the
viewer, and this change would flip a local-only default to a network service on every install. Directly
violates §2.2. Not viable at any price.

### B — dual-stack single socket (`::` with `ipv6Only=false`, filtered)

Not expressible. Node cannot bind "both loopbacks and nothing else" on one socket: a scoped bind takes one
address, and the only dual-stack form is the wildcard `::`, which is approach A. Bun's `Bun.serve` has the
same limitation, and this code path is **Express 5 on `node:http`** anyway (`Server.ts:2-3`), not
`Bun.serve`.

### C — two `http.Server` instances over one Express app ✅ **chosen**

An Express application *is* a `(req, res)` handler, so `http.createServer(this.app)` a second time is
essentially free: same routes, same middleware, same in-process state, one extra socket and its accept
queue. Each socket binds one scoped loopback address, so the loopback-only invariant is structural rather
than policy-enforced. The cost is that `Server` must own a **list** of sockets instead of one — which is
also a latent-bug fix in its own right (§5, D3).

### D — a userspace IPv6→IPv4 forwarder, or a Windows-side `netsh portproxy`

Rejected: an extra moving part, per-machine setup, and it fixes one user's box rather than the product.

---

## 5. Design decisions

### D1 — bind-host resolution is a pure function

New fork-only module `src/shared/host-binding.ts` exports `resolveBindHosts(host: string): string[]`:

- `127.0.0.1` → `['127.0.0.1', '::1']`
- `localhost` → `['127.0.0.1', '::1']`
- `::1` (or `[::1]`) → `['::1', '127.0.0.1']`
- anything else → `[host]`, verbatim

Rules:

- **Requested-host-first ordering.** The configured host is always index 0 ("the primary"), so
  `getHttpServer()` and `resolveBoundPort()` keep reporting the socket the operator asked for.
- **Exact matches only.** `127.0.0.2` is technically loopback (127/8) but is *not* expanded — expanding
  it would bind an address the operator did not name. Non-expansion can never widen; guessing can.
- **`localhost` is expanded explicitly rather than passed to the resolver.** `server.listen(port,
  'localhost')` makes Node do a DNS lookup and bind **one** of the results; mapping it ourselves is both
  deterministic and the whole point of the fix.
- The module is dependency-free (no logger, no settings, no fs) so it can be imported from the
  OpenCode plugin bundle and from `ProcessManager` without creating an import cycle —
  `worker-utils.ts:16` already documents that `ProcessManager` must not import `worker-utils`.

`formatHostForUrl` **moves** into this module and is **re-exported** from `worker-utils.ts`, so every
existing import site keeps compiling unchanged.

### D2 — failure handling is asymmetric between primary and secondary

- **Primary bind fails → reject**, exactly as today. No behaviour change.
- **Secondary bind fails with an "IPv6 is not available on this machine" code** (`EAFNOSUPPORT`,
  `EADDRNOTAVAIL`, `EPROTONOSUPPORT`, `EINVAL`) → **`logger.warn` and continue**. The worker starts and
  serves IPv4, as it does today. The warning names the consequence (`http://localhost:<port>` may hang
  from a Windows browser; use the IPv4 URL) so the log explains the symptom instead of just the cause.
- **Secondary bind fails with anything else — notably `EADDRINUSE` → close the primary and reject.**
  A `EADDRINUSE` on `[::1]:<port>` means something else already owns that address. Swallowing it would
  reintroduce exactly the class of defect this repo fought in `~~17~~` and is fighting again in **#40**:
  a listener nobody owns. Failing loud is consistent with the primary's existing behaviour.
- **Rollback is mandatory.** If a secondary bind fails hard, the already-open primary must be closed
  before the rejection propagates. Otherwise a failed `listen()` leaves a live socket with no owner — the
  orphan bug, self-inflicted.

### D3 — `Server` owns a list of listeners; `listen()`'s signature is unchanged

`private server: http.Server | null` becomes `private servers: http.Server[]`.

Note this fixes a **pre-existing latent defect** independent of IPv6: today `listen()` assigns
`this.server = server` unconditionally, so a second `listen()` call silently orphans the first socket
with no error and no log.

- `getHttpServer()` keeps its exact signature and returns `this.servers[0] ?? null`. Every existing
  caller and every existing test in `tests/server/server.test.ts` stays green untouched.
- New `getHttpServers(): readonly http.Server[]` is the companion for shutdown and for tests that assert
  the bound **set**.
- `close()` closes **all** listeners via `Promise.allSettled`, then rethrows the first rejection. Not a
  sequential `await` chain: one socket rejecting with Node's `ERR_SERVER_NOT_RUNNING` must not leave its
  sibling listening. This is #40's lesson applied prophylactically.

**Deviation from the brief, deliberate:** the brief specifies `listen(host: string | string[])` with
`worker-service.ts` computing the list. Instead, **`listen()` keeps `(port: number, host: string)` and
expands internally.** Two reasons: (a) zero call-site churn — `worker-service.ts:435` and
`ServerService.ts:212` are untouched, so the server runtime gets the fix for free (D5); (b) one expansion
rule in one place cannot drift from a second one. `worker-service.ts` still changes, but only to *log*
the resolved set and to hand `getHttpServers()` to shutdown.

### D4 — `GracefulShutdown` accepts a list

`GracefulShutdownConfig.server` widens to `http.Server | readonly http.Server[] | null` and the close step
iterates with `Promise.allSettled`. Backward-compatible: a single `http.Server` still works, so any other
caller is unaffected.

*Alternative considered and rejected:* leaving `GracefulShutdown.ts` byte-identical to upstream by having
`worker-service.ts` close the secondary sockets in its own wrapper before delegating. It keeps the file
pristine but splits "who closes the worker's sockets" across two modules — the exact fragmentation that
makes leaked-listener bugs possible. A 6-line widening in the module that already owns socket teardown is
the more honest change. **See §7 for the sequencing consequence against #40.**

### D5 — the fix applies to the `CLAUDE_MEM_SERVER_HOST` runtime too

`ServerService` (port 37877) goes through the same `Server.listen()` and defaults to
`DEFAULT_SERVER_HOST = '127.0.0.1'` (`src/server/runtime/ServerService.ts:30`). Because expansion lives
inside `listen()` (D3), the server runtime inherits dual-loopback with **zero edits** — and inherits the
same invariant, since an operator who set `0.0.0.0` for LAN/Tailscale use still gets exactly that.
`resolveBoundPort()` (`ServerService.ts:274-275`) reads `getHttpServer()?.address()`, which is the primary
— unchanged. `ServerService.stop()` calls `this.server.close()`, which now closes both. Intentional and
uniform: the server runtime's viewer has the identical Windows symptom.

### D6 — the extra loopback is implicit: no new settings key, no kill-switch

Per Mark's decision. `SettingsDefaultsManager.ts` gains nothing. A key would recreate the opt-in surface
that was explicitly rejected, and a key defaulted to "on" is a kill-switch with extra steps.

A kill-switch was considered and is **not** recommended: the only plausible failure mode is "this box has
no IPv6", which D2 already degrades gracefully, and the security invariant is covered by a test rather
than by an escape hatch. Recorded as open question (a) in case Mark wants the insurance anyway.

### D7 — the CORS origin predicate becomes exported and shared

`middleware.ts` exports `isAllowedOrigin(origin: string | undefined): boolean` backed by an explicit
prefix list, `createCorsMiddleware` consumes it, and the test imports the real function (C3). The new
prefix is `'http://[::1]:'` — **bracketed, with the trailing colon**, which is what stops
`http://[::1].evil.com` from matching.

*Noted, not fixed:* the same trailing-colon trick means `http://localhost:37777.evil.com` technically
passes the prefix check today. It is not reachable from a browser (a port must be numeric, so that string
is not a parseable origin) and it is pre-existing. Out of scope; recorded here so a reviewer does not
think the new prefix introduced it.

### D8 — the host validator accepts `::1` and still rejects `::`

`SettingsRoutes.ts:201-207`'s pattern gains `::1`. `::` stays rejected, deliberately: `0.0.0.0` is an
explicit, documented opt-in to a LAN bind, whereas `::` would *additionally* accept IPv4 through
v4-mapped addresses on any kernel with `net.ipv6.bindv6only=0` (the Linux default) — a wildcard bind that
does not look like one to someone reading `settings.json`. Operators who want a LAN bind use `0.0.0.0`.
The error string is updated to name the accepted forms.

### D9 — fork divergence is accepted (ADR 0002 §9)

Five of the touched files are currently **byte-identical to upstream `f5633c1f`**: `Server.ts`,
`GracefulShutdown.ts`, `middleware.ts`, `ProcessManager.ts`, `restart-verify.ts`,
`install/shutdown-helper.ts` — plus the two upstream-owned test files. This PR makes them diverge.

That is acceptable and, here, unavoidable:

- ADR 0002 §1.1 constraint 2 forbids upstreaming *anything*, so "keep it clean for a future upstream PR"
  is not a live motive. §9 already records permanent asymmetric divergence as the deliberate, accepted
  price.
- The bind is in `Server.ts` and the origin gate is in `middleware.ts`. There is no route to the fix that
  avoids both. "Zero upstream edits" — the property #40's plan achieves — is simply not attainable for
  this defect, so trading design quality for a partial version of it buys nothing.

The cost is a recurring conflict surface on future upstream syncs, concentrated in `Server.listen`/`close`
and one middleware predicate. The plan keeps each hunk small and heavily commented so the next merge can
re-apply it by eye.

---

## 6. Test plan

Every item below is a **unit test in the fork-only suite**, gated by `npm run test:gate` (**not** raw
`bun test` — see `CLAUDE.md`). Live-Chroma, live-Postgres and a running worker are all unnecessary.

### 6.1 Bind-host resolution — `tests/shared/host-binding.test.ts` (new)

| # | Assertion |
|---|---|
| T1 | `resolveBindHosts('127.0.0.1')` → `['127.0.0.1', '::1']` |
| T2 | `resolveBindHosts('localhost')` → `['127.0.0.1', '::1']` |
| T3 | `resolveBindHosts('::1')` → `['::1', '127.0.0.1']`; `resolveBindHosts('[::1]')` → same |
| T4 | **Security invariant:** `resolveBindHosts('0.0.0.0')` → `['0.0.0.0']` exactly — length 1, no `::1` |
| T5 | **Security invariant:** `resolveBindHosts('::')` → `['::']` exactly — length 1, no `127.0.0.1` |
| T6 | `resolveBindHosts('192.168.1.50')` → `['192.168.1.50']`; `'127.0.0.2'` → `['127.0.0.2']` |
| T7 | **Blanket invariant:** for every input in a fixture list spanning loopback, wildcard, LAN and hostname forms, the output contains `0.0.0.0` or `::` **only if the input was that exact string** |
| T8 | `isIpv6UnavailableError` is true for `EAFNOSUPPORT`/`EADDRNOTAVAIL`/`EPROTONOSUPPORT`/`EINVAL`, false for `EADDRINUSE`/`EACCES`/a plain `Error` |
| T9 | `formatHostForUrl('::1')` → `'[::1]'`; `'[::1]'` → `'[::1]'`; `'127.0.0.1'` → `'127.0.0.1'` (moved-module regression) |

T4/T5/T7 are the encoded form of §2.2 and are the tests a reviewer should look for first.

### 6.2 Listener lifecycle — `tests/server/server-dual-loopback.test.ts` (new)

| # | Assertion |
|---|---|
| T10 | After `listen(port, '127.0.0.1')`, `getHttpServers()` has length 2 and their `address()` set is exactly `{'127.0.0.1', '::1'}` |
| T11 | **Both are reachable:** `GET http://127.0.0.1:<port>/health` → 200 **and** `GET http://[::1]:<port>/health` → 200, same app |
| T12 | **Security invariant:** after `listen(port, '0.0.0.0')`, `getHttpServers()` has length 1 and its address is `0.0.0.0` — no `::` and no second socket |
| T13 | **Shutdown closes BOTH:** after `close()`, every server in the captured list reports `listening === false`, **and** a fresh `Server` can `listen()` on the same port on **both** addresses (proves no leaked listener, not just a flipped flag) |
| T14 | **Graceful degrade:** with `listenOne` stubbed to reject the `::1` bind with `code: 'EAFNOSUPPORT'`, `listen()` **resolves**, one listener remains, IPv4 still serves, and a WARN was logged |
| T15 | **Hard failure rolls back:** with the `::1` bind stubbed to reject `code: 'EADDRINUSE'`, `listen()` **rejects** and the primary IPv4 socket is **not** left listening |
| T16 | `getHttpServer()` still returns the primary (`127.0.0.1`) — back-compat for `resolveBoundPort` and existing callers |

T11 and T14 must be skipped, not failed, on a box with no IPv6 — guard on a one-time probe bind to `::1`,
and assert the guard itself is exercised so the suite cannot silently degrade to zero IPv6 coverage
(the `~~35~~` silent-skip lesson).

`tests/server/server.test.ts:100-210` (`describe('listen')`, `close`, `getHttpServer`) is **extended, not
rewritten**: its existing assertions all pass unchanged under D3, which is itself a useful signal.

### 6.3 Shutdown closes every socket — `tests/services/graceful-shutdown-listeners.test.ts` (new)

| # | Assertion |
|---|---|
| T17 | `performGracefulShutdown({ server: [a, b], ... })` calls `close()` on **both** |
| T18 | When `a.close()` yields `ERR_SERVER_NOT_RUNNING`, `b.close()` is **still called**, and the rejection surfaces afterwards |
| T19 | A single `http.Server` (non-array) still works — back-compat |

**Do not** put these in `tests/services/worker-shutdown-sequence.test.ts`: it is listed as `nonRunnable`
in `tests/known-failures.json`, so anything added there is silently dead (same trap #40's plan flags).

### 6.4 CORS — `tests/worker/middleware/cors-restriction.test.ts` (rewired per C3)

| # | Assertion |
|---|---|
| T20 | The local duplicate `isAllowedOrigin` is **deleted** and the test imports the exported one from `middleware.ts` — all existing cases still pass against the real predicate |
| T21 | `http://[::1]:37777` and `http://[::1]:3000` → allowed |
| T22 | **Lookalikes blocked:** `http://[::1].evil.com`, `http://[::1]evil.com`, `https://[::1]:37777`, `http://[::2]:37777`, `http://[::1]` (no port) → all rejected |
| T23 | End-to-end through `createCorsMiddleware` on a real express app: `Origin: http://[::1]:<port>` on a POST → 200 with a matching `Access-Control-Allow-Origin`; `Origin: http://evil.com` → error |

### 6.5 Settings validator — extend the existing SettingsRoutes tests

| # | Assertion |
|---|---|
| T24 | `CLAUDE_MEM_WORKER_HOST: '::1'` → `{valid: true}` |
| T25 | **`'::'` → `{valid: false}`** with a message naming the accepted forms |
| T26 | `'127.0.0.1'`, `'localhost'`, `'0.0.0.0'`, `'192.168.1.5'` still valid; `'evil.com'`, `''.padEnd(…)`-style junk still invalid |

### 6.6 Health monitor + spawn env

| # | Assertion |
|---|---|
| T27 | `isPortInUse` probes **every** host from `resolveBindHosts` — with `net.createServer` mocked, `listen` is called for both `127.0.0.1` and `::1` |
| T28 | `isPortInUse` returns `true` when **only** the `::1` probe reports `EADDRINUSE` (the stale-IPv6-listener case that is invisible today) |
| T29 | The existing `should honor configured worker host` case (`health-monitor.test.ts:70-89`, host `127.0.0.2`) still passes unchanged — `127.0.0.2` is not expanded (T6) |
| T30 | `spawnDaemon` includes `CLAUDE_MEM_WORKER_HOST` in the child env with the parent's resolved value (C2 — asserted as symmetry with `CLAUDE_MEM_WORKER_PORT`, not as a dropped-env regression) |

### 6.7 Correctness tail

| # | Assertion |
|---|---|
| T31 | For each rewritten call site, with `CLAUDE_MEM_WORKER_HOST='::1'`, the constructed URL is `http://[::1]:<port>/…` and **never** `http://::1:<port>/…`. A source-level grep assertion (no `http://${...Host}` template without `formatHostForUrl`) is acceptable where a call site cannot be unit-tested cheaply |
| T32 | `shutdown-helper.ts` uses the configured host rather than the literal `127.0.0.1` |
| T33 | `HealthMonitor` has no local `formatHostForUrl` definition — it imports the shared one |

### 6.8 Manual UAT (Mark's box — the only place the bug reproduces)

1. `npm run build-and-sync` && `npm run verify:plugin-delivery`.
2. In WSL2: `ss -ltn | grep 37777` shows **two** rows — `127.0.0.1:37777` **and** `[::1]:37777`.
3. `ss -ltn` shows **no** `0.0.0.0:37777` and **no** `[::]:37777`.
4. From the Windows browser: `http://localhost:37777` loads **immediately** (the acceptance criterion).
5. `http://127.0.0.1:37777` and `http://[::1]:37777` both load; exercise one POST/PUT flow (a settings
   save) from the `[::1]` origin and confirm no `CORS not allowed`.
6. `claude-mem worker restart`; repeat 2–4. Then confirm `ss -ltn` shows **zero** `:37777` rows while the
   worker is stopped — no leaked listener on either address.

---

## 7. Sequencing and interactions

- **Sequences AFTER the [P1] hook fail-open fix** (separate PR — spec present in the tree as
  `docs/superpowers/specs/2026-07-31-hook-fail-open-never-block-design.md`, **no queue row filed yet** as
  of this writing).
  **Correction to the brief: the file sets are NOT disjoint.** Two files appear in both scopes —
  `src/shared/worker-utils.ts` and `src/services/worker-service.ts` — but **no hunk overlaps**:

  | File | [P1] hook fail-open | This PR (#42) |
  |---|---|---|
  | `src/shared/worker-utils.ts` | the hook spawn-gate / degraded-notice region (`:606-745`) | `formatHostForUrl` at `:166-169` → re-export, plus one import line |
  | `src/services/worker-service.ts` | the `worker start` / `worker restart` success path (streak reset) | `:449` log, `:781` shutdown config, `:1543` health URL |

  So the ordering is still priority rather than conflict, and whichever lands second is a trivial rebase
  — but Builder should expect to touch two files the other PR also touched, not zero.
  One thing to watch: the [P1] plan includes a **source-shape assertion** that `readFileSync`s
  `src/shared/worker-utils.ts` and asserts on its contents. Task 2 of this plan edits that file. The
  assertion is about the hook exit/notice path and should be unaffected, but if the [P1] PR has already
  landed, re-run its test after Task 2 rather than assuming.
- **Sequences AFTER queue #40** (chroma orphan leak). Not disjoint: #40's plan restructures the
  `performGracefulShutdown` call site in `worker-service.ts:781` and its verification step **greps to
  prove `GracefulShutdown.ts` is byte-identical to `f5633c1f`**. This PR breaks that grep by design (D4).
  Landing #40 first keeps its verification honest and leaves this PR a trivial rebase; landing this one
  first would force #40's Builder to reconcile a moved invariant mid-implementation.
- **#41 cross-reference, do not fix here:** the default port is UID-derived —
  `String(37700 + ((process.getuid?.() ?? 77) % 100))` (`SettingsDefaultsManager.ts:111`) — so two
  processes running under different UIDs compute *different* default ports. That is the version/port
  split-brain hypothesis **H5** that leads #41's investigation. It is a live confounder for anyone
  debugging "the viewer isn't there": on Mark's box the observed port is `37777` while #41 found logs
  from a worker on `37700`. **This PR changes nothing about port resolution** and must not try to.
- No interaction with #36, #38, #39.

---

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A second listener doubles some per-socket resource | Low | Two accept queues over one app; no duplicated app state, no duplicated route table. Measured by T10–T13 only insofar as both serve the same handler |
| Boxes with IPv6 disabled regress from "starts" to "fails to start" | Low | D2's soft-fail list + T14. Explicitly the highest-consequence risk, hence a dedicated test |
| A stale `[::1]` listener now blocks startup where it previously went unnoticed | Low | Intended (D2). T15 covers it, and T28 makes `isPortInUse` able to *see* it, which it cannot today |
| Wildcard bind introduced by accident during a later refactor | Low | T4/T5/T7/T12 encode §2.2 as executable invariants, at both the resolver and the socket level |
| Upstream sync conflicts in `Server.ts` / `middleware.ts` | Medium | Accepted per D9 / ADR §9. Hunks kept small and commented |
| #40 rebase collision in `worker-service.ts` | Medium | Sequencing above; both edits are localised to the `performGracefulShutdown` config object |

---

## 9. Acceptance criteria

1. From a Windows browser on Mark's WSL2 box, `http://localhost:37777` loads the viewer without delay.
2. `ss -ltn` shows exactly two claude-mem rows for the worker port — `127.0.0.1` and `[::1]` — and never
   `0.0.0.0` or `[::]`.
3. Stopping the worker leaves zero listeners on that port.
4. A box with IPv6 disabled starts normally, logs one WARN, and serves on IPv4.
5. `npm run test:gate` is green with no new baseline entries in `tests/known-failures.json`.
6. `npm run build-and-sync` && `npm run verify:plugin-delivery` pass.

---

## 10. Open questions for Mark (non-blocking — Planner's recommendation on each)

- **(a) Kill-switch?** Should an escape hatch (`CLAUDE_MEM_DUAL_LOOPBACK=false`) ship alongside?
  **Rec: no.** The one realistic failure (no IPv6) already degrades gracefully, and a switch reintroduces
  the opt-in surface you rejected. Trivial to add later if a user hits something unforeseen.
- **(b) `GracefulShutdown.ts` divergence.** D4 makes an upstream-identical file diverge, which breaks
  #40's byte-identity grep. **Rec: accept it, and land #40 first** (§7). The alternative — a
  `worker-service`-side wrapper — keeps the file pristine at the cost of splitting socket teardown across
  two modules.
- **(c) Does the server runtime (`:37877`) really want this?** D5 gives it dual loopback for free.
  **Rec: yes** — identical symptom, identical invariant, and its default host is loopback. Say no and it
  needs an explicit opt-out inside `listen()`, which is worse.
- **(d) Hard-fail on a stale `[::1]` listener?** D2 makes `EADDRINUSE` on the secondary abort startup.
  **Rec: yes** — silently continuing is how `~~17~~`/#40 happened. But it is a genuinely new failure
  mode on a box that has one, so flag it if you would rather it warn.
- **(e) Queue numbering — live collision risk, confirmed not hypothetical.** This spec claims **#42**
  (fix) and **#43** (display-string follow-up), and both rows are committed. The [P1] hook fail-open
  spec **exists in the tree** (`docs/superpowers/specs/2026-07-31-hook-fail-open-never-block-design.md`,
  untracked at the time of writing) but has **filed no queue row**, so it has not claimed a number.
  Whoever files it must re-read `BUILDER_QUEUE.md` first and take **#44** — the queue file is the
  authority, and its own banner records that skipping that step caused the #5 collision between PRs #10
  and #11. **Rec: no action needed from Mark unless two rows both come back numbered #42.**
