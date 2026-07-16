# Mission Control — Phase 1b Implementation Plan (repo-root re-enable + UX polish, one pass)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task is TDD: write the failing test, run it red, implement, run it green, commit.

**Goal:** Ship Mission Control Phase 1b as ONE coordinated pass that (a) re-enables the three repo-root-gated sources (velocity, `Proposed`-spec review mining, doc-Open-Questions mining) by implementing `resolveRepoRoot()` and threading the resolved root as the `git`/`gh` boundary cwd, and (b) lands the four polish fixes from the design handoff (attention links, actionable escalations, meaningful progress, and the missing `.mc-*` stylesheet). Both halves edit the same Mission Control code, so they are sequenced **data-layer first, render second** so the panes are rebuilt exactly once.

**Why combined:** #24 (repo-root) and the polish handoff both touch `shell.ts`, `MissionControlRoutes.ts`, `useMissionControl.ts`, and `MissionControl.tsx`. Building them separately would rebuild the same panes twice and thread the same `repoRoot`/boundary-cwd through the route twice. The repo-root work is also a **prerequisite** for one polish item: the `repoWebBase`/`defaultBranch` the attention links need is resolved via the same git/gh boundary, which only points at the correct (fork) repo once the boundary cwd is threaded (Task 2). So repo-root lands first, polish rides on top.

**Tech Stack:** TypeScript, `bun:sqlite`, Express 5 (`BaseRouteHandler`), `Bun.spawnSync` for `gh`/`git`, React 19 viewer (esbuild bundle via `npm run build`), `bun test` with `:memory:` / tmpdir fixtures. Viewer styles live in `src/ui/viewer-template.html` (a single `<style>` block of design tokens).

---

## Corrections to the inputs (verified against the current tree)

Every claim in the #24 spec/plan and the polish handoff was re-checked against source. The inputs are largely accurate; the following need correcting, and this plan builds to the corrected version:

| # | Input claim | Correction (verified) |
|---|---|---|
| K1 | Handoff §2: question rows deep-link with `#L<n>` — "`question:<path>#<n>` → append `#L<n>` best-effort". | **Wrong — that `#<n>` is a bullet ordinal, not a file line number.** `extractOpenQuestions` (`AttentionMiner.ts:62`) emits `ref: \`question:${path}#${index}\`` where `index` counts bullets **within** the Open Questions section (0,1,2…). Appending `#L<index>` would deep-link to the wrong file line. **Fix:** link the file (`blob/<branch>/<path>`) with **no** line fragment. Capturing the true line is out of scope for this pass. |
| K2 | Handoff §3/§6: surface escalation WHERE/WHEN by threading `agent_type`/`agent_id`/`memory_session_id` through `UpsertInput` into the (per-class, deduped) `attention_items` row, plus new `last_seen_epoch`/`occurrence_count` columns. | **A single per-class deduped row cannot honestly express "+N others", occurrence count, or "latest" — it only holds the last upsert's identity.** This plan computes WHERE/WHEN/error-line at **read time** via `buildEscalationContext()` over the recent observations window. Result: **no migration** (`last_seen_epoch`/`occurrence_count` confirmed absent everywhere — not needed), **zero change** to the shipped `upsertMinedItem`/INSERT/`RawRow`/`toItem` surface, and the aggregates are always fresh and actually computable. Strict simplification + correctness win. (The `attention_items.agent_type/agent_id/memory_session_id` columns **do** exist — `SessionStore.ts:534-536` — they're just not needed under the read-time approach.) |
| K3 | Handoff §2/§6: put the remediation **catalog** (WHAT title + FIX text/command/doc) in the render layer as client content. | The viewer bundle **does not currently import from `src/services/**`** (verified: no such import exists). Adding one risks pulling server-only deps into the browser bundle. **Fix:** keep the catalog server-side in a **zero-dependency** module `escalation-catalog.ts`; the `/attention` route joins catalog + read-time context and ships the resolved remediation fields on `escalationContext`. The client renders with **no** server import. Fail-closed is enforced at the route (only catalog keys that actually occurred are emitted) — strictly safer than a client-side filter. |
| K4 | #24 plan Task 4 Step 3: "add an assertion that the module imports" for the velocity view test. | **Insufficient — the existing `mission-control-view.test.tsx` actively asserts the velocity pane is ABSENT** (`expect(src).not.toContain('data-testid="mc-velocity"')`, lines 36-46). That test **fails** the moment the pane is added. **Fix:** flip it to assert presence + deferred-note behavior (Task 12). |
| K5 | Handoff §2/§6: `/attention` returns `repoWebBase`+`defaultBranch` "via the same boundary that already talks to git/gh". | The `GitGhBoundary` interface has only `ghAvailable`/`listOpenPrs`/`listMergeCommits` — there is **no** method for repo web info. This plan **adds** `repoWebInfo()` to the boundary (Task 2), optional on the interface so existing test stubs still typecheck. It runs with the threaded cwd, so it resolves the **fork**, not the marketplace/upstream checkout. |
| K6 | Handoff §4 default range: 7 days; Open Questions Q2/Q3/Q5 left defaults (7d, uniform `open ↗`, ambiguous `#N`). | **Superseded by Mark's locked decisions** (build to these, not the handoff copy): per-class escalations with "+N others" ✓ (matches handoff default); **since-last-opened** default range (client-stored timestamp; selector still offers Today/7d/All); **type-specific** link affordance (`github ↗` for PRs, `view ↗` for files/specs); **defer** files-touched; PRs-touched parser matches **`PR #N` + gh-resolved refs only** — never bare `#N` (collides with roadmap row numbers). |

Minor confirmations (input was right): the escalation miner **does** capture `project` (`AttentionMiner.ts:143`); `pr.url` **is** fetched then discarded (`shell.ts:54` fetches `url`; `AttentionMiner.ts:88` drops it); `byType` **is** computed and discarded (`ProgressQuery.ts:70` vs `MissionControl.tsx:63`); the panes have **zero** CSS (0 `.mc-*`/`mission-control`/`view-toggle` rules in `viewer-template.html`); every referenced design token exists (light+dark+system triplets). Note: `--radius-md` does **not** exist — use literal px for border-radius.

---

## Sequencing (repo-root vs polish) & the render-only / data-layer split

The handoff asked to keep the **render-only vs data-layer** split as the task structure. This plan does exactly that, and orders the two groups so the panes rebuild once:

