# Fix: observation → Chroma vector sync 100% broken (missing `plugin/sqlite/*` modules)

**Date:** 2026-07-02
**Workstream:** 1 (packaging bug) of `HANDOFF_multiuser_and_packaging.md`
**Tracking issues:** #3107 (root cause) · #3091, #3092 (symptoms)
**Superseding PRs:** #3102, #3108, #3116 (see § Adopt-vs-fresh)
**Severity:** High — semantic recall over observations (the headline feature) is non-functional on every 13.9.x install.
**Type:** bug fix + build/packaging hardening. No user-facing API change. Must NOT regress single-user local mode.

This document is both the **spec** (§1–§4) and the **bite-sized implementation plan** (§5) for Builder. Every task
carries literal code. Do not re-plan; if a task's precondition has drifted, surface it, don't improvise.

---

## 1. Problem statement

On published `claude-mem@13.9.x`, every observation fails to vector-sync to Chroma. Session summaries and user prompts
sync fine. Result: the Chroma collection accumulates `session_summary` + `user_prompt` docs but **zero `observation`
docs**, so semantic recall returns nothing useful. Backfill of already-captured observations is also 100% broken.

### 1.1 Root cause (diagnosed — do not re-derive)

`src/services/sync/ChromaSync.ts` reaches two SQLite-layer modules through a runtime `createRequire(import.meta.url)(…)`
indirection instead of a static `import`:

- `../sqlite/observations/files.js` (`parseFileList`) — loaded by `loadFilesHelper()`, called inside
  `formatObservationDocs()`. Pure: its only import is `logger` (no `bun:sqlite`).
- `../sqlite/SessionStore.js` (`SessionStore` ctor) — loaded by `loadSessionStoreCtor()`, used by the backfill paths.
  Pulls `bun:sqlite`.

The indirection is deliberate: a static `import` would make **tsup** follow these modules into the cmem-sdk bundle
(`dist/sdk/index.js`) and drag `bun:sqlite` in, which `scripts/check-sdk-bundle.cjs` forbids (see the comment block at
`ChromaSync.ts:5-11`).

The defect: **`scripts/build-hooks.js` emits `plugin/scripts/worker-service.cjs` via esbuild but never emits the
`plugin/sqlite/**` siblings**, and **`package.json#files` never allowlists `plugin/sqlite`**. esbuild does not follow the
locally-created `createRequire` reference either (that is the whole point of the indirection), so the two modules are
neither bundled nor shipped. At runtime the worker's lazy `require('../sqlite/…')` throws `MODULE_NOT_FOUND`.

- **Why only observations fail:** `formatSummaryDocs()` / `formatUserPromptDoc()` never call `parseFileList`, so they
  never touch the missing module. Only `formatObservationDocs()` does.
- **Why backfill also fails at startup:** `ChromaSync.backfillAllProjects()` calls `loadSessionStoreCtor()`
  **unconditionally** (`ChromaSync.ts:1051`) *before* the `storeOverride ??` fallback, so even though
  `worker-service.ts:603` injects a live `SessionStore`, the lazy require still fires and throws
  (`[CHROMA_SYNC] Failed to initialize backfill resources … Cannot find module '../sqlite/SessionStore.js'`).

### 1.2 Secondary defect — the error was invisible (`{}`)

The failures logged as an empty `{}`, which is why a hard `MODULE_NOT_FOUND` went undiagnosed. Two compounding causes:

1. **Bun throws a `ResolveMessage`, not an `Error`.** A failed `createRequire('…')` under Bun rejects with a
   `ResolveMessage` object, which is **not `instanceof Error`** and whose `message`/`stack` are non-enumerable. The
   logger's serializer (`src/utils/logger.ts`) gates its message/stack extraction on `data instanceof Error`; a
   `ResolveMessage` falls through to `formatData()`, whose empty-`Object.keys()` branch renders `{}`.
2. **Catch sites pass `error as Error`.** `worker-service.ts:597,606` pass `error as Error` — a compile-time cast with
   no runtime effect — so a `ResolveMessage` still reaches the logger un-normalized. `ResponseProcessor.ts:324,410` and
   `SessionRoutes.ts:620` pass the raw `error`.

