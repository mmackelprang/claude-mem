# Unit — Restore test-suite health so the unit suite can auto-gate again (Backlog #7 + #6)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Make `bun test` **run to completion** and give the fork an **auto-gating** unit suite again, replacing the
hand-computed "no *new* regressions vs ~18 pre-existing failures" delta that every PR this session has ridden. Two
mechanisms, both **fork-only** (zero edits to upstream-owned files):

1. **Quarantine the 3 files that stop the suite completing** — 2 hard hangs + 1 crash-file — at the file level so a
   single-process `bun test` finishes and can emit machine-readable output.
2. **Encode the standing failures as an expected-failure baseline** (`tests/known-failures.json`) checked by a gate
   script (`scripts/test-gate.mjs`) that fails on a **new failure**, a **new hang**, *or* an **unexpected pass**, and
   models the #35 env-conditional privacy sentinel.

Design + the #6 Mark-decision: `docs/superpowers/specs/2026-07-17-test-suite-health-baseline-design.md`.

**Re-measured current state (2026-07-17, Windows 11, Bun 1.3.5, `CLAUDE_MEM_TEST_POSTGRES_URL` unset) — the
load-bearing fact.** A per-file sweep of all **253** test files (each in its own process, 75 s wall-clock +
`--timeout 20000`) classified **237 PASS, 13 FAIL-files, 2 HANG-files, 1 CRASH-file**:

- **Non-runnable (3, block completion):** `tests/services/stale-abort-controller-guard.test.ts` (HANG at bun init —
  banner only, pure file, reproduces), `tests/services/worker-shutdown-sequence.test.ts` (HANG, reproduces),
  `tests/utils/project-name.test.ts` (exit **3** — crashes the JUnit reporter so **no XML is written**; excluding just
  this file, the run cleanly exits 1 with a complete XML).
- **Standing failures: 32 failing testcases across 13 files** (per-test timeout applied). All but one are Windows-env
  or upstream-source-standard mismatches; **15 of the 16 failing/non-runnable files are byte-identical to upstream
  `f5633c1f`** (only `plugin-distribution.test.ts` is fork-owned). One of the 32 is the **#35 privacy sentinel**
  (fails when `CLAUDE_MEM_TEST_POSTGRES_URL` unset, **green** when set — the 7 Postgres integration tests report as
  `skipped`, confirmed in the XML).
- **Already fixed since the stale #7/#6 snapshots — do not re-file:** PR #21 greened `health-monitor.test.ts`
  (**21/0**) — the 4 `isPortInUse` failures **and** the 1 `HealthMonitor > honor configured worker host` test that
  #6 counted as one of its four defects. **#6 is now only the 3 `spawn-contract-windows` tests.**

**Architecture / why #6 + #7 are bundled:** they share one root cause (the suite cannot auto-gate) and one mechanism
(a fork-only baseline). #6's three tests are just three `platforms:["win32"]` entries in the same
`known-failures.json`; splitting them into a separate PR would race on the same baseline file for no benefit.

**Tech stack:** TypeScript; **Bun 1.3.5** test runner; `bun test --reporter=junit --reporter-outfile=<path>` emits
per-`<testcase>` JUnit XML with `name` / `classname` / `file` and `<failure>`/`<skipped>` children (verified). Gate
script is plain Node ESM (`scripts/*.mjs` run via `node`, matching the repo's existing `scripts/*.cjs`/`*.js`
convention). No new dependencies (JUnit XML parsed with a tiny hand-rolled reader or `parse5`/regex — no XML dep
needed; `node:child_process` + `node:fs` only).

## Global constraints

- **Fork-only, zero upstream-file edits.** Do **not** modify any `tests/**` file that is byte-identical to upstream
  `f5633c1f` and do **not** edit upstream-owned `src/`. The whole mechanism is two new fork files
  (`tests/known-failures.json`, `scripts/test-gate.mjs`) + one `package.json` script line. The *only* permitted test
  edit is the single **fork-owned** file `tests/infrastructure/plugin-distribution.test.ts` (Task 5), and only if its
  failure is a genuine fork bug; otherwise it is baselined like the rest. Confirm ownership before any edit:
  `git diff --stat f5633c1f HEAD -- <file>` empty ⇒ upstream-owned ⇒ **do not edit**.
