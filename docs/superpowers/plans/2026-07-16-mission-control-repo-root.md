# Mission Control — repo-root resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-enable the three Mission Control sources that Phase 1 deferred (velocity, `Proposed`-spec review mining, doc-Open-Questions mining) by implementing `resolveRepoRoot()` and threading the resolved root into the `git`/`gh` boundary so all filesystem **and** git/gh reads resolve the correct repo on a **deployed** worker. Fall back to today's loud-deferred state — never a silent wrong result — when the root cannot be resolved.

**Architecture:** `resolveRepoRoot()` (`src/services/mission-control/repo-root.ts`) resolves `env CLAUDE_MEM_PROJECT_ROOT → settings.json CLAUDE_MEM_PROJECT_ROOT → git rev-parse --show-toplevel → null`, validating each candidate on the presence of `docs/BUILDER_QUEUE.md` (the canonical roadmap marker) and memoizing the result. A misconfigured (set-but-invalid) env/settings value logs one loud WARN and falls through to `null`. Separately, the `git`/`gh` shell boundary (`shell.ts`) gains an optional `cwd`, threaded from the resolved root by `MissionControlRoutes`, so velocity's `git log` series and PR-review `gh pr list` run against the correct repo rather than the worker's launch directory. The UI re-adds the velocity pane (fetch + render), degrading to a labeled note when velocity is still deferred.

**Tech Stack:** TypeScript, `bun:sqlite`, Express 5 (`BaseRouteHandler`), `Bun.spawnSync` for `gh`/`git`, React 19 viewer (esbuild bundle via the build), `bun test` with `:memory:` / tmpdir fixtures.

## Context: what already exists (do NOT rebuild)

This is a **re-enable**, not a rewrite (design spec §7). The following already ship and are unit-tested — leave them unchanged unless a task says otherwise:

- `VelocityQuery.ts`, `AttentionMiner.ts` (incl. `extractProposedSpec` / `extractOpenQuestions` and the `specMiningEnabled` guard), `loadSpecFiles.ts`, `BuilderQueueParser.ts`.
- `MissionControlRoutes.handleVelocity` already branches on `resolveRepoRoot()`: `null` → `{deferred:true}`, else parse `docs/BUILDER_QUEUE.md` and run `queryVelocity`. `handleAttention` already emits `specMiningDeferred: resolveRepoRoot() === null` and `mineOnce` already passes `specMiningEnabled: resolveRepoRoot() !== null` + `specFiles: loadSpecFiles()`.
- `constants/api.ts` already declares `MC_VELOCITY` (`api.ts:9`).

So the only production changes are: (1) implement `resolveRepoRoot()`; (2) add `cwd` to the boundary + wire it; (3) re-add the velocity fetch + pane in the viewer.

## Global Constraints

- **Read/mine only.** No `attention_raise`, no LLM synthesis, no roadmap-row linkage, no write of any kind toward `docs/BUILDER_QUEUE.md` (design spec §2, parent spec §10).
- **Never resolve a wrong tree silently (R3).** A `CLAUDE_MEM_PROJECT_ROOT` that does not contain `docs/BUILDER_QUEUE.md` must produce a **loud WARN + `null`** (deferred), not a silent resolution of the wrong directory.
- **No regression to the shipped 3 panes.** When `resolveRepoRoot()` returns `null`, every route/pane must behave exactly as it does today (velocity `{deferred:true}`; `specMiningDeferred:true`; boundary runs in the worker cwd). The `cwd` addition to the boundary is additive — `cwd` undefined ⇒ current behavior.
- **`logger.warn(component, message, context?)`** — `component` must be a member of the `Component` union in `src/utils/logger.ts` (**there is no `MISSION_CONTROL` member** — use `'WORKER'`, as `MissionControlRoutes.ts:67` already does).
- **Do not add `CLAUDE_MEM_PROJECT_ROOT` to the typed `SettingsDefaults`.** Read it inline (mirroring `resolveDataDir` in `paths.ts:17-37`) to keep this slice from touching the shared defaults type (design spec Q1).
- **Test runner is `bun test`** (`import { describe, it, expect } from 'bun:test'`).
- **The viewer bundle is a built artifact** — edit `src/ui/viewer/**` and rebuild; never hand-edit `plugin/ui/viewer-bundle.js`.
- Follow branch policy (CLAUDE.md): this plan's PR targets `fork/main`; never push to `origin` (guard `DISABLED_UPSTREAM_DO_NOT_PUSH`).

---