**Group A — data-layer / foundation (Tasks 1–8), built first so the client has final payloads:**
- **Repo-root (#24):** T1 `resolveRepoRoot()`, T2 boundary cwd (+`repoWebInfo`), T7 route injectable `repoRoot` + threaded cwd.
- **Polish data-layer:** T3 progress `project` grouping + `queryTeamSessions`, T5 `parsePrRefs` + `queryTeamPrs`, T6 escalation catalog + `buildEscalationContext`, T7 route payload additions (`repoWebBase`/`defaultBranch`/`escalationContext`, `/progress` `since`+`sessions`+`prs`), T8 route tests.

**Group B — render-only (Tasks 9–13), built once against the final payloads:**
- T9 the `.mc-*`/`.mission-control`/`.view-toggle` stylesheet (the single biggest lever). T10 the data hook (velocity fetch + all new fields + since-last-opened). T11 the component rebuild (all four panes once) + `App.tsx` toggle a11y. T12 view tests. T13 build + verify.

**repo-root lands before polish within each group** because polish's attention links (`repoWebBase`) depend on the boundary cwd being threaded to the fork (T2/T7). Everything else is independent and ordered only for a clean single rebuild.

---

## Context: what already exists (do NOT rebuild)

- `VelocityQuery.ts`, `BuilderQueueParser.ts`, `NextStepsFeed.ts` — intact; unchanged.
- `AttentionMiner.ts` — `extractProposedSpec`/`extractOpenQuestions`, the `specMiningEnabled` guard, and the escalation scan all ship and are unit-tested. Only the escalation pattern **source** moves to the catalog (T6, structural fail-closed) — behavior for the current four keys is identical.
- `MissionControlRoutes` — already branches on `resolveRepoRoot()` in three places (`:62` `specMiningEnabled`, `:86` `specMiningDeferred`, `:104` velocity). We make `repoRoot` injectable + captured once, thread it as boundary cwd, and add payload fields. The velocity resolved/deferred branch bodies are unchanged.
- `constants/api.ts` — `MC_VELOCITY` already declared (`src/ui/viewer/constants/api.ts:9`).
- `attention_items` schema (version 41) already has `agent_type`/`agent_id`/`memory_session_id` columns — **not used** by this plan (see K2), but confirmed present.

## Global constraints

- **Phase 1 no-LLM, read/mine-only boundary.** No `attention_raise`, no synthesis, no roadmap-row linkage, no write of any kind toward `docs/BUILDER_QUEUE.md`. Every data-layer item here is a read/aggregate.
- **No regression to the shipped 3 panes.** When `resolveRepoRoot()` returns `null`: velocity `{deferred:true}`, `specMiningDeferred:true`, boundary runs in worker cwd, `repoWebBase`/`defaultBranch` null (links fall back to plain text). `cwd`/`repoWebInfo` additions are additive — `cwd` undefined ⇒ current behavior.
- **Loud, never silent (R3).** A set-but-invalid `CLAUDE_MEM_PROJECT_ROOT` → one `logger.warn` + `null`, not a silent wrong tree.
- **`logger.warn(component, message, context?)`** — `component` must be in the `Component` union (`src/utils/logger.ts`). There is **no** `MISSION_CONTROL` member — use `'WORKER'` (as `MissionControlRoutes.ts:67` already does).
- **Do not add `CLAUDE_MEM_PROJECT_ROOT` to typed `SettingsDefaults`.** Read it inline, mirroring `resolveDataDir` (`paths.ts:17-37`).
- **`escalation-catalog.ts` must import nothing** (zero deps) so it is safe for both the server and — if ever needed — the viewer bundle. This plan keeps it server-only.
- **PRs-touched parser: `PR #N` + gh-resolved URLs only.** Never bare `#N`. This is load-bearing (roadmap row `#N` collision) — test it hard.
- **Test runner is `bun test`** (`import { describe, it, expect } from 'bun:test'`).
- **The viewer bundle is a built artifact** — edit `src/ui/viewer/**` + `src/ui/viewer-template.html`, then `npm run build`; never hand-edit `plugin/ui/viewer-bundle.js`.
- **Branch policy (CLAUDE.md):** this plan's implementation PR targets `fork/main`; never push to `origin` (guard `DISABLED_UPSTREAM_DO_NOT_PUSH`).
- **Queue:** the coordinator files the `docs/BUILDER_QUEUE.md` row for this item. **Do not edit `docs/BUILDER_QUEUE.md` in this work.**

---

# GROUP A — data-layer / foundation

### Task 1: Implement `resolveRepoRoot()` (env → settings → git-toplevel → null; validated, memoized, loud)

Replace the Phase-1 stub (`repo-root.ts:22-23` `return null`) with the real resolver, mirroring `resolveDataDir` (`paths.ts:17-37`). Validate each candidate on `docs/BUILDER_QUEUE.md`. Memoize (step 3 spawns `git`; this runs on the Attention hot path). Add `resetRepoRootCache()` for tests. Keep `REPO_ROOT_DEFERRED_REASON` (imported by the route).

**Files:** Modify `src/services/mission-control/repo-root.ts`; Test `tests/mission-control/repo-root.test.ts`.

**Interfaces:** consumes `process.env.CLAUDE_MEM_PROJECT_ROOT`, `USER_SETTINGS_PATH`+`parseJsonWithBom`, `runCommand`, `logger`. Produces (unchanged signatures) `resolveRepoRoot(): string | null`, `REPO_ROOT_DEFERRED_REASON: string`; adds `resetRepoRootCache(): void`.

- [ ] **Step 1: Write the failing test** — `tests/mission-control/repo-root.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { resolveRepoRoot, resetRepoRootCache } from '../../src/services/mission-control/repo-root.js';
import { logger } from '../../src/utils/logger.js';

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
    process.env[ENV_KEY] = root; resetRepoRootCache();
    expect(resolveRepoRoot()).toBe(root);
  });

  it('returns null (deferred) — not the wrong tree — when the env var is set but invalid', () => {
    const root = makeRepo(false); cleanup.push(root); // no docs/BUILDER_QUEUE.md
    process.env[ENV_KEY] = root; resetRepoRootCache();
    expect(resolveRepoRoot()).toBeNull();
  });

  it('logs exactly one WARN when the env var is set but invalid (loud, not silent)', () => {
    const root = makeRepo(false); cleanup.push(root);
    process.env[ENV_KEY] = root; resetRepoRootCache();
    const warn = spyOn(logger, 'warn');
    try {
      expect(resolveRepoRoot()).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const [, message] = warn.mock.calls[0];
      expect(String(message)).toContain('CLAUDE_MEM_PROJECT_ROOT');
    } finally { warn.mockRestore(); }
  });

  it('memoizes: a second call does not re-resolve', () => {
    const root = makeRepo(true); cleanup.push(root);
    process.env[ENV_KEY] = root; resetRepoRootCache();
    expect(resolveRepoRoot()).toBe(root);
    process.env[ENV_KEY] = '/nonexistent/other'; // no reset ⇒ memo must persist
    expect(resolveRepoRoot()).toBe(root);
  });

  it('returns a string-or-null terminal state when nothing is explicitly set', () => {
    resetRepoRootCache();
    const result = resolveRepoRoot();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});
```

> If `spyOn`/`mock` ergonomics differ on the installed `bun`, keep the null assertion (the load-bearing safety property) and drop the call-count check.

- [ ] **Step 2: Run red** — `bun test tests/mission-control/repo-root.test.ts` → FAIL (`resetRepoRootCache` not exported; stub returns `null` for the valid-env case).

- [ ] **Step 3: Implement** — replace the body of `src/services/mission-control/repo-root.ts`:

```ts
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { runCommand } from './shell.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { parseJsonWithBom } from '../../shared/atomic-json.js';
import { logger } from '../../utils/logger.js';

/**
 * Resolve the Mission Control repository root for the filesystem- and git-backed
 * sources (velocity → docs/BUILDER_QUEUE.md + git merge series; reviews →
 * docs/superpowers/specs/** + gh pr list; questions → docs/** Open-Questions).
 *
 * Strategy (#24): env CLAUDE_MEM_PROJECT_ROOT → settings.json key →
 * `git rev-parse --show-toplevel` → null. A candidate validates iff it contains
 * docs/BUILDER_QUEUE.md (the canonical roadmap file) so a deployed worker whose
 * cwd is an upstream checkout does NOT false-resolve. A set-but-invalid
 * env/settings value logs one loud WARN and falls through to null. Memoized.
 */
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
    return null;
  }
}

function gitToplevel(): string | null {
  const result = runCommand(['git', 'rev-parse', '--show-toplevel']);
  if (result.exitCode !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

function resolve(): string | null {
  const envRoot = process.env.CLAUDE_MEM_PROJECT_ROOT?.trim();
  if (envRoot) {
    if (isMissionControlRepo(envRoot)) return envRoot;
    logger.warn('WORKER',
      'CLAUDE_MEM_PROJECT_ROOT is set but does not contain docs/BUILDER_QUEUE.md — Mission Control velocity + spec/doc mining stay deferred',
      { path: envRoot });
    return null;
  }
  const settingsRoot = readSettingsProjectRoot();
  if (settingsRoot) {
    if (isMissionControlRepo(settingsRoot)) return settingsRoot;
    logger.warn('WORKER',
      'settings.json CLAUDE_MEM_PROJECT_ROOT does not contain docs/BUILDER_QUEUE.md — Mission Control velocity + spec/doc mining stay deferred',
      { path: settingsRoot });
    return null;
  }
  const top = gitToplevel();
  if (top && isMissionControlRepo(top)) return top;
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

- [ ] **Step 4: Run green** — `bun test tests/mission-control/repo-root.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/mission-control/repo-root.ts tests/mission-control/repo-root.test.ts
git commit -m "feat(mission-control): resolve repo root via CLAUDE_MEM_PROJECT_ROOT env/settings/git (validated, memoized, loud)"
```

---

### Task 2: `shell.ts` — thread a `cwd` through the boundary + add `repoWebInfo()`

Two additive changes to the git/gh seam: (1) an optional `cwd` on `runCommand` + `createGitGhBoundary(cwd?)` (so velocity's `git log` series and `gh pr list` run against the correct repo — #24 F3/F4); (2) a new `repoWebInfo()` method returning `{ repoWebBase, defaultBranch }` for the attention links (polish §2, K5). Both are additive: `cwd` undefined ⇒ today's behavior; `repoWebInfo` is optional on the interface so existing stubs still typecheck.

**Files:** Modify `src/services/mission-control/shell.ts`; Test `tests/mission-control/shell.test.ts`.

**Interfaces:**
- `runCommand(cmd: string[], cwd?: string): ShellResult`
- `createGitGhBoundary(cwd?: string): GitGhBoundary` (closes over `cwd`)
- `GitGhBoundary.repoWebInfo?(): RepoWebInfo | null` where `RepoWebInfo = { repoWebBase: string; defaultBranch: string }`

- [ ] **Step 1: Write the failing test** — append to `tests/mission-control/shell.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

describe('runCommand cwd', () => {
  it('runs the command in the provided working directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mc-cwd-'));
    try {
      // Portable cwd probe (no git init needed): node prints process.cwd().
      const result = runCommand(['node', '-e', 'process.stdout.write(process.cwd())'], dir);
      expect(result.exitCode).toBe(0);
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

- [ ] **Step 2: Run red** — `bun test tests/mission-control/shell.test.ts` → FAIL (`cwd` ignored; probe returns the runner's dir).

- [ ] **Step 3: Implement** — in `src/services/mission-control/shell.ts`:

Change `runCommand` to accept `cwd` and pass it to `Bun.spawnSync`:

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
    return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 127 };
  }
}
```

Add the `RepoWebInfo` type and widen the interface (keep the existing `OpenPr`/`MergeCommit`/`FIELD_SEP` declarations — do not redeclare):

```ts
export interface RepoWebInfo {
  repoWebBase: string;   // e.g. https://github.com/mmackelprang/claude-mem
  defaultBranch: string; // e.g. main
}

export interface GitGhBoundary {
  ghAvailable(): boolean;
  listOpenPrs(): OpenPr[];
  listMergeCommits(sinceIso?: string): MergeCommit[];
  // Optional so existing test stubs (which omit it) still satisfy the type.
  // Resolves the fork when the boundary was created with the repo-root cwd.
  repoWebInfo?(): RepoWebInfo | null;
}
```

Replace `createGitGhBoundary` to take + thread `cwd`, and add `repoWebInfo`:

```ts
export function createGitGhBoundary(cwd?: string): GitGhBoundary {
  return {
    ghAvailable(): boolean {
      return runCommand(['gh', '--version'], cwd).exitCode === 0
        && runCommand(['gh', 'auth', 'status'], cwd).exitCode === 0;
    },

    listOpenPrs(): OpenPr[] {
      const result = runCommand(['gh', 'pr', 'list', '--state', 'open', '--json', 'number,title,url'], cwd);
      if (result.exitCode !== 0) return [];
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

    repoWebInfo(): RepoWebInfo | null {
      const result = runCommand(['gh', 'repo', 'view', '--json', 'url,defaultBranchRef'], cwd);
      if (result.exitCode !== 0) return null;
      try {
        const parsed = JSON.parse(result.stdout) as { url?: string; defaultBranchRef?: { name?: string } };
        if (!parsed.url) return null;
        return { repoWebBase: parsed.url, defaultBranch: parsed.defaultBranchRef?.name ?? 'main' };
      } catch {
        return null;
      }
    },
  };
}
```

- [ ] **Step 4: Run green + typecheck** — `bun test tests/mission-control/shell.test.ts` → PASS (incl. the two new cwd cases + the pre-existing degradation cases). `npm run typecheck` → no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/mission-control/shell.ts tests/mission-control/shell.test.ts
git commit -m "feat(mission-control): thread cwd through git/gh boundary + add repoWebInfo() (fork-correct velocity, reviews, links)"
```

---

### Task 3: `ProgressQuery.ts` — group by `project`, keep `byType`, add distinct-session counts

Two changes (polish §4 data-layer): add `project` to the `SELECT`/`GROUP BY` and the returned `ProgressBucket` (so the client builds the Project→Agent tree from one query), and add a sibling `queryTeamSessions()` that returns **distinct** `memory_session_id` counts at the **(project, agentType)** display grain (the correct grain — a `COUNT(DISTINCT …)` inside the existing per-`type` GROUP BY would double-count sessions that touch multiple types). `byType` is already returned; leave it (the client renders it as the outcome line).

**Files:** Modify `src/services/mission-control/ProgressQuery.ts`; Test `tests/mission-control/progress-query.test.ts`.

**Interfaces:**
- `ProgressBucket` gains `project: string | null`.
- New `queryTeamSessions(db, options: { project?: string; sinceEpoch?: number }): TeamSessions[]` where `TeamSessions = { project: string | null; agentType: string | null; sessions: number }`.

- [ ] **Step 1: Write the failing test** — append to `tests/mission-control/progress-query.test.ts`:

```ts
import { queryProgress, queryTeamSessions } from '../../src/services/mission-control/ProgressQuery.js';
// (Reuse the file's existing Database/SessionStore fixture helpers. If none, mirror
//  the mission-control-routes.test.ts makeDbManager() pattern: new SessionStore(db),
//  PRAGMA foreign_keys = OFF, then INSERT observations rows directly.)

function seedObs(db: any, rows: Array<{ session: string; project: string; agentType: string; type: string; epoch: number }>) {
  const stmt = db.prepare(
    `INSERT INTO observations
       (memory_session_id, project, text, type, agent_type, created_at, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    stmt.run(r.session, r.project, `obs ${r.type}`, r.type, r.agentType, new Date(r.epoch).toISOString(), r.epoch);
  }
}

describe('ProgressQuery — project grouping + sessions', () => {
  it('carries project on each bucket and preserves byType', () => {
    const db = /* fresh :memory: SessionStore().db */ makeProgressDb();
    seedObs(db, [
      { session: 's1', project: 'claude-mem', agentType: 'builder', type: 'feature', epoch: 2000 },
      { session: 's1', project: 'claude-mem', agentType: 'builder', type: 'bugfix', epoch: 2001 },
      { session: 's2', project: 'other', agentType: 'planner', type: 'decision', epoch: 2002 },
    ]);
    const buckets = queryProgress(db, {});
    expect(buckets.every(b => 'project' in b)).toBe(true);
    const cm = buckets.filter(b => b.project === 'claude-mem');
    expect(cm.length).toBeGreaterThan(0);
    const merged = cm.reduce((acc, b) => { for (const [k, v] of Object.entries(b.byType)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {} as Record<string, number>);
    expect(merged.feature).toBe(1);
    expect(merged.bugfix).toBe(1);
  });

  it('counts DISTINCT sessions per (project, agentType), not per type', () => {
    const db = makeProgressDb();
    seedObs(db, [
      { session: 's1', project: 'claude-mem', agentType: 'builder', type: 'feature', epoch: 3000 },
      { session: 's1', project: 'claude-mem', agentType: 'builder', type: 'bugfix', epoch: 3001 }, // same session, 2nd type
      { session: 's2', project: 'claude-mem', agentType: 'builder', type: 'feature', epoch: 3002 },
    ]);
    const teams = queryTeamSessions(db, {});
    const builder = teams.find(t => t.project === 'claude-mem' && t.agentType === 'builder')!;
    expect(builder.sessions).toBe(2); // s1, s2 — NOT 3 (the two types of s1 collapse)
  });

  it('honors sinceEpoch on both queries', () => {
    const db = makeProgressDb();
    seedObs(db, [
      { session: 'old', project: 'p', agentType: 'builder', type: 'feature', epoch: 1000 },
      { session: 'new', project: 'p', agentType: 'builder', type: 'feature', epoch: 5000 },
    ]);
    expect(queryTeamSessions(db, { sinceEpoch: 4000 })[0].sessions).toBe(1);
    expect(queryProgress(db, { sinceEpoch: 4000 }).length).toBe(1);
  });
});
```

> `makeProgressDb()` = a fresh `new SessionStore(new Database(':memory:')).db` with `PRAGMA foreign_keys = OFF`. If the existing test already has such a helper, reuse it; otherwise add this local one.

- [ ] **Step 2: Run red** — `bun test tests/mission-control/progress-query.test.ts` → FAIL (`queryTeamSessions` missing; `project` not on buckets).

- [ ] **Step 3: Implement** — in `src/services/mission-control/ProgressQuery.ts`:

Add `project` to `ProgressBucket` and `RawRow`:

```ts
export interface ProgressBucket {
  project: string | null;
  agentType: string | null;
  agentId: string | null;
  bucket: string;
  total: number;
  byType: Record<string, number>;
}

interface RawRow {
  project: string | null;
  agent_type: string | null;
  agent_id: string | null;
  bucket: string;
  type: string;
  n: number;
}
```

Update the SQL + map in `queryProgress` (keep the `by === 'human'` short-circuit, the `bucketExpr`, and the `where`/`params` builder unchanged):

```ts
  const sql = `
    SELECT project, agent_type, agent_id, ${bucketExpr} AS bucket, type, COUNT(*) AS n
    FROM observations
    ${whereSql}
    GROUP BY project, agent_type, agent_id, bucket, type
    ORDER BY bucket DESC
  `;
  const rows = db.prepare(sql).all(...params) as RawRow[];

  const map = new Map<string, ProgressBucket>();
  for (const r of rows) {
    const key = `${r.project ?? ''} ${r.agent_type ?? ''} ${r.agent_id ?? ''} ${r.bucket}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { project: r.project, agentType: r.agent_type, agentId: r.agent_id, bucket: r.bucket, total: 0, byType: {} };
      map.set(key, bucket);
    }
    bucket.total += r.n;
    bucket.byType[r.type] = (bucket.byType[r.type] ?? 0) + r.n;
  }
  return [...map.values()];
```

Append the sessions query (same WHERE-builder shape, project+sinceEpoch only):

```ts
export interface TeamSessions {
  project: string | null;
  agentType: string | null;
  sessions: number;
}

export function queryTeamSessions(db: Database, options: { project?: string; sinceEpoch?: number } = {}): TeamSessions[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.project) { where.push('project = ?'); params.push(options.project); }
  if (typeof options.sinceEpoch === 'number') { where.push('created_at_epoch >= ?'); params.push(options.sinceEpoch); }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT project, agent_type, COUNT(DISTINCT memory_session_id) AS sessions
    FROM observations
    ${whereSql}
    GROUP BY project, agent_type
  `;
  return (db.prepare(sql).all(...params) as Array<{ project: string | null; agent_type: string | null; sessions: number }>)
    .map(r => ({ project: r.project, agentType: r.agent_type, sessions: r.sessions }));
}
```

- [ ] **Step 4: Run green + typecheck** — `bun test tests/mission-control/progress-query.test.ts` → PASS. `npm run typecheck` → no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/mission-control/ProgressQuery.ts tests/mission-control/progress-query.test.ts
git commit -m "feat(mission-control): progress groups by project + distinct-session counts (byType preserved)"
```

---

### Task 4: `useMissionControl` interface prep — (folded into Task 10)

*No standalone work.* The hook changes ride with the render rebuild (Task 10) so the viewer is edited once. This placeholder keeps the data-layer/render split explicit: all `src/ui/**` edits happen in Group B.

---

### Task 5: PRs-touched parser (`parsePrRefs`) + `queryTeamPrs`

A shared, hard-tested unit that extracts PR numbers from observation text, matching **`PR #N`** and **gh-resolved GitHub URLs only** — never bare `#N` (Mark's locked decision; bare `#N` collides with roadmap row numbers). Plus a query that aggregates distinct PRs per (project, agentType) in range (polish §4; the D4 parser the parent spec earmarked to "factor once, test hard").

**Files:** New `src/services/mission-control/parsePrRefs.ts`; Modify `src/services/mission-control/ProgressQuery.ts` (add `queryTeamPrs`); Test `tests/mission-control/parse-pr-refs.test.ts`.

**Interfaces:**
- `parsePrRefs(text: string): number[]` (distinct, ascending).
- `queryTeamPrs(db, options: { project?: string; sinceEpoch?: number }): TeamPrs[]` where `TeamPrs = { project: string | null; agentType: string | null; prNumbers: number[] }`.

- [ ] **Step 1: Write the failing test** — `tests/mission-control/parse-pr-refs.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { parsePrRefs } from '../../src/services/mission-control/parsePrRefs.js';

describe('parsePrRefs', () => {
  it('matches "PR #N" (case/space tolerant)', () => {
    expect(parsePrRefs('opened PR #22 and pr#17 and PR  #14')).toEqual([14, 17, 22]);
  });
  it('matches gh-resolved GitHub pull URLs', () => {
    expect(parsePrRefs('see https://github.com/mmackelprang/claude-mem/pull/24 for details')).toEqual([24]);
  });
  it('does NOT match bare #N (roadmap-row collision guard)', () => {
    expect(parsePrRefs('roadmap row #22 and issue #5')).toEqual([]);
  });
  it('dedupes across forms and sorts ascending', () => {
    expect(parsePrRefs('PR #24 then https://github.com/x/y/pull/24 then PR #9')).toEqual([9, 24]);
  });
  it('returns [] for empty/undefined', () => {
    expect(parsePrRefs('')).toEqual([]);
    // @ts-expect-error runtime guard
    expect(parsePrRefs(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run red** — `bun test tests/mission-control/parse-pr-refs.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `src/services/mission-control/parsePrRefs.ts` (zero imports):

```ts
/**
 * Extract PR numbers from free text. Matches ONLY "PR #N" and gh-resolved
 * GitHub pull URLs — never a bare "#N", which collides with roadmap row
 * numbers (Mission Control locked decision). Distinct, ascending.
 */
export function parsePrRefs(text: string): number[] {
  if (!text || typeof text !== 'string') return [];
  const nums = new Set<number>();
  // "PR #123" — tolerant of spacing: "PR#123", "pr #123", "PR   #123".
  for (const m of text.matchAll(/\bPR\s*#(\d+)\b/gi)) nums.add(Number(m[1]));
  // gh-resolved URL: github.com/<owner>/<repo>/pull/<n>
  for (const m of text.matchAll(/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/gi)) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}
```

Add `queryTeamPrs` to `ProgressQuery.ts` (imports `parsePrRefs`):

```ts
import { parsePrRefs } from './parsePrRefs.js';

export interface TeamPrs {
  project: string | null;
  agentType: string | null;
  prNumbers: number[];
}

export function queryTeamPrs(db: Database, options: { project?: string; sinceEpoch?: number } = {}): TeamPrs[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.project) { where.push('project = ?'); params.push(options.project); }
  if (typeof options.sinceEpoch === 'number') { where.push('created_at_epoch >= ?'); params.push(options.sinceEpoch); }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT project, agent_type, text, title, narrative
    FROM observations
    ${whereSql}
  `).all(...params) as Array<{ project: string | null; agent_type: string | null; text: string | null; title: string | null; narrative: string | null }>;

  const groups = new Map<string, { project: string | null; agentType: string | null; prs: Set<number> }>();
  for (const r of rows) {
    const key = `${r.project ?? ''} ${r.agent_type ?? ''}`;
    let g = groups.get(key);
    if (!g) { g = { project: r.project, agentType: r.agent_type, prs: new Set() }; groups.set(key, g); }
    for (const n of parsePrRefs(`${r.text ?? ''}\n${r.title ?? ''}\n${r.narrative ?? ''}`)) g.prs.add(n);
  }
  return [...groups.values()].map(g => ({ project: g.project, agentType: g.agentType, prNumbers: [...g.prs].sort((a, b) => a - b) }));
}
```

- [ ] **Step 4: Run green + typecheck** — `bun test tests/mission-control/parse-pr-refs.test.ts` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/mission-control/parsePrRefs.ts src/services/mission-control/ProgressQuery.ts tests/mission-control/parse-pr-refs.test.ts
git commit -m "feat(mission-control): PRs-touched parser (PR #N + gh URLs only, never bare #N) + queryTeamPrs"
```

---

### Task 6: Escalation remediation catalog + read-time `buildEscalationContext`

Make escalations actionable (polish §3). The catalog pairs each error class with a human title + remediation (FIX) — it is the **fail-closed allowlist** (a class with no catalog entry is never surfaced). The miner sources its patterns from the catalog (structural fail-closed; behavior identical for the current 4 keys). `buildEscalationContext()` scans the recent observations window and returns, per catalog key that actually occurred, the four-field render data (WHAT line, WHERE team + "+N others", WHEN latest + count) joined with the catalog's WHAT/FIX. See K2 (read-time, no migration) and K3 (server-side catalog, no client import).

**Files:** New `src/services/mission-control/escalation-catalog.ts`; New `src/services/mission-control/escalationContext.ts`; Modify `src/services/mission-control/AttentionMiner.ts` (source patterns from the catalog); Test `tests/mission-control/escalation-context.test.ts`.

**Interfaces:**
- `ESCALATION_CATALOG: EscalationCatalogEntry[]` and `catalogByKey(): Record<string, EscalationCatalogEntry>`.
- `buildEscalationContext(db, now: number): Record<string, EscalationContext>` (keyed by error key, i.e. the ref without the `error:` prefix).

- [ ] **Step 1: Write the failing test** — `tests/mission-control/escalation-context.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { buildEscalationContext } from '../../src/services/mission-control/escalationContext.js';
import { ESCALATION_CATALOG } from '../../src/services/mission-control/escalation-catalog.js';

function makeDb(): Database {
  const db = new Database(':memory:');
  new SessionStore(db);
  db.run('PRAGMA foreign_keys = OFF');
  return db;
}
function seed(db: Database, rows: Array<{ project: string; agentType: string; session: string; title: string; epoch: number }>) {
  const stmt = db.prepare(
    `INSERT INTO observations
       (memory_session_id, project, text, type, title, agent_type, created_at, created_at_epoch)
     VALUES (?, ?, ?, 'discovery', ?, ?, ?, ?)`
  );
  for (const r of rows) stmt.run(r.session, r.project, r.title, r.title, r.agentType, new Date(r.epoch).toISOString(), r.epoch);
}

const NOW = 10_000_000;

describe('buildEscalationContext', () => {
  it('aggregates count, latest, and "+N others" per catalog error class', () => {
    const db = makeDb();
    seed(db, [
      { project: 'claude-mem', agentType: 'builder', session: 'a', title: 'Error: listen EADDRINUSE :::37777', epoch: NOW - 3000 },
      { project: 'claude-mem', agentType: 'tester',  session: 'b', title: 'EADDRINUSE again',                 epoch: NOW - 2000 },
      { project: 'claude-mem', agentType: 'planner', session: 'c', title: 'EADDRINUSE latest',               epoch: NOW - 1000 },
    ]);
    const ctx = buildEscalationContext(db, NOW);
    expect(ctx.eaddrinuse).toBeDefined();
    expect(ctx.eaddrinuse.count).toBe(3);
    expect(ctx.eaddrinuse.latestAgentType).toBe('planner');       // most recent
    expect(ctx.eaddrinuse.otherTeamsCount).toBe(2);               // builder + tester
    expect(ctx.eaddrinuse.errorLine).toContain('EADDRINUSE');
    expect(ctx.eaddrinuse.whatTitle).toBe('Port already in use'); // joined from catalog
    expect(typeof ctx.eaddrinuse.fixText).toBe('string');
  });

  it('fail-closed: an error with no catalog entry is never surfaced', () => {
    const db = makeDb();
    seed(db, [{ project: 'p', agentType: 'builder', session: 'a', title: 'ECONNREFUSED nope', epoch: NOW - 1000 }]);
    const ctx = buildEscalationContext(db, NOW);
    expect(Object.keys(ctx)).toHaveLength(0);
  });

  it('ignores occurrences outside the recent window', () => {
    const db = makeDb();
    seed(db, [{ project: 'p', agentType: 'builder', session: 'a', title: 'EADDRINUSE old', epoch: NOW - 30 * 24 * 60 * 60 * 1000 }]);
    expect(Object.keys(buildEscalationContext(db, NOW))).toHaveLength(0);
  });

  it('every catalog entry has the four render fields', () => {
    for (const e of ESCALATION_CATALOG) {
      expect(e.key).toBeTruthy();
      expect(e.re instanceof RegExp).toBe(true);
      expect(e.whatTitle).toBeTruthy();
      expect(e.fixText).toBeTruthy();
      expect(e.docHref).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run red** — `bun test tests/mission-control/escalation-context.test.ts` → FAIL (modules missing).

- [ ] **Step 3a: Implement the catalog** — `src/services/mission-control/escalation-catalog.ts` (zero imports):

```ts
/**
 * Remediation catalog = the fail-closed allowlist for escalations. An error
 * class is surfaced ONLY if it has an entry here; a pattern without a
 * remediation cannot exist (the miner iterates this list). Content lives
 * server-side and ships resolved on the /attention payload — the viewer needs
 * no import from src/services (keeps server-only deps out of the browser bundle).
 */
export interface EscalationCatalogEntry {
  key: string;          // matches the `error:<key>` ref
  re: RegExp;           // qualifies an observation as this class
  whatTitle: string;    // WHAT — human error name
  fixText: string;      // FIX — one-line action
  fixCommand?: string;  // FIX — copyable command
  docHref: string;      // FIX — doc link
}

const DOCS = 'https://docs.claude-mem.ai/troubleshooting';

export const ESCALATION_CATALOG: EscalationCatalogEntry[] = [
  {
    key: 'worker-unreachable',
    re: /worker (is )?unreachable/i,
    whatTitle: 'Worker unreachable',
    fixText: 'The worker process is down. Restart it, then check the doctor.',
    fixCommand: 'claude-mem restart',
    docHref: `${DOCS}#worker`,
  },
  {
    key: 'eaddrinuse',
    re: /EADDRINUSE/i,
    whatTitle: 'Port already in use',
    fixText: 'A stale worker holds the port. Restart, or kill the PID on :37777.',
    fixCommand: 'claude-mem restart',
    docHref: `${DOCS}#port`,
  },
  {
    key: 'module-not-found',
    re: /MODULE_NOT_FOUND/i,
    whatTitle: 'Module not found',
    fixText: "A build didn't reach the running plugin. Rebuild and sync.",
    fixCommand: 'npm run build-and-sync',
    docHref: `${DOCS}#build`,
  },
  {
    key: 'swallowed-startup',
    re: /failed to start worker/i,
    whatTitle: 'Worker failed to start',
    fixText: 'A startup error was swallowed. Check the worker log, then restart.',
    fixCommand: 'claude-mem restart',
    docHref: `${DOCS}#startup`,
  },
];

export function catalogByKey(): Record<string, EscalationCatalogEntry> {
  const out: Record<string, EscalationCatalogEntry> = {};
  for (const e of ESCALATION_CATALOG) out[e.key] = e;
  return out;
}
```

- [ ] **Step 3b: Implement the read-time context** — `src/services/mission-control/escalationContext.ts`:

```ts
import type { Database } from 'bun:sqlite';
import { ESCALATION_CATALOG } from './escalation-catalog.js';

/** Must match AttentionMiner's escalation scan window. */
const ESCALATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface EscalationContext {
  key: string;
  whatTitle: string;          // from catalog
  fixText: string;            // from catalog
  fixCommand?: string;        // from catalog
  docHref: string;            // from catalog
  errorLine: string;          // latest matching observation's title/narrative snippet
  count: number;              // total matches in window
  latestEpoch: number;        // latest occurrence
  latestProject: string | null;
  latestAgentType: string | null;
  latestSessionId: string | null;
  otherTeamsCount: number;    // distinct agent_type beyond the latest → "+N others"
}

interface Row {
  project: string | null;
  title: string | null;
  narrative: string | null;
  agent_type: string | null;
  memory_session_id: string | null;
  created_at_epoch: number;
}

/**
 * Aggregate escalation render-context per catalog error class over the recent
 * window. Read-time (not persisted): a single per-class attention_items row
 * cannot hold "+N others"/count/latest honestly, so we compute them fresh.
 * Fail-closed: only classes in ESCALATION_CATALOG can appear.
 */
export function buildEscalationContext(db: Database, now: number): Record<string, EscalationContext> {
  const rows = db.prepare(
    `SELECT project, title, narrative, agent_type, memory_session_id, created_at_epoch
     FROM observations
     WHERE (narrative IS NOT NULL OR title IS NOT NULL) AND created_at_epoch >= ?
     ORDER BY created_at_epoch DESC LIMIT 500`
  ).all(now - ESCALATION_WINDOW_MS) as Row[];

  const out: Record<string, EscalationContext> = {};
  // rows are DESC by epoch → the first match for a key is the latest.
  const teams: Record<string, Set<string>> = {};

  for (const row of rows) {
    const haystack = `${row.title ?? ''}\n${row.narrative ?? ''}`;
    for (const entry of ESCALATION_CATALOG) {
      if (!entry.re.test(haystack)) continue;
      const key = entry.key;
      if (!out[key]) {
        out[key] = {
          key,
          whatTitle: entry.whatTitle,
          fixText: entry.fixText,
          fixCommand: entry.fixCommand,
          docHref: entry.docHref,
          errorLine: (row.title ?? row.narrative ?? '').trim().slice(0, 300),
          count: 0,
          latestEpoch: row.created_at_epoch,
          latestProject: row.project,
          latestAgentType: row.agent_type,
          latestSessionId: row.memory_session_id,
          otherTeamsCount: 0,
        };
        teams[key] = new Set();
      }
      out[key].count++;
      if (row.agent_type) teams[key].add(row.agent_type);
      break; // one class per observation (matches the miner)
    }
  }

  // "+N others" = distinct teams beyond the latest one.
  for (const key of Object.keys(out)) {
    const latest = out[key].latestAgentType;
    const distinct = teams[key];
    out[key].otherTeamsCount = Math.max(0, distinct.size - (latest && distinct.has(latest) ? 1 : 0));
  }
  return out;
}
```

- [ ] **Step 3c: Source the miner's patterns from the catalog** — in `src/services/mission-control/AttentionMiner.ts`, delete the local `ERROR_PATTERNS` const and import the catalog; the escalation loop iterates catalog entries (behavior identical for the 4 keys, now structurally fail-closed):

```ts
import { ESCALATION_CATALOG } from './escalation-catalog.js';
// ...delete: const ERROR_PATTERNS = [ ... ];
// In the escalation scan loop, replace `for (const pattern of ERROR_PATTERNS)` with:
    for (const pattern of ESCALATION_CATALOG) {
      if (pattern.re.test(haystack)) {
        const ref = `error:${pattern.key}`;
        // ...unchanged upsert body (summary stays "Error signature detected: <key>";
        //    the actionable card renders from escalationContext, not this summary)...
        break;
      }
    }
```

- [ ] **Step 4: Run green + typecheck** — `bun test tests/mission-control/escalation-context.test.ts tests/mission-control/attention-miner.test.ts` → PASS (miner behavior unchanged for the 4 keys). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/mission-control/escalation-catalog.ts src/services/mission-control/escalationContext.ts src/services/mission-control/AttentionMiner.ts tests/mission-control/escalation-context.test.ts
git commit -m "feat(mission-control): escalation remediation catalog (fail-closed allowlist) + read-time context (WHAT/WHERE/WHEN/FIX)"
```

---

### Task 7: `MissionControlRoutes` — injectable `repoRoot`, threaded cwd, and all payload additions

The route hub. (a) Add an injectable `repoRoot` constructor param (default `resolveRepoRoot()`), captured once and used in the three branching handlers + as the boundary cwd (#24 §5). (b) Add `repoWebBase`/`defaultBranch`/`escalationContext` to `/attention`. (c) Pass `since` → `sessions`+`prs` on `/progress`.

**Files:** Modify `src/services/worker/http/routes/MissionControlRoutes.ts`; Modify `src/services/mission-control/loadSpecFiles.ts` (optional `root` param). Tests land in Task 8.

- [ ] **Step 1: Injectable `repoRoot` + threaded boundary cwd.** Change the constructor (mirrors the existing optional `boundary` param):

```ts
  private repoWebInfoCache: RepoWebInfo | null | undefined;

  constructor(
    private dbManager: DatabaseManager,
    boundary?: GitGhBoundary,
    // Captured ONCE (not per-request). Default resolves the real root; tests inject
    // `null` (deferred) or a fixture dir (resolved) for determinism. Threaded as the
    // git/gh cwd so `git log` (velocity series), `gh pr list` (reviews), and
    // `gh repo view` (link base) run against the correct repo — a deployed worker's
    // cwd may be an upstream checkout. `undefined` cwd ⇒ worker cwd (Phase-1 behavior).
    private repoRoot: string | null = resolveRepoRoot(),
  ) {
    super();
    this.boundary = boundary ?? createGitGhBoundary(this.repoRoot ?? undefined);
  }
```

Add the imports `createGitGhBoundary` already exists; add `type RepoWebInfo` to the shell import, and import `queryTeamSessions, queryTeamPrs` from `ProgressQuery.js` and `buildEscalationContext` from `escalationContext.js`.

Add a process-lifetime memo for repo web info (mirrors `cachedGhAvailable`, but repo identity is stable so cache for the whole process):

```ts
  private cachedRepoWebInfo(): RepoWebInfo | null {
    if (this.repoWebInfoCache !== undefined) return this.repoWebInfoCache;
    this.repoWebInfoCache = this.boundary.repoWebInfo?.() ?? null;
    return this.repoWebInfoCache;
  }
```

- [ ] **Step 2: Use `this.repoRoot` in the three branching handlers.** Replace the per-request `resolveRepoRoot()` calls:
  - `mineOnce`: `specFiles: loadSpecFiles(this.repoRoot)` and `specMiningEnabled: this.repoRoot !== null`.
  - `handleAttention`: `specMiningDeferred: this.repoRoot === null`.
  - `handleVelocity`: `const root = this.repoRoot;` (the `root === null` deferred branch, the `path.join(root,'docs','BUILDER_QUEUE.md')` read, and the loud parse-error branch are all unchanged).

- [ ] **Step 3: Extend the `/attention` payload** — in `handleAttention`, after `this.mineOnce(refresh)`:

```ts
    const db = this.dbManager.getSessionStore().db;
    const webInfo = this.cachedRepoWebInfo();
    res.json({
      items: readOpenAttentionItems(db, project),
      ghAvailable: this.cachedGhAvailable(),
      specMiningDeferred: this.repoRoot === null,
      repoWebBase: webInfo?.repoWebBase ?? null,
      defaultBranch: webInfo?.defaultBranch ?? null,
      escalationContext: buildEscalationContext(db, Date.now()),
    });
```

- [ ] **Step 4: Extend the `/progress` payload** — in `handleProgress`, read `since` and return sessions + prs:

```ts
  private handleProgress = this.wrapHandler((req: Request, res: Response): void => {
    const by = req.query.by === 'human' ? 'human' : 'agent';
    const granularity = req.query.granularity === 'week' ? 'week' : 'day';
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    const sinceRaw = typeof req.query.since === 'string' ? Number(req.query.since) : NaN;
    const sinceEpoch = Number.isFinite(sinceRaw) ? sinceRaw : undefined;
    const db = this.dbManager.getSessionStore().db;
    res.json({
      buckets: queryProgress(db, { by, granularity, project, sinceEpoch }),
      sessions: queryTeamSessions(db, { project, sinceEpoch }),
      prs: queryTeamPrs(db, { project, sinceEpoch }),
    });
  });
```

- [ ] **Step 5: `loadSpecFiles` optional root** — in `src/services/mission-control/loadSpecFiles.ts`, change the signature only (body unchanged; keep the `resolveRepoRoot` import for the default):

```ts
export function loadSpecFiles(root: string | null = resolveRepoRoot()): { path: string; content: string }[] {
  if (root === null) return [];
  // ...rest unchanged (walkMarkdown over SPEC_DIRS relative to `root`)...
```

- [ ] **Step 6: Typecheck** — `npm run typecheck` → no new errors in `MissionControlRoutes.ts` / `mission-control/**`. (Behavioral tests are Task 8.)

- [ ] **Step 7: Commit**

```bash
git add src/services/worker/http/routes/MissionControlRoutes.ts src/services/mission-control/loadSpecFiles.ts
git commit -m "feat(mission-control): route injectable repoRoot + threaded cwd; /attention link base + escalationContext; /progress since/sessions/prs"
```

---

### Task 8: Route tests — pin deferred cases, add resolved + payload cases

Update `tests/worker/http/routes/mission-control-routes.test.ts`. After Task 7 the two existing deferred tests take the default `repoRoot = resolveRepoRoot()`, which the git-toplevel fallback resolves to the real worktree during `bun test` (it has `docs/BUILDER_QUEUE.md`) — flipping them to the resolved branch and failing. Pin them to `repoRoot: null`. Then add resolved-branch cases: velocity counts survive an empty git series (F3), `specMiningDeferred:false`, `repoWebBase`/`defaultBranch`/`escalationContext` present, and `/progress` returns `sessions`+`prs` honoring `since`.

**Files:** Modify `tests/worker/http/routes/mission-control-routes.test.ts`.

- [ ] **Step 1: Pin the two deferred tests** — add `, null` as the third constructor arg to the velocity-deferred and attention-`specMiningDeferred` constructions:

```ts
    const routes = new MissionControlRoutes(makeDbManager() as any, {
      ghAvailable: () => false, listOpenPrs: () => [], listMergeCommits: () => [],
    }, null); // repoRoot: null ⇒ deferred, deterministic regardless of the bun-test cwd
```

- [ ] **Step 2: Add resolved-branch + payload cases** — append:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

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

const RESOLVED_BOUNDARY = {
  ghAvailable: () => false,
  listOpenPrs: () => [],
  listMergeCommits: () => [],
  repoWebInfo: () => ({ repoWebBase: 'https://github.com/acme/repo', defaultBranch: 'main' }),
};

describe('MissionControlRoutes — Phase 1b payloads', () => {
  it('velocity returns real counts (not deferred), independent of an empty git series (F3)', () => {
    const root = makeFixtureRepo();
    try {
      const app = makeMockApp();
      const routes = new MissionControlRoutes(makeDbManager() as any, RESOLVED_BOUNDARY, root);
      routes.setupRoutes(app as any);
      const body = app.invoke('/api/mission-control/velocity', { query: {} }) as {
        deferred?: boolean; openCount: number | null; shippedCount: number | null; shippedByWeek: unknown[];
      };
      expect(body.deferred).toBeUndefined();
      expect(body.openCount).toBe(1);
      expect(body.shippedCount).toBe(1);
      expect(body.shippedByWeek).toEqual([]); // empty git ⇒ empty series, counts survive
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('attention exposes link base + escalationContext and specMiningDeferred:false when resolved', () => {
    const root = makeFixtureRepo();
    try {
      const app = makeMockApp();
      const routes = new MissionControlRoutes(makeDbManager() as any, RESOLVED_BOUNDARY, root);
      routes.setupRoutes(app as any);
      const body = app.invoke('/api/mission-control/attention', { query: {} }) as {
        specMiningDeferred: boolean; repoWebBase: string | null; defaultBranch: string | null; escalationContext: Record<string, unknown>;
      };
      expect(body.specMiningDeferred).toBe(false);
      expect(body.repoWebBase).toBe('https://github.com/acme/repo');
      expect(body.defaultBranch).toBe('main');
      expect(typeof body.escalationContext).toBe('object');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('progress returns buckets + sessions + prs and honors ?since', () => {
    const dbManager = makeDbManager();
    const db = dbManager.getSessionStore().db;
    db.run(`INSERT INTO observations (memory_session_id, project, text, type, title, agent_type, created_at, created_at_epoch)
            VALUES ('s1','claude-mem','opened PR #42','feature','opened PR #42','builder','2026-07-16T00:00:00.000Z', 5000)`);
    const app = makeMockApp();
    const routes = new MissionControlRoutes(dbManager as any, RESOLVED_BOUNDARY, null);
    routes.setupRoutes(app as any);
    const body = app.invoke('/api/mission-control/progress', { query: { since: '4000' } }) as {
      buckets: Array<{ project: string | null }>; sessions: Array<{ sessions: number }>; prs: Array<{ prNumbers: number[] }>;
    };
    expect(body.buckets.some(b => b.project === 'claude-mem')).toBe(true);
    expect(body.sessions.some(s => s.sessions === 1)).toBe(true);
    expect(body.prs.some(p => p.prNumbers.includes(42))).toBe(true);
  });
});
```

- [ ] **Step 3: Run green** — `bun test tests/worker/http/routes/mission-control-routes.test.ts` → PASS (pinned deferred cases + new resolved/payload cases). A resolved-case failure means the fault is in Task 1/3/5/6/7 wiring — fix there, not by special-casing the route.

- [ ] **Step 4: Commit**

```bash
git add tests/worker/http/routes/mission-control-routes.test.ts
git commit -m "test(mission-control): pin deferred route cases + resolved/link-base/escalation/progress payload cases"
```

---

# GROUP B — render-only (panes rebuilt once)

### Task 9: The Mission Control stylesheet (`.mission-control` / `.mc-*` / `.view-toggle`)

The single biggest lever (polish §5): the panes currently have **zero** CSS. Add one card system that mirrors the Feed's language, mapping to existing tokens only (no new tokens; literal px for radius since `--radius-md` is absent). Append inside the existing `<style>` block in `src/ui/viewer-template.html` (before `</style>`).

**Files:** Modify `src/ui/viewer-template.html`.

- [ ] **Step 1: Append the stylesheet** (typed accent cards map the 4 attention types onto the 4 existing semantic color families; a11y focus rings + reduced-motion guard included):

```css
/* ── Mission Control ─────────────────────────────────────────── */
.view-toggle { display: flex; gap: 4px; padding: 8px 18px; background: var(--color-bg-tertiary); border-bottom: 1px solid var(--color-border-primary); }
.view-toggle button { padding: 6px 14px; font-size: 13px; font-weight: 500; color: var(--color-text-secondary); background: transparent; border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
.view-toggle button:hover { color: var(--color-text-primary); }
.view-toggle button.active { color: #fff; background: var(--color-accent-primary); }
.view-toggle button:focus-visible { box-shadow: var(--shadow-focus); outline: none; }

.mission-control { overflow-y: auto; height: 100vh; padding: 24px 18px; max-width: 760px; margin: 0 auto; }
.mc-header { display: flex; justify-content: flex-end; margin-bottom: 16px; }
.mc-refresh { padding: 6px 14px; font-size: 13px; color: var(--color-text-secondary); background: var(--color-bg-stat); border: 1px solid var(--color-border-primary); border-radius: 6px; cursor: pointer; }
.mc-refresh:hover { color: var(--color-text-primary); }
.mc-refresh:focus-visible { box-shadow: var(--shadow-focus); outline: none; }

.mc-pane { background: var(--color-bg-card); border: 1px solid var(--color-border-primary); border-radius: 8px; padding: 24px; margin-bottom: 24px; }
.mc-pane h2 { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 16px; color: var(--color-text-primary); }
.mc-attention-group { margin-bottom: 20px; }
.mc-attention-group h3, .subsection-label-mc { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--color-text-muted); margin: 0 0 8px; }
.mc-pane ul { list-style: none; margin: 0; padding: 0; }

/* Typed accent cards (reuse the 4 semantic families the viewer already ships). */
.mc-item { padding: 10px 12px; margin-bottom: 8px; border-left: 3px solid var(--color-border-primary); border-radius: 6px; background: var(--color-bg-stat); }
.mc-item.mc-type-escalation { border-left-color: var(--color-accent-error); background: color-mix(in srgb, var(--color-accent-error) 8%, var(--color-bg-card)); }
.mc-item.mc-type-blocker    { border-left-color: var(--color-border-summary); background: var(--color-bg-summary); }
.mc-item.mc-type-review     { border-left-color: var(--color-border-observation); background: var(--color-bg-observation); }
.mc-item.mc-type-question   { border-left-color: var(--color-border-prompt); background: var(--color-bg-prompt); }

.mc-item-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.mc-link { color: var(--color-accent-primary); text-decoration: none; }
.mc-link:hover { text-decoration: underline; }
.mc-link:focus-visible { box-shadow: var(--shadow-focus); outline: none; border-radius: 3px; }
.mc-meta { font-family: var(--font-terminal); font-size: 11px; color: var(--color-text-tertiary); white-space: nowrap; }

/* Escalation card (four-field). */
.mc-escalation { padding: 14px; border: 1px solid var(--color-accent-error); border-left-width: 3px; border-radius: 6px; background: color-mix(in srgb, var(--color-accent-error) 8%, var(--color-bg-card)); margin-bottom: 10px; }
.mc-urgency { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; }
.mc-urgency-high { color: var(--color-accent-error); }
.mc-escalation-title { font-weight: 600; margin-left: 8px; color: var(--color-text-primary); }
.mc-escalation-line { font-family: var(--font-terminal); font-size: 12px; color: var(--color-text-primary); margin: 8px 0; word-break: break-word; }
.mc-field { display: grid; grid-template-columns: 52px 1fr; gap: 8px; font-size: 12px; color: var(--color-text-secondary); margin-top: 4px; }
.mc-field-label { color: var(--color-text-muted); text-transform: uppercase; font-size: 10px; letter-spacing: 0.4px; padding-top: 1px; }
.mc-copy { font-family: var(--font-terminal); font-size: 11px; padding: 1px 6px; border: 1px solid var(--color-border-primary); border-radius: 4px; background: var(--color-bg-stat); cursor: pointer; }
.mc-copy:focus-visible { box-shadow: var(--shadow-focus); outline: none; }

/* Progress rollup. */
.mc-range { display: inline-flex; gap: 4px; float: right; }
.mc-range button { font-size: 11px; padding: 3px 9px; border: 1px solid var(--color-border-primary); border-radius: 5px; background: var(--color-bg-stat); color: var(--color-text-secondary); cursor: pointer; }
.mc-range button[aria-pressed="true"] { background: var(--color-accent-primary); color: #fff; border-color: transparent; }
.mc-range button:focus-visible { box-shadow: var(--shadow-focus); outline: none; }
.mc-project > summary, .mc-project-header { cursor: pointer; font-weight: 600; color: var(--color-text-primary); padding: 6px 0; list-style: none; }
.mc-project-rollup { font-size: 12px; color: var(--color-text-muted); font-weight: 400; margin-left: 8px; }
.mc-team { border-top: 1px solid var(--color-border-primary); padding: 10px 0; }
.mc-team-name { font-weight: 600; color: var(--color-text-primary); }
.mc-team-sessions { font-size: 12px; color: var(--color-text-tertiary); margin-left: 8px; }
.mc-outcome { font-size: 13px; color: var(--color-text-secondary); margin: 4px 0; }
.mc-outcome-empty { font-size: 12px; color: var(--color-text-muted); font-style: italic; }
.mc-obs-tail { font-size: 11px; color: var(--color-text-muted); font-family: var(--font-terminal); }

/* Notes / states. */
.mc-note { background: var(--color-bg-stat); border: 1px solid var(--color-border-primary); border-radius: 6px; padding: 8px 12px; font-size: 12px; color: var(--color-text-secondary); margin-bottom: 12px; }
.mc-empty { text-align: center; color: var(--color-text-muted); font-size: 13px; padding: 12px 0; }
.mc-loading, .mc-error { background: var(--color-bg-card); border: 1px solid var(--color-border-primary); border-radius: 8px; padding: 24px; margin: 24px auto; max-width: 760px; }
.mc-error { border-color: var(--color-accent-error); color: var(--color-accent-error); }
.mc-badge { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--color-text-tertiary); border: 1px solid var(--color-border-primary); border-radius: 4px; padding: 1px 6px; margin-left: 8px; }

@media (prefers-reduced-motion: no-preference) {
  .mc-pane { animation: slideIn 0.2s ease-out; }
}
```

> If `color-mix` is unsupported by the viewer's target, substitute the existing `--color-bg-observation`-style tinted tokens for the escalation background (there is no dedicated error-bg token; `color-mix` over `--color-accent-error` is the closest token-only tint). Builder/Polisher confirm the tint keeps the quoted error line at `--color-text-primary` legibility in both themes (a11y §9).

- [ ] **Step 2: Commit** (bundle rebuild happens in Task 13 after the component lands):

```bash
git add src/ui/viewer-template.html
git commit -m "feat(mission-control): add the .mc-* / .mission-control / .view-toggle stylesheet (token-mapped, a11y, reduced-motion)"
```

---

### Task 10: `useMissionControl` hook — velocity fetch + all Phase-1b fields + since-last-opened range

Rebuild the data hook once: re-add the velocity fetch/state (#24), and add `repoWebBase`/`defaultBranch`/`escalationContext` (attention), `sessions`/`prs` + the `range`/`sinceEpoch` machinery (progress), with the **since-last-opened** default (client-stored timestamp; selector offers Today/7d/All).

**Files:** Modify `src/ui/viewer/hooks/useMissionControl.ts`.

- [ ] **Step 1: Add types + range helper.** Add the interfaces and a pure range→sinceEpoch helper:

```ts
export interface VelocityResult {
  deferred?: boolean; reason?: string; error?: string;
  openCount: number | null; shippedCount: number | null;
  shippedByWeek: { week: string; shipped: number }[];
}
export interface EscalationContext {
  key: string; whatTitle: string; fixText: string; fixCommand?: string; docHref: string;
  errorLine: string; count: number; latestEpoch: number;
  latestProject: string | null; latestAgentType: string | null; latestSessionId: string | null; otherTeamsCount: number;
}
export interface TeamSessions { project: string | null; agentType: string | null; sessions: number; }
export interface TeamPrs { project: string | null; agentType: string | null; prNumbers: number[]; }

export type ProgressRange = 'since-last-opened' | 'today' | '7d' | 'all';
const LAST_OPENED_KEY = 'mc-progress-last-opened';

/** Resolve a range to a sinceEpoch (or undefined = all history). */
function rangeToSince(range: ProgressRange, lastOpened: number | null): number | undefined {
  const now = Date.now();
  switch (range) {
    case 'all': return undefined;
    case 'today': { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
    case '7d': return now - 7 * 24 * 60 * 60 * 1000;
    case 'since-last-opened': return lastOpened ?? now - 7 * 24 * 60 * 60 * 1000; // fallback 7d on first ever open
  }
}
```

- [ ] **Step 2: Extend `MissionControlData` + state.** Add `velocity`, `repoWebBase`, `defaultBranch`, `escalationContext`, `progressSessions`, `progressPrs`, `range`, `setRange` to the interface and the hook state:

```ts
  const [velocity, setVelocity] = useState<VelocityResult | null>(null);
  const [repoWebBase, setRepoWebBase] = useState<string | null>(null);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [escalationContext, setEscalationContext] = useState<Record<string, EscalationContext>>({});
  const [progressSessions, setProgressSessions] = useState<TeamSessions[]>([]);
  const [progressPrs, setProgressPrs] = useState<TeamPrs[]>([]);
  const [range, setRange] = useState<ProgressRange>('since-last-opened');
```

- [ ] **Step 3: Read + advance the last-opened marker once on mount** (before the first load), so "since last opened" means "since the previous visit":

```ts
  const [lastOpened] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(LAST_OPENED_KEY);
      const prev = raw ? Number(raw) : null;
      localStorage.setItem(LAST_OPENED_KEY, String(Date.now())); // advance for next visit
      return prev && Number.isFinite(prev) ? prev : null;
    } catch { return null; }
  });
```

- [ ] **Step 4: Rebuild `load` with all four fetches + the progress `since` param.** `load` depends on `range`/`lastOpened`:

```ts
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const since = rangeToSince(range, lastOpened);
      const progressUrl = since === undefined
        ? API_ENDPOINTS.MC_PROGRESS
        : `${API_ENDPOINTS.MC_PROGRESS}?since=${since}`;
      const [a, p, v, n] = await Promise.all([
        fetch(API_ENDPOINTS.MC_ATTENTION).then(r => r.json()),
        fetch(progressUrl).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_VELOCITY).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_NEXT_STEPS).then(r => r.json()),
      ]);
      setAttention(a.items ?? []);
      setGhAvailable(a.ghAvailable ?? true);
      setSpecMiningDeferred(a.specMiningDeferred ?? false);
      setRepoWebBase(a.repoWebBase ?? null);
      setDefaultBranch(a.defaultBranch ?? null);
      setEscalationContext(a.escalationContext ?? {});
      setProgress(p.buckets ?? []);
      setProgressSessions(p.sessions ?? []);
      setProgressPrs(p.prs ?? []);
      setVelocity(v ?? null);
      setNextSteps(n.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [range, lastOpened]);

  useEffect(() => { load(); }, [load]);
```

- [ ] **Step 5: Return everything:**

```ts
  return {
    attention, ghAvailable, specMiningDeferred, repoWebBase, defaultBranch, escalationContext,
    progress, progressSessions, progressPrs, velocity, nextSteps,
    range, setRange, loading, error, refresh: load,
  };
```

- [ ] **Step 6: Typecheck** — `npm run typecheck:viewer` → no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/ui/viewer/hooks/useMissionControl.ts
git commit -m "feat(mission-control): hook adds velocity + link base + escalationContext + progress sessions/prs + since-last-opened range"
```

---

### Task 11: `MissionControl.tsx` rebuild (all four panes once) + `App.tsx` toggle a11y

Rebuild the component in one pass against the final payloads: Velocity pane (deferred-aware), Attention with typed-accent cards + **type-specific** links (`github ↗` for PRs, `view ↗` for files/specs) + four-field escalation cards (fail-closed via `escalationContext`), Progress as Project→team rollup with the `byType` outcome line + range selector (since-last-opened default), and next-steps grouped by project. Add `aria-pressed` to the `App.tsx` view toggle.

**Files:** Modify `src/ui/viewer/components/MissionControl.tsx`; Modify `src/ui/viewer/App.tsx`.

- [ ] **Step 1: Replace `MissionControl.tsx`** with the full component. Link building respects K1 (question rows link the file, no `#L`) and Mark's type-specific affordance:

```tsx
// src/ui/viewer/components/MissionControl.tsx
import React, { useMemo } from 'react';
import {
  useMissionControl, AttentionItem, EscalationContext, ProgressBucket, TeamSessions, TeamPrs, ProgressRange,
} from '../hooks/useMissionControl';

// Outcome types only (process types session/prompt/change are excluded from the outcome line).
const OUTCOME_ICONS: Record<string, string> = { feature: '◆', bugfix: '●', decision: '⚖', refactor: '↻', discovery: '○' };
const OUTCOME_ORDER = ['feature', 'bugfix', 'decision', 'refactor', 'discovery'];
const OUTCOME_LABELS: Record<string, string> = { feature: 'feature', bugfix: 'bugfix', decision: 'decision', refactor: 'refactor', discovery: 'discovery' };

function plural(n: number, word: string) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

/** Link an attention item by ref. Returns { href, kind } or null (no link). K1: question uses the file, no #L. */
function attentionLink(item: AttentionItem, repoWebBase: string | null, defaultBranch: string | null): { href: string; kind: 'github' | 'view' } | null {
  if (!repoWebBase) return null;
  if (item.ref.startsWith('pr:')) {
    const n = item.ref.slice(3);
    return /^\d+$/.test(n) ? { href: `${repoWebBase}/pull/${n}`, kind: 'github' } : null;
  }
  const branch = defaultBranch ?? 'main';
  if (item.ref.startsWith('spec:')) return { href: `${repoWebBase}/blob/${branch}/${item.ref.slice(5)}`, kind: 'view' };
  if (item.ref.startsWith('question:')) {
    // ref = question:<path>#<bulletIndex>; the #<n> is a bullet ordinal, NOT a file line — link the file only (K1).
    const path = item.ref.slice('question:'.length).split('#')[0];
    return { href: `${repoWebBase}/blob/${branch}/${path}`, kind: 'view' };
  }
  return null;
}

function EscalationCard({ ctx }: { ctx: EscalationContext }) {
  const where = ctx.otherTeamsCount > 0
    ? `${ctx.latestProject ?? '—'} · ${ctx.latestAgentType ?? 'unknown'} team · +${ctx.otherTeamsCount} others`
    : `${ctx.latestProject ?? '—'} · ${ctx.latestAgentType ?? 'unknown'} team`;
  const when = `${plural(ctx.count, 'time')} in last 7d · latest ${new Date(ctx.latestEpoch).toLocaleString()}`;
  return (
    <div className="mc-escalation" data-testid="mc-escalation">
      <span className="mc-urgency mc-urgency-high">{'●'} HIGH</span>
      <span className="mc-escalation-title">{ctx.whatTitle}</span>
      <div className="mc-escalation-line">{ctx.errorLine}</div>
      <div className="mc-field"><span className="mc-field-label">where</span><span>{where}{ctx.latestSessionId ? ` · session ${ctx.latestSessionId.slice(0, 8)}` : ''}</span></div>
      <div className="mc-field"><span className="mc-field-label">when</span><span>{when}</span></div>
      <div className="mc-field">
        <span className="mc-field-label">fix</span>
        <span>
          {ctx.fixText}{' '}
          {ctx.fixCommand && (
            <button className="mc-copy" onClick={() => { try { navigator.clipboard?.writeText(ctx.fixCommand!); } catch { /* noop */ } }} aria-label={`Copy command: ${ctx.fixCommand}`}>
              {ctx.fixCommand} {'⧉'}
            </button>
          )}{' '}
          <a className="mc-link" href={ctx.docHref} target="_blank" rel="noopener noreferrer">docs {'↗'}</a>
        </span>
      </div>
    </div>
  );
}

export function AttentionPane({ items, ghAvailable, specMiningDeferred, escalationContext, repoWebBase, defaultBranch }: {
  items: AttentionItem[]; ghAvailable: boolean; specMiningDeferred: boolean;
  escalationContext: Record<string, EscalationContext>; repoWebBase: string | null; defaultBranch: string | null;
}) {
  const order: Array<AttentionItem['type']> = ['escalation', 'blocker', 'review', 'question'] as any;
  const byType = (type: string) => items.filter(i => i.type === type);
  // Fail-closed: only escalation items whose error key resolved a catalog+context entry render.
  const escalations = byType('escalation')
    .map(i => ({ item: i, ctx: escalationContext[i.ref.replace(/^error:/, '')] }))
    .filter(e => e.ctx);

  return (
    <section className="mc-pane" data-testid="mc-attention">
      <h2>Attention — what needs you now</h2>
      {!ghAvailable && <p className="mc-note" data-testid="mc-gh-unavailable">PR mining unavailable (gh not authenticated) — showing escalations only.</p>}
      {specMiningDeferred && <p className="mc-note" data-testid="mc-spec-mining-deferred">Spec-review &amp; doc-question mining deferred — needs repo root (follow-up #24). Showing escalations + open-PR reviews.</p>}
      {items.length === 0 && <p className="mc-empty">Nothing is gated on you right now.</p>}

      {escalations.length > 0 && (
        <div className="mc-attention-group" data-testid="mc-escalations">
          <h3>Escalations ({escalations.length})</h3>
          {escalations.map(e => <EscalationCard key={e.item.id} ctx={e.ctx} />)}
        </div>
      )}

      {(['blocker', 'review', 'question'] as const).map(type => {
        const group = byType(type);
        if (group.length === 0) return null;
        return (
          <div key={type} className="mc-attention-group">
            <h3>{type}s ({group.length})</h3>
            <ul>
              {group.map(item => {
                const link = attentionLink(item, repoWebBase, defaultBranch);
                return (
                  <li key={item.id} className={`mc-item mc-type-${type}`}>
                    <div className="mc-item-row">
                      {link
                        ? <a className="mc-link" href={link.href} target="_blank" rel="noopener noreferrer">{item.summary} {link.kind === 'github' ? 'github ↗' : 'view ↗'}</a>
                        : <span>{item.summary}</span>}
                      {item.project && <span className="mc-meta">{item.project}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function VelocityPane({ velocity }: { velocity: ReturnType<typeof useMissionControl>['velocity'] }) {
  return (
    <section className="mc-pane" data-testid="mc-velocity">
      <h2>Velocity</h2>
      {velocity?.deferred ? (
        <p className="mc-note" data-testid="mc-velocity-deferred">Velocity deferred — set <code>CLAUDE_MEM_PROJECT_ROOT</code> to the repo containing <code>docs/BUILDER_QUEUE.md</code> (follow-up #24).</p>
      ) : velocity?.error ? (
        <p className="mc-error" data-testid="mc-velocity-error">Queue parse failed: {velocity.error}</p>
      ) : (
        <>
          <p>{velocity?.shippedCount ?? '—'} shipped · {velocity?.openCount ?? '—'} open</p>
          <ul>{(velocity?.shippedByWeek ?? []).map(pt => <li key={pt.week} className="mc-meta">{pt.week}: {pt.shipped} shipped</li>)}</ul>
        </>
      )}
    </section>
  );
}

interface TeamRow { project: string | null; agentType: string | null; byType: Record<string, number>; total: number; sessions: number; prNumbers: number[]; }

function buildTeamTree(progress: ProgressBucket[], sessions: TeamSessions[], prs: TeamPrs[]): Map<string, TeamRow[]> {
  const teamKey = (p: string | null, a: string | null) => `${p ?? ''} ${a ?? ''}`;
  const teams = new Map<string, TeamRow>();
  for (const b of progress) {
    const k = teamKey(b.project, b.agentType);
    let t = teams.get(k);
    if (!t) { t = { project: b.project, agentType: b.agentType, byType: {}, total: 0, sessions: 0, prNumbers: [] }; teams.set(k, t); }
    t.total += b.total;
    for (const [type, n] of Object.entries(b.byType)) t.byType[type] = (t.byType[type] ?? 0) + n;
  }
  for (const s of sessions) { const t = teams.get(teamKey(s.project, s.agentType)); if (t) t.sessions = s.sessions; }
  for (const p of prs) { const t = teams.get(teamKey(p.project, p.agentType)); if (t) t.prNumbers = p.prNumbers; }
  const byProject = new Map<string, TeamRow[]>();
  for (const t of teams.values()) {
    const pk = t.project ?? '(unknown)';
    if (!byProject.has(pk)) byProject.set(pk, []);
    byProject.get(pk)!.push(t);
  }
  return byProject;
}

function outcomeLine(byType: Record<string, number>): string | null {
  const parts = OUTCOME_ORDER.filter(t => (byType[t] ?? 0) > 0).map(t => `${OUTCOME_ICONS[t]} ${plural(byType[t], OUTCOME_LABELS[t])}`);
  return parts.length ? parts.join(' · ') : null;
}

function ProgressPane({ progress, sessions, prs, range, setRange, repoWebBase }: {
  progress: ProgressBucket[]; sessions: TeamSessions[]; prs: TeamPrs[];
  range: ProgressRange; setRange: (r: ProgressRange) => void; repoWebBase: string | null;
}) {
  const tree = useMemo(() => buildTeamTree(progress, sessions, prs), [progress, sessions, prs]);
  const ranges: Array<{ id: ProgressRange; label: string }> = [
    { id: 'since-last-opened', label: 'Since last open' }, { id: 'today', label: 'Today' }, { id: '7d', label: '7 days' }, { id: 'all', label: 'All' },
  ];
  return (
    <section className="mc-pane" data-testid="mc-progress">
      <h2>Progress — what teams accomplished
        <span className="mc-range">{ranges.map(r => (
          <button key={r.id} aria-pressed={range === r.id} onClick={() => setRange(r.id)}>{r.label}</button>
        ))}</span>
      </h2>
      {tree.size === 0 && <p className="mc-empty">No agent activity in range.</p>}
      {[...tree.entries()].map(([project, rows]) => {
        const totalSessions = rows.reduce((a, r) => a + r.sessions, 0);
        return (
          <details className="mc-project" key={project} open>
            <summary className="mc-project-header">{project}<span className="mc-project-rollup">{plural(rows.length, 'team')} · {plural(totalSessions, 'session')}</span></summary>
            {rows.map(t => {
              const line = outcomeLine(t.byType);
              return (
                <div className="mc-team" key={`${project}-${t.agentType}`}>
                  <span className="mc-team-name">{t.agentType ?? 'unknown'}</span>
                  <span className="mc-team-sessions">{plural(t.sessions, 'session')}</span>
                  {line ? <div className="mc-outcome">{line}</div> : <div className="mc-outcome-empty">no outcomes captured</div>}
                  <div className="mc-obs-tail">
                    {t.prNumbers.length > 0 && (
                      <>{plural(t.prNumbers.length, 'PR')} · {t.prNumbers.map((n, i) => (
                        <React.Fragment key={n}>{i > 0 ? ' ' : ''}{repoWebBase ? <a className="mc-link" href={`${repoWebBase}/pull/${n}`} target="_blank" rel="noopener noreferrer">#{n}</a> : `#${n}`}</React.Fragment>
                      ))} · </>
                    )}
                    {t.total} obs
                  </div>
                </div>
              );
            })}
          </details>
        );
      })}
    </section>
  );
}