- **Do not "fix" the environment-specific failures by editing the tests.** They pass on upstream's Linux CI; they are
  test-vs-Windows mismatches, not product bugs. Retiring them at *source* is an explicit, optional follow-up (see
  Queue), made safe by the gate's unexpected-pass ratchet.
- **The #6 fix-vs-carry choice is Mark's** (spec Decision B). The plan implements **(d) encode-as-expected-failure**
  by default (reversible in one line); if Mark picks (a)/(c), only the 3 entries change.
- **Branch + PR policy (CLAUDE.md):** branch from `main`; PR targets **`fork/main`**
  (`gh pr create --repo mmackelprang/claude-mem --base main`). **Never push `origin`** — confirm
  `git remote get-url --push origin` reads `DISABLED_UPSTREAM_DO_NOT_PUSH` before any push. One PR for this unit.
- **Do not edit `docs/BUILDER_QUEUE.md`** (coordinator owns it) or `CHANGELOG.md` (auto-generated).
- **Rebuild note:** this unit touches only `tests/`, `scripts/`, and `package.json` scripts — no `src/` bundle change.
  `npm run build-and-sync` is **not** required for correctness; run `npm run typecheck` + the gate itself instead.

---

### Task 1: Author the baseline — `tests/known-failures.json`

Encode the re-measured set. Three sections: `nonRunnable` (excluded from the run), `expectedFailures` (per-test,
platform-scoped), `conditionalFailures` (env-conditioned). IDs are `{ file, name }` where `name` is the exact
`<testcase name>` from the JUnit XML (Bun's leaf test title). The literal contents below are the measured set — the
Builder regenerates/re-verifies via Task 4's `--update-baseline` and confirms it matches this.

**Files:**
- Create: `tests/known-failures.json`

- [ ] **Step 1: write the file** exactly as below (reasons abbreviated; keep them — they are the audit trail).

```jsonc
{
  "version": 1,
  "description": "Fork-only expected-failure baseline for the unit suite. Consumed by scripts/test-gate.mjs. Restores auto-gating despite pre-existing, environment-specific failures inherited from upstream v13.11.0 (ADR 0002 §9, Backlog #6/#7). Entries are keyed by { file, exact bun testcase name }. Retire an entry ONLY when the gate reports it as an 'unexpected pass' (the test now passes). Re-measured 2026-07-17 on Windows 11 / Bun 1.3.5.",
  "nonRunnable": [
    { "file": "tests/services/stale-abort-controller-guard.test.ts", "kind": "hang", "reason": "Hangs during bun initialization (banner only, no file header); pure file, reproduces in isolation. Excluded so the suite completes. Root-cause investigation deferred (see Queue follow-up)." },
    { "file": "tests/services/worker-shutdown-sequence.test.ts", "kind": "hang", "reason": "Hangs (pass=0/fail=0, 75s), reproduces in isolation. Excluded so the suite completes." },
    { "file": "tests/utils/project-name.test.ts", "kind": "crash-exit3", "reason": "bun exits code 3 and the JUnit reporter never writes its XML, breaking the gate for the whole run. Underlying failures are Windows-path artifacts in the test's own expected-value logic (home.split('/') on C:\\Users\\...). Excluded so the reporter emits output." }
  ],
  "expectedFailures": [
    { "file": "tests/services/integrations/spawn-contract-windows.test.ts", "name": "shared spawn wrapper wraps .cmd shims with cmd.exe and windowsHide", "platforms": ["win32"], "reason": "#6 upstream-owned: toBe('cmd.exe') vs spawn.ts:74 ComSpec absolute path. Mark decision (spec B): default (d) baseline; consider (b) upstream the fix." },
    { "file": "tests/services/integrations/spawn-contract-windows.test.ts", "name": "wraps .cmd shims with cmd.exe /d /s /c and one quoted command string without shell:true", "platforms": ["win32"], "reason": "#6 upstream-owned ComSpec." },
    { "file": "tests/services/integrations/spawn-contract-windows.test.ts", "name": "wraps the codex.cmd fallback with cmd.exe /d /s /c without shell:true", "platforms": ["win32"], "reason": "#6 upstream-owned ComSpec." },
    { "file": "tests/infrastructure/cleanup-v12_4_3.test.ts", "name": "purges observer-sessions and stuck pending_messages, writes marker, wipes chroma", "platforms": ["win32"], "reason": "afterEach rmSync EBUSY — open SQLite handle not released before delete (Windows lock). Upstream-owned." },
    { "file": "tests/infrastructure/cleanup-v12_4_3.test.ts", "name": "preserves pending_messages when stuck count is below the threshold of 10", "platforms": ["win32"], "reason": "EBUSY rmSync teardown (Windows). Upstream-owned." },
    { "file": "tests/infrastructure/cleanup-v12_4_3.test.ts", "name": "is idempotent: a second invocation does no work and does not create a second backup", "platforms": ["win32"], "reason": "EBUSY rmSync teardown (Windows). Upstream-owned." },
    { "file": "tests/infrastructure/cleanup-v12_4_3.test.ts", "name": "proceeds with cleanup when statfsSync returns non-credible values (Bun darwin-x64 #31133)", "platforms": ["win32"], "reason": "EBUSY rmSync teardown (Windows). Upstream-owned." },
    { "file": "tests/infrastructure/cleanup-v12_4_3.test.ts", "name": "honors CLAUDE_MEM_SKIP_CLEANUP_V12_4_3=1 by exiting without writing the marker", "platforms": ["win32"], "reason": "EBUSY rmSync teardown (Windows). Upstream-owned." },
    { "file": "tests/utils/claude-md-utils.test.ts", "name": "should resolve relative paths using projectRoot", "platforms": ["win32"], "reason": "relative-path resolution via OS separator. Upstream-owned." },
    { "file": "tests/utils/claude-md-utils.test.ts", "name": "should handle projectRoot with trailing slash correctly", "platforms": ["win32"], "reason": "Windows path separators. Upstream-owned." },
    { "file": "tests/utils/claude-md-utils.test.ts", "name": "should deduplicate relative paths from same folder with projectRoot", "platforms": ["win32"], "reason": "Windows path separators. Upstream-owned." },
    { "file": "tests/utils/claude-md-utils.test.ts", "name": "should handle empty string paths gracefully with projectRoot", "platforms": ["win32"], "reason": "Windows path separators. Upstream-owned." },
    { "file": "tests/utils/claude-md-utils.test.ts", "name": "should process other folders even when one has active CLAUDE.md", "platforms": ["win32"], "reason": "issue #859 folder handling, Windows paths. Upstream-owned." },
    { "file": "tests/utils/claude-md-utils.test.ts", "name": "should skip only the specific folder containing active CLAUDE.md", "platforms": ["win32"], "reason": "issue #859 folder handling, Windows paths. Upstream-owned." },
    { "file": "tests/utils/claude-md-utils.test.ts", "name": "should skip folder when either CLAUDE.md or CLAUDE.local.md was read", "platforms": ["win32"], "reason": "CLAUDE.local.md folder handling, Windows paths. Upstream-owned." },
    { "file": "tests/transcripts/cursor-extraction.test.ts", "name": "derives transcriptPath from cwd + conversation_id when the file exists (Bug A regression)", "platforms": ["win32"], "reason": "deriveCursorTranscriptPath path derivation uses \\ on Windows. Upstream-owned." },
    { "file": "tests/transcripts/cursor-extraction.test.ts", "name": "returns transcriptPath: undefined when the file does not exist", "platforms": ["win32"], "reason": "Windows path derivation. Upstream-owned." },
    { "file": "tests/transcripts/cursor-extraction.test.ts", "name": "returns undefined when sessionId is missing (deriveCursorTranscriptPath direct call)", "platforms": ["win32"], "reason": "Windows path derivation. Upstream-owned." },
    { "file": "tests/transcripts/cursor-extraction.test.ts", "name": "returns undefined when cwd is missing (deriveCursorTranscriptPath direct call)", "platforms": ["win32"], "reason": "Windows path derivation. Upstream-owned." },
    { "file": "tests/shared/timeline-formatting.test.ts", "name": "should return first modified file as relative path", "platforms": ["win32"], "reason": "extractFirstFile relative-path computation (Windows separators). Upstream-owned." },
    { "file": "tests/shared/timeline-formatting.test.ts", "name": "should return relative path (not absolute) for files inside cwd", "platforms": ["win32"], "reason": "extractFirstFile relative-path (Windows). Upstream-owned." },
    { "file": "tests/shared/find-claude-executable.test.ts", "name": "falls back to known install locations when PATH has no claude", "platforms": ["win32"], "reason": "Windows install-location fallback differs from fixture. Upstream-owned." },
    { "file": "tests/infrastructure/process-manager.test.ts", "name": "should look up Bun on non-Windows when caller is Node (e.g. MCP server)", "platforms": ["win32"], "reason": "resolveWorkerRuntimePath path.join yields \\ on Windows; injected pathExists matches only the / string. Upstream-owned." },
    { "file": "tests/write-json-file-atomic.test.ts", "name": "preserves the destination file mode when the file already exists", "platforms": ["win32"], "reason": "expect(mode).toBe(0o600) — Windows does not represent POSIX mode. Upstream-owned." },
    { "file": "tests/services/sync/chroma-mcp-manager-singleton.test.ts", "name": "kills the prior subprocess tree before a reconnect spawn", "platforms": ["win32"], "reason": "killProcessTree spy does not intercept (killTreeCalls stays []); same mock-does-not-intercept class as PR #21's net.createServer. Also slow. Upstream-owned." },
    { "file": "tests/services/sync/chroma-mcp-manager-singleton.test.ts", "name": "stop() disposes state including any pending connecting promise", "platforms": ["win32"], "reason": "killProcessTree spy interception (Windows/Bun). Upstream-owned." },
    { "file": "tests/services/sync/chroma-mcp-manager-singleton.test.ts", "name": "stop() during a hanging prewarm does not record uvx unavailable or apply reconnect backoff", "platforms": ["win32"], "reason": "killProcessTree spy interception (Windows/Bun). Upstream-owned." },
    { "file": "tests/services/sync/chroma-mcp-manager-singleton.test.ts", "name": "uses the configured prewarm timeout before constructing transport and kills the prewarm tree", "platforms": ["win32"], "reason": "killProcessTree spy interception (Windows/Bun). Upstream-owned." },
    { "file": "tests/logger-usage-standards.test.ts", "name": "should NOT use console.log/console.error (these logs are invisible in background services)", "reason": "PLATFORM-INDEPENDENT source-standard assertion: 26 upstream-owned src files use console.log outside src/hooks/. Fixing = editing 26 upstream files; out of scope. Red on Linux too." },
    { "file": "tests/hook-lifecycle.test.ts", "name": "routes all IO through hook-io.ts and no longer blanket-swallows stderr", "reason": "PLATFORM-INDEPENDENT source-standard assertion (hookCommand stderr discipline). Upstream source. Red on Linux too." },
    { "file": "tests/infrastructure/plugin-distribution.test.ts", "name": "resolves _P from the cache directory when CLAUDE_PLUGIN_ROOT is unset", "platforms": ["win32"], "reason": "FORK-OWNED (Rule-A shell resolution). Baselined provisionally; Task 5 decides fix-at-source vs keep this entry." }
  ],
  "conditionalFailures": [
    { "file": "tests/server/runtime/server-session-runtime.test.ts", "name": "the R2 summary-lane privacy net (markPrivateSession) actually executed this run", "expectFailWhenUnset": "CLAUDE_MEM_TEST_POSTGRES_URL", "reason": "#35 privacy sentinel (PR #37): intentional red when the URL is unset (7 Postgres integration tests skip); green when set (they run). Env-conditional by design — must NOT be hard-failed." }
  ]
}
```

> The `expectedFailures` list is **31 entries** (32 measured failing testcases minus the 1 sentinel, which moves to
> `conditionalFailures`). `plugin-distribution` is included provisionally; Task 5 may remove it (fix-at-source).

---

### Task 2: Implement the gate — `scripts/test-gate.mjs`

The runner that excludes `nonRunnable`, runs the rest to completion under a watchdog, diffs actual-vs-expected, and
exits non-zero on any of: a new failure, a new hang (watchdog), or an unexpected pass.

**Files:**
- Create: `scripts/test-gate.mjs`

- [ ] **Step 1: write the script.** Behaviour spec (implement faithfully; the code below is the reference shape):

```js
// scripts/test-gate.mjs — fork-only auto-gate. `node scripts/test-gate.mjs [--update-baseline]`.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, tmpdir as _t } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const BASELINE = join(ROOT, 'tests', 'known-failures.json');
const PER_TEST_MS = Number(process.env.CLAUDE_MEM_GATE_TEST_TIMEOUT_MS ?? 20000);
const WATCHDOG_MS = Number(process.env.CLAUDE_MEM_GATE_WATCHDOG_MS ?? 300000); // 5 min
const UPDATE = process.argv.includes('--update-baseline');

// 1. Load baseline + compute the excluded (non-runnable) set.
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const excluded = new Set((baseline.nonRunnable ?? []).map(e => e.file.replaceAll('\\', '/')));

// 2. Enumerate all test files, minus excluded.
function allTestFiles(dir = join(ROOT, 'tests'), acc = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) allTestFiles(p, acc);
    else if (d.name.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}
const rel = p => p.replaceAll('\\', '/').slice(ROOT.replaceAll('\\', '/').length + 1);
const files = allTestFiles().filter(p => !excluded.has(rel(p)));

// Guard: every nonRunnable + baseline file must still exist (catch renames).
for (const e of baseline.nonRunnable ?? []) if (!existsSync(join(ROOT, e.file))) fail(`nonRunnable file missing: ${e.file}`);

// 3. Run bun test on the file list with JUnit output, under a wall-clock watchdog.
//    NOTE: if the joined argv risks the Windows command-line limit (~32k chars),
//    shard by top-level tests/<dir> and merge the per-shard XMLs (see Step 2).
const xml = join(mkdtempSync(join(tmpdir(), 'cmem-gate-')), 'junit.xml');
const child = spawn('bun', ['test', ...files.map(rel), `--timeout`, String(PER_TEST_MS),
  '--reporter=junit', `--reporter-outfile=${xml}`], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
const watchdog = setTimeout(() => { child.kill('SIGKILL'); }, WATCHDOG_MS);
const code = await new Promise(res => child.on('exit', c => res(c)));
clearTimeout(watchdog);

// 4. Watchdog fired OR no XML => the suite did not complete: a NEW hang outside the quarantine.
if (!existsSync(xml)) fail(
  `Suite did not complete (no JUnit XML). A NEW hang or crash exists OUTSIDE tests/known-failures.json's ` +
  `nonRunnable list. Identify it (per-file sweep) and either fix it or add it to nonRunnable WITH a root-cause note.`);

