# Plan: dual-stack loopback bind (queue #42, [P2])

- **Spec:** [`docs/superpowers/specs/2026-07-31-dual-stack-loopback-bind-design.md`](../specs/2026-07-31-dual-stack-loopback-bind-design.md)
- **Branch:** `fix/dual-stack-loopback-bind` → PR to `main`
- **Gate:** `npm run test:gate` (**not** raw `bun test` — see `CLAUDE.md`)
- **Sequencing:** after the [P1] hook fail-open fix, and after queue **#40**. **Neither is
  file-disjoint from this PR** — see spec §7 for the hunk-by-hunk table. #40's verification greps
  `GracefulShutdown.ts` for upstream byte-identity, which Task 6 breaks by design; the [P1] fix shares
  `worker-utils.ts` and `worker-service.ts` with Tasks 2 and 7 but touches different regions.

## Read before coding

1. **Spec §3 — four corrections to the originating brief.** Two change what the tests must assert:
   CORS is *not* what breaks `http://localhost:37777` (C1), and the existing CORS test asserts against a
   **local copy** of the predicate rather than the middleware (C3).
2. **Spec §2.2 — the security invariant.** `0.0.0.0` and `::` must never be bound as a side effect.
   Tasks 1 and 8 encode it; do not weaken either.
3. `plugin/` is build output. All edits go in `src/`; `npm run build-and-sync` regenerates `plugin/`.
   The `plugin/` diff already in the working tree is a rebuild, not hand-edits.
4. **Do not add tests to `tests/services/worker-shutdown-sequence.test.ts`** — it is `nonRunnable` in
   `tests/known-failures.json`, so anything added there never executes.

---

## Task 1 — New module: `src/shared/host-binding.ts`

Fork-created, dependency-free (no logger, no settings, no fs) so `ProcessManager` and the OpenCode plugin
bundle can import it without a cycle — `worker-utils.ts:16` documents that `ProcessManager` must not
import `worker-utils`.

`formatHostForUrl` **moves** here from `worker-utils.ts:166-169`; Task 2 re-exports it so no import site
changes.

**Create `src/shared/host-binding.ts`:**

```ts
/**
 * Bind-host resolution and URL host formatting (#42).
 *
 * Windows resolves `localhost` to `::1` (AAAA) ahead of `127.0.0.1` (A). A
 * worker bound to IPv4 loopback only is therefore unreachable at
 * `http://localhost:<port>` from a Windows browser talking to WSL2 under
 * mirrored networking: nothing listens on `[::1]`, and the Hyper-V firewall's
 * `DefaultInboundAction=Block` DROPS the SYN rather than rejecting it — so no
 * RST comes back and the browser waits out the full TCP timeout
 * (ERR_CONNECTION_TIMED_OUT) instead of failing fast.
 *
 * The fix is to bind BOTH loopback addresses whenever the configured host is a
 * loopback address. Node cannot express "dual-stack but loopback-only" on a
 * single socket (the only dual-stack form is the wildcard `::`, which is a LAN
 * bind), so this returns a LIST and the caller opens one http.Server per host
 * over the same Express app.
 *
 * SECURITY INVARIANT (spec §2.2): this function must never widen a bind. A
 * non-loopback host (`0.0.0.0`, `::`, a LAN address, a hostname) is returned
 * unchanged as a single-element list. `0.0.0.0` and `::` may appear in the
 * output ONLY when they were the input.
 */

export const IPV4_LOOPBACK = '127.0.0.1';
export const IPV6_LOOPBACK = '::1';

/**
 * Bind errors that mean "this machine has no usable IPv6" rather than "the bind
 * failed". Only these are tolerated on the SECONDARY loopback socket; anything
 * else (notably EADDRINUSE) is a real failure — see Server.listen().
 */
const IPV6_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'EAFNOSUPPORT',    // address family not supported: IPv6 compiled out or disabled
  'EADDRNOTAVAIL',   // ::1 is not assigned to any interface
  'EPROTONOSUPPORT', // protocol unsupported by the socket layer
  'EINVAL',          // some kernels report a disabled IPv6 stack this way
]);

