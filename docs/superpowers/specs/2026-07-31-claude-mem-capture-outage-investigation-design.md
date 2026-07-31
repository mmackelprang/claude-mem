# Design: claude-mem observation-capture outage — investigation scope

**Status:** Approved for planning · **Date:** 2026-07-31 · **Owner:** Planner
**Type:** **INVESTIGATION, not a fix.** No remedy is specified because no cause is proven. The deliverable is a
falsifiable experiment sequence with pre-registered predictions.
**Adjacent:** Queue #40 (chroma-mcp orphan leak) — same worker-restart lifecycle area; see §5 H1.

> **Planner note.** Ran non-interactively, so judgement calls are recorded in §8 (assumptions) and §9 (open questions)
> rather than asked. **Four claims in the brief did not survive verification** (§3). Read §3 before §5 — two of the
> brief's supporting facts are red herrings and one hypothesis is already refuted, which changes what is worth testing.

---

## 1. Reported symptom

Observation capture for the `claude-mem` project stopped 2026-07-19 and has not resumed, while other projects
continued. The viewer serves fine; `session_summaries` for `claude-mem` continue past the cutoff; only `observations`
flatlined.

## 2. What I verified independently (against `~/.claude-mem/claude-mem.db`, read-only, 2026-07-31)

Confirmed as reported:

- `claude-mem` observations: 1,752 rows, Jul 2 → **Jul 19**. Daily: Jul 17 = 451, Jul 18 = 5, Jul 19 = 1, then zero.
- Summaries continue past the cutoff: Jul 20 (id 843) and Jul 30 (id 1161, 23:30:27Z).
- Session 123's `memory_session_id` `96d4e161…` appears **0 times** in `observations` and exactly once in
  `session_summaries`. That session produced a summary and no observations.
- No misfiling: no NULL/empty `project` buckets; `merged_into_project` NULL for all 13,271 rows.
- The schema gotchas are real — `created_at` is ISO-8601 TEXT; `user_prompts` has no `project` column.

## 3. Four corrections — the brief's evidence base is weaker and different than stated

### 3.1 The 11-day "outage" is mostly an 11-day work stoppage *(largest correction)*

Commits to this repo, by day: **Jul 16 = 85, Jul 17 = 34, Jul 18 = 2, then ZERO until Jul 31.** Observations, by day:
**Jul 16 = 439, Jul 17 = 451, Jul 18 = 5, Jul 19 = 1, then zero.**

These are the same curve. There was essentially **no claude-mem work to capture** between Jul 19 and Jul 30. The brief
states "PRs #37–#40 all landing in this repo Jul 30–31"; git says otherwise — PR #40 merged **Jul 18 21:45**, and the
only commit after Jul 18 is today's. **A capture system that recorded nothing while nothing happened is behaving
correctly.** Any investigation that treats the 11-day gap as 11 days of failure will chase a ghost.

### 3.2 The real evidence base is two sessions — effectively one

Only **two** `claude-mem` summaries exist after the cutoff: Jul 20 and Jul 30. Log retention covers only Jul 30–31, so
only the Jul 30 session (id 123, 23:10:41→23:35:48Z, 25 min) has any log evidence. **n = 1.** That is enough to open an
investigation and nowhere near enough to conclude a systematic failure.

### 3.3 The `sdk_sessions` "4 vs 85" point does not mean what the brief takes it to mean

`sdk_sessions` is **one row per Claude Code conversation**, not per prompt, per SDK spawn, or per capture. It is an
upsert keyed on `(platform_source, content_session_id)` (`src/services/sqlite/SessionStore.ts:1953-1958`, unique index
at `:219`), inserted from three call sites (`http/shared.ts:91`, `SessionRoutes.ts:358`, `:426`).

So claude-mem's 4 rows mean **4 conversations ever** — Jul 2, Jul 14, Jul 15 and Jul 30 — and jobhunt's 85 means 85
separate conversations in three days. That is not evidence of broken capture; it **corroborates §3.1**. The Jul-15 row
(id 19) is the fork-merge marathon: an upsert preserves the original `started_at`, so the 439 + 451 + 5 + 1
observations of Jul 16–19 belong to that one conversation. Four conversations map cleanly onto the commit history —
Jul 2, Jul 14, the Jul 15→18 marathon, and the single Jul 30 session that produced zero observations.