// 5. Parse actual results. Minimal JUnit reader: match <testcase ...> ... </testcase> or self-closing,
//    a <failure/error> child => fail; <skipped/> => skip; else pass. Key = `${file}::${name}`.
const actual = parseJUnit(readFileSync(xml, 'utf8')); // -> Map<key, 'pass'|'fail'|'skip'>, key uses forward slashes

// --update-baseline: rewrite expectedFailures from the current actual fails (excluding conditional) and exit.
if (UPDATE) { rewriteBaseline(baseline, actual); process.exit(0); }

// 6. Expected set = platform-filtered expectedFailures ∪ env-evaluated conditionalFailures.
const plat = process.platform;
const expected = new Set();
for (const e of baseline.expectedFailures ?? [])
  if (!e.platforms || e.platforms.includes(plat)) expected.add(key(e.file, e.name));
for (const e of baseline.conditionalFailures ?? []) {
  const unset = e.expectFailWhenUnset && !process.env[e.expectFailWhenUnset];
  if (unset) expected.add(key(e.file, e.name)); // expected-fail; when SET we expect it to PASS (not in `expected`)
}

// 7. Diff.
const actualFail = new Set([...actual].filter(([, s]) => s === 'fail').map(([k]) => k));
const newFailures = [...actualFail].filter(k => !expected.has(k));
const unexpectedPasses = [...expected].filter(k => !actualFail.has(k)); // baselined test that no longer fails
// 8. Sanity: baseline entries that matched no testcase at all (rename/typo).
const ran = new Set(actual.keys());
const orphaned = [...expected].filter(k => !ran.has(k));