export function isIpv6UnavailableError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && IPV6_UNAVAILABLE_CODES.has(code);
}

/**
 * Accept a bracketed IPv6 literal (`[::1]`) as an alias for the bare form.
 * settings.json / env may carry either, but `server.listen()` wants the bare
 * address while URLs want the bracketed one.
 */
function normalizeHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Exact matches only. 127.0.0.2 is technically loopback (127/8) but is NOT
 * treated as one here: expanding it would bind an address the operator never
 * named. Declining to expand can never widen a bind; guessing can.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === IPV4_LOOPBACK
    || normalized === IPV6_LOOPBACK
    || normalized === 'localhost';
}

/**
 * The requested host is always index 0 ("the primary"), so `getHttpServer()`
 * and `resolveBoundPort()` keep reporting the socket the operator asked for.
 *
 * `localhost` is expanded here rather than handed to `server.listen()`, which
 * would do a DNS lookup and bind exactly ONE of the results — the behaviour
 * this whole change exists to eliminate.
 */
export function resolveBindHosts(host: string): string[] {
  const normalized = normalizeHost(host);
  if (!isLoopbackHost(normalized)) {
    return [normalized];
  }
  const primary = normalized.toLowerCase() === IPV6_LOOPBACK ? IPV6_LOOPBACK : IPV4_LOOPBACK;
  const secondary = primary === IPV4_LOOPBACK ? IPV6_LOOPBACK : IPV4_LOOPBACK;
  return [primary, secondary];
}

/**
 * Bracket IPv6 literals so a host of `::1` yields a valid `http://[::1]:port`
 * URL instead of the malformed `http://::1:port`. Moved here from
 * worker-utils.ts (which re-exports it) so dependency-free callers — the
 * OpenCode plugin bundle, ProcessManager, HealthMonitor — can share one copy.
 */
export function formatHostForUrl(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host;
  return host.includes(':') ? `[${host}]` : host;
}
```

---

## Task 2 — `src/shared/worker-utils.ts`: re-export, don't duplicate

**Add to the import block (after line 17):**

```ts
import { formatHostForUrl } from "./host-binding.js";
```

**Replace lines 166-169** (the local `formatHostForUrl` definition) with a re-export so every existing
`import { formatHostForUrl } from '.../worker-utils.js'` keeps compiling
(`src/npx-cli/commands/install.ts:17` is the current one):

```ts
// Moved to ./host-binding.js (#42) so dependency-free callers can share it.
// Re-exported here because existing import sites point at worker-utils.
export { formatHostForUrl } from "./host-binding.js";
```

`buildWorkerUrl` at `:171-173` is unchanged — it now uses the imported symbol.

---

## Task 3 — `src/services/server/Server.ts`: one listener per bind host

Upstream-identical file; this is the accepted divergence of spec §D9.

**Add the import (after line 3):**

```ts
import { resolveBindHosts, isIpv6UnavailableError } from '../../shared/host-binding.js';
```

**Replace line 121:**

```ts
  private servers: http.Server[] = [];
```

**Replace `getHttpServer()` (lines 136-138) with both accessors:**

```ts
  /**
   * The primary listener — the socket bound to the host the operator actually
   * configured. Unchanged signature: every existing caller (resolveBoundPort,
   * worker-service, the server runtime) wants exactly this.
   */
  getHttpServer(): http.Server | null {
    return this.servers[0] ?? null;
  }

  /**
   * Every listener this Server owns. On a loopback bind that is two sockets
   * (127.0.0.1 and ::1) over one Express app — #42. Shutdown must close all of
   * them; closing only getHttpServer() leaks the sibling.
   */
  getHttpServers(): readonly http.Server[] {
    return this.servers;
  }