**Mechanism correction (my own first-pass analysis was wrong here).** I initially measured that 12,422 of 13,271
observations (93.6%) have a `memory_session_id` with no matching `sdk_sessions` row, and concluded the table was not
the session registry. The real cause is narrower: `memory_session_id` is a **single column that is overwritten on
every generator start** (`SessionStore.ts:1567-1578`, capture at `ClaudeProvider.ts:289-312`), so historical
observations can no longer join. The rows are not missing — the join key was rewritten. Two consequences worth
carrying: the non-join is expected and is **not** a defect signal, and `PaginationHelper.getSummaries` **INNER** joins
`sdk_sessions` (`PaginationHelper.ts:131`) while `getObservations` **LEFT** joins (`:77`), so the viewer displays only
the last observer session per conversation — 4 summaries for claude-mem where the table holds 152.

### 3.4 "Every other project kept capturing through Jul 30" is wrong as stated — but the conclusion survives under a better metric

Only three projects had *any* Jul-30 activity (`jobhunt`, `aitrader`, `chat-gateway`) — and all three first appear
Jul 28. Long-running projects also stop: `FamilyWorkspace` last observation Jul 23, `yoto-maker` Jul 22, `coloringbook`
Jul 14. Recency alone therefore proves nothing.

**The correct discriminator is divergence between the last observation and the last summary** — a project that is
merely idle stops both on the same day; a project whose capture is broken keeps summarising while observations stop.
By that metric:

| Project | last observation | last summary | divergence |
|---|---|---|---|
| **claude-mem** | 2026-07-19 | 2026-07-30 | **11 days** |
| homelab | 2026-07-28 | 2026-07-29 | 1 day (one summary, id 1051) |
| *every other project* | = last summary | = last observation | **0** |

So claude-mem **is** a genuine outlier — the brief's instinct is right, its supporting evidence was not. homelab's
single-day divergence is probably noise but should be checked (§9b).

## 4. The finding that should redirect the investigation: capture is dead *right now*

Measured today, 2026-07-31, during a long, tool-heavy `claude-mem` session:

- **Zero rows written to any capture table today, by any project.** `observations` (13,271, latest
  `2026-07-30T23:49:02Z`), `session_summaries` (1,164, latest `23:46:14Z`), `sdk_sessions` (123, latest `23:10:41Z`),
  `user_prompts` (593, latest `23:38:02Z`). Verified against the live WAL (`journal_mode=wal`; the reader participates
  in it), so this is not a stale-snapshot artifact.
- **`user_prompts` is the sharp one.** It is written by the `UserPromptSubmit` hook, at prompt boundaries, independent
  of the observation pipeline. Today's session has had many prompts and it has recorded **none**.
- **Today's worker log contains zero `[HOOK]`, `[SESSION]`, `[SDK]`, `[PARSER]` and `[QUEUE]` lines.** Yesterday's has
  31, 17, 24, 24 and 28 respectively. The log ends at the 08:18 worker restart and has been silent since.
