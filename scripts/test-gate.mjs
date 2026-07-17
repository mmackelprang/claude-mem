#!/usr/bin/env node
// scripts/test-gate.mjs — fork-only auto-gate for the unit suite.
//
//   node scripts/test-gate.mjs                     # gate the current tree (CI / auto-merge use)
//   node scripts/test-gate.mjs --update-baseline   # seed/refresh expectedFailures (under review only)
//
// Restores auto-gating despite a standing set of pre-existing, environment-specific failures
// inherited from upstream v13.11.0 (ADR 0002 §9, Backlog #6/#7). It:
//   1. excludes the file-level `nonRunnable` set (2 hangs + 1 crash-file) so the suite completes,
//   2. runs every OTHER test file in its OWN `bun test` process (isolation), under a per-file
//      wall-clock watchdog, retrying a file that produces no JUnit XML (a crash or hang),
//   3. exits non-zero on (a) a NEW failure, (b) a NEW hang/crash (a file that never completes,
//      even after retries), or (c) an UNEXPECTED PASS (a baselined test that now passes — the ratchet),
//   4. models the #35 env-conditional privacy sentinel (expected-red when
//      CLAUDE_MEM_TEST_POSTGRES_URL is unset, expected-GREEN when set).
//
// WHY per-file isolation and not one combined `bun test <all>`:
//   * A combined run intermittently panics ("We should be either stdout or stderr") in Bun 1.3.5 when
//     a test spawns a child process under --reporter=junit (~1/3 of runs), which would make the gate
//     falsely report "suite did not complete". Per-file isolation + retry contains that flake.
//   * A combined run's failing set is topology-dependent: an earlier test's `process.env = {...}`
//     reassignment replaces Windows' case-insensitive env proxy with a plain object, flipping the #6
//     spawn-contract assertions (which read `process.env.ComSpec`) from fail to pass by run order.
//     Isolation is deterministic and topology-independent, and reproduces the plan's baseline exactly.
//
// Dependency-free (node:child_process + node:fs + a tiny hand-rolled JUnit reader). No src/ change.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const BASELINE = join(ROOT, 'tests', 'known-failures.json');
const PER_TEST_MS = Number(process.env.CLAUDE_MEM_GATE_TEST_TIMEOUT_MS ?? 20000);
const FILE_WATCHDOG_MS = Number(process.env.CLAUDE_MEM_GATE_FILE_WATCHDOG_MS ?? 90000); // per-file wall clock
const OVERALL_BUDGET_MS = Number(process.env.CLAUDE_MEM_GATE_BUDGET_MS ?? 1800000); // 30 min hard cap
const MAX_ATTEMPTS = Number(process.env.CLAUDE_MEM_GATE_MAX_ATTEMPTS ?? 3); // 1 try + 2 retries on no-XML
const UPDATE = process.argv.includes('--update-baseline');

const fwd = (p) => p.replaceAll('\\', '/');

// ---------------------------------------------------------------------------
// 1. Load baseline + compute the excluded (non-runnable) set.
// ---------------------------------------------------------------------------
if (!existsSync(BASELINE)) fail(`baseline not found: ${BASELINE}`);
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const excluded = new Set((baseline.nonRunnable ?? []).map((e) => fwd(e.file)));

// Guard: every nonRunnable file must still exist (a rename/delete would silently re-admit a hang or
// leave a stale exclusion).
for (const e of baseline.nonRunnable ?? []) {
  if (!existsSync(join(ROOT, e.file))) fail(`nonRunnable file missing (renamed/deleted?): ${e.file}`);
}

// ---------------------------------------------------------------------------
// 2. Enumerate all test files, minus the excluded set.
// ---------------------------------------------------------------------------
// Match the same files `bun test` discovers by default: *.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}.
// endsWith('.test.ts') alone silently dropped tests/**/*.test.tsx (e.g. mission-control-view.test.tsx),
// leaving a real file ungated — a false-pass hole. Keep this in sync with Bun's matcher.
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
function allTestFiles(dir = join(ROOT, 'tests'), acc = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) allTestFiles(p, acc);
    else if (TEST_FILE_RE.test(d.name)) acc.push(p);
  }
  return acc;
}
const rootFwd = fwd(ROOT);
const rel = (p) => fwd(p).slice(rootFwd.length + 1);
const files = allTestFiles()
  .map(rel)
  .filter((p) => !excluded.has(p))
  .sort();

if (files.length === 0) fail('no runnable test files found under tests/');