```

**Replace `listen()` (lines 140-157):**

```ts
  /**
   * Signature deliberately unchanged: expansion happens HERE rather than at the
   * call sites, so (a) worker-service and ServerService need no edit and the
   * server runtime inherits the fix for free, and (b) there is exactly one
   * expansion rule that cannot drift from a second copy.
   */
  async listen(port: number, host: string): Promise<void> {
    const [primaryHost, ...secondaryHosts] = resolveBindHosts(host);

    // The primary bind is load-bearing: a failure here rejects exactly as it
    // did before this change.
    this.servers = [await this.listenOne(port, primaryHost)];

    for (const secondaryHost of secondaryHosts) {
      try {
        this.servers.push(await this.listenOne(port, secondaryHost));
      } catch (error: unknown) {
        if (isIpv6UnavailableError(error)) {
          logger.warn('SYSTEM', 'IPv6 loopback unavailable - serving on IPv4 only', {
            host: secondaryHost,
            port,
            code: (error as NodeJS.ErrnoException).code,
            impact: `http://localhost:${port} may time out from a Windows browser; use http://127.0.0.1:${port}`,
          });
          continue;
        }
        // Anything else is a real failure - notably EADDRINUSE, which means
        // something already owns [::1]:port. Swallowing that would recreate the
        // orphaned-listener class of bug (#17, #40). Roll the primary back
        // first: a rejected listen() must never leave a live socket behind.
        await this.close();
        throw error;
      }
    }

    logger.info('SYSTEM', 'HTTP server started', {
      host: primaryHost,
      hosts: this.servers.map(server => describeBoundAddress(server)),
      port,
      pid: process.pid,
    });
  }

  private listenOne(port: number, host: string): Promise<http.Server> {
    return new Promise<http.Server>((resolve, reject) => {
      const server = http.createServer(this.app);
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // A scoped address is passed, never a wildcard, so `ipv6Only` is
      // unnecessary: `::1` cannot accept IPv4 regardless of
      // net.ipv6.bindv6only. Keeping the plain two-arg call preserves the
      // pre-#42 listen semantics exactly.
      server.listen(port, host);
    });
  }
```

**Replace `close()` (lines 159-178):**

```ts
  async close(): Promise<void> {
    const servers = this.servers;
    if (servers.length === 0) return;
    // Cleared up front so every socket is attempted even if one rejects; a
    // half-closed Server must not keep handing out stale listeners.
    this.servers = [];

    for (const server of servers) {
      server.closeAllConnections();
    }

    if (process.platform === 'win32') {
      await new Promise(r => setTimeout(r, 500));
    }

    // allSettled, NOT a sequential await chain: one socket rejecting with
    // Node's ERR_SERVER_NOT_RUNNING must not leave its sibling listening. That
    // failure mode is exactly what #40 traced in the shutdown path.
    const results = await Promise.allSettled(
      servers.map(server => new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      }))
    );

    if (process.platform === 'win32') {
      await new Promise(r => setTimeout(r, 500));
    }

    logger.info('SYSTEM', 'HTTP server closed', { listeners: servers.length });

    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failure) {
      // Preserve the pre-#42 contract that close() can reject (existing tests
      // catch ERR_SERVER_NOT_RUNNING), but only after every socket was closed.
      throw failure.reason;
    }
  }
```

**Add the module-level helper next to `applySecurityHeaders` (after line 117):**

```ts
function describeBoundAddress(server: http.Server): string {
  const address = server.address();
  if (address && typeof address === 'object') return address.address;
  return String(address ?? 'unknown');
}
```

---

## Task 4 — `src/services/worker/http/middleware.ts`: export the origin predicate, allow `[::1]`

Spec §D7 + correction C3. Exporting is what makes the test able to assert against production code.

**Replace `createCorsMiddleware` (lines 43-62):**

```ts
const ALLOWED_ORIGIN_PREFIXES: readonly string[] = [
  'http://localhost:',
  'http://127.0.0.1:',
  // #42 - the worker also listens on the IPv6 loopback now, so a browser
  // pointed at the literal http://[::1]:<port> sends that as its Origin on
  // every same-origin non-GET request. Bracketed form with the trailing colon:
  // the colon is what stops `http://[::1].evil.com` from matching.
  'http://[::1]:',
];