export function MissionControl() {
  const mc = useMissionControl();
  if (mc.loading) return <div className="mc-loading">Loading Mission Control…</div>;
  if (mc.error) return <div className="mc-error">Failed to load Mission Control: {mc.error}</div>;

  // Phase 1b: 4 panes. Velocity + spec/doc mining resolve when CLAUDE_MEM_PROJECT_ROOT
  // is set (else they degrade to labeled deferred notes). No LLM, read/mine only.
  const nextByProject = mc.nextSteps.reduce((acc, item) => {
    (acc[item.project] ||= []).push(item); return acc;
  }, {} as Record<string, typeof mc.nextSteps>);

  return (
    <div className="mission-control" data-testid="mission-control">
      <div className="mc-header"><button className="mc-refresh" onClick={mc.refresh}>Refresh</button></div>

      <AttentionPane items={mc.attention} ghAvailable={mc.ghAvailable} specMiningDeferred={mc.specMiningDeferred}
        escalationContext={mc.escalationContext} repoWebBase={mc.repoWebBase} defaultBranch={mc.defaultBranch} />

      <VelocityPane velocity={mc.velocity} />

      <ProgressPane progress={mc.progress} sessions={mc.progressSessions} prs={mc.progressPrs}
        range={mc.range} setRange={mc.setRange} repoWebBase={mc.repoWebBase} />

      <section className="mc-pane" data-testid="mc-next-steps">
        <h2>Suggested next steps <span className="mc-badge">Unsynthesized</span></h2>
        {mc.nextSteps.length === 0 && <p className="mc-empty">No next-steps captured yet.</p>}
        {Object.entries(nextByProject).map(([project, items]) => (
          <div className="mc-attention-group" key={project}>
            <h3>{project} ({items.length})</h3>
            <ul>{items.slice(0, 8).map(item => <li key={item.memorySessionId} className="mc-item">{item.text}</li>)}</ul>
            {items.length > 8 && <p className="mc-meta">+{items.length - 8} more</p>}
          </div>
        ))}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Export the hook types the component imports.** Ensure `useMissionControl.ts` exports `ProgressBucket`, `TeamSessions`, `TeamPrs`, `EscalationContext`, `ProgressRange`, `AttentionItem` (add any missing `export`).

- [ ] **Step 3: `App.tsx` toggle a11y** — add `aria-pressed` to the two view-toggle buttons:

```tsx
      <div className="view-toggle">
        <button aria-pressed={view === 'feed'} className={view === 'feed' ? 'active' : ''} onClick={() => setView('feed')}>Feed</button>
        <button aria-pressed={view === 'mission-control'} className={view === 'mission-control' ? 'active' : ''} onClick={() => setView('mission-control')}>Mission Control</button>
      </div>
```

- [ ] **Step 4: Typecheck** — `npm run typecheck:viewer` → no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/viewer/components/MissionControl.tsx src/ui/viewer/App.tsx
git commit -m "feat(mission-control): rebuild panes once — velocity, typed links, escalation cards, project rollup, a11y toggle"
```

---

### Task 12: View tests — flip the velocity-absence test, add link/escalation/progress render assertions

Update `tests/mission-control/mission-control-view.test.tsx` (K4). The existing test that asserts velocity is ABSENT must flip to assert PRESENCE + deferred behavior. Add render assertions for the escalation card (fail-closed), a type-specific link, and the outcome line.

**Files:** Modify `tests/mission-control/mission-control-view.test.tsx`.

- [ ] **Step 1: Flip the absence test + add render cases** — replace the "does not render a Velocity pane" test and add:

```tsx
  it('renders a Velocity pane (re-enabled in Phase 1b)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/ui/viewer/components/MissionControl.tsx'), 'utf8');
    expect(src).toContain('data-testid="mc-velocity"');
    expect(src).toContain('data-testid="mc-progress"');
    expect(src).toContain('data-testid="mc-next-steps"');
  });

  it('renders a type-specific link for a PR review row (github ↗) when repoWebBase is present', () => {
    const item: AttentionItem = { id: 2, type: 'review', summary: 'PR #22 awaiting review: X', blockedOn: null, urgency: 'normal', source: 'mine', ref: 'pr:22', status: 'open', project: 'claude-mem', createdAtEpoch: 1000 };
    const html = renderToString(React.createElement(AttentionPane, {
      items: [item], ghAvailable: true, specMiningDeferred: false, escalationContext: {}, repoWebBase: 'https://github.com/acme/repo', defaultBranch: 'main',
    }));
    expect(html).toContain('href="https://github.com/acme/repo/pull/22"');
    expect(html).toContain('github');
  });

  it('renders an escalation card only when its catalog context is present (fail-closed)', () => {
    const item: AttentionItem = { id: 3, type: 'escalation', summary: 'Error signature detected: eaddrinuse', blockedOn: null, urgency: 'high', source: 'mine', ref: 'error:eaddrinuse', status: 'open', project: 'claude-mem', createdAtEpoch: 1000 };
    const ctx = { eaddrinuse: { key: 'eaddrinuse', whatTitle: 'Port already in use', fixText: 'Restart.', fixCommand: 'claude-mem restart', docHref: 'https://x', errorLine: 'EADDRINUSE :::37777', count: 3, latestEpoch: 1000, latestProject: 'claude-mem', latestAgentType: 'builder', latestSessionId: 'abc12345', otherTeamsCount: 2 } };
    const withCtx = renderToString(React.createElement(AttentionPane, { items: [item], ghAvailable: true, specMiningDeferred: false, escalationContext: ctx as any, repoWebBase: null, defaultBranch: null }));
    expect(withCtx).toContain('Port already in use');
    expect(withCtx).toContain('+2 others');
    const noCtx = renderToString(React.createElement(AttentionPane, { items: [item], ghAvailable: true, specMiningDeferred: false, escalationContext: {}, repoWebBase: null, defaultBranch: null }));
    expect(noCtx).not.toContain('mc-escalation'); // fail-closed: no catalog context ⇒ not rendered
  });
