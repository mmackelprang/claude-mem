# Design — Mission Control repo-root resolution (re-enable velocity + spec/doc mining)

- **Date:** 2026-07-16
- **Status:** Proposed
- **Author:** Planner (with Mark)
- **Consumers:** Builder (implementation plan), Tester (live UAT)
- **Slice of:** `docs/superpowers/specs/2026-07-16-mission-control-design.md` (Phase 1). This closes the repo-filesystem gap that narrowed Phase 1 from 4 panes to 3 (PR #20).
- **Queue:** `docs/BUILDER_QUEUE.md` row **#24** (this spec + its plan re-enable the three deferred sources).
- **Related code:** `src/services/mission-control/{repo-root,loadSpecFiles,VelocityQuery,AttentionMiner,shell}.ts`, `src/services/worker/http/routes/MissionControlRoutes.ts`, `src/ui/viewer/{components/MissionControl.tsx,hooks/useMissionControl.ts}`, `src/shared/paths.ts` (`resolveDataDir` precedent).

---

## 1. Problem

Mission Control Phase 1 shipped **3 working panes** (PR #20): Attention (SQLite error-observation **escalations** + open-PR **reviews** via `gh`), **Progress** (SQLite), **Next-steps** (SQLite). Three sources were **feature-gated OFF** because they read repo-`docs/` files the deployed worker cannot locate:

- **Velocity** — reads `docs/BUILDER_QUEUE.md`.
- **`Proposed`-spec review mining** — reads `docs/superpowers/specs/**`, `docs/architecture/**`.
- **doc-Open-Questions mining** — reads the same `docs/` trees.

The gate is one function: `resolveRepoRoot()` (`src/services/mission-control/repo-root.ts`) returns `null`. The root cause is that repo-doc reads were originally routed through `getPackageRoot()` (`src/shared/paths.ts:56-58` → `join(_dirname, '..')`), which resolves the **plugin install root** (`~/.claude/plugins/…` when deployed), a tree that does **not** ship `docs/`. Rather than read the wrong tree, Phase 1 returns `null` and degrades loudly (velocity → `{deferred:true}`; Attention → `specMiningDeferred:true`).

This slice implements a real repo-root strategy so those three sources resolve on a **deployed** global worker — the environment Mark actually runs, where the worker starts from the install dir, not a source checkout.

## 2. Scope

**In scope**

1. Implement `resolveRepoRoot()` with a deterministic, validated strategy (§4).
2. **Thread the resolved root as the working directory of the `git`/`gh` boundary** so velocity's weekly series and PR-review mining run against the correct repo (§5 — this is the correction to the "one-function change" framing in row #24).
3. Re-enable the **velocity** pane and **doc-Open-Questions** mining in the UI + hook; keep every existing loud-deferred state as the fallback when the root can't be resolved.
4. Keep the three sources' behavior **identical to today when the root is unresolved** — no regression to the shipped 3 panes.

**Out of scope (explicit)**

- The **captured-`AskUserQuestion`** half of the "questions" pillar — a *separate* capture-config blocker, not a repo-root problem (§6, §7). Filed as its own backlog row.
- Any Phase 2–4 work: the `attention_raise` emit tool, LLM synthesis, roadmap-row linkage, stale detection, semantic matching, any write toward `BUILDER_QUEUE.md`. (Parent spec §6/§10 — unchanged.)
- Per-project multi-root resolution. Mission Control's roadmap **is** the single `docs/BUILDER_QUEUE.md`, so one canonical project root is correct, not a limitation (§4.4).

## 3. Verified findings (against the current tree)

Every claim below was checked against source before this spec was written — including two the row-#24 framing understates.

| # | Finding | Evidence |
|---|---|---|
| F1 | The gate is one function; the miner/queries/routes stay registered and unit-tested. **True.** | `repo-root.ts:22-23` returns `null`; `loadSpecFiles.ts:33-34` returns `[]`; `MissionControlRoutes.ts:104-107` returns `{deferred:true}`; `AttentionMiner.ts:100-120` skips the spec/question block (mine **and** auto-resolve) when `specMiningEnabled=false`; `VelocityQuery.ts` intact; route registered at `MissionControlRoutes.ts:46`. |
| F2 | **`getPackageRoot()` ≠ repo root** on a deployed worker. **True.** | `paths.ts:56-58`: `join(_dirname, '..')` → the compiled bundle's parent = plugin install root; `docs/` is a repo-root tree not shipped in `plugin/`. |
| F3 | **CORRECTION — velocity is not fully fixed by `resolveRepoRoot()` alone.** The `git`/`gh` boundary passes **no `cwd`**, so `git log --merges` (velocity's `shippedByWeek`) and `gh pr list` (reviews) run in the *worker process cwd*. Resolving the root fixes the **file reads** (`BUILDER_QUEUE.md`, `loadSpecFiles`) but **not** the git/gh commands. | `shell.ts:11` `Bun.spawnSync({ cmd, … })` — no `cwd`. `VelocityQuery.ts:34`/`46-50`: `openCount`/`shippedCount` come from the parsed file (fixed by root); `shippedByWeek` comes from `boundary.listMergeCommits` (git, **not** fixed by root). |
| F4 | **SHARPENING (confirmed on this box) — the risk is "wrong repo," not merely "empty," and neither deployed candidate is the fork.** Checked the two install roots the hook chain resolves: the **marketplace dir** (`~/.claude/plugins/marketplaces/thedotmack/`) **is a git checkout whose `origin` remote is `https://github.com/thedotmack/claude-mem.git` (UPSTREAM)** and does **not** contain `docs/BUILDER_QUEUE.md`; the **cache dir** (`~/.claude/plugins/cache/thedotmack/claude-mem/13.9.2/`) is **not** a git repo and also lacks `docs/BUILDER_QUEUE.md`. So depending on the worker's actual process cwd, `gh pr list`/`git log` either resolve **upstream's** PRs/merges (marketplace → silently *wrong* velocity + reviews) or fail (cache → *empty*). Neither is Mark's fork. The already-shipped PR-reviews source is exposed to this today. | `shell.ts:48-74` resolve the repo from cwd's git remote. Verified: `git -C <marketplace> remote -v` → upstream; `git -C <cache> rev-parse` → "not a git repository"; neither ships `docs/BUILDER_QUEUE.md`. The explicit-cwd fix (§5) closes both cases; the `docs/BUILDER_QUEUE.md` validation (§4.2) makes auto-detect correctly **decline** both, so it never false-resolves on a deployed install. |
| F5 | The "questions" pillar has **two independent blockers**; only one is repo-root. **True.** | doc-Open-Questions → `loadSpecFiles` (repo-root, this slice). captured-`AskUserQuestion` → in `CLAUDE_MEM_SKIP_TOOLS` default (`SettingsDefaultsManager.ts:109`), dropped at `shared.ts:73` before capture — never enters the observation stream. |
| F6 | There is an existing, proven precedent for exactly the env→settings→default resolution this slice needs. | `paths.ts:17-37` `resolveDataDir()`: `process.env.CLAUDE_MEM_DATA_DIR` → `settings.json` `CLAUDE_MEM_DATA_DIR` → default. Mirror it. |

## 4. Decision — repo-root mechanism

### 4.1 Options weighed

| Option | How | Works on the deployed global worker (Mark's actual setup)? | Verdict |
|---|---|---|---|
| **(a) env `CLAUDE_MEM_PROJECT_ROOT`** (+ `settings.json` key) | Explicit path; read env → `settings.json` → default, mirroring `resolveDataDir` (F6). | **Yes** — deterministic, independent of where the worker was launched. | **Primary.** |
| **(b) cwd / `git rev-parse --show-toplevel` auto-detect** | Walk up from the worker cwd for the repo root. | **No, alone** — the deployed worker's cwd is the install dir, not the repo; auto-detect returns nothing or the *wrong* repo (F4). Useful only from a source checkout. | **Fallback only.** |
| **(c) dev-only** | Resolve only from a `src/` checkout; stay off for deployed installs. | **No** — explicitly leaves Mark's deployed worker unfixed. | Rejected. |
| **(d) derive from observation `cwd`s** | The DB stores each observation's client cwd (`shared.ts:61`, `SessionManager.ts:163`); pick claude-mem's. | Ambiguous across projects; non-deterministic; picks a *project dir*, not necessarily a checkout containing `docs/`. | Rejected (over-engineered; one canonical queue makes it unnecessary). |

### 4.2 Recommendation

**Hybrid (a) authoritative + (b) zero-config fallback, both validated, memoized, and loudly-deferred when neither resolves.**

`resolveRepoRoot()` resolves in this order, returning the first candidate that **validates**:

1. `process.env.CLAUDE_MEM_PROJECT_ROOT`
2. `settings.json` `CLAUDE_MEM_PROJECT_ROOT` (inline read, mirroring `resolveDataDir`; no change to the typed `SettingsDefaults`)
3. `git rev-parse --show-toplevel` run from the worker cwd (auto-detect; serves the source-checkout dev case, implicitly covering option (c))
4. `null` → the existing loud-deferred state stands (unchanged)

**Validation (the R3 safety rule):** a candidate validates **iff** `<candidate>/docs/BUILDER_QUEUE.md` exists. `BUILDER_QUEUE.md` is the canonical roadmap file (parent spec D1) and the strongest single signal that a path is *the Mission Control repo*. This is what makes the fallback safe: run from the upstream marketplace checkout (which has no fork-only `docs/BUILDER_QUEUE.md`), auto-detect **correctly declines** and stays deferred instead of resolving upstream's tree.

**Loud on misconfiguration (R3):** if `CLAUDE_MEM_PROJECT_ROOT` is *set but does not validate* (typo, moved repo, missing `docs/BUILDER_QUEUE.md`), emit a single `logger.warn` naming the offending path and the reason, then fall through. A misconfigured root must be visible in the logs, never a silently-wrong velocity.

**Resolve once, memoize.** `MissionControlRoutes` captures the root once at construction into `this.repoRoot` (so no per-request resolution on the Attention hot path), and `resolveRepoRoot()` additionally memoizes its own result (step 3 spawns `git`; memoization protects the default-param evaluation and any other caller). Expose a `resetRepoRootCache()` for tests. A settings/env change takes effect on the next worker restart — acceptable, and consistent with how `DATA_DIR` is captured once at module load (`paths.ts:39`).

### 4.3 Why this honors the parent design's advisory/loud ethos

- **Deterministic + explicit** (D1's "one trustworthy list" temperament): an operator sets one path; the result is not guessed.
- **Graceful, labeled degradation** (R3, R5): unresolved → the *existing* `{deferred:true}` / `specMiningDeferred` states, which the UI already labels. Misconfigured → a loud WARN. Never a silent wrong tree.
- **Re-enables, doesn't rewrite** (row #24): the miner, queries, routes, and parser are untouched except for the boundary-cwd thread (§5).

### 4.4 Single canonical root is correct, not a limitation

Mark drives several agent teams, but Mission Control's **roadmap** is exactly one file — `docs/BUILDER_QUEUE.md` in the claude-mem repo (parent spec D1/D4). Velocity and spec/doc mining are *about that repo's queue*, so a single `CLAUDE_MEM_PROJECT_ROOT` is the right cardinality. (Per-project Progress/Next-steps already scope by the `project` query param, independent of repo-root.)

## 5. Correction to "one-function change": thread the root into the git/gh boundary

Per F3/F4, re-enabling velocity's **weekly series** and making PR-review mining resolve the **correct** repo requires the `git`/`gh` commands to run with `cwd = resolvedRoot`. This is a small, additive change, but it is **not** inside `resolveRepoRoot()`:

- `shell.ts`: add an optional `cwd?: string` to `runCommand` (passed straight to `Bun.spawnSync`) and to `createGitGhBoundary(cwd?)`, which closes over it for every `gh`/`git` invocation. `cwd` undefined ⇒ today's behavior (worker cwd) ⇒ **no regression** to any existing test or the shipped panes.
- `MissionControlRoutes.ts`: capture the root **once** into an injectable `repoRoot` constructor param (defaulting to `resolveRepoRoot()`), mirroring the existing optional `boundary` param, then: construct the default boundary with `createGitGhBoundary(this.repoRoot ?? undefined)`, and use `this.repoRoot` (not a per-request `resolveRepoRoot()` call) in the three handlers that branch on it (`handleVelocity`, `handleAttention`'s `specMiningDeferred`, `mineOnce`'s `specMiningEnabled`). The injectable seam makes route tests deterministic — pass `repoRoot: null` for the deferred branch or a fixture dir for the resolved branch — without touching env vars or the module-level memo. Injected test boundaries remain unaffected.

Consequence: when the root resolves, `gh pr list` and `git log --merges` operate on Mark's fork; when it doesn't, they behave exactly as today (and the panes stay in their labeled degraded/deferred states). This also upgrades the **already-shipped** PR-reviews source from "silently wrong/unavailable on deploy" to "correct," which is a strict improvement even though reviews were nominally "done" in Phase 1.

## 6. Decision — the "questions" pillar belongs to *two* slices

The parent design's "questions" source (§D6/§5.2) has two feeds:

1. **doc-Open-Questions** — mined from `## Open Questions` sections in specs/ADRs via `loadSpecFiles` + `extractOpenQuestions` (`AttentionMiner.ts:51-68,112-119`). **Repo-root-gated.** This slice re-enables it **for free** — it rides the same `specMiningEnabled = resolveRepoRoot() !== null` flag as spec-review mining (`MissionControlRoutes.ts:62`). No extra miner work.
2. **captured-`AskUserQuestion`** — the parent design's second questions feed. **Not repo-root-gated.** `AskUserQuestion` is in the default `CLAUDE_MEM_SKIP_TOOLS` (`SettingsDefaultsManager.ts:109`) and is dropped at `shared.ts:73` before capture, so it never enters the observation stream. Re-enabling repo-root does nothing for it.

**Recommendation: include doc-Open-Questions in this slice (it comes for free); split captured-`AskUserQuestion` into its own backlog row.** Reasoning:

- **Different mechanism, different blast radius.** Un-skipping `AskUserQuestion` is a change to a *shared, cross-cutting capture default* affecting **every** claude-mem user and **every** session — a capture-policy decision with volume/noise/cost implications, not a Mission-Control-local change. It does not belong bundled into a repo-root slice.
- **It isn't just "un-skip."** Even if captured, mapping an `AskUserQuestion` observation → an attention `question` item, and auto-resolving it when the question is answered, is new miner logic that doesn't exist yet.
- **The Phase 2 emit channel may be the better home.** Parent spec R6 already flags mined-question precision; `attention_raise` (Phase 2) lets an agent *declare* a pending decision with provenance, which is higher-precision than un-skipping a tool globally. So the right answer to "should captured-`AskUserQuestion` exist at all?" is genuinely open — it deserves its own decision row, not a default flip smuggled into this PR.

Filed as **Backlog #25** ("decide whether to pursue captured-`AskUserQuestion` as a questions source; if yes, its own capture + miner spec").

## 7. Components changed (this slice)

| Unit | Change | Risk |
|---|---|---|
| `repo-root.ts` | Implement `resolveRepoRoot()` (env → settings → git-toplevel → null), validate on `docs/BUILDER_QUEUE.md`, memoize, warn-on-misconfig, add `resetRepoRootCache()`. Keep `REPO_ROOT_DEFERRED_REASON` (still imported by the route). | Low — pure resolver; falls back to today's `null`. |
| `shell.ts` | Optional `cwd` on `runCommand` + `createGitGhBoundary(cwd?)`. | Low — additive; undefined ⇒ unchanged. |
| `MissionControlRoutes.ts` | Add an injectable `repoRoot` constructor param (default `resolveRepoRoot()`); store as `this.repoRoot`; use it in the three branching handlers and to build the default boundary's cwd. (Route bodies already handle resolved vs. deferred.) | Low. |
| `loadSpecFiles.ts` | **Signature only:** add optional `root` param (default `resolveRepoRoot()`) so the injected route root flows to the spec-file reads. Body unchanged. | Low. |
| `useMissionControl.ts` | Re-add `MC_VELOCITY` fetch + `velocity` state (removed in the 3-pane narrowing). | Low. |
| `MissionControl.tsx` | Re-render the Velocity pane; render a labeled note (not a broken pane) when `velocity.deferred` is true. | Low. |
| *(none)* `VelocityQuery.ts`, `AttentionMiner.ts`, `BuilderQueueParser.ts`, `constants/api.ts` | **Unchanged.** `MC_VELOCITY` already exists (`api.ts:9`); the miner already honors `specMiningEnabled`. | — |

## 8. Testing

- **`resolveRepoRoot()` (unit, `resetRepoRootCache()` between cases):**
  - env var set + valid (dir has `docs/BUILDER_QUEUE.md`) → returns it.
  - env var set + **invalid** (no `docs/BUILDER_QUEUE.md`) → returns `null` **and** logs one WARN (assert loud-not-silent).
  - env unset, `settings.json` key valid → returns it.
  - env + settings unset, git-toplevel path valid → returns it; git-toplevel invalid/absent → `null`.
  - memoization: two calls resolve the filesystem/git probe once (spy/counter).
- **`shell.ts` boundary cwd:** `runCommand(['git','rev-parse','--show-toplevel'], someRepoDir)` resolves *that* dir, not the process cwd (assert cwd is actually applied). Existing `shell.test.ts` cases still pass with `cwd` undefined (no-regression).
- **Route (`mission-control-routes.test.ts`):** constructing the route with `repoRoot` = a fixture dir containing a fixture `docs/BUILDER_QUEUE.md`, `/velocity` returns real `openCount`/`shippedCount` (not `{deferred:true}`) and `/attention` returns `specMiningDeferred:false`. With `repoRoot: null`, both keep today's deferred payloads. **Note:** the existing deferred-state route tests must be updated to pass `repoRoot: null` explicitly — otherwise the git-toplevel fallback resolves the real repo during `bun test` (whose cwd *is* a checkout containing `docs/BUILDER_QUEUE.md`) and they would flip to the resolved branch. This test-determinism need is the concrete reason for the injectable seam.
- **Velocity partial-degradation guard (the F3 correction):** with root resolved but the injected boundary's `listMergeCommits` returning `[]`, `/velocity` returns real counts and an **empty** `shippedByWeek` without error — proving counts and series have independent sources, so a git-cwd miss can't silently zero the counts.
- **UI (`mission-control-view.test.tsx`):** the Velocity pane renders when `velocity` is present; renders the deferred label (not a crash) when `velocity.deferred` is true.
- **Live UAT (Tester):** see the plan's Test Plan — drive both the resolved path (env var set → 4 panes, real velocity) and the deferred path (env var unset → 3 panes + labeled deferred notes), and confirm no write to `BUILDER_QUEUE.md` and no LLM calls.

## 9. Risks & open questions

| # | Risk / question | Disposition |
|---|---|---|
| R1 | `git rev-parse` in the auto-detect fallback spawns a process on a code path that runs at worker startup. | Memoized to a single probe per process (§4.2); `Bun.spawnSync` already has a 5s timeout (`shell.ts:11`). |
| R2 | A `CLAUDE_MEM_PROJECT_ROOT` pointed at the wrong repo (has *a* `docs/BUILDER_QUEUE.md` but not this project's) would resolve it. | Accepted: BUILDER_QUEUE.md presence is the agreed marker; a deliberately-wrong path is operator error, and velocity is advisory (D1). No stronger fingerprint added (YAGNI). |
| R3 | Worker cwd being an upstream checkout (F4) is *inferred*, not confirmed. | The explicit-cwd fix (§5) closes the risk **whether or not** the inference holds, so confirming it is not a blocker. Tester should still spot-check that resolved velocity/reviews reflect the **fork**, not upstream. |
| R4 | Settings/env change not picked up until worker restart (memoization). | Accepted + documented; matches `DATA_DIR` (`paths.ts:39`). Mark restarts the worker via `build-and-sync` anyway. |
| Q1 | Should `CLAUDE_MEM_PROJECT_ROOT` also be added to the typed `SettingsDefaults` (for settings-UI discoverability)? | Deferred — the inline read (mirroring `resolveDataDir`) keeps the slice tight and avoids touching the shared defaults type. Add later if operators want UI configurability. |
| Q2 | Captured-`AskUserQuestion` — pursue at all, or lean on the Phase 2 emit channel? | Out of scope; **Backlog #25** owns the decision (§6). |

## 10. Out of scope (YAGNI)

- No change to `CLAUDE_MEM_SKIP_TOOLS` / capture behavior (that is #25's decision, if pursued).
- No multi-root / per-project velocity (§4.4).
- No typed-`SettingsDefaults` entry for `CLAUDE_MEM_PROJECT_ROOT` in this slice (Q1).
- No Phase 2–4 work; no write toward `BUILDER_QUEUE.md`.
- No new fingerprint beyond `docs/BUILDER_QUEUE.md` for root validation (R2).

---

*Terminal state of this spec: hand to `superpowers:writing-plans` for a TDD implementation plan (`docs/superpowers/plans/2026-07-16-mission-control-repo-root.md`), then queue via row #24. Captured-`AskUserQuestion` splits to Backlog #25.*