/**
 * Exported so tests assert against the real predicate. It previously existed
 * only inline here AND as a duplicate inside
 * tests/worker/middleware/cors-restriction.test.ts, which meant the test stayed
 * green regardless of what the middleware did.
 *
 * No Origin header (hooks, curl, CLI) is allowed: same-origin GETs and
 * non-browser clients do not send one.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return ALLOWED_ORIGIN_PREFIXES.some(prefix => origin.startsWith(prefix));
}

export function createCorsMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin) {
      if (!isAllowedOrigin(origin)) {
        next(new Error('CORS not allowed'));
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
      res.status(204).end();
      return;
    }
    next();
  };
}
```

`requireLocalhost` (`:64-86`) is **unchanged** — it already accepts `::1` and `::ffff:127.0.0.1`.

---

## Task 5 — `src/services/worker/http/routes/SettingsRoutes.ts`: accept `::1`, keep rejecting `::`

`validateSettings` is a private method, so the host rule is lifted to an exported module-level function
to make it directly testable.

**Add near the top of the file (after the `toggleMcpSchema` declaration around line 19):**

```ts
// Exported for direct unit testing: validateSettings is a private method, and
// the host rule is the one carrying a security invariant (#42).
export function validateWorkerHostSetting(host: string): { valid: boolean; error?: string } {
  // `::1` is accepted because the worker binds both loopback addresses when
  // configured for loopback (#42). The IPv6 wildcard `::` is deliberately NOT
  // accepted: `0.0.0.0` is an explicit, documented opt-in to a LAN bind,
  // whereas `::` would ALSO accept IPv4 via v4-mapped addresses on any kernel
  // with net.ipv6.bindv6only=0 (the Linux default) - a wildcard bind that does
  // not look like one to someone reading settings.json. Use 0.0.0.0 for a LAN.
  const validHostPattern = /^(127\.0\.0\.1|0\.0\.0\.0|localhost|::1|\[::1\]|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
  if (!validHostPattern.test(host)) {
    return {
      valid: false,
      error: 'CLAUDE_MEM_WORKER_HOST must be 127.0.0.1, ::1, localhost, 0.0.0.0, or an IPv4 address',
    };
  }
  return { valid: true };
}
```

**Replace the host branch inside `validateSettings` (lines 201-207):**

```ts
    if (settings.CLAUDE_MEM_WORKER_HOST) {
      const hostValidation = validateWorkerHostSetting(settings.CLAUDE_MEM_WORKER_HOST);
      if (!hostValidation.valid) {
        return hostValidation;
      }
    }
```

---

## Task 6 — `src/services/infrastructure/GracefulShutdown.ts`: close every listener

Upstream-identical file — accepted divergence (spec §D4/§D9). **Land queue #40 first** (spec §7).

**Replace the `server` field of `GracefulShutdownConfig` (line 23):**

```ts
  /**
   * Every HTTP listener the worker owns. Widened to a list by #42: on a
   * loopback bind the worker holds two sockets (127.0.0.1 and ::1) over one
   * Express app, and closing only the first leaks the second. A bare
   * http.Server is still accepted, so other callers are unaffected.
   */
  server: http.Server | readonly http.Server[] | null;
```

**Replace lines 33-36:**

```ts
  const servers: http.Server[] = config.server === null
    ? []
    : Array.isArray(config.server)
      ? [...config.server]
      : [config.server as http.Server];

  if (servers.length > 0) {
    await closeHttpServers(servers);
    logger.info('SYSTEM', 'HTTP server closed', { listeners: servers.length });
  }