```

- [ ] **Step 2: Run green** — `bun test tests/mission-control/mission-control-view.test.tsx` → PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/mission-control/mission-control-view.test.tsx
git commit -m "test(mission-control): flip velocity-absence test; add link + fail-closed escalation render cases"
```

---

### Task 13: Build, full suite, and bundle

- [ ] **Step 1: Full mission-control + route suite** — `bun test tests/mission-control/ tests/worker/http/routes/mission-control-routes.test.ts` → all green.
- [ ] **Step 2: Typecheck** — `npm run typecheck` and `npm run typecheck:viewer` → no new errors.
- [ ] **Step 3: Build + sync** — `npm run build-and-sync` → completes; the worker restarts cleanly and `plugin/ui/viewer-bundle.js` regenerates. Do not hand-edit the bundle.
- [ ] **Step 4: Commit the rebuilt bundle**

```bash
git add plugin/ui/viewer-bundle.js
git commit -m "chore(mission-control): rebuild viewer bundle for Phase 1b"
```

---

## Verification (before opening the PR)

- [ ] **No-regression guard (deferred path):** with `CLAUDE_MEM_PROJECT_ROOT` unset and no valid git-toplevel, `/velocity` → `{deferred:true}`, `/attention` → `specMiningDeferred:true` + `repoWebBase:null`, panes show labeled notes (not crashes). Identical shipped-3-pane behavior + a deferred velocity note.
- [ ] **Loud-on-misconfig (R3):** `repo-root.test.ts` invalid-env case returns `null` and logs one WARN.
- [ ] **Counts/series independence (F3):** route test proves resolved velocity returns real `openCount`/`shippedCount` with an empty `listMergeCommits`.
- [ ] **Escalation fail-closed:** `escalation-context.test.ts` proves a non-catalog error (e.g. `ECONNREFUSED`) never surfaces; the view test proves an escalation item with no context does not render.
- [ ] **Progress project-grouping + since:** `progress-query.test.ts` + route test prove `project` on buckets, distinct sessions per (project, agentType), and `?since` honored.
- [ ] **PRs parser:** `parse-pr-refs.test.ts` proves `PR #N` + gh URLs match and bare `#N` (roadmap rows) does not.