- Meanwhile **the infrastructure is healthy**: `/api/health` → `status:ok`, `pid 7127`, `initialized:true`,
  `mcpReady:true`, uptime 3081 s. The hook's own plugin-root resolution, dry-run verbatim from
  `hooks/hooks.json`, resolves cleanly to `~/.claude/plugins/cache/thedotmack/claude-mem/13.11.0`. `node` v24.18.1 is
  on PATH, `bun-runner.js` is present, all six hook events (`Setup`, `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `Stop`) are registered, `claude-mem@thedotmack` is `true` in `enabledPlugins`, and
  `CLAUDE_MEM_EXCLUDED_PROJECTS` is empty.
- `"lastInteraction": null` in `/api/health` — the worker has served zero AI interactions since boot.

**This matters more than the Jul-19 archaeology.** The Jul-19 window has no logs and is unrecoverable; this failure is
**live, current, and reproducible in the next five minutes**. It also shifts the prime suspect: nothing is reaching the
worker at all, so today's failure is upstream of the observer/parser — the hooks are not being *invoked*, rather than
being invoked and failing.

**Unresolved confound, and it is the whole ballgame:** only `claude-mem` sessions have run today. So "hooks are dead
today" is equally consistent with a claude-mem-specific fault and with a global regression. **One five-minute test in a
different project separates them** (§6, E1).

**Change-point candidate:** `~/.claude/settings.json` was modified **2026-07-30 20:59:27 local** — after the last
successful hook event (23:38:02Z = 19:38 local) and before the first failed one (today). `~/.claude-mem/settings.json`
was modified 20:13:51 local the same evening. Both sit exactly in the gap. Neither file's *current* content shows an
obvious fault, so this is a lead, not a finding.

## 5. Hypothesis set (revised)

### H1 — worker restart destroys in-flight observation batches *(brief's #1; mechanism confirmed, relevance unproven)*

**The buffer loss is real and documented.** `SessionMessageBuffer` is a plain in-process `Map`
(`src/services/worker/SessionMessageBuffer.ts:43`) whose own doc block states the policy outright (`:21-41`): *"this
buffer deliberately holds work only for the worker process lifetime: no 'processing' state to resurrect on restart, no
startup sweep, no respawn-on-pending. If the worker dies, the buffer is gone."* `claude-mem` is the only project where
`build-and-sync` routinely restarts the worker mid-session. **Overlaps #40:** the `performGracefulShutdown` chain
proven there to abort at step 1 — forfeiting steps 2–6 — is the prime suspect for discarding more than chroma.

**But the brief's rationale for it is wrong, and that matters.** Observations and summaries are **not** structurally
different pipelines. Both are enqueued into the *same* per-session buffer, drained by the *same* async generator, and
fed to the *same* long-lived SDK subprocess — a `summarize` is just another `PendingMessage` with `type:'summarize'`
(`SessionRoutes.ts:376` → `SessionManager.queueSummarize:183-205`). There is no "short call at a prompt boundary" to
explain why summaries survive. The genuine asymmetry is §-H4's, not a restart asymmetry. Recovery also re-registers
rather than dying permanently (`ClaudeProvider.ts:202,289-312`). **Further weakened by §4:** today's failure kills
`user_prompts` too, which is not batch-accumulated at all.

### H2 — claude-mem sessions run a different build *(brief's #2; REFUTED for the capture path)*

- **Hooks are not cwd-sensitive.** `hooks.json` and `codex-hooks.json` contain **zero** `$PWD` tokens. The cwd-relative
  candidates (`$PWD/plugin`, `$PWD`) are **MCP-only**, gated on `isMcp` in
  `src/build/hook-shell-template.ts:116-121`, supplied at `scripts/build-hooks.js:166`. Every capture hook resolves
  cache-first regardless of project.
- **All three roots are byte-identical right now** — working tree `plugin/`, `cache/13.11.0/`, and the marketplace
  clone share md5s on every file including the four intentionally-modified ones; the only difference anywhere is an
  `.in_use` marker file. So even the MCP-only preference currently selects identical bytes.
- **No self-capture guard exists.** `src/shared/should-track-project.ts:15-23` gates only on `CLAUDE_MEM_INTERNAL=1`
  (the nested-SDK-recursion guard, `EnvManager.ts:183`), the observer-sessions dir, and
  `CLAUDE_MEM_EXCLUDED_PROJECTS` — which is empty.

**Two real defects fall out of refuting it, worth their own rows (§9c):** `CLAUDE.md:48-50` documents the resolution
chain as three steps and **omits the MCP-only `$PWD/plugin` → `$PWD` step** plus two Codex cache roots, so the file is
wrong for the MCP server; and `scripts/verify-plugin-delivery.cjs` models only the hook chain, so
`npm run verify:plugin-delivery` is **structurally blind to MCP-root divergence** — it reports green while the MCP
server loads the working tree. Latent today because the roots match; a live trap the moment someone rebuilds without
re-mirroring.

### H3 — hooks are not being invoked at all *(NEW — promoted to primary by §4)*

Nothing reaches the worker: no `[HOOK]` lines, no `user_prompts` rows, `lastInteraction: null`. Configuration and
resolution both check out, so the suspicion is that Claude Code is not firing the hooks for this session — a
session-lifetime, harness, or Claude Code version issue, or a consequence of the Jul-30 evening settings edit.
**Cheapest to test and highest information yield.**

### H4 — a non-XML reply permanently discards the batch *(sharpened from the brief's fallback; strongest *mechanistic* candidate)*

This is no longer just "the SDK returns idle". The drop is explicit and permanent:

- `ResponseProcessor.ts:74-89` classifies a non-XML reply, logs
  `SDK returned non-XML <class> response — ignoring queued batch`, then calls `confirmClaimedMessages(...)` at `:87` —
  and `confirm()` **splices the messages out of the buffer permanently** (`SessionMessageBuffer.ts:74-84`).
- `idle` is `raw.trim() === ''` (`src/sdk/output-classifier.ts:40-50`), and **an empty reply is the designed no-op for
  a skipped tool use** (`src/sdk/prompts.ts:152`; the `code` mode's `skip_guidance`). The classifier cannot distinguish
  *"the model chose to skip"* from *"the model never saw anything"*.
- **Every generator start yields an init/continuation prompt first** (`ClaudeProvider.ts:466-483`), before any tool
  event — so its reply is legitimately empty or prose. Confirmed in the log: *"I'm ready to observe… No observations to
  report yet—waiting for session activity."*
- Because the SDK is fed an **async generator** (`ClaudeProvider.ts:241-242`), it pulls later prompts off the buffer
  before the reply to the earlier one arrives. An `idle` reply to the init prompt therefore confirms-and-drops
  everything already pulled ahead.

**This explains the asymmetry H1 could not:** a summary's persistence depends only on the `<summary>` XML arriving, not
on its buffer entry surviving — and `<skip_summary/>` still parses `valid:true` (`parser.ts:54-72`), so the summary
path has a *structured* skip while the observation path's skip is indistinguishable from silence.

**This is a distinct drop site from the closed `~~32~~`/`~~33~~` forensic**, which covered empty `<observation>` shells
at `parser.ts:153` and concluded benign. That investigation did not examine the `confirmClaimedMessages` branch.

### H5 — version/port split-brain, then a downgrade *(NEW — not in the brief; verified, and the strongest lead)*

**The logs the brief quotes were not written by the worker that owns the database.**

- The **entire** Jul-30 log is plugin **13.12.4 on port 37700** (101 matching lines, e.g. paths under
  `~/.claude/plugins/cache/thedotmack/claude-mem/13.12.4/`). It contains **zero** `13.11.0` or `37777` mentions.
- The Jul-31 log continues 13.12.4/:37700 to 20:50 local, including
  `Worker already running (PID alive), refusing to start duplicate {existingPid=1641, existingPort=37700}`.
- **`.../cache/thedotmack/claude-mem/13.12.4/` no longer exists.** The cache now holds only `13.11.0` — a
  **downgrade** — and the cache directory's mtime is **Jul 30 20:59**, matching `~/.claude/settings.json`'s
  **20:59:27**.
- `sdk_sessions.worker_port` is only ever **37777 (70 rows) or NULL (53 rows, Jul 28–30)** — **never 37700**. Many of
  the NULL rows are stuck `status='active'`.
- Today only pid 7127 listens, on 37777, running 13.11.0.

So on Jul 30 a **13.12.4 worker on :37700 and a 13.11.0 identity on :37777 coexisted**, the box was downgraded to
13.11.0 that evening, and **no hook has written anything since**. This subsumes the brief's noted log↔DB correlation
failure (§9e) — the streams are from different workers — and it is a far better explanation for a port/version-shaped
capture failure than anything in the original hypothesis set. Note CLAUDE.md's documented resolution is *newest
**mtime** first, not highest version*, so with two versions present different processes could resolve differently.

**Ordering:** **H5 → H3 → H4 → H1.** H2 is closed.

## 6. Experiment design

The brief's proposed experiment (end this session without `build-and-sync`; check for a new observation) is the right
instinct but **not decisive as specified** — a null result is consistent with H1, H3 and H4 at once, and §3.1 shows the
work-stoppage confound can masquerade as either outcome. It needs a control.

**E1 — project control (do this first; ~5 minutes).** Open a short session in a *different* project (e.g. `RTest`),
issue one prompt and one tool call, do **not** run `build-and-sync`. Then check `user_prompts` and the worker log for
`[HOOK]` lines.

**E2 — the brief's experiment, with the restart variable held fixed.** Let a real, tool-heavy `claude-mem` session end
**without** `build-and-sync`, then check for new `claude-mem` observations.

**E3 — restart contrast (only if E2 produces observations).** Repeat E2 but run `build-and-sync` mid-session. Compare.

**Pre-registered predictions** — write these down *before* running, so no outcome can be rationalised afterwards:

| E1 result | E2 result | Conclusion |
|---|---|---|
| Other project **captures** | claude-mem **captures** | Today's silence was a session artifact. Outage was §3.1's work stoppage; **close as no-bug**, keep the §5-H2 doc/tooling defects. |
| Other project **captures** | claude-mem **does not** | Genuinely claude-mem-specific. H2 is refuted, so pivot to H4 (observer/parser) — and explain what is project-specific given identical builds. |
| Other project **does not capture** | either | **Global** regression, not claude-mem-specific. Re-scope the whole row; investigate the Jul-30 20:59 settings change and the Claude Code hook layer. Highest-priority branch. |
| Other project captures | claude-mem captures only with no restart (E3 differs) | **H1 confirmed** — restart destroys in-flight work. Cross-link #40. |

**Ordering rationale:** E1 costs five minutes and can invalidate the row's entire premise, so it runs first. Running
E2 first risks a week of claude-mem-specific investigation into a global fault.

## 7. Evidence preservation — do this before anything else

Only **two** log files exist (`claude-mem-2026-07-30.log`, `-31.log`); no retention/cleanup code was found under
`src/`, so why older logs are absent is itself unknown (§9d). The Jul-19 window is **already unrecoverable**, and
today's file is the only record of the live failure. **Snapshot the logs and the row counts before running any
experiment, restarting the worker, or rebuilding** — a restart may rotate or overwrite the one artifact that matters.

## 8. Assumptions

1. **The Jul-19 cutoff has no direct evidence and will not get any.** Logs for that window are gone. The investigation
   targets the **reproducible present**, not the unrecoverable past. If the present is healthy, the Jul-19 gap is
   attributed to §3.1's work stoppage and the row closes.
2. **Read-only until a cause is proven.** No production code, no config edits, no manual hook invocation — a manual
   invocation would write to Mark's live DB and pollute the very dataset under analysis.
3. **`homelab`'s one-day divergence is noise** until shown otherwise (§9b).
4. **Diagnostic-first.** No remedy is specified. If a Phase-1 result points at a fix, that fix gets its **own** queue
   row with its own plan.

## 9. Open questions

- **(a)** ~~What does an `sdk_sessions` row represent?~~ **ANSWERED during planning** — one row per Claude Code
  conversation, upserted on `(platform_source, content_session_id)` (§3.3). Retained only to record that the brief's
  "4 vs 85" diagnostic is retired.
- **(a′)** Why do **53** `sdk_sessions` rows (Jul 28–30) have `worker_port = NULL` and many a stuck
  `status='active'`, while 70 have `37777` and none have `37700`? Under H5 this is the fingerprint of the 13.12.4
  worker, and it may be the cleanest available marker for *which* worker served a session.
- **(b)** Is `homelab`'s 1-day obs/summary divergence a second instance or a boundary artifact? One query.
- **(c)** Should the two H2 by-products — `CLAUDE.md:48-50` documenting the resolution chain wrongly, and
  `verify:plugin-delivery` being blind to MCP-root divergence — be filed as their own Backlog rows? Planner's
  recommendation: **yes**, both are real and cheap, and neither belongs in a diagnostic row.
- **(d)** Why do only two days of logs exist, with no retention code in `src/`? If something is deleting them, that is
  actively destroying the evidence this investigation needs.
- **(e)** ~~Why is log↔DB correlation imperfect?~~ **ANSWERED during planning** — the two streams come from **different
  workers** (logs = 13.12.4/:37700; DB rows = 37777/NULL). See H5. No further work needed on the correlation itself.
- **(f)** ~~Is `hasGenerator=false` the smoking gun?~~ **NO — retired.** `hasGenerator` and `queueDepth` at
  `SessionManager.ts:140-141` are **hardcoded literals** on the cold-create path, never read from
  `session.generatorPromise`. They carry **zero** diagnostic information. The real signal is
  `Generator auto-starting (<source>) using <agent>` (`SessionRoutes.ts:155-159`) — present in the Jul-30 log, i.e. a
  generator **did** start. Likewise the empty `project=` is the known Stop-hook-before-session-init ordering,
  backfilled once session-init supplies it (`SessionStore.ts:1961-1966`); verified harmless here — **zero** rows in
  `observations`, `session_summaries` or `sdk_sessions` carry an empty or NULL `project`.
- **(g)** What removed plugin `13.12.4` and downgraded the box to `13.11.0` on the evening of Jul 30 — a marketplace
  update, a claude-mem self-update, or a manual action? Under H5 this is the change-point, and the answer determines
  whether it can recur.

## 10. Out of scope

- Any production code change. This row ends at a proven root cause; the fix is a separate row.
- Editing upstream-owned files, or `plugin/*` build artifacts (four are intentionally dirty — do not revert them).
- Re-litigating the Jul-19 cutoff from data that no longer exists.
- The #40 chroma orphan leak itself — related lifecycle, separate row.