```

**Replace `closeHttpServer` (lines 60-75) with the plural form:**

```ts
async function closeHttpServers(servers: readonly http.Server[]): Promise<void> {
  for (const server of servers) {
    server.closeAllConnections();
  }

  if (process.platform === 'win32') {
    await new Promise(r => setTimeout(r, 500));
  }

  // allSettled, NOT a sequential await chain: one socket rejecting (Node throws
  // ERR_SERVER_NOT_RUNNING on a double close) must not leave a sibling
  // listening. The sequential-await failure mode is what #40 traced through
  // this exact function.
  const results = await Promise.allSettled(
    servers.map(server => new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    }))
  );

  if (process.platform === 'win32') {
    await new Promise(r => setTimeout(r, 500));
    logger.info('SYSTEM', 'Waited for Windows port cleanup');
  }

  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failure) {
    throw failure.reason;
  }
}
```

---

## Task 7 — `src/services/worker-service.ts`: log the bound set, hand over all listeners

**Replace the startup log at line 449:**

```ts
    logger.info('SYSTEM', 'Worker started', {
      host,
      // #42 - the resolved bind set, not just the configured host. On a
      // loopback config this is ['127.0.0.1', '::1']; a warn from
      // Server.listen() explains any box where the second one is absent.
      hosts: this.server.getHttpServers().map(s => {
        const address = s.address();
        return address && typeof address === 'object' ? address.address : String(address);
      }),
      port,
      pid: process.pid,
    });
```

**Replace line 781** (inside the `performGracefulShutdown` config object):

```ts
        server: this.server.getHttpServers(),
```

**Replace line 1543** in `fetchWorkerHealth` — a host of `::1` currently produces the malformed
`http://::1:37777/api/health`:

```ts
    const response = await fetchWithTimeout(
      `http://${formatHostForUrl(getWorkerHost())}:${port}/api/health`,
      {},
      timeoutMs
    );
```

Ensure `formatHostForUrl` is in the existing `worker-utils.js` import (it is re-exported there by Task 2);
add it to the import list if absent.

---

## Task 8 — `src/services/infrastructure/HealthMonitor.ts`: probe every bind host, drop the duplicate

**Replace lines 13-18** (the copy-pasted `formatHostForUrl`) with an import — add to the import block at
the top:

```ts
import { resolveBindHosts, formatHostForUrl } from '../../shared/host-binding.js';
```

and delete the local definition and its comment entirely. `httpRequestToWorker` at `:25` keeps working
against the imported symbol.

**Replace `isPortInUse` (lines 34-58):**

```ts
export async function isPortInUse(port: number): Promise<boolean> {
  // #42 - probe EVERY address the worker would bind, not just the configured
  // one. With two listeners, a stale IPv6-only socket is otherwise invisible:
  // the IPv4 probe succeeds, the port reads as free, and the real bind then
  // fails with EADDRINUSE from a place nothing was watching.
  for (const host of resolveBindHosts(getWorkerHost())) {
    if (await isPortInUseOn(port, host)) return true;
  }
  return false;
}

function isPortInUseOn(port: number, host: string): Promise<boolean> {
  // Real `net` bind probe on ALL platforms (#17). The former win32 branch did an
  // HTTP /api/health check instead, so a dead-but-bound port read as *free* on
  // Windows - the one platform the orphaned-socket bug bites - making the
  // "port bound but worker not responding -> dead" diagnosis unreachable there.
  // A bind probe correctly reports EADDRINUSE regardless of whether anything is
  // accepting.
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        // Includes EAFNOSUPPORT on a box with IPv6 disabled: "cannot probe" is
        // reported as "not in use", matching the pre-#42 single-host behaviour.
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, host);
  });
}
```

---

## Task 9 — `src/services/infrastructure/ProcessManager.ts`: pin the resolved host

Hardening, not a live-bug fix — see spec correction **C2**. `SettingsDefaultsManager` is used rather than
`worker-utils` because `worker-utils.ts:16` states ProcessManager must not import it (cycle).

**Add to the import block (after line 11):**

```ts
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
```

(`paths.js` is already imported at `:11` for `paths`; extend that import rather than adding a second one
if the file's style prefers it.)

**Replace the `sanitizeEnv` call in `spawnDaemon` (lines 345-349):**

```ts
  const env = sanitizeEnv({
    ...process.env,
    CLAUDE_MEM_WORKER_PORT: String(port),
    // #42 - pin the host the parent resolved, mirroring the port. sanitizeEnv
    // is a DENYLIST, so an env-set host already reached the child via the
    // spread above; this closes the narrower window where the parent read the
    // host from settings.json and settings.json changes before the child reads
    // it, leaving parent and child bound to different addresses.
    CLAUDE_MEM_WORKER_HOST: SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_WORKER_HOST,
    ...extraEnv
  });