> **Correction to the handoff brief:** the `{}`-swallowing catch sites are **not** inside `ChromaSync.ts`. ChromaSync's
> own catches already normalize correctly (e.g. `error instanceof Error ? error : new Error(String(error))` at
> `ChromaSync.ts:634,1056`). The real swallow sites are the fire-and-forget `.catch()` callers listed above. Builder
> must fix those files + the logger, **not** ChromaSync's catches.

### 1.3 Why the existing smoke test missed it

`scripts/smoke-clean-room.cjs` boots the packed worker via `worker-service.cjs --version`, which executes only **eager
top-level requires**. The broken requires are **lazy** `createRequire('../sqlite/…')` calls that fire only on the first
observation sync / backfill — never during `--version`. So neither PART 1 (plugin closure) nor PART 2 (tarball
entrypoints) exercises them. The new guard must be a **static** assertion against the packed tarball, not a runtime boot.

---

## 2. Approach decision — A vs B vs Hybrid

| | Approach A (ship loose modules) | Approach B (inline / static-import) |
|---|---|---|
| `parseFileList` (pure, no `bun:sqlite`) | emit `plugin/sqlite/observations/files.js` + allowlist it; keep lazy require | **static `import`** → inlined into the worker bundle AND safe in the SDK bundle (no `bun:sqlite` in its chain) |
| `SessionStore` (pulls `bun:sqlite`) | emit `plugin/sqlite/SessionStore.js` + allowlist it; keep lazy require | cannot static-import into `ChromaSync.ts` — tsup would drag `bun:sqlite` into the SDK bundle → `check-sdk-bundle` fails |

**Decision: HYBRID (B for `files.js`, A for `SessionStore.js`).** Rationale:

- **`parseFileList` → B.** It is pure (`logger` only). Inlining it into the worker bundle eliminates the runtime-require
  foot-gun on the **hot path** (every observation) entirely, and keeps the SDK bundle clean. `#3116` already verified
  `build:sdk` + `check:sdk-bundle` stay green with this change. This is strictly better than shipping it as a loose file.
- **`SessionStore` → A.** It must stay off the SDK's static-import graph because of `bun:sqlite`, so it stays a lazy
  `createRequire`. The lazy target must therefore be emitted as a loose sibling **and** allowlisted in `package.json#files`.
  Fully inlining it into the worker bundle (injection-only, no lazy fallback) is possible but out of scope — see §6.
- The handoff recommended "B unless the worker intentionally hot-swaps those modules." Inspection of `build-hooks.js` and
  `ChromaSync.ts` confirms **there is no hot-swap** — the externalization exists solely to protect the SDK bundle. So B
  is preferred wherever `bun:sqlite` is not in the chain (i.e. `files.js`), and A is the minimal safe option for
  `SessionStore`.

**Net effect after the hybrid:** the only relative require left in any `plugin/scripts/*.cjs` is
`../sqlite/SessionStore.js`, and we ship exactly that one loose file. `files.js` is inlined and no longer shipped.

### 2.1 `loadSessionStoreCtor()` short-circuit (from #3116) is required regardless

`#3116` also fixes the unconditional `loadSessionStoreCtor()` call (§1.1) by short-circuiting it behind the
`storeOverride ??` fallback. Because `worker-service.ts` always injects a live store
(`DatabaseManager.getSessionStore()` returns non-null), this means the worker's backfill path never fires the lazy
require. We keep the loose `SessionStore.js` anyway so (a) any non-injecting caller still resolves and (b) the static
packaging guard passes. Belt-and-suspenders; low risk.

---

## 3. Adopt-vs-fresh — write a FRESH consolidated branch crediting all three contributors

No single open PR is complete or mergeable as-is:

- **#3102 (bionicbutterfly13 — Approach A, most complete):** emits `plugin/sqlite/**` + adds `plugin/sqlite` to
  `package.json#files` + regression test + `npm pack --dry-run` verified. **But** keeps the `parseFileList` foot-gun on
  the hot path, does not fix the unconditional-`loadSessionStoreCtor` backfill bug, and adds no CI packaging guard or
  logging fix.
- **#3108 (KaizenPrompt — Approach A, partial):** emits **and commits** the artifacts, **but does NOT touch
  `package.json#files`.** Verified via `gh pr diff 3108` — the diff contains no `package.json` hunk. **The tarball still
  omits `plugin/sqlite/**`,** so a fresh `npm install` remains broken — the exact bug it claims to fix. Its own PR body
  proposes the packaging guard as a follow-up but does not implement it.