// 9. Report + exit.
report({ newFailures, unexpectedPasses, orphaned });
process.exit(newFailures.length || unexpectedPasses.length || orphaned.length ? 1 : 0);

function key(f, n) { return `${f.replaceAll('\\', '/')}::${n}`; }
function fail(msg) { console.error(`[test-gate] FAIL: ${msg}`); process.exit(1); }
// parseJUnit / rewriteBaseline / report: implement per Step 2–3.
```

- [ ] **Step 2: `parseJUnit`.** Bun's XML nests `<testsuite>`; iterate every `<testcase ...>`. A testcase is a
  **failure** if it contains a `<failure` or `<error` child, **skip** if `<skipped`, else **pass**. Use the
  `file="..."` and `name="..."` attributes (both present — verified); normalise `file` to forward slashes; unescape XML
  entities (`&amp;gt;` etc.) in `name`. A dependency-free regex/stream reader is sufficient (no XML lib); or use the
  already-present `parse5` devDependency. Key = `` `${file}::${name}` ``. Handle duplicate leaf names across different
  `classname`s by keying on `file::name` — if a real collision exists (same file, same leaf name, different describe),
  fall back to `file::classname::name`; none exists in the current set (verified), but code defensively.

- [ ] **Step 3: `rewriteBaseline` + `report`.**
  - `rewriteBaseline`: replace `expectedFailures` with the current `actualFail` set minus any key already covered by
    `conditionalFailures`, preserving existing `platforms`/`reason` where the key matches; new keys get
    `platforms:[process.platform]` and `reason:"TODO: classify"`. Write back with 2-space indent. **This is a
    seed/maintenance tool, used under review — never in CI.**
  - `report`: print three labelled blocks. New failures → "NEW FAILURE (fix it, or it must not have been introduced)".
    Unexpected passes → "FIXED — remove from tests/known-failures.json: <key>". Orphaned → "baseline entry matched no
    test (renamed/typo?): <key>". Keep messages self-documenting (they are what a Builder reads on a red gate).

- [ ] **Step 4: command-line-length guard.** ~250 file paths (~12 KB) is under the Windows ~32 KB argv limit, so a
  single `bun test <files>` invocation is fine today. Add a guard: if `files.map(rel).join(' ').length > 24000`, shard
  by top-level `tests/<dir>` (one `bun test` per shard, each with its own JUnit outfile) and concatenate the parsed
  results. Keep the watchdog per-shard **and** an overall budget.

---

### Task 3: Wire the gate into `package.json`

**Files:**
- Edit: `package.json` (scripts block only)

- [ ] **Step 1:** add one script (leave `"test": "bun test"` untouched — the raw runner stays available):

```jsonc
"test:gate": "node scripts/test-gate.mjs",
"test:gate:update": "node scripts/test-gate.mjs --update-baseline",
```

- [ ] **Step 2:** add a short note to `CLAUDE.md`'s Build section (fork-owned file — safe to edit) pointing auto-merge
  gate 2 at `npm run test:gate` and explaining that `tests/known-failures.json` encodes the standing Windows/upstream
  failures; a red gate means a *new* failure, a *new* hang, or a *fixed* baselined test (remove its entry).

---

### Task 4: Seed + self-verify the baseline

- [ ] **Step 1:** run `npm run test:gate:update` once to regenerate `expectedFailures` from the live run, then **diff
  against Task 1's hand-written file**. They must match (modulo `reason` text). Any discrepancy means the measurement
  drifted — reconcile before proceeding (do not blindly accept the generated file; the hand-written reasons are the
  audit trail).
- [ ] **Step 2:** run `npm run test:gate` on the clean tree → **exit 0**, and its log shows the suite **ran to
  completion** (JUnit XML produced) with the 3 `nonRunnable` files excluded and every standing failure matched.

---

### Task 5: Triage the one fork-owned failure — `plugin-distribution.test.ts`

`resolves _P from the cache directory when CLAUDE_PLUGIN_ROOT is unset` is the **only** failing test in a fork-owned
file (the fork maintains this file per Queue #1/#11's `.cjs`/shell-resolution work). Because it is fork-owned, fixing
it adds **no** divergence.

- [ ] **Step 1: characterise.** Run `bun test tests/infrastructure/plugin-distribution.test.ts -t "resolves _P from the
  cache directory"` and read the assertion. Decide: (i) genuine fork bug in the Rule-A shell-resolution template
  (`src/build/hook-shell-template.ts`) or the test's Windows path expectation → **fix at source** and **remove** the
  `plugin-distribution` entry from `known-failures.json`; or (ii) an irreducible Windows-env expectation → **keep** the
  baseline entry (it is fork-owned, so the entry carries no divergence cost) and note why.