```

---

## Task 10 — correctness tail: one URL builder everywhere

Each site below builds `http://${host}:${port}` by raw interpolation and emits the malformed
`http://::1:37777` for an IPv6 host — reachable for the first time now that Task 5 lets `::1` be
configured. Apply `formatHostForUrl`.

**Import source matters.** Files that already import from `worker-utils.js` just add `formatHostForUrl`
to that existing import (Task 2 re-exports it there, so no new module edge). Everything else imports from
`host-binding.js` directly.

| File:line | Import from | Change |
|---|---|---|
| `src/services/restart-verify.ts:49` | existing `'../shared/worker-utils.js'` (`:19`) | `const url = \`http://${formatHostForUrl(getWorkerHost())}:${port}/api/health\`;` |
| `src/services/integrations/WindsurfHooksInstaller.ts:269` | existing `'../../shared/worker-utils.js'` (`:6`) | `const workerUrl = \`http://${formatHostForUrl(getWorkerHost())}:${port}\`;` |
| `src/services/integrations/OpenCodeInstaller.ts:183-184` | existing `'../../shared/worker-utils.js'` (`:8`) | `const workerUrl = \`http://${formatHostForUrl(workerHost)}:${workerPort}\`;` |
| `src/integrations/opencode-plugin/index.ts:103` | **new** `'../../shared/host-binding.js'` | `const WORKER_BASE_URL = \`http://${formatHostForUrl(resolveWorkerHost())}:${resolveWorkerPort()}\`;` |
| `src/npx-cli/commands/doctor.ts:37` | **new** `'../../shared/host-binding.js'` | `const workerUrl = \`http://${formatHostForUrl(workerHost)}:${workerPort}\`;` |
| `src/npx-cli/commands/runtime.ts:169` | **new** `'../../shared/host-binding.js'` | `const searchUrl = \`http://${formatHostForUrl(workerHost)}:${workerPort}/api/search?query=${encodeURIComponent(query)}\`;` |

`src/integrations/opencode-plugin/index.ts` is a standalone bundle — importing from `host-binding.js`
(dependency-free, Task 1) is safe; importing from `worker-utils.js` would drag in the logger, the settings
cache and telemetry, and must not be done. `doctor.ts` and `runtime.ts` likewise only import
`SettingsDefaultsManager` today; keep them off `worker-utils`.

**`src/services/install/shutdown-helper.ts:10`** additionally hardcodes the host, ignoring the setting:

```ts
import { formatHostForUrl } from '../../shared/host-binding.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

// ...inside shutdownWorkerAndWait:
  const host = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_WORKER_HOST;
  const baseUrl = `http://${formatHostForUrl(host)}:${port}`;
```

Check the rest of the function for further `127.0.0.1` literals and route them through `baseUrl`.

---

## Task 11 — Tests

Full assertion list is spec §6; it is the contract. Highlights and the traps:

**`tests/shared/host-binding.test.ts` (new)** — T1–T9. T4/T5/T7 are the encoded security invariant:

```ts
import { describe, it, expect } from 'bun:test';
import {
  resolveBindHosts, isLoopbackHost, isIpv6UnavailableError, formatHostForUrl,
} from '../../src/shared/host-binding.js';