- **#3116 (Garcia6l20 — Approach B):** the cleanest core fix — static `parseFileList` import + `loadSessionStoreCtor`
  short-circuit. **But** it does not ship `SessionStore.js` nor allowlist `plugin/sqlite`, so **backfill stays broken**
  (`SessionStore.js` still `MODULE_NOT_FOUND`), and it bundles **two unrelated fixes** (folder-`CLAUDE.md`
  project-relative path in `claude-md-utils.ts` + `HybridSearchStrategy.isFolder`/metadata-fallback) that must be split
  into a separate change.

**Recommendation: fresh consolidated branch, `Co-authored-by:` all three contributors**, cherry-picking the good parts:

- from **#3116**: the `parseFileList` static-import refactor + the `loadSessionStoreCtor()` short-circuit (Tasks 1–2).
- from **#3102**: the `build-hooks.js` emit step (narrowed to `SessionStore.js` only) + `package.json#files` entry +
  the regression test, adapted (Tasks 3–5, 8).
- **new**: the static packaging guard (Task 7) + the logging fix (Task 6) — neither exists in any PR.
- **exclude** #3116's folder-`CLAUDE.md` + `HybridSearchStrategy` changes → route to a **separate** queue item (they are
  a distinct bug, Workstream-3-adjacent). Do not fold them into this PR.

After merge, close #3102/#3108/#3116 with a note crediting each and pointing at the consolidated PR; close #3091/#3092/#3107.

---

## 4. Scope / non-goals

**In scope:** make the worker's lazy relative requires resolve in the published tarball; kill the hot-path foot-gun;
make MODULE_NOT_FOUND-class errors visible in logs; add a CI guard so this class of bug cannot ship again.