- [ ] **Step 2:** whichever path, re-run `npm run test:gate` → exit 0 (if fixed, the entry is gone and the gate must
  not report an orphaned/unexpected-pass; if kept, it stays matched).

---

### Task 6: Typecheck + final gate

- [ ] **Step 1:** `npm run typecheck` → no new errors (the gate is `.mjs`/Node, not in the TS project, but confirm no
  incidental breakage).
- [ ] **Step 2:** run the three Verification proofs below and capture output for the PR.

## Verification (before opening the PR)

- [ ] **(1) The suite runs to completion + the gate passes on a clean tree.** With `CLAUDE_MEM_TEST_POSTGRES_URL`
  **unset** (default dev box), `npm run test:gate` **exits 0**. Its log proves completion: the JUnit XML exists, the 3
  `nonRunnable` files are excluded, all 31 platform-matched `expectedFailures` + the sentinel `conditionalFailure` are
  matched, and there are **zero** new failures / unexpected passes / orphans. Contrast: raw `bun test` on this box
  never completes (hangs on `stale-abort` / `worker-shutdown`).
- [ ] **(2) A fake NEW failure trips the gate.** Temporarily add `expect(true).toBe(false)` to any currently-passing
  test (e.g. `tests/json-utils.test.ts`), run `npm run test:gate` → **exit 1**, output names that test under **NEW
  FAILURE**. Revert.
