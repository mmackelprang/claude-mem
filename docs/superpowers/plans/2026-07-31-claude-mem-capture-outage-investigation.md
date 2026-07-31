# Unit — Investigate the claude-mem observation-capture outage (Queue #41)

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:systematic-debugging`. This is a **diagnostic** plan —
> it produces a proven root cause, **not** a patch. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Determine whether `claude-mem` observation capture is actually broken, and if so why — with evidence, not
inference. **Ship no production code from this row.** A confirmed cause earns its own queue row with its own plan.

Design, full evidence trail, and the four corrections to the original report:
`docs/superpowers/specs/2026-07-31-claude-mem-capture-outage-investigation-design.md`.

---

## Read this first — three things that will mislead you

1. **The 11-day gap is mostly a work stoppage, not an outage.** Commits: Jul 16 = 85, Jul 17 = 34, Jul 18 = 2, then
   **zero until Jul 31**. Observations: Jul 16 = 439, Jul 17 = 451, Jul 18 = 5, Jul 19 = 1, then zero. Same curve.
   There was no claude-mem work to capture. Do not treat 11 days as 11 days of failure.
2. **The evidence base is one session.** Only two claude-mem summaries exist after the cutoff (Jul 20, Jul 30), and
   logs survive only for Jul 30–31. n = 1.
3. **Capture is dead *right now*, for every project, and that is the real lead.** Nothing has been written to
   `observations`, `session_summaries`, `sdk_sessions` or `user_prompts` since `2026-07-30T23:49:02Z`, despite a long
   tool-heavy claude-mem session today. Today's log has zero `[HOOK]`/`[SESSION]`/`[SDK]`/`[PARSER]` lines (yesterday:
   31/17/24/24). Yet the worker is healthy and the hook's plugin-root resolution is clean. **Investigate the
   reproducible present, not the unrecoverable past.**

4. **The logs the report quotes were written by a different worker than the one owning the database.** The whole
   Jul-30 log is plugin **13.12.4 on port 37700**; the DB's rows are `worker_port` 37777 or NULL, never 37700. That
   cache directory has since been deleted and the box **downgraded to 13.11.0** on the Jul-30 evening. This is
   hypothesis **H5** and it is the strongest lead — test it first (Phase 1a).

**Three claims from the original report are dead — do not spend time on them.**
- The `sdk_sessions` "4 vs 85" comparison: a row is **one Claude Code conversation** (upsert on
  `(platform_source, content_session_id)`, `SessionStore.ts:1953-1958`). Four rows = four conversations, which
  *corroborates* the work stoppage. (The 93.6% non-join I first measured is because `memory_session_id` is a single
  **overwritten** column, `SessionStore.ts:1567-1578` — not because rows are missing.)
- "claude-mem runs a different build": refuted. Hooks contain **zero** `$PWD` tokens (the cwd candidates are MCP-only,
  `hook-shell-template.ts:116-121`), and the working tree, cache and marketplace roots are currently byte-identical.
- "`hasGenerator=false` is the smoking gun": no. `hasGenerator` and `queueDepth` (`SessionManager.ts:140-141`) are
  **hardcoded literals** with zero diagnostic value. The real signal is `Generator auto-starting (…)`
  (`SessionRoutes.ts:155-159`), which **is** present in the Jul-30 log.

## Global constraints

- **Read-only until a cause is proven.** No production code, no config edits, no worker restarts except where a step
  says so.
- **Never invoke a capture hook manually.** It would write to Mark's live DB and pollute the dataset under analysis.
- **Do not touch `plugin/*`.** Four artifacts are intentionally dirty; do not revert, rebuild or commit them.
- **`sqlite3` is NOT installed on this box.** Query via `bun:sqlite` (Phase 0 supplies a reusable script).
- **Schema gotchas:** `created_at` is ISO-8601 **TEXT** — `created_at/1000` coerces to 1970; use `substr(created_at,1,10)`.
  `user_prompts` has no `project` column; `session_summaries` has no `title` column. There is no `agent_events` table.
- **Logs are local time (UTC−4); the DB is UTC.** A 4-hour offset has already caused one mis-correlation in this
  investigation.

---

### Phase 0: Preserve the evidence — BEFORE anything else

Only two log files exist and no retention code was found in `src/`. Today's file is the sole record of the live
failure, and a worker restart may rotate or overwrite it.

- [ ] Snapshot logs and DB state to a scratch dir **outside** the repo:

```bash
SNAP=~/claude-mem-outage-snapshot-$(date +%Y%m%d-%H%M%S)
mkdir -p "$SNAP"
cp -a ~/.claude-mem/logs/. "$SNAP/logs/"
cp -a ~/.claude-mem/settings.json "$SNAP/claude-mem-settings.json"
cp -a ~/.claude/settings.json "$SNAP/claude-settings.json"
ls -la --time-style=full-iso ~/.claude-mem/ > "$SNAP/datadir-listing.txt"
curl -s http://127.0.0.1:37777/api/health > "$SNAP/health.json"
ps -eo pid,ppid,pgid,lstart,rss,args > "$SNAP/ps.txt"
echo "$SNAP"
```

- [ ] Create the reusable query script (`sqlite3` is unavailable):

```bash
cat > /tmp/cm-query.ts <<'EOF'
import { Database } from 'bun:sqlite';
const db = new Database(process.env.HOME + '/.claude-mem/claude-mem.db', { readonly: true });
const sql = process.argv.slice(2).join(' ');
for (const row of db.query(sql).all() as any[]) console.log(JSON.stringify(row));
EOF
```

- [ ] Record the **baseline watermark** — every later step compares against this:

```bash
bun /tmp/cm-query.ts "
  SELECT 'observations' t, COUNT(*) n, MAX(created_at) latest FROM observations
  UNION ALL SELECT 'summaries', COUNT(*), MAX(created_at) FROM session_summaries
  UNION ALL SELECT 'sdk_sessions', COUNT(*), MAX(started_at) FROM sdk_sessions
  UNION ALL SELECT 'user_prompts', COUNT(*), MAX(created_at) FROM user_prompts
" | tee "$SNAP/baseline-watermark.txt"
```

Expected baseline (as measured 2026-07-31): observations 13,271 / `2026-07-30T23:49:02.638Z`; summaries 1,164 /
`23:46:14.325Z`; sdk_sessions 123 / `23:10:41.204Z`; user_prompts 593 / `23:38:02Z`.

- [ ] **Verify WAL visibility** — a read-only connection that misses the WAL would fake a "no new rows" result and
      invalidate every subsequent step:

```bash
bun /tmp/cm-query.ts "PRAGMA journal_mode"   # must print wal
ls -la --time-style=+%H:%M:%S ~/.claude-mem/claude-mem.db-wal
```

---

### Phase 1a — H5: the version/port split-brain check (RUN FIRST; ~2 minutes, read-only)

Cheapest possible test of the strongest hypothesis. If the hook layer and the running worker disagree about
version or port, nothing downstream matters.

- [ ] Establish which worker the hooks would reach, and which is actually listening:

```bash
ls -la ~/.claude/plugins/cache/thedotmack/claude-mem/          # expect ONLY 13.11.0; note mtimes
(ss -tlnp 2>/dev/null || netstat -tlnp) | grep -E '3770|3777'  # expect one listener
cat ~/.claude-mem/worker.pid
curl -s http://127.0.0.1:37777/api/health | head -c 400
curl -s -m 2 http://127.0.0.1:37700/api/health || echo "37700: nothing listening (expected)"
grep -ac '13\.12\.4\|37700' ~/.claude-mem/logs/*.log
```

- [ ] Establish which port the hooks are configured to POST to, and confirm it matches the listener:

```bash
grep -iE 'port|WORKER_PORT' ~/.claude-mem/settings.json
grep -oE 'CLAUDE_MEM_[A-Z_]*PORT[^,}]*' ~/.claude/plugins/cache/thedotmack/claude-mem/13.11.0/hooks/hooks.json | head
```

- [ ] Cross-check the DB fingerprint (§9a′ in the spec):

```bash
bun /tmp/cm-query.ts "SELECT worker_port, status, COUNT(*) n FROM sdk_sessions GROUP BY worker_port, status"
```

- [ ] **Classify.** A hook/worker port or version mismatch → **H5 confirmed**, go to Phase 3 Branch D and skip E1/E2.
      Everything agrees → H5 is not the *current* cause; continue to Phase 1b. Either way, record why 13.12.4 was
      removed (spec §9g) — if it can recur, it will.

### Phase 1b — E1: the project control (~5 minutes)

**This step can invalidate the entire premise of the row, so it precedes everything.** Only claude-mem sessions have
run today, so "capture is dead" is equally consistent with a claude-mem-specific fault and a global regression.

- [ ] Open a Claude Code session in a **different** project (e.g. `~/prj/RTest` — it has prior successful capture).
- [ ] Issue **one** user prompt and make **one** tool call (e.g. ask it to read a file). Keep it trivial.
- [ ] Do **not** run `build-and-sync`. Do **not** restart the worker.
- [ ] End the session normally.
- [ ] Measure — did any hook fire at all?

```bash
bun /tmp/cm-query.ts "SELECT id, substr(created_at,1,19) t FROM user_prompts ORDER BY id DESC LIMIT 5"
grep -c '\[HOOK' ~/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log
grep -ahE '\[(HOOK|SESSION|SDK|PARSER|QUEUE)' ~/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log | tail -20
```

- [ ] **Classify against the pre-registered table and STOP at the branch point.**

| E1 outcome | Meaning | Next |
|---|---|---|
| `user_prompts` gains a row **and** `[HOOK]` lines appear | Hooks work globally; today's claude-mem silence is project-specific or session-specific | → Phase 2 |
| **No** new `user_prompts` row and **no** `[HOOK]` lines | **GLOBAL hook failure — the row is mis-scoped.** claude-mem is not special | → Phase 3 (highest priority; re-scope) |

---

### Phase 2 — E2: the claude-mem experiment, restart variable held fixed

Only run this if E1 showed hooks working elsewhere.

- [ ] Work a normal, tool-heavy `claude-mem` session — real edits and reads, several prompts, ≥10 minutes.
- [ ] **Do not run `npm run build-and-sync`** and do not restart the worker at any point. This is the whole point of
      the experiment; a single restart voids it.
- [ ] End the session normally.
- [ ] Measure:

```bash
bun /tmp/cm-query.ts "
  SELECT substr(created_at,1,19) t, substr(memory_session_id,1,8) msid
  FROM observations WHERE project='claude-mem' ORDER BY created_at DESC LIMIT 10"
bun /tmp/cm-query.ts "
  SELECT id, substr(created_at,1,19) t FROM session_summaries
  WHERE project='claude-mem' ORDER BY id DESC LIMIT 5"
```

- [ ] Classify:

| E2 outcome | Conclusion | Next |
|---|---|---|
| New claude-mem observations land | Capture is **healthy**; the Jul-19 gap was the work stoppage | → Phase 4, **close as no-bug** |
| Summary lands, **zero** observations | Genuine claude-mem-specific observation failure | → Phase 3 (H4 pivot) |
| Neither lands | Hooks died again mid-experiment | → Phase 3, and re-run E1 to re-check globality |

- [ ] **E3 (only if E2 produced observations):** repeat E2 but run `npm run build-and-sync` mid-session. If
      observations vanish, **H1 is confirmed** — the worker restart destroys in-flight observation work. Cross-link
      Queue #40: the same `performGracefulShutdown` chain proven there to abort at step 1 (forfeiting steps 2–6) is
      the prime suspect for dropping session state too.

---

### Phase 3 — Branch investigation (only reached on a confirmed failure)

Pick the branch the classification tables selected. **Do not run all three.**

- [ ] **Branch A — global hook failure (from E1).** Re-scope the row; this is not a claude-mem bug. Investigate:
  - The change-point: `~/.claude/settings.json` mtime **2026-07-30 20:59:27 local** and
    `~/.claude-mem/settings.json` mtime **20:13:51 local** — both fall between the last successful hook event
    (`23:38:02Z` = 19:38 local) and the first failed one. Diff against the Phase-0 snapshot and any backup.
  - Whether Claude Code is invoking plugin hooks at all for these sessions (host-side, not claude-mem-side).
  - Already ruled out, do not redo: plugin enabled (`claude-mem@thedotmack: true`), `CLAUDE_MEM_EXCLUDED_PROJECTS`
    empty, all six hook events registered, hook plugin-root resolution clean
    (→ `~/.claude/plugins/cache/thedotmack/claude-mem/13.11.0`), `node` v24.18.1 on PATH, `bun-runner.js` present,
    worker healthy (`initialized:true`, `mcpReady:true`).

- [ ] **Branch B — H4, the non-XML batch drop (from E2).** Hooks fire, events reach the worker, observations still do
      not land. The mechanism is already located — confirm it fires here and measure its blast radius:
  - `ResponseProcessor.ts:74-89` logs `SDK returned non-XML <class> response — ignoring queued batch` and then calls
    `confirmClaimedMessages` at `:87`, which **permanently splices** the messages out (`SessionMessageBuffer.ts:74-84`).
  - `idle` is `raw.trim() === ''` (`output-classifier.ts:40-50`), and an empty reply is the **designed** skip signal
    (`prompts.ts:152`) — so a legitimate skip and a total miss are indistinguishable.
  - Every generator start yields an init/continuation prompt **before** any tool event
    (`ClaudeProvider.ts:466-483`), and the SDK is fed an async generator (`:241-242`) so it **pulls ahead** — quantify
    how many queued messages one `idle` reply discards.
  - Contrast with the summary path, which survives because persistence depends only on the `<summary>` XML arriving and
    `<skip_summary/>` still parses `valid:true` (`parser.ts:54-72`).
  - **This is a different site from the closed `~~32~~`/`~~33~~` forensic** (empty `<observation>` shells at
    `parser.ts:153`). Do not assume that investigation's "benign" verdict covers it.

- [ ] **Branch C — H1, restart destroys in-flight work (from E3).** The buffer-loss mechanism is already **confirmed**
      — `SessionMessageBuffer` is an in-process `Map` whose doc block states the no-recovery policy outright
      (`SessionMessageBuffer.ts:21-41,43`). What is unproven is whether it explains *this* symptom. Establish what a
      restart discards beyond the buffer, starting from
      `Discarding stale memory_session_id from previous worker instance (Issue #817)`
      (`SessionManager.ts:78-84`). Note recovery **does** re-register a new id (`ClaudeProvider.ts:289-312`) and a
      valid parse in the gap is **deferred, not dropped** (`ResponseProcessor.ts:96-105`) — so only RAM-buffered work
      is lost. Coordinate with #40.

- [ ] **Branch D — H5, version/port split-brain (from Phase 1a).** Establish which worker served which session and
      whether hooks were POSTing to a port nothing served. Anchors: the 13.12.4/:37700 log lines, the deleted
      `cache/.../13.12.4/` directory (mtime Jul 30 20:59) against `~/.claude/settings.json` (20:59:27), and the
      `worker_port` NULL-vs-37777 split with its stuck `status='active'` rows. Determine what performed the downgrade
      (spec §9g) and whether CLAUDE.md's *newest-mtime-wins* resolution let two versions serve concurrently.

---

### Phase 4 — Report and hand off

- [ ] Write up findings in the PR description (or as a comment on the queue row if no code changed):
      what was tested, what each experiment returned, which hypotheses were **falsified**, and the proven cause — or
      an explicit "no fault reproduced".
- [ ] If capture proved healthy (E2 positive), **close #41 as no-bug** and record that the Jul-19 gap was the work
      stoppage documented in the spec §3.1.
- [ ] If a cause was proven, **file a new queue row for the fix.** Do not fix it here.
- [ ] File the two by-products the H2 refutation surfaced, regardless of outcome (both are real and independent):
  - `CLAUDE.md:48-50` documents the plugin-root chain as three steps, **omitting** the MCP-only
    `$PWD/plugin` → `$PWD` candidates and two Codex cache roots — the file is wrong for the MCP server.
  - `scripts/verify-plugin-delivery.cjs` models only the hook chain, so `npm run verify:plugin-delivery` is
    **structurally blind to MCP-root divergence** — green while the MCP server could load the working tree. Latent
    today (roots byte-identical), a live trap after any rebuild without re-mirroring.
- [ ] Answer or re-file the spec's open questions — in particular **(d) why only two days of logs exist with no
      retention code in `src/`**, since something may be actively destroying this investigation's evidence.

---

## Verification (this row's definition of done)

- [ ] Phase 0 snapshot exists and is referenced by path in the report.
- [ ] E1 was run **before** E2, and both outcomes are recorded against the **pre-registered** prediction tables — not
      rationalised after the fact.
- [ ] Every conclusion cites either a query result or a `file:line`. No inference is presented as a finding.
- [ ] Hypotheses are explicitly marked confirmed / falsified / untested.
- [ ] **No production code changed.** `git status` shows only the four pre-existing dirty `plugin/*` artifacts.

## Cross-references

- Spec: `docs/superpowers/specs/2026-07-31-claude-mem-capture-outage-investigation-design.md`
- Queue **#40** — chroma-mcp orphan leak; same worker-restart lifecycle, and the source of the H1/Branch-C suspicion
  that `performGracefulShutdown` aborting at step 1 discards more than chroma.
- `CLAUDE.md` — build, plugin-delivery and test-gate contracts (and the §5-H2 documentation defect above).

## Queue

Row **#41** in `docs/BUILDER_QUEUE.md`.