**Out of scope (do not touch in this PR):** #3116's folder-`CLAUDE.md`/`HybridSearchStrategy` changes; the `.install-version`
marker / "runtime not yet set up" issue (#3092 Bug 2); any multi-user/server work (Workstream 2); fully inlining
`SessionStore` via injection-only (§6).

---

## 5. Implementation plan (bite-sized, literal code)

Order matters: Tasks 1–2 remove `files.js` from the lazy set so Task 3 only needs to emit `SessionStore.js`.

### Task 1 — Inline `parseFileList` as a static import (Approach B) · `src/services/sync/ChromaSync.ts`

Source of change: #3116. `parseFileList` has no `bun:sqlite` in its import chain, so a static import is safe for both
the worker bundle (inlined) and the SDK bundle (verified green in #3116).

**1a.** Replace the type-only files import with a value import. Change:

```ts
import type * as SqliteFilesModule from '../sqlite/observations/files.js';
```

to:

```ts
import { parseFileList } from '../sqlite/observations/files.js';
```

**1b.** Update the SDK-bundle comment block (lines 5-11) to no longer claim `parseFileList` is lazy. Replace:

```ts
// cmem-sdk: keep SessionStore + parseFileList off the SDK's import graph.
// Both come from the SQLite layer (`bun:sqlite`). The SDK only uses the
// constructor + ensureCollectionExists + close() surface of ChromaSync,
// so a TYPE-ONLY import is sufficient — value-level uses (`new
// SessionStore()` / parseFileList(...)) are loaded lazily inside the
// SQLite-only methods that need them. Plan §3 anti-pattern: do NOT add
// `bun:sqlite` to the SDK bundle externals — fix the import chain.
```

with:

```ts
// cmem-sdk: keep SessionStore off the SDK's import graph. It comes from the
// SQLite layer (`bun:sqlite`). The SDK only uses the constructor +
// ensureCollectionExists + close() surface of ChromaSync, so a TYPE-ONLY
// import is sufficient — the value-level use (`new SessionStore()`) is loaded
// lazily inside the SQLite-only backfill methods that need it. Plan §3
// anti-pattern: do NOT add `bun:sqlite` to the SDK bundle externals — fix the
// import chain. parseFileList is pure (imports only `logger`, no `bun:sqlite`),
// so it is a normal static import — inlined into the worker bundle, still
// absent from anything that would pull `bun:sqlite` into the SDK bundle.
```

**1c.** Delete the now-dead `loadFilesHelper()` loader (lines 41-48):

```ts
let _filesHelper: typeof SqliteFilesModule | undefined;
function loadFilesHelper(): typeof SqliteFilesModule {
  if (!_filesHelper) {
    const req = lazyCreateRequire();
    _filesHelper = req('../sqlite/observations/files.js') as typeof SqliteFilesModule;
  }
  return _filesHelper;
}
```

**1d.** In `formatObservationDocs()` (lines 155-160), call `parseFileList` directly. Replace:

```ts
    // parseFileList is SQLite-shaped (`bun:sqlite` in the import chain) —
    // resolve it through the deferred loader so this method stays out of
    // the SDK bundle's import graph. Plan §3.
    const filesHelper = loadFilesHelper();
    const files_read = filesHelper.parseFileList(obs.files_read);
    const files_modified = filesHelper.parseFileList(obs.files_modified);
```

with:

```ts
    const files_read = parseFileList(obs.files_read);
    const files_modified = parseFileList(obs.files_modified);
```

### Task 2 — Short-circuit `loadSessionStoreCtor()` behind the injected store · `src/services/sync/ChromaSync.ts`

Source of change: #3116. Fixes the unconditional lazy require in the worker backfill path (§1.1).

**2a.** In `ensureBackfilled()` (around line 628), replace:

```ts
    const SessionStoreCtor = loadSessionStoreCtor();
    const db = storeOverride ?? new SessionStoreCtor();
```

with:

```ts
    const db = storeOverride ?? new (loadSessionStoreCtor())();
```

**2b.** In `backfillAllProjects()` (around line 1051), replace:

```ts
      const SessionStoreCtor = loadSessionStoreCtor();
      db = storeOverride ?? new SessionStoreCtor();
      sync = new ChromaSync('claude-mem');
```

with:

```ts
      db = storeOverride ?? new (loadSessionStoreCtor())();
      sync = new ChromaSync('claude-mem');
```

Leave `loadSessionStoreCtor()` itself in place — it is still the fallback when no store is injected.

### Task 3 — Emit `plugin/sqlite/SessionStore.js` from the build (Approach A) · `scripts/build-hooks.js`

Source of change: #3102 / #3108, narrowed to `SessionStore.js` only (files.js is now inlined by Task 1).

Insert this block **after** the worker-service build + its `WORKER_SERVICE_MAX_BYTES` advisory (after the
`console.warn` block that ends near line 350) and **before** the `console.log('\n🔧 Building server beta service...')`
line:

```js
    // worker-service reaches SessionStore through a runtime
    // createRequire(import.meta.url)('../sqlite/SessionStore.js') call (see
    // ChromaSync.ts loadSessionStoreCtor), not a static import: SessionStore
    // pulls in `bun:sqlite`, so a static import would drag it into the cmem-sdk
    // (tsup) bundle and fail scripts/check-sdk-bundle.cjs. esbuild's worker
    // bundle does not follow that indirection either, so SessionStore.js must be
    // emitted as a loose sibling of the bundle for the runtime require to
    // resolve (#3091/#3092/#3107). observations/files.js is intentionally NOT
    // emitted — parseFileList is a static import inlined into the worker bundle
    // (no bun:sqlite in its chain), the more robust fix for the hot path.
    console.log(`\n🔧 Building lazy-loaded SessionStore module for worker-service...`);
    const sessionStoreOut = `${hooksDir}/../sqlite/SessionStore.js`;
    await build({
      entryPoints: ['src/services/sqlite/SessionStore.ts'],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: sessionStoreOut,
      minify: true,
      logLevel: 'error',
      external: ['bun:sqlite'],
    });
    const sessionStoreStats = fs.statSync(sessionStoreOut);
    console.log(`✓ sqlite/SessionStore.js built (${(sessionStoreStats.size / 1024).toFixed(2)} KB)`);

    // Fast, local half of the packaging guard: assert every relative require
    // target inside the just-built plugin/scripts/*.cjs resolves to an emitted
    // sibling. smoke:clean-room PART 3 re-checks the same invariant against the
    // packed tarball (what actually ships). Together they make the
    // #3091/#3092/#3107 class of bug — a lazy createRequire('../…') whose target
    // the build never emits — impossible to ship. See scripts/check-sdk-bundle.cjs
    // for the sibling string-scan pattern.
    assertPluginRelativeRequiresResolve(hooksDir);
```

And add this helper near the top-level helpers in `scripts/build-hooks.js` (e.g. after `stripHardcodedDirname`):

```js
/**
 * Assert that every relative module specifier (`"../x.js"` / `"./x.js"`)
 * appearing as a string literal inside plugin/scripts/*.cjs resolves to a file
 * on disk, relative to that .cjs. The worker reaches SessionStore via a lazy
 * createRequire('../sqlite/SessionStore.js') that esbuild leaves as a bare
 * string literal in the bundle (not a static import it can follow) — so a
 * missing emit is invisible to esbuild and only explodes at runtime on the
 * first observation/backfill. This static scan catches it at build time.
 * Model: scripts/check-sdk-bundle.cjs (string match against emitted JS).
 */
function assertPluginRelativeRequiresResolve(scriptsDir) {
  const RELATIVE_SPECIFIER = /["'](\.\.?\/[A-Za-z0-9_./-]+\.(?:c?js))["']/g;
  const failures = [];
  for (const entry of fs.readdirSync(scriptsDir)) {
    if (!entry.endsWith('.cjs')) continue;
    const filePath = path.join(scriptsDir, entry);
    const content = fs.readFileSync(filePath, 'utf-8');
    const seen = new Set();
    let m;
    while ((m = RELATIVE_SPECIFIER.exec(content)) !== null) {
      const spec = m[1];
      if (seen.has(spec)) continue;
      seen.add(spec);
      const resolved = path.resolve(path.dirname(filePath), spec);
      if (!fs.existsSync(resolved)) {
        failures.push(`${entry} requires "${spec}" but ${path.relative(scriptsDir, resolved)} was not emitted`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(
      'Plugin relative-require guard FAILED — a bundled script references a ' +
      'sibling module the build did not emit (this is the #3091/#3092/#3107 ' +
      'class of bug):\n  - ' + failures.join('\n  - ')
    );
  }
  console.log('✓ Plugin relative-require guard: all ../ and ./ require targets in plugin/scripts/*.cjs resolve');
}
```

> Note: `${hooksDir}/../sqlite/SessionStore.js` resolves to `plugin/sqlite/SessionStore.js` (sibling of
> `plugin/scripts/`), which is exactly the path the runtime `createRequire('../sqlite/SessionStore.js')` from a file in
> `plugin/scripts/` resolves to. esbuild creates the `plugin/sqlite/observations/` parents as needed; here only
> `plugin/sqlite/` is needed.

### Task 4 — Allowlist `plugin/sqlite` in the npm tarball · `package.json`

Source of change: #3102. In the `"files"` array, add `"plugin/sqlite"` immediately after `"plugin/scripts/*.cjs"`:

```json
  "files": [
    "dist",
    ".agents/plugins/marketplace.json",
    ".codex-plugin",
    "plugin/.claude-plugin",
    "plugin/.codex-plugin",
    "plugin/.mcp.json",
    "plugin/package.json",
    "plugin/bun.lock",
    "plugin/hooks",
    "plugin/modes",
    "plugin/scripts/*.js",
    "plugin/scripts/*.cjs",
    "plugin/sqlite",
    "plugin/skills",
    "plugin/ui",
    "openclaw"
  ],
```

`"plugin/sqlite"` packs the directory recursively, so `plugin/sqlite/SessionStore.js` (and any future emitted sibling)
ships.

### Task 5 — Commit the emitted `plugin/sqlite/SessionStore.js`

`plugin/scripts/*.cjs` are tracked in git (verified: `git ls-files plugin/scripts/` lists `worker-service.cjs` et al.),
and the marketplace sync (`scripts/sync-marketplace.cjs`) copies the committed `plugin/` tree. For parity, the emitted
`plugin/sqlite/SessionStore.js` must be committed too. Steps:

1. Run `npm run build` (emits `plugin/sqlite/SessionStore.js`).
2. `git add plugin/sqlite/SessionStore.js` and commit it alongside the source changes.

It is not gitignored (verified: `git check-ignore` reports it is not ignored). Do **not** commit
`plugin/sqlite/observations/` — Task 1 inlines `files.js`, so it is never emitted.

### Task 6 — Make MODULE_NOT_FOUND-class errors visible (fix the `{}` swallow)

**6a (primary, durable) — harden the logger · `src/utils/logger.ts`.** Bun's `ResolveMessage` is not `instanceof
Error`, so broaden the serializer to treat any object exposing a string `message` as error-like. Add this helper at
module scope (e.g. just above `class Logger`):

```ts
/**
 * Bun throws `ResolveMessage` / `BuildMessage` for a failed require()/import.
 * These are NOT `instanceof Error`, and their `.message`/`.stack` are
 * non-enumerable, so `Object.keys()`/JSON serialization renders them as `{}` —
 * exactly why the #3091/#3092 MODULE_NOT_FOUND presented as an empty `{}` and
 * went undiagnosed. Treat any object exposing a string `message` (or `stack`)
 * as error-like so it serializes usefully.
 */
function isErrorLike(value: unknown): value is { message: string; stack?: string } {
  return (
    value instanceof Error ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as { message?: unknown }).message === 'string')
  );
}
```

In `formatData()`, replace the `data instanceof Error` branch (lines 131-135):

```ts
      if (data instanceof Error) {
        return this.getLevel() === LogLevel.DEBUG
          ? `${data.message}\n${data.stack}`
          : data.message;
      }
```

with:

```ts
      if (isErrorLike(data)) {
        const stack = data.stack;
        return this.getLevel() === LogLevel.DEBUG && stack
          ? `${data.message}\n${stack}`
          : data.message;
      }
```

In `log()`, replace the `data instanceof Error` branch (lines 247-250):

```ts
      if (data instanceof Error) {
        dataStr = this.getLevel() === LogLevel.DEBUG
          ? `\n${data.message}\n${data.stack}`
          : ` ${data.message}`;
      } else if (this.getLevel() === LogLevel.DEBUG && typeof data === 'object') {
```

with:

```ts
      if (isErrorLike(data)) {
        const stack = data.stack;
        dataStr = this.getLevel() === LogLevel.DEBUG && stack
          ? `\n${data.message}\n${stack}`
          : ` ${data.message}`;
      } else if (this.getLevel() === LogLevel.DEBUG && typeof data === 'object') {
```

In `routeErrorToSink()` (line 324), broaden the gate so error-like non-Error values still route, and normalize to a real
Error for the sink. Replace:

```ts
      if (!errorSink || !(data instanceof Error)) return;
```

with:

```ts
      if (!errorSink || !isErrorLike(data)) return;
```

and replace the `errorSink(data);` call (line 330) with:

```ts
      errorSink(data instanceof Error ? data : new Error(data.message));
```

**6b (defense in depth) — normalize the swallow catch sites.** Fix the `error as Error` cast lies so a `ResolveMessage`
reaches the logger as a real Error even independent of 6a.

- `src/services/worker-service.ts:597` — replace `}, error as Error);` on the telemetry-backfill catch with:
  `}, error instanceof Error ? error : new Error(String(error)));`
- `src/services/worker-service.ts:606` — same replacement on the `Backfill failed (non-blocking)` catch.
- `src/services/worker/agents/ResponseProcessor.ts:328` and `:413` — the `.catch((error) => {…}, error)` calls pass raw
  `error`; change the 4th arg from `error` to `error instanceof Error ? error : new Error(String(error))`.
- `src/services/worker/http/routes/SessionRoutes.ts:623` — same: change the 4th arg from `error` to
  `error instanceof Error ? error : new Error(String(error))`.

6a alone fixes the visible symptom; 6b removes the misleading casts. Do both.

### Task 7 — CI packaging guard against the packed tarball · `scripts/smoke-clean-room.cjs`

The build-time guard (Task 3) checks the repo tree; this checks **what actually ships**. Add a PART 3 to
`smoke-clean-room.cjs` that scans the already-installed tarball's `plugin/scripts/*.cjs` for relative require targets and
asserts each resolves inside the installed package. Reuses the pack+install PART 2 already performs.

**7a.** Add the check function (model: `check-sdk-bundle.cjs` string scan):

```js
// ---------------------------------------------------------------------------
// PART 3 — plugin relative-require closure (the #3091/#3092/#3107 guard)
// ---------------------------------------------------------------------------
// The worker reaches SessionStore via a lazy
// createRequire('../sqlite/SessionStore.js') that fires only on the first
// observation/backfill — never during the `--version` boots PART 1/2 do, so
// those parts cannot catch a missing sibling. Statically assert every relative
// require target inside the PACKED plugin/scripts/*.cjs resolves inside the
// tarball. This is the guard that would have caught 13.9.x shipping without
// plugin/sqlite/.
function checkPluginRelativeRequires(failures, pkgRoot) {
  log('\nPART 3 — plugin relative-require closure (#3091/#3092/#3107 guard)');

  const scriptsDir = path.join(pkgRoot, 'plugin', 'scripts');
  if (!fs.existsSync(scriptsDir)) {
    failures.push(`packed tarball is missing plugin/scripts (${scriptsDir})`);
    return;
  }

  const RELATIVE_SPECIFIER = /["'](\.\.?\/[A-Za-z0-9_./-]+\.(?:c?js))["']/g;
  let checked = 0;
  for (const entry of fs.readdirSync(scriptsDir)) {
    if (!entry.endsWith('.cjs')) continue;
    const filePath = path.join(scriptsDir, entry);
    const content = fs.readFileSync(filePath, 'utf8');
    const seen = new Set();
    let m;
    while ((m = RELATIVE_SPECIFIER.exec(content)) !== null) {
      const spec = m[1];
      if (seen.has(spec)) continue;
      seen.add(spec);
      checked++;
      const resolved = path.resolve(path.dirname(filePath), spec);
      if (!fs.existsSync(resolved)) {
        failures.push(
          `published plugin/scripts/${entry} requires "${spec}" but it is ` +
            `absent from the tarball (would throw MODULE_NOT_FOUND at runtime)`
        );
      }
    }
  }
  log(`  Checked ${checked} relative require target(s) across plugin/scripts/*.cjs.`);
}
```

**7b.** `checkPackageCompleteness()` computes `pkgRoot` but does not return it. Return it at the end of that function
(add `return pkgRoot;` before its final closing brace on the success paths — simplest: change the final fall-through so
the function returns `pkgRoot`), then in `main()` pass it to PART 3. Replace the `try` block in `main()`:

```js
  try {
    checkPluginClosure(failures);
    checkPackageCompleteness(failures);
  } finally {
```

with:

```js
  try {
    checkPluginClosure(failures);
    const pkgRoot = checkPackageCompleteness(failures);
    if (pkgRoot) checkPluginRelativeRequires(failures, pkgRoot);
  } finally {
```

If a `failures.push` + `return` early-exit path in `checkPackageCompleteness()` returns `undefined`, PART 3 is skipped
(the pack/install already failed and is reported) — that is correct. Ensure the success path ends with `return pkgRoot;`.

`smoke:clean-room` already runs in CI (`.github/workflows/ci.yml` → `clean-room-deps` job) and in
`.github/workflows/npm-publish.yml`, so PART 3 gates both PRs and publishes with no workflow edit.

### Task 8 — Regression test · `tests/worker-service-lazy-sqlite-modules.test.ts`

Source of change: #3102, adapted: `SessionStore.js` must be emitted+resolvable; `files.js` must be **inlined** (i.e.
`parseFileList` reachable from the worker bundle **without** a `plugin/sqlite/observations/files.js` file existing).

```ts
import { describe, it, expect } from 'bun:test';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';

const PLUGIN_DIR = join(import.meta.dir, '..', 'plugin');
const WORKER_SCRIPTS_DIR = join(PLUGIN_DIR, 'scripts');
const SESSION_STORE_PATH = join(PLUGIN_DIR, 'sqlite', 'SessionStore.js');
const WORKER_BUNDLE = join(WORKER_SCRIPTS_DIR, 'worker-service.cjs');

const require = createRequire(import.meta.url);

// #3091/#3092/#3107: worker-service.cjs reaches SessionStore via a runtime
// createRequire('../sqlite/SessionStore.js') that the build must emit as a loose
// sibling (Approach A — SessionStore pulls bun:sqlite, so it cannot be inlined
// into the SDK bundle). parseFileList, by contrast, is now a static import
// inlined into the worker bundle (Approach B), so it must resolve WITHOUT any
// plugin/sqlite/observations/files.js file existing.
describe('worker-service.cjs lazy/inlined SQLite modules (#3091/#3092/#3107)', () => {
  it('emits sqlite/SessionStore.js next to the worker bundle', () => {
    expect(existsSync(SESSION_STORE_PATH)).toBe(true);
  });

  it('resolves sqlite/SessionStore.js the same way ChromaSync.ts requires it at runtime', () => {
    const { SessionStore } = require(join(WORKER_SCRIPTS_DIR, '../sqlite/SessionStore.js'));
    expect(typeof SessionStore).toBe('function');
  });

  it('inlines parseFileList — no ../sqlite/observations/files.js require survives in the bundle', () => {
    const bundle = require('fs').readFileSync(WORKER_BUNDLE, 'utf8');
    expect(bundle).not.toContain('../sqlite/observations/files.js');
  });

  it('does not ship a loose observations/files.js (it is inlined, not emitted)', () => {
    expect(existsSync(join(PLUGIN_DIR, 'sqlite', 'observations', 'files.js'))).toBe(false);
  });
});
```

> This test depends on build output — it must run after `npm run build`. CI runs `bun test` after `npm run build` in the
> `build` job, so it is covered; note that in the local pre-build tree it will fail until `npm run build` runs.

---

## 6. Open decisions for Mark (do not block Builder; default in **bold**)

1. **Fully inline `SessionStore` into the worker bundle (injection-only), eliminating the last loose module?**
   Because `worker-service.ts` always injects a live `SessionStore`, the lazy `createRequire('../sqlite/SessionStore.js')`
   fallback is dead in production after Task 2. A follow-up could make injection mandatory (drop the lazy fallback) and
   statically import `SessionStore` only from a worker-only entry, making `worker-service.cjs` fully self-contained (zero
   `plugin/sqlite/**`). **Default: defer to a separate hardening item — keep the loose file + guard now** (lower risk,
   satisfies "no single-user regression"). Flag if you'd rather do it in one pass.
2. **Commit `plugin/sqlite/SessionStore.js` (Task 5) vs build-only (like #3102)?** The repo tracks `plugin/scripts/*.cjs`
   and the marketplace sync copies the committed tree, so **default: commit it** for parity. Flag if you want `plugin/`
   build artifacts kept out of git wholesale (that is a larger, separate policy change).
3. **Split #3116's folder-`CLAUDE.md` + `HybridSearchStrategy` fixes into their own queue item now, or later?**
   **Default: file a separate item and exclude them here** so this PR stays a clean packaging fix. They look correct but
   need their own review + UAT (folder context generation).

---

## 7. Verification (Builder gates)

1. `npm run typecheck` — clean.
2. `npm run build` — the new build-time relative-require guard (Task 3) prints
   `✓ Plugin relative-require guard: …` and `✓ sqlite/SessionStore.js built (…)`; `check:sdk-bundle` stays green
   (confirms `parseFileList`'s static import did not pull `bun:sqlite` into the SDK bundle).
3. `bun test` — the Task 8 regression test passes; full suite green.
4. `npm run smoke:clean-room` — PART 3 prints `Checked N relative require target(s)` and passes (asserts
   `plugin/sqlite/SessionStore.js` ships in the tarball and resolves).
5. **Manual UAT:** `npm pack` → `npm install <tarball>` into a throwaway plugin dir → start the worker → trigger an
   observation. Confirm the log transitions from `[CHROMA] … chroma sync failed … {}` to
   `[CHROMA_SYNC] Syncing observation {…}`, that an `observation` doc lands in Chroma, and that startup logs
   `[CHROMA_SYNC] Smart backfill complete` (backfill initializes) rather than `Failed to initialize backfill resources`.
6. Regression negative check (optional, high-value): temporarily remove `plugin/sqlite/SessionStore.js` (or the
   `package.json#files` entry) and confirm `npm run smoke:clean-room` FAILS with the PART 3 message — proves the guard is
   not a tautology.

---

## 8. Credits

Consolidates and supersedes #3102 (bionicbutterfly13), #3108 (KaizenPrompt), #3116 (Garcia6l20). The consolidated PR
should carry `Co-authored-by:` trailers for all three.