- [ ] **(3) An unexpected PASS trips the gate + the env-conditional path works.**
  - Add a bogus `expectedFailures` entry pointing at a known-passing test (e.g. `tests/json-utils.test.ts` :: a real
    passing case). Run the gate → **exit 1**, output says **FIXED — remove from tests/known-failures.json** for that
    key. Revert.
  - Set `CLAUDE_MEM_TEST_POSTGRES_URL` to a throwaway scratch Postgres (per the #35 plan's pattern — a disposable DB on
    `:37778`, never real tables). Run the gate → the sentinel `conditionalFailure` flips to **expected-pass**, the 7
    Postgres integration tests **run** (not skip), and the gate stays **green** (or names a genuine new failure if one
    exists). Unset again → sentinel back to expected-fail, still green. This proves the #35 model.
- [ ] **No upstream-owned file edited.** `git diff --name-only f5633c1f HEAD -- tests/ src/` shows **only**
  `tests/known-failures.json` (new) and, if Task 5 chose fix-at-source, `tests/infrastructure/plugin-distribution.test.ts`
  (fork-owned) + its `src/build/hook-shell-template.ts` target — nothing byte-identical-to-upstream is touched.
- [ ] **Typecheck clean.** No `src/` bundle change; `npm run build-and-sync` not required.