describe('resolveBindHosts', () => {
  it('expands IPv4 loopback to both loopback addresses', () => {
    expect(resolveBindHosts('127.0.0.1')).toEqual(['127.0.0.1', '::1']);
  });

  it('expands localhost deterministically instead of leaving it to DNS', () => {
    expect(resolveBindHosts('localhost')).toEqual(['127.0.0.1', '::1']);
  });

  it('keeps the requested host primary when IPv6 loopback is configured', () => {
    expect(resolveBindHosts('::1')).toEqual(['::1', '127.0.0.1']);
    expect(resolveBindHosts('[::1]')).toEqual(['::1', '127.0.0.1']);
  });

  // SECURITY INVARIANT (spec 2.2): a wildcard is never introduced.
  it('never widens a wildcard bind', () => {
    expect(resolveBindHosts('0.0.0.0')).toEqual(['0.0.0.0']);
    expect(resolveBindHosts('::')).toEqual(['::']);
  });

  it('leaves LAN and near-loopback addresses untouched', () => {
    expect(resolveBindHosts('192.168.1.50')).toEqual(['192.168.1.50']);
    expect(resolveBindHosts('127.0.0.2')).toEqual(['127.0.0.2']);
  });

  it('never emits a wildcard that was not asked for', () => {
    const inputs = [
      '127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.2',
      '192.168.1.50', '10.0.0.5', 'nas.lan', '0.0.0.0', '::',
    ];
    for (const input of inputs) {
      for (const resolved of resolveBindHosts(input)) {
        if (resolved === '0.0.0.0' || resolved === '::') {
          expect(input).toBe(resolved);
        }
      }
    }
  });
});

describe('isIpv6UnavailableError', () => {
  const err = (code: string) => Object.assign(new Error(code), { code });

  it('recognises the no-IPv6-on-this-box family', () => {
    for (const code of ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT', 'EINVAL']) {
      expect(isIpv6UnavailableError(err(code))).toBe(true);
    }
  });

  it('does NOT swallow a real bind failure', () => {
    expect(isIpv6UnavailableError(err('EADDRINUSE'))).toBe(false);
    expect(isIpv6UnavailableError(err('EACCES'))).toBe(false);
    expect(isIpv6UnavailableError(new Error('boom'))).toBe(false);
  });
});

describe('formatHostForUrl', () => {
  it('brackets bare IPv6 literals and leaves everything else alone', () => {
    expect(formatHostForUrl('::1')).toBe('[::1]');
    expect(formatHostForUrl('[::1]')).toBe('[::1]');
    expect(formatHostForUrl('127.0.0.1')).toBe('127.0.0.1');
    expect(formatHostForUrl('localhost')).toBe('localhost');
  });
});

describe('isLoopbackHost', () => {
  it('matches exactly, never by prefix', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(false);
    expect(isLoopbackHost('localhost.evil.com')).toBe(false);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });
});
```

**`tests/server/server-dual-loopback.test.ts` (new)** — T10–T16. Shape:

- Reuse the `mockOptions` factory from `tests/server/server.test.ts` (copy it; do not export from the
  existing upstream-owned test file).
- Random port in `40000 + Math.floor(Math.random() * 10000)`, as the existing suite does.
- **IPv6 guard:** probe once with `net.createServer().listen(0, '::1')`. If it errors, `it.skip` the
  IPv6-dependent cases (T11, T14) — and assert the guard flag itself in a separate always-running test so
  a box silently losing all IPv6 coverage is visible in the output rather than absent from it (the
  `~~35~~` silent-skip lesson).
- T13 must prove **absence of a leaked listener**, not just `listening === false`: after `close()`, bind a
  fresh `net` server on the same port on **both** `127.0.0.1` and `::1` and expect success.
- T14/T15 stub the secondary bind by `spyOn`-ing `http.createServer` (or by injecting via a
  `listenOne` spy on the instance) and rejecting the second call with the target `code`.
- T12 asserts `getHttpServers()` has **length 1** after `listen(port, '0.0.0.0')` — this is the
  socket-level half of the security invariant.

**`tests/services/graceful-shutdown-listeners.test.ts` (new)** — T17–T19. Use fake servers
(`{ closeAllConnections(){}, close(cb){...} }` cast to `http.Server`), a stub `sessionManager` with
`shutdownAll`, and no other config members. T18 is the important one: the first `close` yields
`Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' })` and the second
`close` must **still** have been called.