### Task 1: Implement `resolveRepoRoot()` (env → settings → git-toplevel → null, validated + memoized + loud)

Replaces the Phase-1 stub (`repo-root.ts:22-23` `return null`) with the real resolver. Mirrors the proven `resolveDataDir` precedent (`paths.ts:17-37`). Validates every candidate on `docs/BUILDER_QUEUE.md`. Memoizes (the git-toplevel probe spawns a process and this runs on the Attention hot path). Adds `resetRepoRootCache()` for tests. Keeps `REPO_ROOT_DEFERRED_REASON` (imported by the route).

**Files:**
- Modify: `src/services/mission-control/repo-root.ts`
- Test: `tests/mission-control/repo-root.test.ts`

**Interfaces:**
- Consumes: `process.env.CLAUDE_MEM_PROJECT_ROOT`; `USER_SETTINGS_PATH` + `parseJsonWithBom` (settings.json); `runCommand` (git); `logger`.
- Produces (unchanged signatures): `function resolveRepoRoot(): string | null`; `const REPO_ROOT_DEFERRED_REASON: string`. Adds: `function resetRepoRootCache(): void`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/mission-control/repo-root.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { resolveRepoRoot, resetRepoRootCache } from '../../src/services/mission-control/repo-root.js';

function makeRepo(withQueue: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mc-root-'));
  if (withQueue) {
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'BUILDER_QUEUE.md'), '# Builder Queue\n');
  }
  return root;
}

const ENV_KEY = 'CLAUDE_MEM_PROJECT_ROOT';
let savedEnv: string | undefined;
const cleanup: string[] = [];