### Test Plan (live UAT — for the Tester)

1. `npm run build-and-sync`, open the viewer `/`, toggle to **Mission Control**.
2. **Deferred path (default install):** `CLAUDE_MEM_PROJECT_ROOT` unset → Velocity shows the deferred note, Attention shows the spec/doc-mining deferred note; PR-review rows render (gh) but WITHOUT github links (no `repoWebBase`); escalation cards still render from SQLite. No crash, no blank pane.
3. **Resolved path:** set `CLAUDE_MEM_PROJECT_ROOT` (env or `~/.claude-mem/settings.json`) to the fork checkout containing `docs/BUILDER_QUEUE.md`; restart (`build-and-sync`). Confirm:
   - **Velocity:** "N shipped · M open" matches the real `docs/BUILDER_QUEUE.md`; weekly series lists ISO weeks with PR-merge counts.
   - **Fork-vs-upstream cwd correctness (#24 R3):** open-PR `review` rows and the velocity merge series reflect **Mark's fork**, not upstream/marketplace. PR rows link to `https://github.com/mmackelprang/claude-mem/pull/<N>` (the boundary cwd points at the fork). Spec/question rows link to `blob/<branch>/<path>`; a question row links the FILE (no bogus `#L`).
   - **Escalations:** trigger (or seed) an `EADDRINUSE` observation → one card per class with WHAT/WHERE ("+N others" when multi-team)/WHEN/FIX (copyable command + docs link). A non-catalog error never appears.
   - **Progress:** Project→team rollup; outcome line uses icons (feature ◆, bugfix ●, decision ⚖, refactor ↻, discovery ○); `agent_id` explosion collapsed to one team row; obs count demoted; range selector defaults to **Since last open** and offers Today/7d/All; PRs-touched shows `PR #N`/gh-URL numbers only.
4. **Misconfiguration is loud:** point `CLAUDE_MEM_PROJECT_ROOT` at a dir without `docs/BUILDER_QUEUE.md`, restart → Velocity deferred note + a WARN in the worker log naming the bad path. Restore.
5. **Boundary check:** `git status` clean for `docs/BUILDER_QUEUE.md` (no writes); no LLM calls (read/mine only).

## Scoped deferrals (called out honestly)

- **Escalation session → Feed deep-link:** rendered as muted session-id provenance text, not a link. A working Feed deep-link needs App-level view switching + scroll-to-session plumbing that doesn't exist in Phase 1; deferred. The FIX doc link + copy command keep the card actionable.
- **Files-touched in Progress:** deferred per Mark's locked decision.
- **Captured-`AskUserQuestion` questions source:** out of scope (Backlog #25, per #24 spec §6).
- **True question line numbers:** the miner emits a bullet ordinal, not a file line; deep-linking to the exact line needs a miner change — deferred (link the file).

## Cross-references

- Repo-root spec: `docs/superpowers/specs/2026-07-16-mission-control-repo-root-design.md` (§4 mechanism, §5 boundary-cwd correction, F3/F4).
- Repo-root plan (superseded by this combined plan for the shared files): `docs/superpowers/plans/2026-07-16-mission-control-repo-root.md`.
- Polish handoff: `docs/design-handoffs/2026-07-16-mission-control-polish.md` (§2 links, §3 escalations, §4 progress, §5 CSS, §6 render/data-layer worklist, §8 token map, §9 a11y).
- Parent design: `docs/superpowers/specs/2026-07-16-mission-control-design.md` (D1 advisory, D4 explicit-refs, D7 auto-resolve, R3/R5).
- Phase 1 plan: `docs/superpowers/plans/2026-07-16-mission-control-phase-1-plan.md`.

## Queue

**The coordinator files the `docs/BUILDER_QUEUE.md` row for this item.** Do not edit `docs/BUILDER_QUEUE.md` as part of implementing this plan. This plan folds and supersedes queue row #24's original plan for the shared Mission Control files (repo-root work is Tasks 1, 2, 7, 8 here).