**`tests/worker/middleware/cors-restriction.test.ts` (rewire)** — T20–T23.
**Delete the local `isAllowedOrigin` at lines 7-12** and import the real one:

```ts
import { createCorsMiddleware, createMiddleware, isAllowedOrigin } from '../../../src/services/worker/http/middleware.js';
```

All existing cases stay. Add:

```ts
    it('allows the bracketed IPv6 loopback with port', () => {
      expect(isAllowedOrigin('http://[::1]:37777')).toBe(true);
      expect(isAllowedOrigin('http://[::1]:3000')).toBe(true);
    });

    it('blocks IPv6-loopback lookalikes', () => {
      expect(isAllowedOrigin('http://[::1].evil.com')).toBe(false);
      expect(isAllowedOrigin('http://[::1]evil.com')).toBe(false);
      expect(isAllowedOrigin('https://[::1]:37777')).toBe(false);
      expect(isAllowedOrigin('http://[::2]:37777')).toBe(false);
      expect(isAllowedOrigin('http://[::1]')).toBe(false);
    });
```

**Settings validator** — T24–T26, against the exported `validateWorkerHostSetting` from Task 5. Place in
a new `tests/worker/routes/settings-worker-host-validation.test.ts` (or the nearest existing
SettingsRoutes test file if one exists). `'::'` **must** be rejected.

**`tests/infrastructure/health-monitor.test.ts`** — T27–T29. Already fork-diverged, safe to edit.
The existing `should honor configured worker host` case (host `127.0.0.2`) must pass **unchanged** —
if it does not, `isLoopbackHost` has been loosened past the spec.

**`tests/infrastructure/process-manager.test.ts`** — T30. Assert as *symmetry with the port*, not as a
dropped-env regression (spec C2).

---

## Verification

Run in order; every one must pass before the PR opens.

```bash
npx tsc --noEmit                      # or the repo's typecheck script
npm run test:gate                     # THE gate - not raw `bun test`
npm run build-and-sync
npm run verify:plugin-delivery
```

Then, on the WSL2 box (spec §6.8):

```bash
ss -ltn | grep 37777                  # expect TWO rows: 127.0.0.1 and [::1]
ss -ltn | grep -E '0\.0\.0\.0:37777|\[::\]:37777'   # expect NO output
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:37777/health   # 200
curl -s -o /dev/null -w '%{http_code}\n' 'http://[::1]:37777/health'     # 200
```

From the Windows browser: `http://localhost:37777` loads **immediately** — this is the acceptance
criterion for the whole PR. Then exercise one settings save from `http://[::1]:37777` and confirm no
`CORS not allowed`.

Finally, stop the worker and confirm `ss -ltn | grep 37777` is **empty** — no leaked listener on either
address.

`tests/known-failures.json` must gain **zero** new entries. If the gate reports an unexpected pass,
retire that baseline entry in this PR (that is the ratchet working, not a failure).

---

## Docs impact

- No `docs/public/` change: the user-facing URL (`http://localhost:37777`) is unchanged — it simply
  starts working on Windows.
- `CLAUDE.md`: no change. The gate, build and file-location sections are all still accurate.
- The `CLAUDE_MEM_WORKER_HOST` docs (wherever the settings table lives) should note that `::1` is now
  accepted and that a loopback host binds both loopback addresses. Check `TEAM-CONFIG.md` and
  `docs/ops/2026-07-15-nas-server-setup.md` for a host table; update if present, skip if not.
- PR body must carry a **Docs Impact** section stating the above.

## Out of scope (do not do in this PR)

- The ~8 display-only hardcoded `localhost` strings — queue **#43**. They become correct automatically
  once `::1` is bound (spec §2.4).
- General IPv6 host support in the validator (`fd00::1` and friends) — `::1` only.
- Issue **#41**'s UID-derived port split-brain. Do not touch port resolution (spec §7).
- Any change to `requireLocalhost`, to `/api/admin/*` auth, or to `SettingsDefaultsManager` defaults.