// ---------------------------------------------------------------------------
// 3. Run each file in its own `bun test` process, under a per-file watchdog, retrying on no-XML.
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'cmem-gate-'));
// Clean up the per-run JUnit XML scratch dir on ANY exit path (success, fail(), non-completion,
// crash). Registered right after creation so every subsequent process.exit() sweeps it — otherwise
// each run leaks a cmem-gate-* dir of ~250 XML files under the OS temp dir.
process.on('exit', () => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
const startedAt = Date.now();

function runFileOnce(relPath, xmlPath) {
  return new Promise((resolve) => {
    const args = [
      'test',
      relPath,
      '--timeout',
      String(PER_TEST_MS),
      '--reporter=junit',
      `--reporter-outfile=${xmlPath}`,
    ];
    const child = spawn('bun', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let tail = '';
    const cap = (d) => {
      tail += d.toString();
      if (tail.length > 8192) tail = tail.slice(-8192); // keep only the last ~8KB for diagnostics
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, FILE_WATCHDOG_MS);
    const finish = (code) => {
      clearTimeout(watchdog);
      // A run is USABLE iff it produced a well-formed JUnit XML (closing </testsuites>), which Bun
      // writes only after every test in the file has run. This is checked REGARDLESS of the watchdog:
      // a complete XML means all tests finished and only process teardown overran (e.g. a leaked
      // handle/subprocess/timer) — that is NOT a hang, so accept the result (and flag the overrun as a
      // diagnostic). Missing or truncated XML is a genuine mid-run hang or crash ⇒ not usable ⇒ retry.
      let ok = false;
      if (existsSync(xmlPath)) {
        try {
          ok = readFileSync(xmlPath, 'utf8').includes('</testsuites>');
        } catch {
          ok = false;
        }
      }
      resolve({ ok, timedOut, code, tail });
    };
    child.on('exit', (c) => finish(c));
    child.on('error', (e) => {
      tail += `\n[spawn error] ${e.message}`;
      finish(-1);
    });
  });
}

const xmlPaths = [];
const notCompleted = []; // files that never produced a complete XML after MAX_ATTEMPTS
const retried = []; // { file, attempts } — completed, but only after >1 attempt (intermittent flake)
const overran = []; // { file } — complete XML, but the process overran the watchdog (slow exit / leak)
for (let i = 0; i < files.length; i++) {
  if (Date.now() - startedAt > OVERALL_BUDGET_MS) {
    fail(`overall time budget (${OVERALL_BUDGET_MS}ms) exceeded at file ${i + 1}/${files.length}. A file is hanging beyond expectations — raise CLAUDE_MEM_GATE_BUDGET_MS or investigate.`);
  }
  const relPath = files[i];
  const xmlPath = join(tmp, `junit-${i}.xml`);
  let result;
  let attempt = 0;
  for (attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    rmSync(xmlPath, { force: true });
    result = await runFileOnce(relPath, xmlPath);
    if (result.ok) break;
    if (attempt < MAX_ATTEMPTS) {
      console.error(
        `[test-gate] retry ${attempt}/${MAX_ATTEMPTS - 1}: ${relPath} ` +
          `(${result.timedOut ? 'hang/watchdog' : 'crash/no-xml'})`
      );
    }
  }
  if (result.ok) {
    xmlPaths.push(xmlPath);
    if (attempt > 1) retried.push({ file: relPath, attempts: attempt }); // intermittent — surface it
    if (result.timedOut) overran.push({ file: relPath }); // completed but slow-exit — surface it
  } else {
    notCompleted.push({ file: relPath, timedOut: result.timedOut, tail: result.tail });
  }
  if ((i + 1) % 25 === 0 || i + 1 === files.length) {
    console.error(`[test-gate] progress: ${i + 1}/${files.length} files (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  }
}

// ---------------------------------------------------------------------------
// 4. Any file that never completed (even after retries) => a NEW hang/crash OUTSIDE the quarantine.
// ---------------------------------------------------------------------------
if (notCompleted.length) {
  console.error('');
  console.error(
    `[test-gate] FAIL: ${notCompleted.length} file(s) did not complete after ${MAX_ATTEMPTS} attempts ` +
      `(a NEW hang or crash OUTSIDE tests/known-failures.json's nonRunnable list):`
  );
  for (const f of notCompleted) {
    console.error(`  - ${f.file} (${f.timedOut ? 'hang/watchdog' : 'crash/no-xml'})`);
    console.error(f.tail.split('\n').map((l) => `      ${l}`).join('\n'));
  }
  console.error('Fix the file, or add it to nonRunnable in tests/known-failures.json WITH a root-cause note.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 5. Parse actual results across all per-file XMLs. Key = `${file}::${name}` (forward slashes).
// ---------------------------------------------------------------------------
const { actual, collisions } = parseAllJUnit(xmlPaths);

if (collisions.length) {
  console.error('[test-gate] FAIL: ambiguous testcase keys (same file::name, differing status).');
  console.error('  The { file, name } key cannot disambiguate these — switch the affected baseline');
  console.error('  entries and the parser to file::classname::name keying:');
  for (const c of collisions) {
    console.error(`    ${c.key}  [statuses: ${c.statuses.join(', ')}; classnames: ${c.classnames.join(' | ')}]`);
  }
  process.exit(1);
}

// --update-baseline: rewrite expectedFailures from the current actual fails (excluding anything already
// covered by conditionalFailures) and exit. Seed/maintenance tool only — never in CI.
if (UPDATE) {
  rewriteBaseline(baseline, actual);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 6. Expected set = platform-filtered expectedFailures ∪ env-evaluated conditionalFailures.
// ---------------------------------------------------------------------------
const plat = process.platform;
const expected = new Set();
for (const e of baseline.expectedFailures ?? []) {
  if (!e.platforms || e.platforms.includes(plat)) expected.add(key(e.file, e.name));
}
for (const e of baseline.conditionalFailures ?? []) {
  // expectFailWhenUnset: expected-FAIL when the named var is unset; when SET we expect it to PASS
  // (so it is NOT added to `expected`, and a red there becomes a genuine new failure).
  const unset = e.expectFailWhenUnset && !process.env[e.expectFailWhenUnset];
  if (unset) expected.add(key(e.file, e.name));
}

// ---------------------------------------------------------------------------
// 7. Diff.
// ---------------------------------------------------------------------------
const actualFail = new Set([...actual].filter(([, s]) => s === 'fail').map(([k]) => k));
const newFailures = [...actualFail].filter((k) => !expected.has(k)).sort();
const unexpectedPasses = [...expected].filter((k) => !actualFail.has(k)); // baselined test no longer fails
// 8. Sanity: baseline entries that matched no testcase at all (rename/typo) vs genuinely fixed.
const ran = new Set(actual.keys());
const orphaned = unexpectedPasses.filter((k) => !ran.has(k)).sort();
const fixed = unexpectedPasses.filter((k) => ran.has(k)).sort();

// ---------------------------------------------------------------------------
// 9. Report + exit.
// ---------------------------------------------------------------------------
report({ files, actual, expected, newFailures, fixed, orphaned, retried, overran });
process.exit(newFailures.length || fixed.length || orphaned.length ? 1 : 0);

// ===========================================================================
// Helpers
// ===========================================================================
function key(f, n) {
  return `${fwd(f)}::${n}`;
}

function fail(msg) {
  console.error(`[test-gate] FAIL: ${msg}`);
  process.exit(1);
}

function unescapeXml(s) {
  // Bun double-escapes some attributes (e.g. classname ` > ` => `&amp;gt;`). Two passes collapse
  // both layers, which is sufficient for the entities Bun emits.
  const once = (t) =>
    t
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&#10;', '\n')
      .replaceAll('&#13;', '\r')
      .replaceAll('&#9;', '\t')
      .replaceAll('&amp;', '&');
  return once(once(s));
}

function getAttr(attrs, name) {
  // attrs is the raw text between `<testcase` and the closing `>`; values are double-quoted.
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}

// Parse Bun's JUnit XML into per-testcase status. A <testcase> is a FAILURE if it has a
// <failure>/<error> child, SKIP if <skipped>, else PASS. Accumulates into byKey for collision checks.
function parseJUnit(xmlText, byKey) {
  const re = /<testcase\b([^>]*)>/g;
  let m;
  while ((m = re.exec(xmlText)) !== null) {
    let attrs = m[1];
    let body = '';
    if (attrs.trimEnd().endsWith('/')) {
      // self-closing <testcase ... /> — a pass with no children.
      attrs = attrs.trimEnd().slice(0, -1);
    } else {
      const closeIdx = xmlText.indexOf('</testcase>', re.lastIndex);
      body = closeIdx === -1 ? '' : xmlText.slice(re.lastIndex, closeIdx);
    }
    const file = fwd(unescapeXml(getAttr(attrs, 'file') ?? ''));
    const name = unescapeXml(getAttr(attrs, 'name') ?? '');
    const classname = unescapeXml(getAttr(attrs, 'classname') ?? '');
    let status = 'pass';
    if (/<(failure|error)\b/.test(body)) status = 'fail';
    else if (/<skipped\b/.test(body)) status = 'skip';
    const k = key(file, name);
    if (!byKey.has(k)) byKey.set(k, { statuses: new Set(), classnames: new Set() });
    const entry = byKey.get(k);
    entry.statuses.add(status);
    entry.classnames.add(classname);
  }
}

function parseAllJUnit(xmlFilePaths) {
  const byKey = new Map();
  for (const p of xmlFilePaths) parseJUnit(readFileSync(p, 'utf8'), byKey);
  const actual = new Map();
  const collisions = [];
  for (const [k, e] of byKey) {
    if (e.statuses.size > 1) {
      collisions.push({ key: k, statuses: [...e.statuses], classnames: [...e.classnames] });
    }
    // Aggregate with fail > pass > skip precedence so a duplicate leaf name cannot let a passing
    // instance mask a failing one (collisions are also reported above and hard-fail the gate).
    const s = e.statuses.has('fail') ? 'fail' : e.statuses.has('pass') ? 'pass' : 'skip';
    actual.set(k, s);
  }
  return { actual, collisions };
}

function rewriteBaseline(base, actualMap) {
  const conditionalKeys = new Set((base.conditionalFailures ?? []).map((e) => key(e.file, e.name)));
  const prior = new Map((base.expectedFailures ?? []).map((e) => [key(e.file, e.name), e]));
  const emitted = new Set();
  const next = [];
  // 1. Carry forward prior entries this run CANNOT have exercised as expected-fail: those scoped to
  //    OTHER platforms (`platforms` defined and not including the current one). This run has no
  //    evidence about them, so preserving them verbatim prevents `--update-baseline` on one OS from
  //    silently deleting another OS's baseline entries.
  for (const [k, e] of prior) {
    if (Array.isArray(e.platforms) && !e.platforms.includes(process.platform)) {
      next.push(e);
      emitted.add(k);
    }
  }
  // 2. Emit the current run's observed failures (minus env-conditional keys), preserving existing
  //    platforms/reason where the key already existed.
  for (const [k, status] of [...actualMap].sort()) {
    if (status !== 'fail') continue;
    if (conditionalKeys.has(k)) continue; // env-conditioned; lives in conditionalFailures
    if (emitted.has(k)) continue;
    const [file, name] = splitKey(k);
    next.push(prior.has(k) ? prior.get(k) : { file, name, platforms: [process.platform], reason: 'TODO: classify' });
    emitted.add(k);
  }
  base.expectedFailures = next;
  writeFileSync(BASELINE, JSON.stringify(base, null, 2) + '\n');
  console.error(
    `[test-gate] --update-baseline: wrote ${next.length} expectedFailures to ${rel(BASELINE)}. ` +
      `Review the diff; new entries carry reason:"TODO: classify".`
  );
}

function splitKey(k) {
  const i = k.indexOf('::');
  return [k.slice(0, i), k.slice(i + 2)];
}

function report({ files, actual, expected, newFailures, fixed, orphaned, retried = [], overran = [] }) {
  const total = actual.size;
  let pass = 0;
  let failN = 0;
  let skip = 0;
  for (const s of actual.values()) {
    if (s === 'pass') pass++;
    else if (s === 'fail') failN++;
    else skip++;
  }
  console.error('');
  console.error('──────────────────────────────────────────────────────────────');
  console.error(`[test-gate] suite completed: ${files.length} files ran, ${total} testcases`);
  console.error(`            ${pass} pass · ${failN} fail · ${skip} skip`);
  console.error(`            baseline expected-fail this env/platform: ${expected.size}`);
  console.error('──────────────────────────────────────────────────────────────');

  // Advisories — do NOT affect the exit code, but must be visible (a silently-retried intermittent
  // crash or a chronic watchdog overrun is worth a human's attention even when the gate is green).
  if (retried.length) {
    console.error('');
    console.error(`⚠ NEEDED RETRIES (intermittent crash/hang — investigate) — ${retried.length}:`);
    for (const r of retried) console.error(`  ↻ ${r.file} (${r.attempts} attempts)`);
  }
  if (overran.length) {
    console.error('');
    console.error(`⚠ COMPLETED BUT OVERRAN WATCHDOG (leaked handle/slow teardown?) — ${overran.length}:`);
    for (const o of overran) console.error(`  ⏱ ${o.file}`);
  }

  if (newFailures.length) {
    console.error('');
    console.error(`NEW FAILURE (fix it, or it must not have been introduced) — ${newFailures.length}:`);
    for (const k of newFailures) console.error(`  ✗ ${k}`);
  }
  if (fixed.length) {
    console.error('');
    console.error(`FIXED — remove from tests/known-failures.json — ${fixed.length}:`);
    for (const k of fixed) console.error(`  ✓ ${k}`);
  }
  if (orphaned.length) {
    console.error('');
    console.error(`BASELINE ENTRY MATCHED NO TEST (renamed/typo?) — ${orphaned.length}:`);
    for (const k of orphaned) console.error(`  ? ${k}`);
  }

  if (!newFailures.length && !fixed.length && !orphaned.length) {
    console.error('');
    console.error('[test-gate] PASS — actual failures match the encoded baseline exactly.');
  } else {
    console.error('');
    console.error('[test-gate] FAIL — the actual failing set differs from tests/known-failures.json.');
  }
}