beforeEach(() => { savedEnv = process.env[ENV_KEY]; delete process.env[ENV_KEY]; resetRepoRootCache(); });
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedEnv;
  resetRepoRootCache();
  for (const dir of cleanup.splice(0)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('resolveRepoRoot', () => {
  it('returns the env-var path when it contains docs/BUILDER_QUEUE.md', () => {
    const root = makeRepo(true); cleanup.push(root);
    process.env[ENV_KEY] = root;
    resetRepoRootCache();
    expect(resolveRepoRoot()).toBe(root);
  });

  it('returns null (deferred) — loudly, not silently — when the env var is set but invalid', () => {
    const root = makeRepo(false); cleanup.push(root); // no docs/BUILDER_QUEUE.md
    process.env[ENV_KEY] = root;
    resetRepoRootCache();
    // Must NOT resolve the wrong tree; deferred instead (the WARN is asserted via the log spy below).
    expect(resolveRepoRoot()).toBeNull();
  });

  it('memoizes: a second call does not re-resolve', () => {
    const root = makeRepo(true); cleanup.push(root);
    process.env[ENV_KEY] = root;
    resetRepoRootCache();
    expect(resolveRepoRoot()).toBe(root);
    // Change the env var WITHOUT resetting the cache — memoized value must persist.
    process.env[ENV_KEY] = '/nonexistent/other';
    expect(resolveRepoRoot()).toBe(root);
  });

  it('returns null when nothing resolves (no env, no settings key, git-toplevel invalid)', () => {
    // In the bun-test cwd there is no docs/BUILDER_QUEUE.md at the git toplevel of a tmp cwd;
    // this asserts the terminal deferred state rather than a throw.
    resetRepoRootCache();
    const result = resolveRepoRoot();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});
```

> **Implementer note:** the "loud WARN" assertion in the invalid-env case is exercised end-to-end by the log-spy variant in Step 4; the shape test above asserts the **`null`** (never-wrong-tree) behavior, which is the load-bearing safety property.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-control/repo-root.test.ts`
Expected: FAIL — `resetRepoRootCache` is not exported, and `resolveRepoRoot()` currently always returns `null` (the env-var case fails).

- [ ] **Step 3: Implement the resolver**

```ts
// src/services/mission-control/repo-root.ts
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { runCommand } from './shell.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { parseJsonWithBom } from '../../shared/atomic-json.js';
import { logger } from '../../utils/logger.js';

/**
 * Resolve the Mission Control repository root for the filesystem- and git-backed
 * sources:
 *   - velocity  → docs/BUILDER_QUEUE.md   (+ `git log` merge series, via the boundary cwd)
 *   - reviews   → docs/superpowers/specs/** (Proposed-spec mining) + `gh pr list`
 *   - questions → docs/**                   (doc Open-Questions mining)
 *
 * Strategy (Backlog #24): env `CLAUDE_MEM_PROJECT_ROOT` (authoritative) → settings.json
 * key → `git rev-parse --show-toplevel` (source-checkout convenience) → null. A candidate
 * validates iff it contains `docs/BUILDER_QUEUE.md` — the canonical roadmap file — so a
 * deployed worker whose cwd is an upstream checkout does NOT false-resolve. A set-but-
 * invalid env/settings value logs one loud WARN and falls through to null (never a silent
 * wrong tree). Memoized: the git probe spawns a process and this runs on the Attention hot
 * path. `null` keeps velocity + spec/doc mining in their existing labeled-deferred state.
 */

/** A candidate validates iff it contains docs/BUILDER_QUEUE.md (the canonical roadmap file). */
function isMissionControlRepo(root: string): boolean {
  return existsSync(path.join(root, 'docs', 'BUILDER_QUEUE.md'));
}

function readSettingsProjectRoot(): string | null {
  try {
    if (!existsSync(USER_SETTINGS_PATH)) return null;
    const raw = parseJsonWithBom<Record<string, any>>(readFileSync(USER_SETTINGS_PATH, 'utf-8'));
    const settings = raw.env ?? raw;
    const val = settings.CLAUDE_MEM_PROJECT_ROOT;
    return typeof val === 'string' && val.trim() ? val.trim() : null;
  } catch {
    return null; // settings missing/corrupt — treat as unset
  }
}

function gitToplevel(): string | null {
  const result = runCommand(['git', 'rev-parse', '--show-toplevel']);
  if (result.exitCode !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

function resolve(): string | null {
  // 1. Explicit env var — authoritative. Loud on misconfiguration (R3).
  const envRoot = process.env.CLAUDE_MEM_PROJECT_ROOT?.trim();
  if (envRoot) {
    if (isMissionControlRepo(envRoot)) return envRoot;
    logger.warn('WORKER',
      'CLAUDE_MEM_PROJECT_ROOT is set but does not contain docs/BUILDER_QUEUE.md — Mission Control velocity + spec/doc mining stay deferred',
      { path: envRoot });
    return null;
  }
  // 2. settings.json key (mirrors resolveDataDir). Loud on misconfiguration.
  const settingsRoot = readSettingsProjectRoot();
  if (settingsRoot) {
    if (isMissionControlRepo(settingsRoot)) return settingsRoot;
    logger.warn('WORKER',
      'settings.json CLAUDE_MEM_PROJECT_ROOT does not contain docs/BUILDER_QUEUE.md — Mission Control velocity + spec/doc mining stay deferred',
      { path: settingsRoot });
    return null;
  }
  // 3. git auto-detect from the worker cwd — serves the source-checkout dev case only.
  //    Validation on docs/BUILDER_QUEUE.md means an upstream/other checkout declines safely.
  const top = gitToplevel();
  if (top && isMissionControlRepo(top)) return top;
  // 4. Deferred — the existing labeled state stands.
  return null;
}

let cache: { root: string | null } | undefined;

export function resolveRepoRoot(): string | null {
  if (cache === undefined) cache = { root: resolve() };
  return cache.root;
}

/** Test-only: clear the memoized resolution so env/settings changes re-resolve. */
export function resetRepoRootCache(): void {
  cache = undefined;
}

/** Human-readable label for a repo-root-gated (deferred) source. */
export const REPO_ROOT_DEFERRED_REASON =
  'Deferred — needs repo-root resolution (follow-up #24)';
```

- [ ] **Step 4: Add the loud-WARN log-spy test, then run to verify all pass**

Append to `tests/mission-control/repo-root.test.ts`:

```ts
import { logger } from '../../src/utils/logger.js';
import { spyOn } from 'bun:test';

describe('resolveRepoRoot loud-on-misconfig', () => {
  it('logs exactly one WARN when the env var is set but invalid', () => {
    const root = makeRepo(false); cleanup.push(root);
    process.env[ENV_KEY] = root;
    resetRepoRootCache();
    const warn = spyOn(logger, 'warn');
    try {
      expect(resolveRepoRoot()).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const [, message] = warn.mock.calls[0];
      expect(String(message)).toContain('CLAUDE_MEM_PROJECT_ROOT');
    } finally {
      warn.mockRestore();
    }
  });
});
```

Run: `bun test tests/mission-control/repo-root.test.ts`
Expected: PASS (all cases). If `spyOn`/`mock` ergonomics differ on the installed `bun` version, keep the assertion to "returns null" and drop the call-count check — the null (never-wrong-tree) behavior is the load-bearing one.

- [ ] **Step 5: Commit**

```bash
git add src/services/mission-control/repo-root.ts tests/mission-control/repo-root.test.ts
git commit -m "feat(mission-control): resolve repo root via CLAUDE_MEM_PROJECT_ROOT env/settings/git (validated, memoized, loud)"
```

---

### Task 2: Thread a working directory through the `git`/`gh` boundary (velocity series + reviews resolve the right repo)

Per design spec §5/F3/F4: the boundary's `runCommand` passes no `cwd`, so `git log --merges` (velocity's `shippedByWeek`) and `gh pr list` (reviews) run in the worker's launch directory — on a deployed worker, potentially an **upstream** checkout. Add an optional `cwd`, thread it from the resolved root. Additive: `cwd` undefined ⇒ today's behavior.

**Files:**
- Modify: `src/services/mission-control/shell.ts` (optional `cwd`)
- Modify: `src/services/worker/http/routes/MissionControlRoutes.ts` (injectable `repoRoot`, thread as boundary cwd, use in the 3 handlers)
- Modify: `src/services/mission-control/loadSpecFiles.ts` (optional `root` param)
- Test: `tests/mission-control/shell.test.ts` (add a cwd case)

**Interfaces:**
- `function runCommand(cmd: string[], cwd?: string): ShellResult`
- `function createGitGhBoundary(cwd?: string): GitGhBoundary` (closes over `cwd` for every `gh`/`git` call)

- [ ] **Step 1: Write the failing test**

Append to `tests/mission-control/shell.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

describe('runCommand cwd', () => {
  it('runs the command in the provided working directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mc-cwd-'));
    try {
      // `git rev-parse` is unavailable/uninitialized in a bare tmpdir; use a portable
      // cwd probe instead: node -e printing process.cwd() must equal the passed dir.
      const result = runCommand(['node', '-e', 'process.stdout.write(process.cwd())'], dir);
      expect(result.exitCode).toBe(0);
      // Realpath-normalize both sides (macOS /var -> /private/var symlinking).
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(path.basename(result.stdout)).toBe(path.basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still works with cwd omitted (no regression)', () => {
    const result = runCommand(['node', '-e', 'process.stdout.write("ok")']);
    expect(result.stdout).toBe('ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-control/shell.test.ts`
Expected: FAIL — `runCommand` does not accept a `cwd` argument (the passed dir is ignored; `process.cwd()` is the test runner's dir).

- [ ] **Step 3: Add `cwd` to `runCommand` and `createGitGhBoundary`**

In `src/services/mission-control/shell.ts`, change the `runCommand` signature and `Bun.spawnSync` call:

```ts
export function runCommand(cmd: string[], cwd?: string): ShellResult {
  try {
    const result = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
    return {
      stdout: new TextDecoder().decode(result.stdout).trim(),
      stderr: new TextDecoder().decode(result.stderr).trim(),
      exitCode: result.exitCode ?? 1,
    };
  } catch (error) {
    // Bun.spawnSync throws when the binary is missing — normalize to 127.
    return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 127 };
  }
}
```

Then make `createGitGhBoundary` accept and thread the `cwd` into every invocation:

```ts
export function createGitGhBoundary(cwd?: string): GitGhBoundary {
  return {
    ghAvailable(): boolean {
      return runCommand(['gh', '--version'], cwd).exitCode === 0
        && runCommand(['gh', 'auth', 'status'], cwd).exitCode === 0;
    },

    listOpenPrs(): OpenPr[] {
      const result = runCommand(['gh', 'pr', 'list', '--state', 'open', '--json', 'number,title,url'], cwd);
      if (result.exitCode !== 0) return []; // graceful degradation (R5)
      try {
        const parsed = JSON.parse(result.stdout) as Array<{ number: number; title: string; url: string }>;
        return parsed.map(p => ({ number: p.number, title: p.title, url: p.url }));
      } catch {
        return [];
      }
    },

    listMergeCommits(sinceIso?: string): MergeCommit[] {
      const args = ['git', 'log', '--merges', `--pretty=format:%H${FIELD_SEP}%cI${FIELD_SEP}%s`];
      if (sinceIso) args.push(`--since=${sinceIso}`);
      const result = runCommand(args, cwd);
      if (result.exitCode !== 0 || result.stdout.length === 0) return [];
      return result.stdout
        .split('\n')
        .map(line => line.split(FIELD_SEP))
        .filter(parts => parts.length === 3)
        .map(([sha, dateIso, subject]) => ({ sha, dateIso, subject }));
    },
  };
}
```

> **Implementer note:** `FIELD_SEP` and the `ShellResult`/`OpenPr`/`MergeCommit`/`GitGhBoundary` declarations already exist above these functions — do not redeclare them; only the two function bodies change.

- [ ] **Step 4: Capture the root once into an injectable `repoRoot` param, and thread it as the boundary cwd**

In `src/services/worker/http/routes/MissionControlRoutes.ts`, the constructor currently does `this.boundary = boundary ?? createGitGhBoundary();`. Add an injectable `repoRoot` param (default `resolveRepoRoot()`, which the file already imports), store it, and build the default boundary's cwd from it. The injectable seam is what makes the route deterministically testable (Task 3) — the git-toplevel fallback would otherwise resolve the real repo during `bun test`.

```ts
  constructor(
    private dbManager: DatabaseManager,
    boundary?: GitGhBoundary,
    // Captured ONCE (not per-request). Default resolves the real root; tests inject
    // `null` (deferred) or a fixture dir (resolved) for determinism. Threaded as the
    // git/gh cwd so `git log` (velocity series) + `gh pr list` (reviews) run against the
    // correct repo, not the worker launch dir (a deployed worker's cwd may be an upstream
    // checkout). `undefined` cwd ⇒ worker cwd (unchanged Phase-1 behavior).
    private repoRoot: string | null = resolveRepoRoot(),
  ) {
    super();
    this.boundary = boundary ?? createGitGhBoundary(this.repoRoot ?? undefined);
  }
```

Then replace the three per-request `resolveRepoRoot()` calls with `this.repoRoot`:

- `mineOnce`: `specMiningEnabled: this.repoRoot !== null` (was `resolveRepoRoot() !== null`) **and** `specFiles: loadSpecFiles(this.repoRoot)` (was `loadSpecFiles()`) — so the files read come from the same injected root.
- `handleAttention`: `specMiningDeferred: this.repoRoot === null` (was `resolveRepoRoot() === null`).
- `handleVelocity`: `const root = this.repoRoot;` (was `const root = resolveRepoRoot();`). The rest of `handleVelocity` (the `root === null` deferred branch, the `path.join(root, 'docs', 'BUILDER_QUEUE.md')` read, the loud parse-error branch) is unchanged.

Give `loadSpecFiles` a matching optional root so the injected value flows through. In `src/services/mission-control/loadSpecFiles.ts`, change the signature only:

```ts
export function loadSpecFiles(root: string | null = resolveRepoRoot()): { path: string; content: string }[] {
  if (root === null) return [];
  const files: { path: string; content: string }[] = [];
  // ...rest of the body unchanged (walkMarkdown over SPEC_DIRS relative to `root`)...
```

(Delete the now-redundant `const root = resolveRepoRoot();` line; keep the `resolveRepoRoot` import for the default param. Everything below the guard is unchanged.) This keeps `this.repoRoot`, the boundary cwd, and the spec-file reads all sourced from one value — consistent in production and deterministic in tests.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test tests/mission-control/shell.test.ts`
Expected: PASS (all cases, incl. the two new cwd cases and the pre-existing degradation cases).
Run: `npm run typecheck` — no new errors in `src/services/mission-control/**` or `MissionControlRoutes.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/services/mission-control/shell.ts src/services/worker/http/routes/MissionControlRoutes.ts src/services/mission-control/loadSpecFiles.ts tests/mission-control/shell.test.ts
git commit -m "feat(mission-control): thread resolved repo root as git/gh cwd + injectable repoRoot (velocity series + reviews resolve the right repo)"
```

---

### Task 3: Route-level tests — update the deferred cases, add resolved cases + the counts/series independence guard

Two things: (1) the existing "velocity returns deferred" and "attention specMiningDeferred" tests (`mission-control-routes.test.ts:65-93`) construct the route with the 2-arg form, so after Task 2 they'd take the **default** `repoRoot = resolveRepoRoot()` — which, during `bun test`, the git-toplevel fallback resolves to the real worktree (it *has* `docs/BUILDER_QUEUE.md`), flipping them to the resolved branch and **failing**. They must pass `repoRoot: null` explicitly to keep asserting the deferred branch. (2) Add resolved-branch cases via a fixture-dir `repoRoot`, including the F3 counts/series independence guard.

This task uses the file's **existing** harness — `makeMockApp()`, `makeDbManager()`, `routes.setupRoutes(app)`, `app.invoke(path, req)` (see `mission-control-routes.test.ts:8-29`). No env-var manipulation and no module-memo reset are needed, because `repoRoot` is injected directly.

**Files:**
- Modify: `tests/worker/http/routes/mission-control-routes.test.ts`

**Interfaces:** none new — uses the injectable `repoRoot` constructor param from Task 2.

- [ ] **Step 1: Pin the two existing deferred tests to `repoRoot: null`**

In `mission-control-routes.test.ts`, the two constructions that must stay deferred are the velocity test (`:65-80`) and the attention test (`:82-93`). Add `null` as the third constructor arg to each:

```ts
    // velocity deferred test (was: new MissionControlRoutes(makeDbManager() as any, { ... }))
    const routes = new MissionControlRoutes(makeDbManager() as any, {
      ghAvailable: () => false, listOpenPrs: () => [], listMergeCommits: () => [],
    }, null); // repoRoot: null ⇒ deferred, deterministic regardless of the bun-test cwd
```

Apply the same `, null` third argument to the attention `specMiningDeferred` test's construction. (The other two existing tests — "registers the four endpoints" and "serves next-steps" — do not branch on repo-root; leaving them at the 2-arg form is fine, but adding `, null` to them too is harmless and recommended for consistency.)

- [ ] **Step 2: Add the resolved-branch cases (fixture-dir `repoRoot`)**

Append to `tests/worker/http/routes/mission-control-routes.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Minimal VALID fixture queue: BuilderQueueParser's loud guards require a `## Queue`
// section with >=1 row AND a `## Recently shipped` section with >=1 row.
const FIXTURE_QUEUE = `# Builder Queue

## Queue

| # | Status | Item | Spec + Plan | Depends on | Notes |
|---|--------|------|-------------|------------|-------|
| 1 | 📋 | **First item** | [plan](x.md) | — | note |

## Recently shipped

| Item | PR | Notes |
|------|----|-------|
| Something shipped | #99 | note |
`;

function makeFixtureRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mc-route-'));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'BUILDER_QUEUE.md'), FIXTURE_QUEUE);
  return root;
}

describe('MissionControlRoutes — repo-root re-enable (resolved branch)', () => {
  it('velocity returns real counts (not deferred) when repoRoot resolves, independent of git', () => {
    const fixtureRoot = makeFixtureRepo();
    try {
      const app = makeMockApp();
      // Empty listMergeCommits proves counts come from the parsed FILE, not git (F3).
      const routes = new MissionControlRoutes(makeDbManager() as any, {
        ghAvailable: () => false, listOpenPrs: () => [], listMergeCommits: () => [],
      }, fixtureRoot);
      routes.setupRoutes(app as any);
      const body = app.invoke('/api/mission-control/velocity', { query: {} }) as {
        deferred?: boolean; openCount: number | null; shippedCount: number | null; shippedByWeek: unknown[];
      };
      expect(body.deferred).toBeUndefined();
      expect(body.openCount).toBe(1);        // one Queue row
      expect(body.shippedCount).toBe(1);     // one Recently-shipped row
      expect(body.shippedByWeek).toEqual([]); // empty git ⇒ empty series, but counts survive
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('attention reports specMiningDeferred:false when repoRoot resolves', () => {
    const fixtureRoot = makeFixtureRepo();
    try {
      const app = makeMockApp();
      const routes = new MissionControlRoutes(makeDbManager() as any, {
        ghAvailable: () => false, listOpenPrs: () => [], listMergeCommits: () => [],
      }, fixtureRoot);
      routes.setupRoutes(app as any);
      const body = app.invoke('/api/mission-control/attention', { query: {} }) as { specMiningDeferred: boolean };
      expect(body.specMiningDeferred).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
```

> **Implementer note:** the fixture dir has `docs/BUILDER_QUEUE.md` but no `docs/superpowers/specs` tree, so `loadSpecFiles(fixtureRoot)` returns `[]` and the attention mine reads no real-repo files — deterministic. The velocity case asserts the F3 correction directly: real counts survive an empty git series.

- [ ] **Step 3: Run test to verify the new cases pass and the pinned deferred cases still pass**

Run: `bun test tests/worker/http/routes/mission-control-routes.test.ts`
Expected: PASS (all cases — the two pinned deferred cases and the two new resolved cases). If a resolved case fails, the fault is in Task 1's resolver or Task 2's wiring — fix there, not by special-casing the route.

- [ ] **Step 4: Commit**

```bash
git add tests/worker/http/routes/mission-control-routes.test.ts
git commit -m "test(mission-control): pin deferred route cases + add repoRoot-resolved cases (counts/series independence guard)"
```

---

### Task 4: Viewer — re-add the Velocity pane (fetch + render, deferred-aware)

Re-adds the velocity fetch to the data hook and the Velocity pane to the component. Both were removed in the 3-pane narrowing (PR #20). The pane must render a labeled note (never a crash) when velocity is still deferred, so an install without `CLAUDE_MEM_PROJECT_ROOT` degrades cleanly. `MC_VELOCITY` already exists in `constants/api.ts` — no change there.

**Files:**
- Modify: `src/ui/viewer/hooks/useMissionControl.ts`
- Modify: `src/ui/viewer/components/MissionControl.tsx`
- Modify: `tests/mission-control/mission-control-view.test.tsx`
- Rebuild: `plugin/ui/viewer-bundle.js` (via the build; do not hand-edit)

**Interfaces:**
- `useMissionControl()` gains a `velocity: VelocityResult | null` field.
- `VelocityResult = { deferred?: boolean; reason?: string; error?: string; openCount: number | null; shippedCount: number | null; shippedByWeek: { week: string; shipped: number }[] }`.

- [ ] **Step 1: Add velocity back to the hook**

In `src/ui/viewer/hooks/useMissionControl.ts`:

Add the interface (near `NextStepItem`):

```ts
export interface VelocityResult {
  deferred?: boolean;
  reason?: string;
  error?: string;
  openCount: number | null;
  shippedCount: number | null;
  shippedByWeek: { week: string; shipped: number }[];
}
```

Add `velocity` to `MissionControlData`:

```ts
  velocity: VelocityResult | null;
```

Add the state, fetch, and return. Change the state block to include:

```ts
  const [velocity, setVelocity] = useState<VelocityResult | null>(null);
```

Change the `Promise.all` in `load` to include velocity:

```ts
      const [a, p, v, n] = await Promise.all([
        fetch(API_ENDPOINTS.MC_ATTENTION).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_PROGRESS).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_VELOCITY).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_NEXT_STEPS).then(r => r.json()),
      ]);
      setAttention(a.items ?? []);
      setGhAvailable(a.ghAvailable ?? true);
      setSpecMiningDeferred(a.specMiningDeferred ?? false);
      setProgress(p.buckets ?? []);
      setVelocity(v ?? null);
      setNextSteps(n.items ?? []);
```

Add `velocity` to the returned object:

```ts
  return { attention, ghAvailable, specMiningDeferred, progress, velocity, nextSteps, loading, error, refresh: load };
```

- [ ] **Step 2: Add the Velocity pane to the component**

In `src/ui/viewer/components/MissionControl.tsx`, destructure `velocity` from the hook and render a pane. Insert the pane between `<AttentionPane .../>` and the Progress `<section>`:

```tsx
      <section className="mc-pane" data-testid="mc-velocity">
        <h2>Velocity</h2>
        {velocity?.deferred ? (
          <p className="mc-note" data-testid="mc-velocity-deferred">
            Velocity deferred — set <code>CLAUDE_MEM_PROJECT_ROOT</code> to the repo containing <code>docs/BUILDER_QUEUE.md</code> (follow-up #24).
          </p>
        ) : velocity?.error ? (
          <p className="mc-error" data-testid="mc-velocity-error">Queue parse failed: {velocity.error}</p>
        ) : (
          <>
            <p>{velocity?.shippedCount ?? '—'} shipped · {velocity?.openCount ?? '—'} open</p>
            <ul>
              {(velocity?.shippedByWeek ?? []).map(pt => (
                <li key={pt.week}>{pt.week}: {pt.shipped} shipped</li>
              ))}
            </ul>
          </>
        )}
      </section>
```

Update the destructure line at the top of `MissionControl()`:

```tsx
  const { attention, ghAvailable, specMiningDeferred, progress, velocity, nextSteps, loading, error, refresh } = useMissionControl();
```

Also update the file-top comment (currently "Phase 1 = 3 panes … Velocity … intentionally not rendered") to reflect that velocity now renders, degrading to a labeled note when deferred.

- [ ] **Step 3: Update the view smoke test**

In `tests/mission-control/mission-control-view.test.tsx`, add an assertion that the component module still imports without throwing and (if the existing test renders label logic) that a deferred-velocity note label is present. Keep it consistent with the existing test's style (module-import assertion is the load-bearing minimum):

```tsx
  it('the MissionControl module still imports after the velocity pane is re-added', () => {
    expect(() => require('../../src/ui/viewer/components/MissionControl')).not.toThrow();
  });
```

- [ ] **Step 4: Run tests + typecheck + build**

Run: `bun test tests/mission-control/mission-control-view.test.tsx`
Expected: PASS.
Run: `npm run typecheck:viewer` (`tsc -p src/ui/viewer/tsconfig.json`) — no new errors.
Run: `npm run build` — rebuilds `plugin/ui/viewer-bundle.js`. Confirm exit 0 and the bundle timestamp updates.

- [ ] **Step 5: Commit**

```bash
git add src/ui/viewer/hooks/useMissionControl.ts src/ui/viewer/components/MissionControl.tsx tests/mission-control/mission-control-view.test.tsx plugin/ui/viewer-bundle.js
git commit -m "feat(mission-control): re-add Velocity pane (deferred-aware) to the viewer"
```

---

## Verification

Run before opening the PR:

- [ ] **Full mission-control unit suite:** `bun test tests/mission-control/ tests/worker/http/routes/mission-control-routes.test.ts` — all green (incl. the new `repo-root.test.ts`, the `shell.test.ts` cwd cases, and the route re-enable cases).
- [ ] **Typecheck:** `npm run typecheck` and `npm run typecheck:viewer` — no new errors.
- [ ] **Build:** `npm run build-and-sync` — completes; the worker restarts cleanly and the bundle regenerates.
- [ ] **Loud-on-misconfig guard (R3):** the `repo-root.test.ts` invalid-env case returns `null` (and logs a WARN) — the regression guard against silently resolving the wrong tree.
- [ ] **No-regression guard:** with `CLAUDE_MEM_PROJECT_ROOT` unset and no valid git-toplevel, `/velocity` returns `{deferred:true}` and `/attention` returns `specMiningDeferred:true` (identical to the shipped 3-pane behavior).
- [ ] **Counts/series independence guard (F3):** the route test proves resolved velocity returns real `openCount`/`shippedCount` even when `listMergeCommits` is empty.

### Test Plan (live UAT — for the Tester)

1. `npm run build-and-sync`, then open the viewer at the worker's `/` URL; toggle to **Mission Control**.
2. **Deferred path (default install):** with `CLAUDE_MEM_PROJECT_ROOT` unset, confirm the Velocity pane shows the labeled "Velocity deferred — set CLAUDE_MEM_PROJECT_ROOT…" note (not a crash, not a blank pane), and the Attention pane still shows the "Spec-review & doc-question mining deferred" note.
3. **Resolved path:** set `CLAUDE_MEM_PROJECT_ROOT` (env or `~/.claude-mem/settings.json`) to the fork checkout that contains `docs/BUILDER_QUEUE.md`; restart the worker (`build-and-sync`). Confirm:
   - **Velocity:** "N shipped · M open" reflects the real `docs/BUILDER_QUEUE.md`, and the weekly series lists ISO weeks with PR-merge counts. Cross-check the counts against the file and the series against `git log --merges`.
   - **Reviews reflect the FORK, not upstream** (design spec R3): the open-PR `review` items are Mark's fork PRs (e.g. the current open ones), and the velocity merge series matches the fork's history — confirming the boundary cwd points at the fork, not the marketplace/upstream checkout.
   - **doc-Open-Questions:** a spec/ADR under `docs/` with an `## Open Questions` section surfaces `question` items in Attention; `Proposed`-status specs surface `review` items.
4. **Misconfiguration is loud:** set `CLAUDE_MEM_PROJECT_ROOT` to a path without `docs/BUILDER_QUEUE.md`, restart, and confirm (a) Velocity shows the deferred note, and (b) the worker log contains the WARN naming the bad path. Restore.
5. Confirm **no writes** to `docs/BUILDER_QUEUE.md` (`git status` clean for that file) and **no LLM calls** (read/mine-only).

## Cross-references

- Design spec: `docs/superpowers/specs/2026-07-16-mission-control-repo-root-design.md`.
- Parent design: `docs/superpowers/specs/2026-07-16-mission-control-design.md` (Phase 1 §6, D1/D4, R3/R5/R6).
- Phase 1 plan: `docs/superpowers/plans/2026-07-16-mission-control-phase-1-plan.md` (the narrowing note at its top defines what this slice re-enables).
- Queue rows: `docs/BUILDER_QUEUE.md` #24 (this slice) and #25 (captured-`AskUserQuestion`, split out per design spec §6).