### Test Plan (live UAT — for the Tester)

No running-app UI surface — this is test-infrastructure. UAT = the three gate proofs above, captured as terminal
output: (1) `test:gate` green + a completion log on a clean tree; (2) `test:gate` red naming an injected new failure;
(3) `test:gate` red naming an injected unexpected pass, then green with `CLAUDE_MEM_TEST_POSTGRES_URL` set (sentinel
flips, 7 integration tests run). No billed provider calls; the only live dependency is the optional throwaway Postgres
for proof (3), which must be a disposable scratch DB.

## Cross-references

- Design + the #6 Mark-decision: `docs/superpowers/specs/2026-07-17-test-suite-health-baseline-design.md`.
- Findings: `docs/BUILDER_QUEUE.md` Backlog #6 (upstream test defects — now re-scoped to 3), #7 (pre-existing failures
  / auto-gate); Backlog #10 (the Windows spawn ComSpec watch-item — same surface as #6).
- Already-shipped context: PR #21 (Queue ~~17~~) greened HealthMonitor (retired the 4th #6 defect + 4 of #7's cluster);
  PR #37 (Queue ~~35~~) added the #35 privacy sentinel the baseline models as env-conditional.
- Divergence cost basis: ADR 0002 §9 (`docs/architecture/decisions/2026-07-14-upstream-v13.11.0-fork-merge.md`) —
  "upstreaming our fixes so they stop being divergence … is explicitly excluded"; the reason editing the 15
  upstream-identical files is rejected.

## Queue

**The coordinator files the `docs/BUILDER_QUEUE.md` row(s).** Do not edit `docs/BUILDER_QUEUE.md`. Proposed shape
(rationale in the report): a **core row #37** — "[test-health] Restore auto-gating: quarantine the 2 hangs + 1
crash-file, add `tests/known-failures.json` + `scripts/test-gate.mjs`, decide #6 (Mark)" — self-contained, unblocks the
auto-merge gate. Optional follow-ups: **#38** (deps #37) "retire baseline entries at source / upstream the #6
spawn-contract fix — the gate's unexpected-pass ratchet proves each removal", and **#39** (deps #37) "root-cause the 2
hangs (esp. the `stale-abort` bun-init hang)". #37 alone restores the gate; #38/#39 shrink the baseline over time.
