# Design Handoff — Mission Control Phase 1 Polish

- **Date:** 2026-07-16
- **Status:** Proposed (awaiting Mark's review before Planner picks it up)
- **Author:** Designer (from Mark's live UAT feedback)
- **Consumers:** Planner (implementation plan), Architect (the escalation-context + PR/spec-link data seams), Builder
- **Surface:** the worker's SSE viewer — `src/ui/viewer/components/MissionControl.tsx`, `src/ui/viewer/hooks/useMissionControl.ts`, styles in `src/ui/viewer-template.html`; data from `src/services/mission-control/*` via `src/services/worker/http/routes/MissionControlRoutes.ts`.

### follows / extends / deviates

- **Follows** the existing viewer visual language verbatim — the token set, card treatment, badge system, and the collapsible-section pattern already defined in `src/ui/viewer-template.html`. **No new color/spacing/type tokens are introduced** (see §8).
- **Follows** the Mission Control Phase 1 spec (`docs/superpowers/specs/2026-07-16-mission-control-design.md`): advisory-only (D1), mine-not-emit (Phase 1 scope), auto-resolving items (D7), explicit-`#N`-refs-as-fact (D4).
- **Extends** that spec on the three points it left to rendering polish: how mined refs become links, what makes an escalation *actionable*, and what a *meaningful* progress rollup is. These were named as read-view concerns but never specified at the pixel/copy level. This document specifies them.
- **Deviates** from nothing. Two items touch the data layer (escalation-context capture, progress aggregation) — those are **extensions within Phase 1's stated "read/mine engine, no LLM" boundary**, not new architecture. Flagged for Planner/Architect in §6.

---

## 1. Why this handoff exists

Phase 1 shipped the three panes and the data pipeline behind them. Mark is UAT-ing it live and the verdict is "needs a lot of polish." Read against the code, the feedback resolves into **four concrete problems**, three of which are visible in the rendered panes and one of which is structural:

| # | Mark's words | Root cause (verified in code) |
|---|---|---|
| 1 | Attention items should be **links** | Refs (`pr:`, `spec:`) are stored but rendered as plain text. `MissionControl.tsx:29` prints `{item.summary}` in a bare `<li>`. |
| 2 | Escalations are **useless** ("`eaddrinuse` — nothing to do") | The miner reduces a rich error observation to `Error signature detected: <key>` and throws away where/when/who and any fix (`AttentionMiner.ts:137-145`). |
| 3 | Progress is a **wall of noise** (`builder · 30 obs / · 46 obs / · 52 obs`) | The query groups by `agent_id` **and** renders only `total` "obs" (`ProgressQuery.ts:53`, `MissionControl.tsx:63`). The outcome breakdown it already computes (`byType`) is discarded. |
| 4 | **Overall polish** | The panes have **zero CSS**. Not one `.mc-*`, `.mission-control`, or `.view-toggle` rule exists in `viewer-template.html`. The panes render as raw browser `<ul>`/`<h2>` on the page. |

**The through-line for all four: the data is already good; the presentation layer is throwing most of it away.** Fixes 1 and 4 are pure rendering. Fixes 2 and 3 are mostly rendering plus a small, well-bounded data-capture/aggregation change. §6 draws that line explicitly for the Planner.

---

## 2. Fix 1 — Attention: real links, grouped

### Problem

Every attention item is a plain `<li>{summary}</li>`. A review reads `PR #22 awaiting review: Merge upstream v13.11.0` as dead text; a spec reads `Spec awaiting review (Proposed): …` as dead text. Mark cannot click through to the thing that needs him. Specs in particular want to be a **scannable list of links**, not prose.

### Grounding correction (important for Planner)

The task framed PR links as "needs the fork repo URL." In fact **the canonical PR URL is already fetched and then discarded.** `shell.ts:54` runs `gh pr list --json number,title,url` and `listOpenPrs()` returns `{ number, title, url }`. `AttentionMiner.ts:88` upserts using `number` and `title` but **drops `url`**. So the PR link needs no reconstruction — it needs the already-fetched `url` surfaced. Spec links (`spec:<repo-relative-path>`) have no gh-provided URL and do need a repo web base + branch to build a GitHub `blob` URL.

### Redesign

Attention becomes a single card, one collapsible group per type, ordered **escalation → blocker → review → question** (the existing `order` array in `MissionControl.tsx:9` is correct — keep it). Each item is a **row with a linked primary label + muted provenance**. Reviews and questions that point at a file/PR are links; escalations get the §3 treatment.

```
┌─ ATTENTION — what needs you now ───────────────────────────── [12] ┐
│                                                                     │
│  ⚠ ESCALATIONS (1)                                    ── see §3 ──  │
│                                                                     │
│  ◆ REVIEWS (4)                                              ▾       │
│    ↳ PR #22 · Merge upstream v13.11.0            → github ↗   claude-mem │
│    ↳ PR #17 · Fix chroma observation sync        → github ↗   claude-mem │
│    ↳ Spec (Proposed): NAS multi-user pilot       → view ↗     claude-mem │
│    ↳ Spec (Proposed): Roadmap history loop       → view ↗     claude-mem │
│                                                                     │
│  ? QUESTIONS (7)                                           ▾       │
│    ↳ ADR-0002 · "Should promote be a Planner dispatch?"  → view ↗  │
│    … 6 more                                                         │
└─────────────────────────────────────────────────────────────────────┘
```

- **Reviews group** splits visually into PRs and specs but stays one type-group (they share `type: 'review'` in the store — do not re-model). A small leading glyph distinguishes them: PR rows use the PR number as the link label; spec rows lead with `Spec (Proposed):` + the spec title (both already in `summary`).
- **The whole primary label is the link.** PR row → `pr.url`. Spec row → `<repoWebBase>/blob/<branch>/<path>`. Question row → same blob URL, deep-linked to the section when the ref carries a line (`question:<path>#<n>` → append `#L<n>` best-effort, else link the file).
- **Trailing metadata**, muted, right-aligned: an `↗ github` / `↗ view` affordance and the `project`. Reuse `.card-meta` typography (`viewer-template.html:806`).
- **Link target:** new tab (`target="_blank" rel="noopener noreferrer"`) — this is a local console; the user keeps Mission Control open while the PR/file opens in the browser/host.

### Copy

- Group headers: `REVIEWS (4)`, `QUESTIONS (7)`, `ESCALATIONS (1)`, `BLOCKERS (n)` — uppercase, count in parens (matches `.subsection-label` style, `viewer-template.html:1995`).
- PR row label: `PR #22 · Merge upstream v13.11.0` (strip the redundant "awaiting review:" that's currently baked into `summary` — see data note below).
- Spec row label: `Spec (Proposed) · NAS multi-user pilot`.
- Question row label: the question text (already in `summary` after the `Open question in <file>:` prefix — render the prefix as muted context, the question as the label).
- Link affordance text: `open ↗` (uniform; simpler than github/view split — see Open Question Q3).
- Empty state (unchanged, good): `Nothing is gated on you right now.`

### Render-only vs data-layer

| Piece | Classification | Note |
|---|---|---|
| Link the PR row | **Data-layer (tiny)** | Persist or expose the already-fetched `pr.url`. Two options for Architect: (a) add a `link TEXT` column to `attention_items` and store `pr.url` at upsert; (b) don't store it — have the attention route resolve a `repoWebBase` + `defaultBranch` once and return them, client builds all links. **(b) is preferred**: it also solves spec/question links (which have no stored url), avoids a migration, and keeps repo identity server-side (out of the browser bundle). |
| Link the spec / question row | **Data-layer (tiny) + render** | Needs `repoWebBase` + `defaultBranch` from the route (same as above); the `blob/<branch>/<path>` string is built client-side from the existing `ref`. |
| Group headers, ordering, glyphs, layout, tab behavior | **Render-only** | Store already carries `type`, `summary`, `ref`, `project`. |
| Drop the "awaiting review:" filler from labels | **Render-only** | Parse the label out of `summary`, or (cleaner) stop baking prose into `summary` at the miner and let the client compose. Either is fine; render-side parse unblocks without touching the miner. |

**Data the route must add:** `repoWebBase` (e.g. `https://github.com/mmackelprang/claude-mem`) and `defaultBranch` (e.g. `main`), resolved server-side via the same boundary that already talks to git/gh (`git remote get-url` / `gh repo view`, or lifted from the `pr.url` pattern). Return them once on the `/attention` payload, not per item.

---

## 3. Fix 2 — Escalations: only what Mark can act on

### Problem

`AttentionMiner.ts:137-145` turns any observation whose text matches an `ERROR_PATTERN` into:

```
summary: "Error signature detected: eaddrinuse"
urgency: "high"
ref: "error:eaddrinuse"
project: <the obs's project>        ← this IS captured (task said "no other context"; minor correction)
```

Everything else on the triggering observation — the actual error line (`title`/`narrative`), **which agent/session hit it** (`agent_type`, `agent_id`, `memory_session_id`), **when** (`created_at_epoch`), how many times — is discarded. `eaddrinuse` with no what/where/when/fix is exactly Mark's "nothing to do."

### The actionable-escalation bar (the model I'm recommending)

**An error class is surfaced as an escalation only if it maps to a known remediation. The remediation catalog *is* the allowlist.** Anything not in the catalog stays an ordinary feed observation and never becomes an escalation. This is a natural extension of what already exists: `ERROR_PATTERNS` (`AttentionMiner.ts:36-41`) is *already* an allowlist of four classes — we pair each with a remediation and refuse to surface a class that has none.

Every surfaced escalation must render **four fields**. If a class can't fill all four, it isn't actionable enough to surface:

1. **WHAT** — a human error name + the real error line. `Port already in use (EADDRINUSE)` with the observation's `title`/`narrative` snippet, not the bare key.
2. **WHERE** — `project` + which **agent team / session** is blocked. "in `claude-mem`, builder team" with a link to that session in the Feed.
3. **WHEN** — latest occurrence + count. "3× in the last 24h, latest 2:41pm."
4. **FIX** — the remediation: a one-line action, optionally a copyable command and/or a doc link. "A stale worker holds `:37777`. Run `claude-mem restart`, or kill the PID on that port. → troubleshooting doc."

### The remediation catalog (content — belongs in-repo, keyed by error class)

A static map, one entry per surfaced class. This is presentation content, not captured data — it lives in code next to `ERROR_PATTERNS` and is looked up at render time from the existing `error:<key>` ref.

| class (`ref` key) | title (WHAT) | remediation (FIX) | doc link |
|---|---|---|---|
| `eaddrinuse` | Port already in use | Stale worker holds the port. `claude-mem restart`, or kill the PID on `:37777`. | troubleshooting#port |
| `worker-unreachable` | Worker unreachable | The worker process is down. `claude-mem restart`; check `claude-mem doctor`. | troubleshooting#worker |
| `module-not-found` | Module not found | A build didn't reach the running plugin. `npm run build-and-sync`, then `npm run verify:plugin-delivery`. | CLAUDE.md#build |
| `swallowed-startup` | Worker failed to start | Startup error was swallowed. Check the worker log; `claude-mem restart`. | troubleshooting#startup |

If a future pattern is added to `ERROR_PATTERNS` **without** a catalog entry, it must **not** surface as an escalation (fail closed → stays in the feed). That single rule is the whole "only actionable" guarantee.

### Redesign (the escalation bar)

Escalations render as the top group of the Attention pane — full-width cards, error accent, one card per class (keep the current per-class dedup; do **not** fan out per session — see below):

```
┌─ ⚠ ESCALATIONS (1) ─────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ ● HIGH   Port already in use (EADDRINUSE)                         │ │
│ │ "Error: listen EADDRINUSE: address already in use :::37777"       │ │
│ │                                                                    │ │
│ │ where   claude-mem · builder team · session a1c8… → open ↗         │ │
│ │ when    3× in last 24h · latest today 2:41pm                       │ │
│ │ fix     Stale worker holds :37777. `claude-mem restart`  ⧉         │ │
│ │         or kill the PID on that port.            → troubleshooting↗ │ │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

- **One card per error class** (matches the existing `error:<key>` single-ref dedup). If multiple teams hit the same class, WHERE reads "latest: builder team, +2 others." This keeps the pane calm (Mark's #1 complaint is noise) while staying actionable.
- **`● HIGH`** urgency chip — icon **and** text, never color alone (a11y, §9). Error accent = existing `--color-accent-error`.
- **`⧉`** = copy-command affordance on the remediation command (reuse nothing new — a small copy button).
- The error-line quote uses `.card-content` / monospace treatment (`viewer-template.html:1279`, `--font-terminal`).
- Empty state: escalations simply don't render their group when count is 0 (they should be rare — that's the point).

### Render-only vs data-layer

| Piece | Classification | Note |
|---|---|---|
| Remediation catalog → WHAT title + FIX text/command/doc link | **Render-only (new content)** | Static map keyed by the existing `error:<key>` ref. No DB, no capture. |
| Fail-closed filter (only catalog'd classes surface) | **Render-only / config** | Enforced by pairing every `ERROR_PATTERN` with a catalog entry; drop any pattern that has no remediation. |
| Urgency chip, error-line quote, card layout, copy button | **Render-only** | — |
| WHERE = agent team + session (+ link) | **Data-layer** | Miner must carry `agent_type`, `agent_id`, `memory_session_id` from the triggering observation into the upsert. **The `attention_items` columns already exist** (`SessionStore.ts:534-536`); the miner just doesn't populate them and `upsertMinedItem` doesn't accept them. Widen the observations `SELECT` (`AttentionMiner.ts:126`) to include those columns + `created_at_epoch`, and thread them through `UpsertInput`. |
| WHEN = latest occurrence + count | **Data-layer** | `created_at_epoch` is set once at first insert and never refreshed on re-upsert (`attention-items.ts:66-74`). Need: refresh a `last_seen_epoch` on each mine pass, and a small `occurrence_count`. Either two new columns, or fold "latest/count" into a refreshed timestamp + a COUNT over recent matching observations at read time. Architect's call. |
| The real error line in WHAT | **Data-layer (small)** | Put the observation's `title`/`narrative` snippet into `summary` (or a new field) instead of the generic "Error signature detected" string (`AttentionMiner.ts:139`). |

**Net:** the *actionable model itself* (catalog + fail-closed filter + the four-field card) is mostly render-only. The only genuine capture work is **widening what the miner reads from the observation and writes to the item** — and most target columns already exist on the table.

---

## 4. Fix 3 — Progress: meaningful, collapsible

### Problem (with Mark's real example)

**Before** — what Mark sees today (`MissionControl.tsx:60-66`):

```
Progress (by agent × time)
  2026-07-16 · builder · 30 obs
  2026-07-16 · builder · 46 obs
  2026-07-16 · builder · 52 obs
  2026-07-16 · planner · 12 obs
  2026-07-15 · builder · 41 obs
  2026-07-15 · tester · 8 obs
  … (one <li> per agent_id × day, forever)
```

Two defects, both verified:

1. **Three `builder` rows for one day** because `ProgressQuery.ts:53` groups by `agent_id` as well as `agent_type` and `bucket`. Each distinct builder *instance* becomes its own row. This is the noise.
2. **"N obs" is meaningless to a human.** Mark manages agent teams; he wants to know what a team *accomplished*, not how many observations it emitted. And the data to answer that is **already returned and discarded**: `ProgressBucket.byType` (`ProgressQuery.ts:70`) carries the per-type counts — the exact outcome breakdown — but `MissionControl.tsx:63` renders only `b.total`.

### What "meaningful" is, concretely (in Mark's terms)

For a human running agent teams, a team's day/week is: **how many times it ran, what it delivered, and which reviewable units it touched.** Per **Project → Agent**, over a selected range:

| Field | Definition | Source |
|---|---|---|
| **Sessions** | distinct runs of this team | `COUNT(DISTINCT memory_session_id)` |
| **Outcomes** | what it delivered, by kind | observation `type` → `feature ◆`, `bugfix ●`, `decision ⚖`, `refactor ↻`, `discovery ○` (icons already defined, `claude-md-commands.ts:39-48`) |
| **PRs touched** | reviewable units it moved | distinct `#N` / `PR #N` refs parsed from observation `text`/`title`/`narrative` in range (explicit linkage, spec D4) |
| **Files touched** *(optional / later)* | breadth of change | distinct entries in `files_modified` |
| ~~obs count~~ | de-emphasized | kept as a muted tertiary detail, or dropped |

### Redesign — grouping & collapse

Hierarchy: **Project → Agent (team) → (expand) sessions/days.** Collapse the `agent_id` explosion by rolling all instances of an `agent_type` into one team row. Time becomes a **range selector** (Today / 7 days / 30 days; default 7 days), not a row-per-day fan-out. Reuse the existing collapsible pattern (`.settings-section-collapsible` + `.chevron-icon.rotated`, `viewer-template.html:1776-1828`) — do not invent a new disclosure.

**After** — the redesign of Mark's exact example:

```
┌─ PROGRESS — what teams accomplished ───────── [ Today · 7d · 30d ] ┐
│                                                                     │
│  ▾ claude-mem                              4 teams · 9 sessions      │
│    ┌───────────────────────────────────────────────────────────┐  │
│    │ builder      3 sessions                                     │  │
│    │   4 features ◆ · 6 bugfixes ● · 2 decisions ⚖ · 1 refactor ↻ │  │
│    │   3 PRs · #22 #17 #14              · 18 files   · 128 obs    │  │
│    ├───────────────────────────────────────────────────────────┤  │
│    │ planner      1 session                                      │  │
│    │   1 decision ⚖ · 2 discoveries ○                            │  │
│    │   1 PR · #24                       · 3 files    · 12 obs     │  │
│    ├───────────────────────────────────────────────────────────┤  │
│    │ tester       2 sessions   · no outcomes captured · 8 obs    │  │
│    └───────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ▸ some-other-project                      1 team · 2 sessions      │
└─────────────────────────────────────────────────────────────────────┘
```

- **Project header** collapses; shows a one-line roll-up (`4 teams · 9 sessions`). Default: current project's section expanded, others collapsed.
- **Agent (team) row** is the meaningful unit: sessions → outcomes line → PRs / files, with `· N obs` demoted to a muted tail (`--color-text-muted`, `.meta-files` size). Outcome counts use the existing type icons; zero-count types are omitted (only show what happened).
- **Expand a team** → its sessions with day buckets and per-session outcomes (this is where the old day-level `byType` detail lives, now as progressive disclosure, not the default).
- **Outcome line honesty:** `session`/`prompt`/`change` observation types are process noise, not outcomes — exclude them from the outcome line (they can stay in the raw obs tail). Show a `no outcomes captured` note (muted) when a team emitted only process types, so an empty outcome line reads as "nothing shipped," not "bug."

### Copy

- Pane title: `PROGRESS — what teams accomplished` (was "Progress (by agent × time)" — reframes volume → accomplishment).
- Range selector: `Today` · `7 days` · `30 days`.
- Outcome line: `4 features · 6 bugfixes · 2 decisions` (plural-aware; icon before each).
- PRs: `3 PRs · #22 #17 #14` (PR numbers link via the same `repoWebBase` from §2).
- Empty per-team outcomes: `no outcomes captured` (muted).
- Empty pane (keep, restyle): `No agent activity in range.`

### Render-only vs data-layer

| Piece | Classification | Note |
|---|---|---|
| Collapse `agent_id` rows into one team row | **Render-only** | Client can sum the per-`agentId` buckets it already receives into per-`agentType` groups. |
| Outcome breakdown (byType → icons+labels) | **Render-only** | `byType` is already returned (`ProgressQuery.ts:70`); today's UI just ignores it. **This is the single biggest cheap win.** |
| Range selector (Today/7d/30d) | **Render-only + tiny route** | `queryProgress` already accepts `sinceEpoch` (`ProgressQuery.ts:46`); route just needs to pass it from a query param. |
| De-emphasize obs count | **Render-only** | — |
| **Group/collapse by project** | **Data-layer (small)** | `queryProgress` *filters* by project but does not *group* by it — `project` is not in the `SELECT`/`GROUP BY` or the returned `ProgressBucket` (`ProgressQuery.ts:52-58`). Add `project` to both so the client can build the Project→Agent tree in one query instead of N. |
| **Sessions = distinct runs** | **Data-layer (small)** | Add `COUNT(DISTINCT memory_session_id)` per group. `agent_id` is an instance id, not a session count — they are not interchangeable, so this genuinely needs the query. |
| **PRs touched** | **Data-layer (moderate)** | Parse `#N` / `PR #N` refs from observation `text`/`title`/`narrative`, aggregate distinct per (project, agent) in range. This is the D4 explicit-ref parser the spec already earmarked to "factor once, test hard" (§7 of the spec). Reuse it here and in Phase 3. |
| Files touched *(optional)* | **Data-layer (moderate)** | Parse `files_modified` JSON, distinct-count. Safe to defer past this polish pass. |

---

## 5. Fix 4 — Overall polish: the panes have no CSS

### Problem

This is the structural finding and the largest visible gap. **There is not one style rule for the Mission Control surface.** Verified: `grep view-toggle|mission-control|mc-` over `viewer-template.html` → no matches. `App.tsx:113` renders `<div className="view-toggle">` with two `<button>`s and `.active` — none styled. `MissionControl.tsx` emits `.mission-control`, `.mc-pane`, `.mc-header`, `.mc-refresh`, `.mc-attention-group`, `.mc-item`, `.mc-urgency-*`, `.mc-empty`, `.mc-note`, `.mc-badge`, `.mc-loading`, `.mc-error` — all undefined. The panes inherit only the global `button`/`select`/`ul` defaults. That is the whole reason the surface reads as unfinished next to the Feed's polished cards.

### The fix: one card system, reusing existing tokens

Give Mission Control a stylesheet that **mirrors the Feed's card language** so the two views read as one app. No new tokens — map to what exists (§8).

**Structure**
- `.mission-control` — a scroll container matching `.feed` (`viewer-template.html:607`): `overflow-y: scroll; height: 100vh; padding: 24px 18px`, centered, `max-width: ~760px` (Mission Control is denser than the 650px feed; a bit wider reads better for the rollup rows).
- `.mc-pane` — reuse `.card` (`:620`): `bg-card`, `1px border-primary`, `radius 8px`, `padding 24px`, `margin-bottom 24px`.
- Pane `<h2>` — reuse `.summary-title` scale (`:914`) or `.card-title` (`:717`): 17–20px, weight 600, `-0.01em`.
- Group headers `<h3>` — reuse `.subsection-label` (`:1995`): 11px, uppercase, `letter-spacing .5px`, `--color-text-muted`, with the count.

**Attention items → typed accent cards** (reuse the Feed's per-type left-accent + tinted-bg pattern exactly — observation/summary/prompt cards already do this):

| Attention type | Accent family (existing) | Border / bg tokens |
|---|---|---|
| escalation | error (red) | `--color-accent-error` accent; tinted error bg |
| blocker | summary (amber) | `--color-border-summary` / `--color-bg-summary` |
| review | observation (blue) | `--color-border-observation` / `--color-bg-observation` |
| question | prompt (purple) | `--color-border-prompt` / `--color-bg-prompt` |

This maps the four attention types onto the four semantic color families the viewer **already** ships — zero new color decisions, and it makes type legible at a glance without reading text.

**Urgency** — `.mc-urgency-high|normal|low`: a chip with icon+text (`● HIGH`), not a color-only signal. High = error accent; normal/low = muted.

**Type/count badges** — reuse `.card-type` (`:663`) and `.mc-badge` "Unsynthesized" → reuse `.summary-badge` (`:890`).

**Provenance / meta** (project, session, timestamps) — reuse `.card-meta` (`:806`): 11px monospace, `--color-text-tertiary`.

**Links** — inherit `.welcome-modal-footer a` treatment (`:1242`): `--color-accent-primary`, no underline, underline on hover; **add** `:focus-visible { box-shadow: var(--shadow-focus) }` (the token exists; the pattern currently only styles hover — see a11y §9).

**View toggle** (`.view-toggle` in `App.tsx`) — reuse the `.view-mode-toggle` pattern (`:732`): tertiary bg, active = `--color-accent-primary` bg + button text. Add `aria-pressed`.

**States**
- `.mc-loading` / `.mc-error` — wrap in a `.mc-pane` card (not a bare div). Error uses `--color-accent-error`. Loading reuses `.spinner` (`:1288`).
- `.mc-note` (gh-unavailable, spec-deferred) — a muted info banner: `--color-bg-stat`, `1px border-primary`, `radius 6px`, `--color-text-secondary`, 12px. Keep both existing notes verbatim; they're good degradation copy.
- Empty states — keep current copy, style as centered `--color-text-muted` inside the pane.

**Motion** — reuse `slideIn` (`:631`) on cards; respect `prefers-reduced-motion` (the viewer currently doesn't gate its animations — add the guard here, §9).

**Theme** — every value above is a token that already has light + dark + system-preference variants (`viewer-template.html:18-296`). Using tokens = dark mode is free. No `dark:`-style overrides needed; do **not** hardcode hex.

### Signal-over-noise pass (cross-pane)

- Attention ordered escalation→blocker→review→question; empty groups don't render.
- Progress: outcome-first, obs-count demoted, projects collapsed by default except the active one.
- Next-steps: keep the dedup (`NextStepsFeed.ts`), keep the `Unsynthesized` badge, but **group by project** and cap the initial render (e.g. 8) with a "show more" — 200 deduped next-steps is its own wall. Add per-item project + relative time via `.card-meta`.

---

## 6. Consolidated worklist for Planner / Architect

**Render-only (no data-layer change) — the bulk of the polish:**

1. Write the entire `.mc-*` / `.mission-control` / `.view-toggle` stylesheet in `viewer-template.html`, mapping to existing tokens (§5, §8).
2. Attention: group headers with counts, typed accent cards, ordering, empty-group hiding (§2, §5).
3. Attention links: build PR/spec/question anchors client-side from `ref` + the route-provided `repoWebBase`/`defaultBranch` (§2).
4. Escalation card: remediation **catalog** (new static content), fail-closed filter, four-field layout, urgency chip, copy-command button (§3).
5. Progress: collapse `agent_id`→team, render `byType` as the outcome line with existing icons, range selector wired to the existing `sinceEpoch` param, demote obs count (§4).
6. Next-steps: group by project, cap + show-more, add meta (§5).
7. A11y + reduced-motion pass across all three panes (§9).

**Data-layer (Planner: these need query/miner/route changes; Architect: the escalation-context + link-base seams):**

| Item | Where | Size |
|---|---|---|
| Return `repoWebBase` + `defaultBranch` on `/attention` (resolve via git/gh boundary) | `MissionControlRoutes.ts`, `shell.ts` | tiny |
| Escalation: widen observation `SELECT` to include `agent_type`, `agent_id`, `memory_session_id`, `created_at_epoch`; thread through `UpsertInput` → item (columns already exist on the table) | `AttentionMiner.ts:126`, `attention-items.ts` | small |
| Escalation: `last_seen_epoch` refresh + `occurrence_count` (new columns or read-time COUNT) | `attention-items.ts`, `SessionStore.ts` migration | small–moderate |
| Escalation: put the real error snippet into `summary` (or new field) instead of the generic string | `AttentionMiner.ts:139` | tiny |
| Progress: add `project` to `SELECT`/`GROUP BY` + `ProgressBucket` | `ProgressQuery.ts` | small |
| Progress: `COUNT(DISTINCT memory_session_id)` per group (sessions) | `ProgressQuery.ts` | small |
| Progress: PRs-touched = parse `#N` refs from observation text/title/narrative, distinct per group (the D4 parser the spec earmarked) | new shared unit + `ProgressQuery.ts` | moderate |
| Progress: files-touched from `files_modified` *(optional / deferrable)* | `ProgressQuery.ts` | moderate |

All data-layer items stay inside Phase 1's "read/mine engine, no LLM, no queue writes" boundary. None touch `BUILDER_QUEUE.md`, the emit channel, or synthesis. The escalation-context capture and the `repoWebBase` seam are the two worth an Architect glance because they set the shape other phases will reuse (the `#N` parser especially — Phase 3 linkage needs the same one).

---

## 7. Before / After summary (Mark's examples)

**Progress**

```
BEFORE                                AFTER
2026-07-16 · builder · 30 obs         claude-mem
2026-07-16 · builder · 46 obs           builder   3 sessions
2026-07-16 · builder · 52 obs             4 features · 6 bugfixes · 2 decisions
2026-07-16 · planner · 12 obs             3 PRs · #22 #17 #14 · 18 files · 128 obs
2026-07-15 · builder · 41 obs           planner   1 session
2026-07-15 · tester  ·  8 obs             1 decision · 2 discoveries · 1 PR #24
                                          tester    2 sessions · no outcomes · 8 obs
```

**Escalation**

```
BEFORE                                AFTER
Error signature detected: eaddrinuse  ● HIGH  Port already in use (EADDRINUSE)
                                      "listen EADDRINUSE :::37777"
                                      where  claude-mem · builder team · session a1c8… ↗
                                      when   3× in last 24h · latest 2:41pm
                                      fix    Stale worker holds :37777. `claude-mem restart` ⧉ → docs ↗
```

**Attention (review)**

```
BEFORE                                          AFTER
PR #22 awaiting review: Merge upstream v13.11   ↳ PR #22 · Merge upstream v13.11.0   open ↗  claude-mem
```

---

## 8. Tokens — none new

Everything maps to tokens already defined in `viewer-template.html:18-296` (light, dark, and system-preference triplets all present):

| Need | Existing token |
|---|---|
| Pane surface | `--color-bg-card`, `--color-border-primary` |
| Escalation accent | `--color-accent-error` |
| Review accent | `--color-border-observation`, `--color-bg-observation` |
| Question accent | `--color-border-prompt`, `--color-bg-prompt` |
| Blocker accent | `--color-border-summary`, `--color-bg-summary` |
| Group header text | `--color-text-muted` |
| Provenance meta | `--color-text-tertiary`, `--font-terminal` |
| Links | `--color-accent-primary` |
| Focus ring | `--shadow-focus` |
| "Unsynthesized" / count badges | `--color-type-badge-*`, `--color-summary-badge-*` |

If Planner finds a genuine gap while implementing, that's a `tokens.md` justification back to Designer — do not hardcode hex in the panes.

---

## 9. Accessibility checklist (applies to all three panes)

- **Not color alone:** urgency and attention-type carry an icon + text label, never just an accent color.
- **Collapsibles:** implemented as `<button aria-expanded>` (or `<details>`), keyboard-operable, chevron rotation mirrors state (reuse `.chevron-icon.rotated`).
- **Links:** `:focus-visible { box-shadow: var(--shadow-focus) }` on every anchor and the copy-command button; the token exists but is not currently applied to text links.
- **View toggle & range selector:** `aria-pressed` on the active segment; arrow-key navigation between segments is a nice-to-have.
- **Reduced motion:** wrap `slideIn`/`fadeIn`/spinner in `@media (prefers-reduced-motion: reduce)` (the viewer does not currently guard motion — add it for this surface).
- **New-tab links:** `rel="noopener noreferrer"`; the affordance text ("open ↗") signals the new tab, not color/icon alone.
- **Contrast:** all token pairs above already meet the viewer's existing contrast in both themes; the escalation error-bg tint must keep the quoted error line at `--color-text-primary` legibility.

---

## 10. Open questions for Mark

1. **Escalation granularity** — one card per error *class* with a "+N others" for multi-team hits (my recommendation, quieter), or one card per *(class, session)* so each blocked team is its own row (louder, more explicit)? Default in this handoff: per-class.
2. **Progress default range** — 7 days is my default. Prefer Today, or a "since last opened" marker?
3. **Link affordance** — uniform `open ↗` everywhere (simpler), or type-specific `github ↗` for PRs vs `view ↗` for files (more informative)? Default: uniform.
4. **Files-touched** in the progress rollup — worth it in this pass, or defer? It's the one moderate data-layer item with the least payoff. Default: defer.
5. **PRs-touched parser** — confirm the `#N` convention to match (bare `#22`, `PR #22`, `row #22`)? The spec's D4 lists `#N` / `row #N` / `PR #N`; escalation to Architect if the ambiguity between roadmap-row `#N` and PR `#N` matters here.

---

## 11. Next step

On Mark's approval, this hands to **Planner** for the implementation plan (render-only items can ship as one PR; the data-layer items in §6 as a second), with an **Architect** glance at the escalation-context capture and the `repoWebBase`/`#N`-parser seams (both are reused by later phases). Polisher validates the final `.mc-*` stylesheet against this handoff's token map before merge.
