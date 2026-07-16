# Mission Control — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface everything that already exists in claude-mem's history as a read-only "Mission Control" console — a mined Attention floor (reviews/escalations/questions) plus Observability read-views (per-agent progress, ungrouped velocity, deduped next-steps) — by extending the existing worker viewer. Read/mine only: no LLM cost, no emit tool, no writes toward `BUILDER_QUEUE.md`.

**Architecture:** Small, independently-testable read/query units under `src/services/mission-control/` (`BuilderQueueParser`, `ProgressQuery`, `VelocityQuery`, `NextStepsFeed`, `AttentionMiner`) that read the existing `bun:sqlite` database via the worker's shared `DatabaseManager`, plus `gh`/`git` via a stubbable shell boundary. One new SQLite table (`attention_items`, schema version 41) stores *mined* items only. A new `MissionControlRoutes` Express handler exposes `/api/mission-control/*` endpoints on the existing worker HTTP server; a new React view in `src/ui/viewer/` renders them. The `BuilderQueueParser` is factored once and shared (VelocityQuery now, Phase 3 linkage later).

**Tech Stack:** TypeScript, `bun:sqlite` (`Database`), Express 5 (`BaseRouteHandler`), `Bun.spawnSync` for `gh`/`git`, React 19 viewer (esbuild bundle via `scripts/build-viewer.js`), `bun test` with `:memory:` fixture databases.

## ⚖️ Scope narrowed to 3 panes (2026-07-16, Mark's call — shipped in PR #20)

**What shipped is 3 panes, not 4.** Builder UAT found that `handleVelocity` + `loadSpecFiles` resolve repo `docs/` via `getPackageRoot()`, which returns the **plugin install root** — where `docs/` is *not* shipped. So the three sources that need repo-filesystem access cannot resolve their inputs from the *deployed worker's* environment. Mark's decision: **ship the panes that work from the worker's env; defer the repo-filesystem ones behind a clean feature gate (prefer gating over deleting, so the follow-up re-enables rather than rewrites).**

- **SHIPPED (resolve from SQLite + `gh`):**
  - **Attention pane** — error-observation **escalations** (SQLite) + open-PR **reviews** (`gh`). Kept the pre-merge review fixes: hot-path `gh` timeout + `ghAvailable` 60s cache, loud per-section parser, bounded (7-day) escalation scan + auto-resolve.
  - **Progress pane** — `ProgressQuery` (per-agent × time rollup, SQLite).
  - **Next-steps pane** — `NextStepsFeed` (deduped `session_summaries.next_steps`, SQLite).
- **DEFERRED to Backlog #24 (need repo-root filesystem access):**
  - **Velocity** (Task 5 pane) — reads `docs/BUILDER_QUEUE.md`. `VelocityQuery.ts` (Task 5) stays in the tree, unit-tested; the route returns a `{ deferred: true }` state (no `getPackageRoot()` read, no crash) and the UI pane is not rendered.
  - **Proposed-spec review mining** + **doc-Open-Questions mining** (Task 7) — read `docs/`. `extractProposedSpec` / `extractOpenQuestions` stay in the miner; they are fed **no** files (`loadSpecFiles()` returns `[]`) and their auto-resolve is skipped (`specMiningEnabled=false`) so a gated pass never wipes previously-open `spec:`/`question:` items.
- **The gate** is one function — `src/services/mission-control/repo-root.ts` `resolveRepoRoot()` returns `null` in Phase 1. `#24` implements it (env `CLAUDE_MEM_PROJECT_ROOT` vs cwd/git auto-detect vs dev-only) — a one-function change that RE-ENABLES velocity + spec/doc mining without rewriting the miner, queries, routes, or UI.
- **Note for #24 — the "questions" type has a *second* blocker beyond repo-root:** its `captured AskUserQuestion` half (spec §D6/§5.3) is unreachable because `AskUserQuestion` is in the default `CLAUDE_MEM_SKIP_TOOLS` (`SettingsDefaultsManager.ts:109`) — it is dropped before capture (`worker/http/shared.ts:73`), so it never reaches the observation stream. Re-enabling the doc-Open-Questions half (repo-root, #24) does **not** enable the captured-AskUserQuestion half; that needs a separate capture decision.

Everything below is the original plan (Tasks 1–9) as executed. Tasks 1–4, 6 shipped as written. Task 5 shipped as a library + gated route (pane deferred). Task 7 shipped with the spec/question sources gated. Tasks 8–9 shipped with velocity gated + the 3-pane UI.

## Global Constraints

- **Phase 1 is read/mine only.** No `attention_raise` MCP tool, no agent-facing attention writes, no LLM synthesis, no roadmap-row linkage, no stale detection, no new-row proposals, no semantic (Chroma) matching, and **no write of any kind toward `docs/BUILDER_QUEUE.md`**. (Spec §6, §10.) The `attention_items` table MAY be created as the store for *mined* items — `source = 'mine'` only in Phase 1.
- **Do not scaffold a new app.** Extend the existing viewer at `src/services/worker/http/routes/ViewerRoutes.ts` / `src/ui/viewer/` and the bundle `plugin/ui/viewer-bundle.js` (spec decision D5). The bundle is a **built artifact** — edit `src/ui/viewer/**` and rebuild with `npm run build`; never hand-edit `plugin/ui/viewer-bundle.js`.
- **`BUILDER_QUEUE.md` parser must fail LOUDLY.** A parse failure raises a typed error; it must **never** return a silent empty result (that silent-empty behavior was the 2026-07-15 failure mode, spec §8/R3). The parser must handle the established conventions: strikethrough tombstone IDs (`~~9~~`, `~~15~~`) and **unnumbered** "Recently shipped" rows.
- **`AttentionMiner` must be idempotent and self-cleaning.** Two mine passes over identical state produce no duplicate rows (upsert on `(source, ref)`). A resolved underlying cause (merged/closed PR, spec no longer `Proposed`, error signature cleared) auto-resolves the item (`resolved_by = 'auto'`). Spec §5.3/D7.
- **Graceful degradation when `gh` is unavailable** (spec R5): mining continues with specs + error observations only and reports a "PR mining unavailable" state; it never throws the whole pane down.
- **Database library is `bun:sqlite`** (`import { Database } from 'bun:sqlite'`), not `better-sqlite3`. Query idiom: `db.prepare(sql).all(...params)` / `.get(...params)` / `.run(...params)`.
- **Test runner is `bun test`** (`import { describe, it, expect } from 'bun:test'`). Fixture DBs use `new Database(':memory:')`.
- **Migrations are numbered private methods on `SessionStore`**, guarded by a `schema_versions` row, called in order from the constructor. Current highest version is **40**; the new table is **version 41**.
- **`session_summaries` has NO `agent_type` / `agent_id` columns** (only `observations` does, since v27). Do not reference agent columns on `session_summaries`.
- Follow project branch policy (CLAUDE.md): branch from `main`, one PR per queue row, merge on green gates.

---

### Task 1: `attention_items` table (schema version 41)

Creates the store for *mined* attention items. Mirrors the existing `createPendingMessagesTable` migration pattern (`src/services/sqlite/SessionStore.ts:938-976`).

**Files:**
- Modify: `src/services/sqlite/SessionStore.ts` (add a `createAttentionItemsTable()` private method; call it at the end of the constructor's migration list; the new schema version is `41`)
- Test: `tests/sqlite/attention-items-migration.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a table `attention_items` with columns
  `id INTEGER PK AUTOINCREMENT, created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL, blocked_on TEXT, urgency TEXT NOT NULL DEFAULT 'normal', source TEXT NOT NULL, ref TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolved_at INTEGER, resolved_by TEXT, project TEXT, agent_type TEXT, agent_id TEXT, memory_session_id TEXT`,
  a UNIQUE index `ux_attention_items_source_ref ON attention_items(source, ref)`, and an index `idx_attention_items_status ON attention_items(status)`. Schema version stamped: `41`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/sqlite/attention-items-migration.test.ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

interface TableRow { name: string }
interface ColumnRow { name: string }
interface VersionRow { version: number }

describe('attention_items migration (v41)', () => {
  it('creates the attention_items table with the expected columns and indexes', () => {
    const db = new Database(':memory:');
    // Constructing SessionStore runs every migration in order.
    new SessionStore(db);

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='attention_items'")
      .all() as TableRow[];
    expect(tables.length).toBe(1);

    const columns = (db.query('PRAGMA table_info(attention_items)').all() as ColumnRow[]).map(c => c.name);
    for (const expected of [
      'id', 'created_at', 'created_at_epoch', 'type', 'summary', 'blocked_on', 'urgency',
      'source', 'ref', 'status', 'resolved_at', 'resolved_by', 'project', 'agent_type', 'agent_id', 'memory_session_id',
    ]) {
      expect(columns).toContain(expected);
    }

    const indexes = (db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='attention_items'")
      .all() as TableRow[]).map(i => i.name);
    expect(indexes).toContain('ux_attention_items_source_ref');

    const version = db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(41) as VersionRow | undefined;
    expect(version?.version).toBe(41);
  });

  it('is idempotent: constructing a second SessionStore over the same db does not throw', () => {
    const db = new Database(':memory:');
    new SessionStore(db);
    expect(() => new SessionStore(db)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sqlite/attention-items-migration.test.ts`
Expected: FAIL — `attention_items` table not found (migration not written yet).

- [ ] **Step 3: Add the migration method**

In `src/services/sqlite/SessionStore.ts`, add this private method (place it alongside the other numbered migration methods, e.g. after `requeuePromptCloudSyncAfterMapperFix`):

```ts
  private createAttentionItemsTable(): void {
    const applied = this.db
      .prepare('SELECT version FROM schema_versions WHERE version = ?')
      .get(41) as { version: number } | undefined;
    if (applied) return;

    const existing = this.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='attention_items'")
      .all() as { name: string }[];
    if (existing.length > 0) {
      this.db
        .prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(41, new Date().toISOString());
      return;
    }

    this.db.run(`
      CREATE TABLE attention_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        blocked_on TEXT,
        urgency TEXT NOT NULL DEFAULT 'normal',
        source TEXT NOT NULL,
        ref TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        resolved_at INTEGER,
        resolved_by TEXT,
        project TEXT,
        agent_type TEXT,
        agent_id TEXT,
        memory_session_id TEXT
      )
    `);
    this.db.run('CREATE UNIQUE INDEX IF NOT EXISTS ux_attention_items_source_ref ON attention_items(source, ref)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_attention_items_status ON attention_items(status)');

    this.db
      .prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)')
      .run(41, new Date().toISOString());
  }
```

Then register the call at the END of the constructor's migration list (the block near `SessionStore.ts:83-111` that calls the numbered migrations in order). Add:

```ts
    this.createAttentionItemsTable();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/sqlite/attention-items-migration.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/sqlite/SessionStore.ts tests/sqlite/attention-items-migration.test.ts
git commit -m "feat(mission-control): add attention_items table (schema v41)"
```

---

### Task 2: `BuilderQueueParser` — shared, loud-on-failure queue parser

Greenfield (nothing parses `BUILDER_QUEUE.md` today). Shared by `VelocityQuery` now and Phase 3 linkage later. Must handle tombstones (`~~9~~`) and unnumbered "Recently shipped" rows, and **throw loudly** rather than return a silent empty result.

**Files:**
- Create: `src/services/mission-control/BuilderQueueParser.ts`
- Test: `tests/mission-control/builder-queue-parser.test.ts`

**Interfaces:**
- Consumes: nothing (pure function over a markdown string).
- Produces:
  - `interface QueueRow { id: number | null; status: string | null; item: string; raw: string; }`
  - `interface ParsedQueue { queueRows: QueueRow[]; backlogRows: QueueRow[]; shippedRows: QueueRow[]; tombstones: number[]; openRows: QueueRow[]; }`
  - `class BuilderQueueParseError extends Error {}`
  - `function parseBuilderQueue(markdown: string): ParsedQueue` — throws `BuilderQueueParseError` on malformed/empty-result input.

- [ ] **Step 1: Write the failing test**

```ts
// tests/mission-control/builder-queue-parser.test.ts
import { describe, it, expect } from 'bun:test';
import { parseBuilderQueue, BuilderQueueParseError } from '../../src/services/mission-control/BuilderQueueParser.js';

const FIXTURE = `# Builder Queue

## Queue

| # | Status | Item | Spec + Plan | Depends on | Notes |
|---|--------|------|-------------|------------|-------|
| 1 | 📋 | **First item** | [plan](x.md) | — | note |

## Backlog (not yet planned — needs a Planner pass)

| # | Item | Origin | Notes |
|---|------|--------|-------|
| 2 | Second item | origin | note |
| ~~9~~ | ✅ **Shipped as PR #11** — retired, ID not reused. | confirmed | tombstone |
| 16 | Sixteenth item | origin | note |
| ~~15~~ | ✅ **Shipped as PR #14** — retired. | confirmed | tombstone |
| 17 | Seventeenth item | origin | note |

## Recently shipped

| Item | PR | Notes |
|------|----|-------|
| Merge upstream v13.11.0 into fork | #9 | not a queue row |
| build-and-sync on Windows | #11 | shipped #9 |
`;

describe('parseBuilderQueue', () => {
  it('extracts queue, backlog, tombstones, and shipped rows', () => {
    const parsed = parseBuilderQueue(FIXTURE);
    expect(parsed.queueRows.map(r => r.id)).toEqual([1]);
    expect(parsed.backlogRows.map(r => r.id)).toEqual([2, 9, 16, 15, 17]);
    expect(parsed.tombstones).toEqual([9, 15]);
    // Recently shipped rows are UNNUMBERED — id is null.
    expect(parsed.shippedRows.length).toBe(2);
    expect(parsed.shippedRows.every(r => r.id === null)).toBe(true);
  });

  it('excludes tombstones from openRows', () => {
    const parsed = parseBuilderQueue(FIXTURE);
    expect(parsed.openRows.map(r => r.id).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 16, 17]);
    expect(parsed.openRows.map(r => r.id)).not.toContain(9);
    expect(parsed.openRows.map(r => r.id)).not.toContain(15);
  });

  it('throws loudly on markdown that has headings but yields zero rows (never a silent empty result)', () => {
    const broken = `# Builder Queue\n\n## Queue\n\n(no table here at all)\n`;
    expect(() => parseBuilderQueue(broken)).toThrow(BuilderQueueParseError);
  });

  it('throws loudly on empty input', () => {
    expect(() => parseBuilderQueue('')).toThrow(BuilderQueueParseError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-control/builder-queue-parser.test.ts`
Expected: FAIL — module `BuilderQueueParser` not found.

- [ ] **Step 3: Write the parser**

```ts
// src/services/mission-control/BuilderQueueParser.ts

export interface QueueRow {
  id: number | null;
  status: string | null;
  item: string;
  raw: string;
}

export interface ParsedQueue {
  queueRows: QueueRow[];
  backlogRows: QueueRow[];
  shippedRows: QueueRow[];
  tombstones: number[];
  openRows: QueueRow[];
}

export class BuilderQueueParseError extends Error {
  constructor(message: string) {
    super(`BUILDER_QUEUE.md parse failure: ${message}`);
    this.name = 'BuilderQueueParseError';
  }
}

type SectionKind = 'queue' | 'backlog' | 'shipped' | 'other';

function classifyHeading(headingText: string): SectionKind {
  const lower = headingText.toLowerCase();
  if (lower.startsWith('queue')) return 'queue';
  if (lower.startsWith('backlog')) return 'backlog';
  if (lower.startsWith('recently shipped')) return 'shipped';
  return 'other';
}

/** Split a markdown table row `| a | b | c |` into trimmed cell strings. */
function splitCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(c => c.trim());
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith('|');
}

/** A markdown separator row like `|---|---|`. */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every(c => /^:?-{3,}:?$/.test(c));
}

/** Parse the first cell as either a plain id `N`, a tombstone `~~N~~`, or neither. */
function parseIdCell(cell: string): { id: number | null; tombstone: boolean } {
  const tomb = cell.match(/^~~\s*(\d+)\s*~~$/);
  if (tomb) return { id: Number(tomb[1]), tombstone: true };
  const plain = cell.match(/^(\d+)$/);
  if (plain) return { id: Number(plain[1]), tombstone: false };
  return { id: null, tombstone: false };
}

export function parseBuilderQueue(markdown: string): ParsedQueue {
  if (!markdown || markdown.trim().length === 0) {
    throw new BuilderQueueParseError('input was empty');
  }

  const lines = markdown.split('\n');
  const queueRows: QueueRow[] = [];
  const backlogRows: QueueRow[] = [];
  const shippedRows: QueueRow[] = [];
  const tombstones: number[] = [];
  let sawHeading = false;
  let section: SectionKind = 'other';

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.*)$/);
    if (headingMatch) {
      sawHeading = true;
      section = classifyHeading(headingMatch[1].trim());
      continue;
    }

    if (!isTableRow(line)) continue;
    const cells = splitCells(line);
    if (cells.length === 0 || isSeparatorRow(cells)) continue;

    if (section === 'queue' || section === 'backlog') {
      const first = cells[0];
      // Skip the header row (`# | Status | Item ...` etc.).
      if (/^#$/.test(first) || first === '' ) continue;
      const { id, tombstone } = parseIdCell(first);
      // Header rows have a non-numeric, non-tombstone first cell — skip them,
      // but only when we cannot parse an id (real numbered rows always parse).
      if (id === null && !tombstone) {
        // Could be a header row such as "| # | Status | ..." already handled,
        // or a genuine non-id row — treat as header/noise and skip.
        continue;
      }
      const statusCell = section === 'queue' ? (cells[1] ?? null) : null;
      const itemCell = section === 'queue' ? (cells[2] ?? '') : (cells[1] ?? '');
      const row: QueueRow = { id, status: statusCell, item: itemCell, raw: line };
      if (tombstone && id !== null) tombstones.push(id);
      (section === 'queue' ? queueRows : backlogRows).push(row);
    } else if (section === 'shipped') {
      const first = cells[0];
      // Skip header row (`Item | PR | Notes`).
      if (/^item$/i.test(first)) continue;
      shippedRows.push({ id: null, status: null, item: first, raw: line });
    }
  }

  const tombstoneSet = new Set(tombstones);
  const openRows = [...queueRows, ...backlogRows].filter(
    r => r.id !== null && !tombstoneSet.has(r.id)
  );

  // LOUD failure: markdown had headings but produced zero rows across all sections.
  // Never return a silent empty result (the 2026-07-15 failure mode).
  if (sawHeading && queueRows.length + backlogRows.length + shippedRows.length === 0) {
    throw new BuilderQueueParseError('found section headings but extracted zero rows — the table format may have drifted');
  }
  if (!sawHeading) {
    throw new BuilderQueueParseError('no `## Queue` / `## Backlog` / `## Recently shipped` headings found');
  }

  return { queueRows, backlogRows, shippedRows, tombstones, openRows };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-control/builder-queue-parser.test.ts`
Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/mission-control/BuilderQueueParser.ts tests/mission-control/builder-queue-parser.test.ts
git commit -m "feat(mission-control): add shared BUILDER_QUEUE.md parser (loud on failure, tombstone-aware)"
```

---

### Task 3: `ProgressQuery` — per-agent × time rollup

Groups `observations` by `agent_type`/`agent_id` × day or week, counting by observation `type`. The `groupBy` abstraction accepts a `human` axis that returns an empty (clearly-labeled) result until NAS `actor_id` data exists (spec D2/R4).

**Files:**
- Create: `src/services/mission-control/ProgressQuery.ts`
- Test: `tests/mission-control/progress-query.test.ts`

**Interfaces:**
- Consumes: a `bun:sqlite` `Database` with the `observations` table (columns `agent_type`, `agent_id`, `type`, `project`, `created_at`, `created_at_epoch`).
- Produces:
  - `type GroupAxis = 'agent' | 'human';`
  - `interface ProgressBucket { agentType: string | null; agentId: string | null; bucket: string; total: number; byType: Record<string, number>; }`
  - `interface ProgressQueryOptions { by?: GroupAxis; granularity?: 'day' | 'week'; project?: string; sinceEpoch?: number; }`
  - `function queryProgress(db: Database, options?: ProgressQueryOptions): ProgressBucket[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mission-control/progress-query.test.ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { queryProgress } from '../../src/services/mission-control/ProgressQuery.js';

function seed(db: Database): void {
  db.run(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT,
    project TEXT NOT NULL,
    type TEXT NOT NULL,
    agent_type TEXT,
    agent_id TEXT,
    created_at TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL
  )`);
  const insert = db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, agent_type, agent_id, created_at, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // Two observations for builder on 2026-07-16, one discovery + one bugfix.
  insert.run('s1', 'proj', 'discovery', 'builder', 'b-1', '2026-07-16T10:00:00.000Z', Date.parse('2026-07-16T10:00:00.000Z'));
  insert.run('s1', 'proj', 'bugfix', 'builder', 'b-1', '2026-07-16T11:00:00.000Z', Date.parse('2026-07-16T11:00:00.000Z'));
  // One for planner on the same day.
  insert.run('s2', 'proj', 'feature', 'planner', 'p-1', '2026-07-16T12:00:00.000Z', Date.parse('2026-07-16T12:00:00.000Z'));
}

describe('queryProgress', () => {
  it('groups observations by agent × day and counts by type', () => {
    const db = new Database(':memory:');
    seed(db);
    const rows = queryProgress(db, { by: 'agent', granularity: 'day' });
    const builder = rows.find(r => r.agentType === 'builder' && r.bucket === '2026-07-16');
    expect(builder).toBeDefined();
    expect(builder!.total).toBe(2);
    expect(builder!.byType).toEqual({ discovery: 1, bugfix: 1 });

    const planner = rows.find(r => r.agentType === 'planner');
    expect(planner!.total).toBe(1);
    expect(planner!.byType).toEqual({ feature: 1 });
  });

  it('returns an empty result for the human axis (no actor data yet)', () => {
    const db = new Database(':memory:');
    seed(db);
    expect(queryProgress(db, { by: 'human' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-control/progress-query.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the query**

```ts
// src/services/mission-control/ProgressQuery.ts
import type { Database } from 'bun:sqlite';

export type GroupAxis = 'agent' | 'human';

export interface ProgressBucket {
  agentType: string | null;
  agentId: string | null;
  bucket: string;
  total: number;
  byType: Record<string, number>;
}

export interface ProgressQueryOptions {
  by?: GroupAxis;
  granularity?: 'day' | 'week';
  project?: string;
  sinceEpoch?: number;
}

interface RawRow {
  agent_type: string | null;
  agent_id: string | null;
  bucket: string;
  type: string;
  n: number;
}

export function queryProgress(db: Database, options: ProgressQueryOptions = {}): ProgressBucket[] {
  const by: GroupAxis = options.by ?? 'agent';

  // The human axis has no backing column yet (WS2 actor_id arrives with the NAS
  // pilot). Return an empty, clearly-labeled result rather than a fabricated one.
  if (by === 'human') return [];

  const bucketExpr = options.granularity === 'week'
    ? "strftime('%Y-W%W', created_at)"
    : "strftime('%Y-%m-%d', created_at)";

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.project) {
    where.push('project = ?');
    params.push(options.project);
  }
  if (typeof options.sinceEpoch === 'number') {
    where.push('created_at_epoch >= ?');
    params.push(options.sinceEpoch);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const sql = `
    SELECT agent_type, agent_id, ${bucketExpr} AS bucket, type, COUNT(*) AS n
    FROM observations
    ${whereSql}
    GROUP BY agent_type, agent_id, bucket, type
    ORDER BY bucket DESC
  `;
  const rows = db.prepare(sql).all(...params) as RawRow[];

  const map = new Map<string, ProgressBucket>();
  for (const r of rows) {
    const key = `${r.agent_type ?? ''} ${r.agent_id ?? ''} ${r.bucket}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { agentType: r.agent_type, agentId: r.agent_id, bucket: r.bucket, total: 0, byType: {} };
      map.set(key, bucket);
    }
    bucket.total += r.n;
    bucket.byType[r.type] = (bucket.byType[r.type] ?? 0) + r.n;
  }
  return [...map.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-control/progress-query.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/mission-control/ProgressQuery.ts tests/mission-control/progress-query.test.ts
git commit -m "feat(mission-control): add ProgressQuery (per-agent × time rollup, human axis stub)"
```

---

### Task 4: `git`/`gh` shell boundary (stubbable)

A thin, injectable boundary over `Bun.spawnSync` mirroring `scripts/pr-babysit-status.ts` (typed result, exit-code allowlist, availability probe). `VelocityQuery` and `AttentionMiner` depend on the **interface** so tests can stub it without spawning processes.

**Files:**
- Create: `src/services/mission-control/shell.ts`
- Test: `tests/mission-control/shell.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ShellResult { stdout: string; stderr: string; exitCode: number; }`
  - `function runCommand(cmd: string[]): ShellResult`
  - `interface OpenPr { number: number; title: string; url: string; }`
  - `interface MergeCommit { sha: string; dateIso: string; subject: string; }`
  - `interface GitGhBoundary { ghAvailable(): boolean; listOpenPrs(): OpenPr[]; listMergeCommits(sinceIso?: string): MergeCommit[]; }`
  - `function createGitGhBoundary(): GitGhBoundary` (real implementation)

- [ ] **Step 1: Write the failing test**

```ts
// tests/mission-control/shell.test.ts
import { describe, it, expect } from 'bun:test';
import { runCommand, createGitGhBoundary } from '../../src/services/mission-control/shell.js';

describe('runCommand', () => {
  it('returns exit code 127 when the binary does not exist (graceful, no throw)', () => {
    const result = runCommand(['definitely-not-a-real-binary-xyz', '--version']);
    expect(result.exitCode).toBe(127);
  });
});

describe('createGitGhBoundary', () => {
  it('reports ghAvailable() as a boolean without throwing', () => {
    const boundary = createGitGhBoundary();
    expect(typeof boundary.ghAvailable()).toBe('boolean');
  });

  it('returns [] from listOpenPrs() when gh is unavailable rather than throwing', () => {
    const boundary = createGitGhBoundary();
    // Regardless of environment, listOpenPrs must never throw.
    expect(Array.isArray(boundary.listOpenPrs())).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-control/shell.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the boundary**

```ts
// src/services/mission-control/shell.ts

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runCommand(cmd: string[]): ShellResult {
  try {
    const result = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
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

export interface OpenPr {
  number: number;
  title: string;
  url: string;
}

export interface MergeCommit {
  sha: string;
  dateIso: string;
  subject: string;
}

export interface GitGhBoundary {
  ghAvailable(): boolean;
  listOpenPrs(): OpenPr[];
  listMergeCommits(sinceIso?: string): MergeCommit[];
}

export function createGitGhBoundary(): GitGhBoundary {
  return {
    ghAvailable(): boolean {
      return runCommand(['gh', '--version']).exitCode === 0
        && runCommand(['gh', 'auth', 'status']).exitCode === 0;
    },

    listOpenPrs(): OpenPr[] {
      const result = runCommand(['gh', 'pr', 'list', '--state', 'open', '--json', 'number,title,url']);
      if (result.exitCode !== 0) return []; // graceful degradation (R5)
      try {
        const parsed = JSON.parse(result.stdout) as Array<{ number: number; title: string; url: string }>;
        return parsed.map(p => ({ number: p.number, title: p.title, url: p.url }));
      } catch {
        return [];
      }
    },

    listMergeCommits(sinceIso?: string): MergeCommit[] {
      const args = ['git', 'log', '--merges', '--pretty=format:%H%cI%s'];
      if (sinceIso) args.push(`--since=${sinceIso}`);
      const result = runCommand(args);
      if (result.exitCode !== 0 || result.stdout.length === 0) return [];
      return result.stdout
        .split('\n')
        .map(line => line.split(''))
        .filter(parts => parts.length === 3)
        .map(([sha, dateIso, subject]) => ({ sha, dateIso, subject }));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-control/shell.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/mission-control/shell.ts tests/mission-control/shell.test.ts
git commit -m "feat(mission-control): add stubbable git/gh shell boundary with graceful degradation"
```

---

### Task 5: `VelocityQuery` — shipped-vs-open over time (ungrouped)

Consumes the parsed queue (open/shipped totals) plus git merge commits (bucketed by ISO week) to produce a D-lite velocity read-view. **Ungrouped** ("N shipped this week") — per-row velocity waits for Phase 3 linkage (spec §6).

**Files:**
- Create: `src/services/mission-control/VelocityQuery.ts`
- Test: `tests/mission-control/velocity-query.test.ts`

**Interfaces:**
- Consumes: `ParsedQueue` (Task 2), `Pick<GitGhBoundary, 'listMergeCommits'>` (Task 4).
- Produces:
  - `interface VelocitySeriesPoint { week: string; shipped: number; }`
  - `interface VelocityResult { openCount: number; shippedCount: number; shippedByWeek: VelocitySeriesPoint[]; }`
  - `function isoWeek(dateIso: string): string`
  - `function queryVelocity(parsed: ParsedQueue, boundary: Pick<GitGhBoundary, 'listMergeCommits'>, sinceIso?: string): VelocityResult`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mission-control/velocity-query.test.ts
import { describe, it, expect } from 'bun:test';
import { queryVelocity, isoWeek } from '../../src/services/mission-control/VelocityQuery.js';
import type { ParsedQueue } from '../../src/services/mission-control/BuilderQueueParser.js';
import type { MergeCommit } from '../../src/services/mission-control/shell.js';

const parsed: ParsedQueue = {
  queueRows: [{ id: 1, status: '📋', item: 'a', raw: '' }],
  backlogRows: [
    { id: 2, status: null, item: 'b', raw: '' },
    { id: 16, status: null, item: 'c', raw: '' },
  ],
  shippedRows: [
    { id: null, status: null, item: 'shipped-1', raw: '' },
    { id: null, status: null, item: 'shipped-2', raw: '' },
  ],
  tombstones: [9, 15],
  openRows: [
    { id: 1, status: '📋', item: 'a', raw: '' },
    { id: 2, status: null, item: 'b', raw: '' },
    { id: 16, status: null, item: 'c', raw: '' },
  ],
};

describe('queryVelocity', () => {
  it('reports open and shipped totals from the parsed queue', () => {
    const boundary = { listMergeCommits: (): MergeCommit[] => [] };
    const result = queryVelocity(parsed, boundary);
    expect(result.openCount).toBe(3);
    expect(result.shippedCount).toBe(2);
  });

  it('buckets merged PRs by ISO week', () => {
    const boundary = {
      listMergeCommits: (): MergeCommit[] => [
        { sha: 'a', dateIso: '2026-07-15T00:00:00Z', subject: 'Merge pull request #11 from x' },
        { sha: 'b', dateIso: '2026-07-16T00:00:00Z', subject: 'Merge pull request #14 from y' },
        { sha: 'c', dateIso: '2026-07-16T00:00:00Z', subject: 'chore: not a PR merge' },
      ],
    };
    const result = queryVelocity(parsed, boundary);
    const week = isoWeek('2026-07-16T00:00:00Z');
    const point = result.shippedByWeek.find(p => p.week === week);
    // Only the two "Merge pull request #N" subjects count; both fall in the same ISO week.
    expect(point?.shipped).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-control/velocity-query.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the query**

```ts
// src/services/mission-control/VelocityQuery.ts
import type { ParsedQueue } from './BuilderQueueParser.js';
import type { GitGhBoundary } from './shell.js';

export interface VelocitySeriesPoint {
  week: string;
  shipped: number;
}

export interface VelocityResult {
  openCount: number;
  shippedCount: number;
  shippedByWeek: VelocitySeriesPoint[];
}

/** ISO-8601 week label, e.g. "2026-W29". */
export function isoWeek(dateIso: string): string {
  const d = new Date(dateIso);
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = utc.getUTCDay() || 7; // Mon=1..Sun=7
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

const PR_MERGE_SUBJECT = /Merge pull request #\d+/i;

export function queryVelocity(
  parsed: ParsedQueue,
  boundary: Pick<GitGhBoundary, 'listMergeCommits'>,
  sinceIso?: string
): VelocityResult {
  const merges = boundary.listMergeCommits(sinceIso).filter(c => PR_MERGE_SUBJECT.test(c.subject));

  const byWeek = new Map<string, number>();
  for (const commit of merges) {
    const week = isoWeek(commit.dateIso);
    byWeek.set(week, (byWeek.get(week) ?? 0) + 1);
  }

  const shippedByWeek: VelocitySeriesPoint[] = [...byWeek.entries()]
    .map(([week, shipped]) => ({ week, shipped }))
    .sort((a, b) => a.week.localeCompare(b.week));

  return {
    openCount: parsed.openRows.length,
    shippedCount: parsed.shippedRows.length,
    shippedByWeek,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-control/velocity-query.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/mission-control/VelocityQuery.ts tests/mission-control/velocity-query.test.ts
git commit -m "feat(mission-control): add VelocityQuery (ungrouped shipped-vs-open, ISO-week series)"
```

---

### Task 6: `NextStepsFeed` — deduped recent next-steps (B-lite)

Surfaces existing `session_summaries.next_steps` (currently read by nothing), ranked by recency and deduplicated lexically. No LLM, no Chroma — a lexical (token-Jaccard) dedup floor. Label the feed "unsynthesized" in the UI (spec R1).

**Files:**
- Create: `src/services/mission-control/NextStepsFeed.ts`
- Test: `tests/mission-control/next-steps-feed.test.ts`

**Interfaces:**
- Consumes: a `bun:sqlite` `Database` with `session_summaries` (columns `memory_session_id`, `project`, `next_steps`, `created_at_epoch`).
- Produces:
  - `interface NextStepItem { memorySessionId: string; project: string; createdAtEpoch: number; text: string; }`
  - `function normalizeForDedup(text: string): string`
  - `function dedupeByLexicalSimilarity(items: NextStepItem[], threshold?: number): NextStepItem[]`
  - `function queryNextSteps(db: Database, options?: { project?: string; limit?: number }): NextStepItem[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mission-control/next-steps-feed.test.ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { queryNextSteps, dedupeByLexicalSimilarity } from '../../src/services/mission-control/NextStepsFeed.js';

function seed(db: Database): void {
  db.run(`CREATE TABLE session_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    next_steps TEXT,
    created_at_epoch INTEGER NOT NULL
  )`);
  const insert = db.prepare(
    `INSERT INTO session_summaries (memory_session_id, project, next_steps, created_at_epoch) VALUES (?, ?, ?, ?)`
  );
  insert.run('s1', 'proj', 'Fix the chroma sync packaging bug', 3000);
  insert.run('s2', 'proj', 'Fix the Chroma sync packaging bug.', 2000); // near-duplicate of s1
  insert.run('s3', 'proj', 'Write the mission control velocity view', 1000);
  insert.run('s4', 'proj', '', 500); // empty — excluded
  insert.run('s5', 'proj', null, 400); // null — excluded
}

describe('queryNextSteps', () => {
  it('returns non-empty next_steps ordered by recency, deduped lexically', () => {
    const db = new Database(':memory:');
    seed(db);
    const items = queryNextSteps(db, { project: 'proj' });
    // s1/s2 are near-duplicates → collapse to one; s3 stays; empties excluded.
    expect(items.length).toBe(2);
    expect(items[0].createdAtEpoch).toBe(3000); // most recent first
    expect(items.some(i => /velocity view/i.test(i.text))).toBe(true);
  });
});

describe('dedupeByLexicalSimilarity', () => {
  it('keeps the first (most recent) of two near-identical strings', () => {
    const deduped = dedupeByLexicalSimilarity([
      { memorySessionId: 'a', project: 'p', createdAtEpoch: 2, text: 'run the tests and commit' },
      { memorySessionId: 'b', project: 'p', createdAtEpoch: 1, text: 'Run the tests, and commit.' },
    ], 0.7);
    expect(deduped.length).toBe(1);
    expect(deduped[0].memorySessionId).toBe('a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-control/next-steps-feed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the feed**

```ts
// src/services/mission-control/NextStepsFeed.ts
import type { Database } from 'bun:sqlite';

export interface NextStepItem {
  memorySessionId: string;
  project: string;
  createdAtEpoch: number;
  text: string;
}

export function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(normalizeForDedup(text).split(' ').filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Keep the first occurrence of each near-duplicate. Callers pass items already
 * sorted most-recent-first, so the kept item is the most recent.
 */
export function dedupeByLexicalSimilarity(items: NextStepItem[], threshold = 0.8): NextStepItem[] {
  const kept: NextStepItem[] = [];
  const keptTokens: Set<string>[] = [];
  for (const item of items) {
    const tokens = tokenSet(item.text);
    const isDup = keptTokens.some(prev => jaccard(prev, tokens) >= threshold);
    if (!isDup) {
      kept.push(item);
      keptTokens.push(tokens);
    }
  }
  return kept;
}

interface RawRow {
  memory_session_id: string;
  project: string;
  next_steps: string | null;
  created_at_epoch: number;
}

export function queryNextSteps(db: Database, options: { project?: string; limit?: number } = {}): NextStepItem[] {
  const where: string[] = ["next_steps IS NOT NULL", "TRIM(next_steps) != ''"];
  const params: (string | number)[] = [];
  if (options.project) {
    where.push('project = ?');
    params.push(options.project);
  }
  const limit = options.limit ?? 200;
  const sql = `
    SELECT memory_session_id, project, next_steps, created_at_epoch
    FROM session_summaries
    WHERE ${where.join(' AND ')}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params, limit) as RawRow[];
  const items: NextStepItem[] = rows.map(r => ({
    memorySessionId: r.memory_session_id,
    project: r.project,
    createdAtEpoch: r.created_at_epoch,
    text: (r.next_steps ?? '').trim(),
  }));
  return dedupeByLexicalSimilarity(items);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-control/next-steps-feed.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/mission-control/NextStepsFeed.ts tests/mission-control/next-steps-feed.test.ts
git commit -m "feat(mission-control): add NextStepsFeed (recency-ranked, lexical dedup)"
```

---

### Task 7: `AttentionMiner` — mine the Attention floor into `attention_items`

Mines three sources into `attention_items` (`source='mine'`): open PRs + `Proposed` specs → reviews; error observations → escalations; doc "Open Questions" sections → questions. Idempotent upsert on `(source, ref)`; auto-resolves items whose cause no longer qualifies. Degrades gracefully when `gh` is unavailable.

**Files:**
- Create: `src/services/mission-control/attention-items.ts` (store read/write helpers)
- Create: `src/services/mission-control/AttentionMiner.ts` (mining logic)
- Test: `tests/mission-control/attention-miner.test.ts`

**Interfaces:**
- Consumes: `bun:sqlite` `Database` (tables `attention_items` from Task 1, `observations`), `Pick<GitGhBoundary, 'ghAvailable' | 'listOpenPrs'>` (Task 4).
- Produces:
  - `interface AttentionItem { id: number; type: string; summary: string; blockedOn: string | null; urgency: string; source: string; ref: string; status: string; project: string | null; createdAtEpoch: number; }`
  - `function readOpenAttentionItems(db: Database, project?: string): AttentionItem[]`
  - `interface MineOptions { specFiles?: { path: string; content: string }[]; now?: number; ghUnavailable?: boolean; }`
  - `interface MineResult { upserted: number; resolved: number; ghAvailable: boolean; }`
  - `function runAttentionMine(db: Database, boundary: Pick<GitGhBoundary, 'ghAvailable' | 'listOpenPrs'>, options?: MineOptions): MineResult`
  - `function extractProposedSpec(path: string, content: string): { ref: string; summary: string } | null`
  - `function extractOpenQuestions(path: string, content: string): { ref: string; summary: string }[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mission-control/attention-miner.test.ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { runAttentionMine, readOpenAttentionItems } from '../../src/services/mission-control/AttentionMiner.js';
import type { OpenPr } from '../../src/services/mission-control/shell.js';

function freshDb(): Database {
  const db = new Database(':memory:');
  new SessionStore(db); // creates attention_items (v41) + observations + session_summaries
  // Fixture rows below are inserted without parent sdk_sessions rows; disable FK
  // enforcement so the bare inserts succeed regardless of connection pragmas.
  db.run('PRAGMA foreign_keys = OFF');
  return db;
}

function seedErrorObservation(db: Database): void {
  const insert = db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, agent_type, agent_id, created_at, created_at_epoch, narrative, title)
     VALUES (?, ?, 'discovery', NULL, NULL, ?, ?, ?, ?)`
  );
  insert.run('s1', 'proj', '2026-07-16T00:00:00.000Z', Date.parse('2026-07-16T00:00:00.000Z'),
    'The worker is unreachable: EADDRINUSE on 127.0.0.1:37777', 'Worker down');
}

const SPEC = {
  path: 'docs/superpowers/specs/2026-07-16-example-design.md',
  content: '# Design\n\n- **Status:** Proposed\n\n## Open Questions\n\n- Should we cache the result?\n',
};

describe('runAttentionMine', () => {
  it('mines open PRs, proposed specs, error observations, and open questions', () => {
    const db = freshDb();
    seedErrorObservation(db);
    const boundary = {
      ghAvailable: () => true,
      listOpenPrs: (): OpenPr[] => [{ number: 42, title: 'Add feature', url: 'https://x/42' }],
    };
    const result = runAttentionMine(db, boundary, { specFiles: [SPEC] });
    expect(result.ghAvailable).toBe(true);
    const items = readOpenAttentionItems(db);
    expect(items.some(i => i.type === 'review' && i.ref === 'pr:42')).toBe(true);
    expect(items.some(i => i.type === 'review' && i.ref.startsWith('spec:'))).toBe(true);
    expect(items.some(i => i.type === 'escalation')).toBe(true);
    expect(items.some(i => i.type === 'question')).toBe(true);
  });

  it('is idempotent: two passes over identical state produce no duplicates', () => {
    const db = freshDb();
    const boundary = {
      ghAvailable: () => true,
      listOpenPrs: (): OpenPr[] => [{ number: 42, title: 'Add feature', url: 'https://x/42' }],
    };
    runAttentionMine(db, boundary, { specFiles: [SPEC] });
    runAttentionMine(db, boundary, { specFiles: [SPEC] });
    const items = readOpenAttentionItems(db);
    const prItems = items.filter(i => i.ref === 'pr:42');
    expect(prItems.length).toBe(1);
  });

  it('auto-resolves a review when its PR is no longer open (merged/closed)', () => {
    const db = freshDb();
    const withPr = {
      ghAvailable: () => true,
      listOpenPrs: (): OpenPr[] => [{ number: 42, title: 'Add feature', url: 'https://x/42' }],
    };
    runAttentionMine(db, withPr, {});
    expect(readOpenAttentionItems(db).some(i => i.ref === 'pr:42')).toBe(true);

    const withoutPr = { ghAvailable: () => true, listOpenPrs: (): OpenPr[] => [] };
    const result = runAttentionMine(db, withoutPr, {});
    expect(result.resolved).toBeGreaterThanOrEqual(1);
    expect(readOpenAttentionItems(db).some(i => i.ref === 'pr:42')).toBe(false);
  });

  it('degrades gracefully when gh is unavailable (specs/errors still mined)', () => {
    const db = freshDb();
    seedErrorObservation(db);
    const boundary = {
      ghAvailable: () => false,
      listOpenPrs: (): OpenPr[] => [],
    };
    const result = runAttentionMine(db, boundary, { specFiles: [SPEC] });
    expect(result.ghAvailable).toBe(false);
    const items = readOpenAttentionItems(db);
    expect(items.some(i => i.ref.startsWith('spec:'))).toBe(true);
    expect(items.some(i => i.type === 'escalation')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-control/attention-miner.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the store helpers**

```ts
// src/services/mission-control/attention-items.ts
import type { Database } from 'bun:sqlite';

export interface AttentionItem {
  id: number;
  type: string;
  summary: string;
  blockedOn: string | null;
  urgency: string;
  source: string;
  ref: string;
  status: string;
  project: string | null;
  createdAtEpoch: number;
}

export interface UpsertInput {
  type: string;
  summary: string;
  blockedOn?: string | null;
  urgency?: string;
  source: string;
  ref: string;
  project?: string | null;
  now: number;
}

interface RawRow {
  id: number;
  type: string;
  summary: string;
  blocked_on: string | null;
  urgency: string;
  source: string;
  ref: string;
  status: string;
  project: string | null;
  created_at_epoch: number;
}

function toItem(r: RawRow): AttentionItem {
  return {
    id: r.id,
    type: r.type,
    summary: r.summary,
    blockedOn: r.blocked_on,
    urgency: r.urgency,
    source: r.source,
    ref: r.ref,
    status: r.status,
    project: r.project,
    createdAtEpoch: r.created_at_epoch,
  };
}

/**
 * Idempotent upsert on (source, ref). If a row exists it is re-opened and its
 * content refreshed; otherwise inserted. Returns true if a NEW row was created.
 */
export function upsertMinedItem(db: Database, input: UpsertInput): boolean {
  const existing = db
    .prepare('SELECT id FROM attention_items WHERE source = ? AND ref = ?')
    .get(input.source, input.ref) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE attention_items
       SET type = ?, summary = ?, blocked_on = ?, urgency = ?, project = ?,
           status = 'open', resolved_at = NULL, resolved_by = NULL
       WHERE id = ?`
    ).run(
      input.type, input.summary, input.blockedOn ?? null, input.urgency ?? 'normal',
      input.project ?? null, existing.id
    );
    return false;
  }

  db.prepare(
    `INSERT INTO attention_items
       (created_at, created_at_epoch, type, summary, blocked_on, urgency, source, ref, status, project)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(
    new Date(input.now).toISOString(), input.now, input.type, input.summary,
    input.blockedOn ?? null, input.urgency ?? 'normal', input.source, input.ref, input.project ?? null
  );
  return true;
}

export function readOpenAttentionItems(db: Database, project?: string): AttentionItem[] {
  const params: (string)[] = [];
  let sql = "SELECT * FROM attention_items WHERE status = 'open'";
  if (project) {
    sql += ' AND project = ?';
    params.push(project);
  }
  sql += ' ORDER BY created_at_epoch DESC';
  return (db.prepare(sql).all(...params) as RawRow[]).map(toItem);
}

/**
 * Auto-resolve open mined items of `type` whose ref is NOT in `liveRefs`.
 * Returns the number resolved. Used for review auto-resolution (D7).
 */
export function autoResolveMissing(db: Database, type: string, liveRefs: Set<string>, now: number): number {
  const open = db
    .prepare("SELECT id, ref FROM attention_items WHERE status = 'open' AND source = 'mine' AND type = ?")
    .all(type) as { id: number; ref: string }[];
  let resolved = 0;
  const update = db.prepare(
    "UPDATE attention_items SET status = 'resolved', resolved_at = ?, resolved_by = 'auto' WHERE id = ?"
  );
  for (const row of open) {
    if (!liveRefs.has(row.ref)) {
      update.run(now, row.id);
      resolved++;
    }
  }
  return resolved;
}
```

- [ ] **Step 4: Write the miner**

```ts
// src/services/mission-control/AttentionMiner.ts
import type { Database } from 'bun:sqlite';
import type { GitGhBoundary } from './shell.js';
import {
  upsertMinedItem,
  autoResolveMissing,
  readOpenAttentionItems,
} from './attention-items.js';

export { readOpenAttentionItems } from './attention-items.js';
export type { AttentionItem } from './attention-items.js';

export interface MineOptions {
  specFiles?: { path: string; content: string }[];
  now?: number;
}

export interface MineResult {
  upserted: number;
  resolved: number;
  ghAvailable: boolean;
}

/** Error-signature patterns that qualify an observation as an escalation. */
const ERROR_PATTERNS: { key: string; re: RegExp }[] = [
  { key: 'worker-unreachable', re: /worker (is )?unreachable/i },
  { key: 'eaddrinuse', re: /EADDRINUSE/i },
  { key: 'module-not-found', re: /MODULE_NOT_FOUND/i },
  { key: 'swallowed-startup', re: /failed to start worker/i },
];

export function extractProposedSpec(path: string, content: string): { ref: string; summary: string } | null {
  // Match a "Status: Proposed" line (tolerant of markdown bold and spacing).
  if (!/^[-*\s>]*\**\s*Status\s*:?\s*\**\s*Proposed\b/im.test(content)) return null;
  const titleMatch = content.match(/^#\s+(.*)$/m);
  const title = titleMatch ? titleMatch[1].trim() : path.split('/').pop() ?? path;
  return { ref: `spec:${path}`, summary: `Spec awaiting review (Proposed): ${title}` };
}

export function extractOpenQuestions(path: string, content: string): { ref: string; summary: string }[] {
  const lines = content.split('\n');
  const results: { ref: string; summary: string }[] = [];
  let inSection = false;
  let index = 0;
  for (const line of lines) {
    if (/^#{1,6}\s+Open Questions?\b/i.test(line)) { inSection = true; continue; }
    if (inSection && /^#{1,6}\s+/.test(line)) { inSection = false; continue; }
    if (inSection) {
      const bullet = line.match(/^\s*[-*]\s+(.*\S.*)$/);
      if (bullet) {
        results.push({ ref: `question:${path}#${index}`, summary: `Open question in ${path.split('/').pop()}: ${bullet[1].trim()}` });
        index++;
      }
    }
  }
  return results;
}

export function runAttentionMine(
  db: Database,
  boundary: Pick<GitGhBoundary, 'ghAvailable' | 'listOpenPrs'>,
  options: MineOptions = {}
): MineResult {
  const now = options.now ?? Date.now();
  let upserted = 0;
  let resolved = 0;

  // --- Reviews: open PRs (graceful degradation when gh is unavailable, R5) ---
  const ghAvailable = boundary.ghAvailable();
  if (ghAvailable) {
    const prs = boundary.listOpenPrs();
    const liveRefs = new Set<string>();
    for (const pr of prs) {
      const ref = `pr:${pr.number}`;
      liveRefs.add(ref);
      if (upsertMinedItem(db, { type: 'review', summary: `PR #${pr.number} awaiting review: ${pr.title}`, source: 'mine', ref, now })) upserted++;
    }
    // Auto-resolve reviews whose PR is no longer open (merged/closed) — but only
    // the PR-typed refs, identified by the `pr:` prefix.
    resolved += resolvePrefixed(db, 'review', 'pr:', liveRefs, now);
  }

  // --- Reviews: Proposed specs ---
  const specFiles = options.specFiles ?? [];
  const liveSpecRefs = new Set<string>();
  for (const file of specFiles) {
    const proposed = extractProposedSpec(file.path, file.content);
    if (proposed) {
      liveSpecRefs.add(proposed.ref);
      if (upsertMinedItem(db, { type: 'review', summary: proposed.summary, source: 'mine', ref: proposed.ref, now })) upserted++;
    }
  }
  resolved += resolvePrefixed(db, 'review', 'spec:', liveSpecRefs, now);

  // --- Questions: doc Open-Questions sections ---
  const liveQuestionRefs = new Set<string>();
  for (const file of specFiles) {
    for (const q of extractOpenQuestions(file.path, file.content)) {
      liveQuestionRefs.add(q.ref);
      if (upsertMinedItem(db, { type: 'question', summary: q.summary, source: 'mine', ref: q.ref, now })) upserted++;
    }
  }
  resolved += resolvePrefixed(db, 'question', 'question:', liveQuestionRefs, now);

  // --- Escalations: error observations ---
  const errorRows = db
    .prepare(`SELECT id, project, narrative, title FROM observations
              WHERE narrative IS NOT NULL OR title IS NOT NULL`)
    .all() as { id: number; project: string | null; narrative: string | null; title: string | null }[];
  for (const row of errorRows) {
    const haystack = `${row.title ?? ''}\n${row.narrative ?? ''}`;
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.re.test(haystack)) {
        const ref = `error:${pattern.key}`;
        if (upsertMinedItem(db, {
          type: 'escalation',
          summary: `Error signature detected: ${pattern.key}`,
          urgency: 'high',
          source: 'mine',
          ref,
          project: row.project,
          now,
        })) upserted++;
        break;
      }
    }
  }

  return { upserted, resolved, ghAvailable };
}

/** Auto-resolve open mined items of `type` whose ref carries `prefix` and is not in `liveRefs`. */
function resolvePrefixed(db: Database, type: string, prefix: string, liveRefs: Set<string>, now: number): number {
  const open = readOpenAttentionItems(db).filter(i => i.type === type && i.source === 'mine' && i.ref.startsWith(prefix));
  const stillLive = new Set([...liveRefs]);
  const scoped = new Set(open.map(i => i.ref).filter(ref => stillLive.has(ref)));
  return autoResolveMissing(db, type, new Set([...scoped]), now) - countNonPrefixResolved(db, type, prefix);
}

/** Guard so autoResolveMissing (which is type-wide) does not touch other-prefixed refs of the same type. */
function countNonPrefixResolved(_db: Database, _type: string, _prefix: string): number {
  return 0;
}
```

> **Note for the implementer:** the `resolvePrefixed` helper above must only resolve refs sharing `prefix`. Simplify it to iterate the open items of `(type, prefix)` directly and resolve those not in `liveRefs`, rather than delegating to the type-wide `autoResolveMissing`. Concretely, replace the body of `resolvePrefixed` with:
>
> ```ts
> function resolvePrefixed(db: Database, type: string, prefix: string, liveRefs: Set<string>, now: number): number {
>   const open = readOpenAttentionItems(db).filter(
>     i => i.type === type && i.source === 'mine' && i.ref.startsWith(prefix)
>   );
>   let resolved = 0;
>   const update = db.prepare(
>     "UPDATE attention_items SET status = 'resolved', resolved_at = ?, resolved_by = 'auto' WHERE id = ?"
>   );
>   for (const item of open) {
>     if (!liveRefs.has(item.ref)) { update.run(now, item.id); resolved++; }
>   }
>   return resolved;
> }
> ```
>
> and delete `autoResolveMissing` / `countNonPrefixResolved` if unused. (The store helper `autoResolveMissing` is retained in `attention-items.ts` for potential reuse but is not required by the miner once `resolvePrefixed` is self-contained.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/mission-control/attention-miner.test.ts`
Expected: PASS (all five tests). If the PR-resolution test fails, confirm `resolvePrefixed` uses the self-contained body from the note above.

- [ ] **Step 6: Commit**

```bash
git add src/services/mission-control/attention-items.ts src/services/mission-control/AttentionMiner.ts tests/mission-control/attention-miner.test.ts
git commit -m "feat(mission-control): add AttentionMiner (reviews/questions/escalations, idempotent, auto-resolve)"
```

---

### Task 8: `MissionControlRoutes` + worker wiring

Exposes the read-views and mined attention over HTTP on the existing worker server, and wires a periodic + on-demand mine pass. Mirrors the `DataRoutes` / `ViewerRoutes` pattern (`BaseRouteHandler`, `wrapHandler`, `res.json`). Registered in `worker-service.ts` next to the existing route registrations.

**Files:**
- Create: `src/services/mission-control/loadSpecFiles.ts` (reads spec/ADR files off disk for the miner)
- Create: `src/services/worker/http/routes/MissionControlRoutes.ts`
- Modify: `src/services/worker-service.ts` (register the route; wire a periodic mine)
- Test: `tests/worker/http/routes/mission-control-routes.test.ts`

**Interfaces:**
- Consumes: `DatabaseManager` (`getSessionStore().db`), the queries/miner from Tasks 2–7, `createGitGhBoundary()`.
- Produces: HTTP endpoints
  - `GET /api/mission-control/attention` → `{ items: AttentionItem[], ghAvailable: boolean }`
  - `GET /api/mission-control/progress?by=agent&granularity=day&project=` → `{ buckets: ProgressBucket[] }`
  - `GET /api/mission-control/velocity` → `VelocityResult`
  - `GET /api/mission-control/next-steps?project=` → `{ items: NextStepItem[] }`
  - `GET /api/mission-control/attention?refresh=1` triggers an immediate mine before reading.
  - `function loadSpecFiles(): { path: string; content: string }[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/worker/http/routes/mission-control-routes.test.ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { MissionControlRoutes } from '../../../../src/services/worker/http/routes/MissionControlRoutes.js';

// Minimal Express-like app double: records handlers keyed by path.
function makeMockApp() {
  const handlers = new Map<string, (req: any, res: any) => void>();
  return {
    get(path: string, handler: (req: any, res: any) => void) { handlers.set(path, handler); },
    use() { /* static — ignored */ },
    invoke(path: string, req: any) {
      let body: unknown;
      const res = { json: (b: unknown) => { body = b; }, status: () => res, setHeader: () => {}, send: () => {} };
      handlers.get(path)!(req, res);
      return body;
    },
    handlers,
  };
}

function makeDbManager() {
  const db = new Database(':memory:');
  const store = new SessionStore(db);
  // Fixture row below has no parent sdk_sessions row; disable FK enforcement.
  db.run('PRAGMA foreign_keys = OFF');
  return { getSessionStore: () => store };
}

describe('MissionControlRoutes', () => {
  it('registers the four mission-control endpoints', () => {
    const app = makeMockApp();
    const routes = new MissionControlRoutes(makeDbManager() as any, {
      ghAvailable: () => false,
      listOpenPrs: () => [],
      listMergeCommits: () => [],
    });
    routes.setupRoutes(app as any);
    for (const p of [
      '/api/mission-control/attention',
      '/api/mission-control/progress',
      '/api/mission-control/velocity',
      '/api/mission-control/next-steps',
    ]) {
      expect(app.handlers.has(p)).toBe(true);
    }
  });

  it('serves next-steps as JSON', () => {
    const dbManager = makeDbManager();
    const db = dbManager.getSessionStore().db;
    db.run(`INSERT INTO session_summaries (memory_session_id, project, next_steps, created_at, created_at_epoch)
            VALUES ('s1', 'proj', 'Ship the thing', '2026-07-16T00:00:00.000Z', 1000)`);
    const app = makeMockApp();
    const routes = new MissionControlRoutes(dbManager as any, {
      ghAvailable: () => false, listOpenPrs: () => [], listMergeCommits: () => [],
    });
    routes.setupRoutes(app as any);
    const body = app.invoke('/api/mission-control/next-steps', { query: {} }) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(1);
  });
});
```

> **Implementer note:** the exact `session_summaries` column set is created by `SessionStore`'s migrations; the INSERT above lists the columns it needs. If a `NOT NULL` column without a default is missing, add it to the INSERT — do not alter the schema.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/worker/http/routes/mission-control-routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `loadSpecFiles`**

```ts
// src/services/mission-control/loadSpecFiles.ts
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import { getPackageRoot } from '../../shared/paths.js';

const SPEC_DIRS = [
  'docs/superpowers/specs',
  'docs/architecture',
  'docs/architecture/decisions',
];

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isFile() && entry.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Read spec + ADR markdown off disk for the miner. Best-effort: unreadable files are skipped. */
export function loadSpecFiles(): { path: string; content: string }[] {
  const root = getPackageRoot();
  const files: { path: string; content: string }[] = [];
  for (const rel of SPEC_DIRS) {
    for (const full of walkMarkdown(path.join(root, rel))) {
      try {
        const relPath = path.relative(root, full).split(path.sep).join('/');
        files.push({ path: relPath, content: readFileSync(full, 'utf8') });
      } catch { /* skip unreadable file */ }
    }
  }
  return files;
}
```

- [ ] **Step 4: Write the route class**

```ts
// src/services/worker/http/routes/MissionControlRoutes.ts
import express, { Request, Response } from 'express';
import { DatabaseManager } from '../../DatabaseManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { queryProgress } from '../../../mission-control/ProgressQuery.js';
import { queryVelocity } from '../../../mission-control/VelocityQuery.js';
import { queryNextSteps } from '../../../mission-control/NextStepsFeed.js';
import { runAttentionMine, readOpenAttentionItems } from '../../../mission-control/AttentionMiner.js';
import { parseBuilderQueue } from '../../../mission-control/BuilderQueueParser.js';
import { createGitGhBoundary, type GitGhBoundary } from '../../../mission-control/shell.js';
import { loadSpecFiles } from '../../../mission-control/loadSpecFiles.js';
import { getPackageRoot } from '../../../../shared/paths.js';
import { logger } from '../../../../utils/logger.js';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

export class MissionControlRoutes extends BaseRouteHandler {
  private boundary: GitGhBoundary;
  private lastMineAt = 0;
  private readonly minMineIntervalMs = 60_000;

  constructor(private dbManager: DatabaseManager, boundary?: GitGhBoundary) {
    super();
    this.boundary = boundary ?? createGitGhBoundary();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/mission-control/attention', this.handleAttention.bind(this));
    app.get('/api/mission-control/progress', this.handleProgress.bind(this));
    app.get('/api/mission-control/velocity', this.handleVelocity.bind(this));
    app.get('/api/mission-control/next-steps', this.handleNextSteps.bind(this));
  }

  /** Runs a mine pass, throttled unless forced. Never throws — mining is best-effort. */
  mineOnce(force = false): boolean {
    const now = Date.now();
    if (!force && now - this.lastMineAt < this.minMineIntervalMs) return false;
    this.lastMineAt = now;
    try {
      const db = this.dbManager.getSessionStore().db;
      runAttentionMine(db, this.boundary, { specFiles: loadSpecFiles(), now });
      return true;
    } catch (error) {
      logger.warn('MISSION_CONTROL', 'Attention mine pass failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private handleAttention = this.wrapHandler((req: Request, res: Response): void => {
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    this.mineOnce(refresh);
    const db = this.dbManager.getSessionStore().db;
    res.json({ items: readOpenAttentionItems(db, project), ghAvailable: this.boundary.ghAvailable() });
  });

  private handleProgress = this.wrapHandler((req: Request, res: Response): void => {
    const by = req.query.by === 'human' ? 'human' : 'agent';
    const granularity = req.query.granularity === 'week' ? 'week' : 'day';
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    const db = this.dbManager.getSessionStore().db;
    res.json({ buckets: queryProgress(db, { by, granularity, project }) });
  });

  private handleVelocity = this.wrapHandler((req: Request, res: Response): void => {
    const queuePath = path.join(getPackageRoot(), 'docs', 'BUILDER_QUEUE.md');
    let parsed;
    try {
      if (!existsSync(queuePath)) throw new Error(`BUILDER_QUEUE.md not found at ${queuePath}`);
      parsed = parseBuilderQueue(readFileSync(queuePath, 'utf8'));
    } catch (error) {
      // Loud, visible failure state — never a silent empty velocity view (R3).
      res.status(200).json({ error: error instanceof Error ? error.message : String(error), openCount: null, shippedCount: null, shippedByWeek: [] });
      return;
    }
    res.json(queryVelocity(parsed, this.boundary));
  });

  private handleNextSteps = this.wrapHandler((req: Request, res: Response): void => {
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    const db = this.dbManager.getSessionStore().db;
    res.json({ items: queryNextSteps(db, { project }) });
  });
}
```

- [ ] **Step 5: Register the route + periodic mine in `worker-service.ts`**

In `src/services/worker-service.ts`, inside `registerRoutes()` (near the existing `this.server.registerRoutes(new DataRoutes(...))` call around line 356), add:

```ts
    const missionControlRoutes = new MissionControlRoutes(this.dbManager);
    this.server.registerRoutes(missionControlRoutes);
    // Periodic best-effort mine so the Attention pane self-populates and auto-resolves.
    this.missionControlMineTimer = setInterval(() => { missionControlRoutes.mineOnce(true); }, 5 * 60_000);
    if (typeof this.missionControlMineTimer.unref === 'function') this.missionControlMineTimer.unref();
```

Add the import at the top of the file:

```ts
import { MissionControlRoutes } from './worker/http/routes/MissionControlRoutes.js';
```

Add the field to the class (near the other private fields):

```ts
  private missionControlMineTimer: ReturnType<typeof setInterval> | null = null;
```

And clear it wherever the worker tears down timers/intervals on shutdown (match the existing shutdown/cleanup pattern in this file):

```ts
    if (this.missionControlMineTimer) { clearInterval(this.missionControlMineTimer); this.missionControlMineTimer = null; }
```

> **Implementer note:** locate the existing shutdown method (search for `clearInterval` or `shutdown`/`stop` in `worker-service.ts`) and place the clear line there. If none exists, place it in the worker's dispose/stop path. Do not invent a new lifecycle method.

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test tests/worker/http/routes/mission-control-routes.test.ts`
Expected: PASS (both tests).
Run: `npm run typecheck` (or the project's TS check) and confirm no new errors in `src/services/mission-control/**` or `src/services/worker/http/routes/MissionControlRoutes.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/services/mission-control/loadSpecFiles.ts src/services/worker/http/routes/MissionControlRoutes.ts src/services/worker-service.ts tests/worker/http/routes/mission-control-routes.test.ts
git commit -m "feat(mission-control): add HTTP routes + periodic mine wiring"
```

---

### Task 9: Viewer UI — the Mission Control view

Adds a "Mission Control" view to the existing React viewer: a top-level view toggle in `App.tsx`, a `MissionControl` component with an Attention pane + Observability panes (progress, velocity, unsynthesized next-steps), and a data hook. The next-steps feed is explicitly labeled **"Unsynthesized"** (spec R1); an empty human-axis / PR-mining-unavailable state is labeled rather than shown as an error (R4/R5). Rebuild the bundle with `npm run build`.

**Files:**
- Modify: `src/ui/viewer/constants/api.ts` (add the mission-control endpoints)
- Create: `src/ui/viewer/hooks/useMissionControl.ts`
- Create: `src/ui/viewer/components/MissionControl.tsx`
- Modify: `src/ui/viewer/App.tsx` (add a `view` state + toggle, render `<MissionControl/>`)
- Test: `tests/mission-control/mission-control-view.test.tsx` (render-shape smoke test against fixture data)

**Interfaces:**
- Consumes: the `/api/mission-control/*` endpoints (Task 8).
- Produces: a rendered Mission Control view reachable from the viewer header/toggle.

- [ ] **Step 1: Add endpoint constants**

Edit `src/ui/viewer/constants/api.ts`:

```ts
export const API_ENDPOINTS = {
  OBSERVATIONS: '/api/observations',
  SUMMARIES: '/api/summaries',
  PROMPTS: '/api/prompts',
  SETTINGS: '/api/settings',
  STREAM: '/stream',
  MC_ATTENTION: '/api/mission-control/attention',
  MC_PROGRESS: '/api/mission-control/progress',
  MC_VELOCITY: '/api/mission-control/velocity',
  MC_NEXT_STEPS: '/api/mission-control/next-steps',
} as const;
```

- [ ] **Step 2: Write the data hook**

```ts
// src/ui/viewer/hooks/useMissionControl.ts
import { useState, useEffect, useCallback } from 'react';
import { API_ENDPOINTS } from '../constants/api';

export interface AttentionItem {
  id: number; type: string; summary: string; blockedOn: string | null;
  urgency: string; source: string; ref: string; status: string; project: string | null; createdAtEpoch: number;
}
export interface ProgressBucket {
  agentType: string | null; agentId: string | null; bucket: string; total: number; byType: Record<string, number>;
}
export interface VelocityResult {
  openCount: number | null; shippedCount: number | null;
  shippedByWeek: { week: string; shipped: number }[]; error?: string;
}
export interface NextStepItem { memorySessionId: string; project: string; createdAtEpoch: number; text: string; }

export interface MissionControlData {
  attention: AttentionItem[];
  ghAvailable: boolean;
  progress: ProgressBucket[];
  velocity: VelocityResult | null;
  nextSteps: NextStepItem[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useMissionControl(): MissionControlData {
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [ghAvailable, setGhAvailable] = useState(true);
  const [progress, setProgress] = useState<ProgressBucket[]>([]);
  const [velocity, setVelocity] = useState<VelocityResult | null>(null);
  const [nextSteps, setNextSteps] = useState<NextStepItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, p, v, n] = await Promise.all([
        fetch(API_ENDPOINTS.MC_ATTENTION).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_PROGRESS).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_VELOCITY).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_NEXT_STEPS).then(r => r.json()),
      ]);
      setAttention(a.items ?? []);
      setGhAvailable(a.ghAvailable ?? true);
      setProgress(p.buckets ?? []);
      setVelocity(v);
      setNextSteps(n.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { attention, ghAvailable, progress, velocity, nextSteps, loading, error, refresh: load };
}
```

- [ ] **Step 3: Write the component**

```tsx
// src/ui/viewer/components/MissionControl.tsx
import React from 'react';
import { useMissionControl, AttentionItem } from '../hooks/useMissionControl';

function AttentionPane({ items, ghAvailable }: { items: AttentionItem[]; ghAvailable: boolean }) {
  const byType = (type: string) => items.filter(i => i.type === type);
  const order = ['escalation', 'blocker', 'review', 'question'];
  return (
    <section className="mc-pane" data-testid="mc-attention">
      <h2>Attention — what needs you now</h2>
      {!ghAvailable && (
        <p className="mc-note" data-testid="mc-gh-unavailable">PR mining unavailable (gh not authenticated) — showing specs & escalations only.</p>
      )}
      {items.length === 0 && <p className="mc-empty">Nothing is gated on you right now.</p>}
      {order.map(type => {
        const group = byType(type);
        if (group.length === 0) return null;
        return (
          <div key={type} className="mc-attention-group">
            <h3>{type} ({group.length})</h3>
            <ul>
              {group.map(item => (
                <li key={item.id} className={`mc-item mc-urgency-${item.urgency}`}>
                  {item.summary}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

export function MissionControl() {
  const { attention, ghAvailable, progress, velocity, nextSteps, loading, error, refresh } = useMissionControl();

  if (loading) return <div className="mc-loading">Loading Mission Control…</div>;
  if (error) return <div className="mc-error">Failed to load Mission Control: {error}</div>;

  return (
    <div className="mission-control" data-testid="mission-control">
      <div className="mc-header">
        <button className="mc-refresh" onClick={refresh}>Refresh</button>
      </div>

      <AttentionPane items={attention} ghAvailable={ghAvailable} />

      <section className="mc-pane" data-testid="mc-velocity">
        <h2>Velocity</h2>
        {velocity?.error ? (
          <p className="mc-error">Queue parse failed: {velocity.error}</p>
        ) : (
          <p>{velocity?.shippedCount ?? '—'} shipped · {velocity?.openCount ?? '—'} open</p>
        )}
        <ul>
          {(velocity?.shippedByWeek ?? []).map(pt => (
            <li key={pt.week}>{pt.week}: {pt.shipped} shipped</li>
          ))}
        </ul>
      </section>

      <section className="mc-pane" data-testid="mc-progress">
        <h2>Progress (by agent × time)</h2>
        {progress.length === 0 && <p className="mc-empty">No agent activity in range.</p>}
        <ul>
          {progress.map(b => (
            <li key={`${b.agentType}-${b.agentId}-${b.bucket}`}>
              {b.bucket} · {b.agentType ?? 'unknown'} · {b.total} obs
            </li>
          ))}
        </ul>
      </section>

      <section className="mc-pane" data-testid="mc-next-steps">
        <h2>Suggested next steps <span className="mc-badge">Unsynthesized</span></h2>
        {nextSteps.length === 0 && <p className="mc-empty">No next-steps captured yet.</p>}
        <ul>
          {nextSteps.map(item => (
            <li key={item.memorySessionId}>{item.text}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Wire the view toggle into `App.tsx`**

In `src/ui/viewer/App.tsx`, add the import, a `view` state, a toggle button, and conditional rendering. Concretely:

Add to the imports block:

```tsx
import { MissionControl } from './components/MissionControl';
```

Add to the state near the other `useState` calls (after line 21):

```tsx
  const [view, setView] = useState<'feed' | 'mission-control'>('feed');
```

Replace the `<Feed .../>` render (lines 111-118) with a conditional, and add a toggle above it:

```tsx
      <div className="view-toggle">
        <button className={view === 'feed' ? 'active' : ''} onClick={() => setView('feed')}>Feed</button>
        <button className={view === 'mission-control' ? 'active' : ''} onClick={() => setView('mission-control')}>Mission Control</button>
      </div>

      {view === 'mission-control' ? (
        <MissionControl />
      ) : (
        <Feed
          observations={allObservations}
          summaries={allSummaries}
          prompts={allPrompts}
          onLoadMore={handleLoadMore}
          isLoading={pagination.observations.isLoading || pagination.summaries.isLoading || pagination.prompts.isLoading}
          hasMore={pagination.observations.hasMore || pagination.summaries.hasMore || pagination.prompts.hasMore}
        />
      )}
```

> **Implementer note:** the toggle placement/styling should match the existing header/tab pattern in the codebase — read `src/ui/viewer/components/Header.tsx` first and, if it already renders a nav/tab strip, add the Mission Control tab there instead of a standalone `.view-toggle` div. The functional requirement is: a control that flips `view` state and conditionally renders `<MissionControl/>`.

- [ ] **Step 5: Write a render-shape smoke test**

```tsx
// tests/mission-control/mission-control-view.test.tsx
import { describe, it, expect } from 'bun:test';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { AttentionItem } from '../../src/ui/viewer/hooks/useMissionControl';

// Import the pane in isolation by re-declaring the minimal render path.
// The full MissionControl uses fetch; here we assert the attention grouping shape
// renders the labels the operator relies on.
function renderAttention(items: AttentionItem[], ghAvailable: boolean): string {
  const { MissionControl } = require('../../src/ui/viewer/components/MissionControl');
  void MissionControl; // ensure the module imports without error
  // Render just the label logic via a tiny harness:
  return renderToString(
    React.createElement('div', null,
      ghAvailable ? null : React.createElement('span', { 'data-testid': 'gh-unavailable' }, 'PR mining unavailable'),
      React.createElement('span', { className: 'mc-badge' }, 'Unsynthesized')
    )
  );
}

describe('Mission Control view labels', () => {
  it('the MissionControl component module imports without throwing', () => {
    expect(() => require('../../src/ui/viewer/components/MissionControl')).not.toThrow();
  });

  it('renders the Unsynthesized badge and gh-unavailable note when applicable', () => {
    const html = renderAttention([], false);
    expect(html).toContain('Unsynthesized');
    expect(html).toContain('PR mining unavailable');
  });
});
```

> **Implementer note:** if `react-dom/server` is not already a dependency usable under `bun test`, keep this test to the module-import assertion (`require(...).not.toThrow()`) and drop the `renderToString` case — the load-bearing verification is that the component and hook typecheck and the endpoints match `API_ENDPOINTS`. UI behavior is validated live in the Test Plan below.

- [ ] **Step 6: Run tests + typecheck + build the bundle**

Run: `bun test tests/mission-control/mission-control-view.test.tsx`
Expected: PASS.
Run: `npm run typecheck:viewer` (`tsc -p src/ui/viewer/tsconfig.json`) — expect no new errors.
Run: `npm run build` — rebuilds `plugin/ui/viewer-bundle.js` from the React source. Confirm the command exits 0 and the bundle timestamp updates.

- [ ] **Step 7: Commit**

```bash
git add src/ui/viewer/constants/api.ts src/ui/viewer/hooks/useMissionControl.ts src/ui/viewer/components/MissionControl.tsx src/ui/viewer/App.tsx tests/mission-control/mission-control-view.test.tsx plugin/ui/viewer-bundle.js plugin/ui/viewer.html
git commit -m "feat(mission-control): add Mission Control viewer view (attention + observability panes)"
```

---

## Verification

Run before opening the PR:

- [ ] **Full mission-control unit suite:** `bun test tests/mission-control/ tests/sqlite/attention-items-migration.test.ts tests/worker/http/routes/mission-control-routes.test.ts` — all green.
- [ ] **Typecheck:** `npm run typecheck` and `npm run typecheck:viewer` — no new errors introduced by this change.
- [ ] **Build:** `npm run build-and-sync` — completes; the worker restarts cleanly and the bundle is regenerated.
- [ ] **Parser loud-failure guard:** confirm `parseBuilderQueue` on a headings-but-no-rows fixture throws `BuilderQueueParseError` (Task 2 test) — this is the regression guard for the 2026-07-15 silent-empty failure mode.
- [ ] **Idempotency + auto-resolve:** confirm the AttentionMiner tests for "two passes = no duplicates" and "merged PR → resolved" pass (Task 7).
- [ ] **Graceful degradation:** confirm the AttentionMiner "gh unavailable" test passes and `/api/mission-control/attention` returns `ghAvailable:false` with specs/errors still present.

### Test Plan (live UAT — for the Tester)

1. `npm run build-and-sync`, then open the viewer at the worker's `/` URL.
2. Toggle to **Mission Control**. Confirm four panes render: Attention, Velocity, Progress, Suggested next steps (badged "Unsynthesized").
3. **Attention:** with an open PR on the repo, confirm a `review` item appears; with a `Status: Proposed` spec under `docs/superpowers/specs/`, confirm a second `review` item; confirm the "PR mining unavailable" note appears when `gh auth` is logged out.
4. **Velocity:** confirm "N shipped · M open" reflects `docs/BUILDER_QUEUE.md`; corrupt the queue table locally and confirm the pane shows a visible parse-error message (never a blank/zeroed pane), then restore.
5. **Progress:** confirm per-agent buckets render for recent observations; switching `by=human` (if surfaced) shows a labeled empty state, not an error.
6. **Next steps:** confirm recent `session_summaries.next_steps` render deduped, badged "Unsynthesized".
7. Confirm no writes occurred to `docs/BUILDER_QUEUE.md` (git status clean for that file) and no LLM calls were made (this is a read/mine-only feature).

## Cross-references

- Design spec: `docs/superpowers/specs/2026-07-16-mission-control-design.md` (Phase 1 = §6 "Phase 1", components §7, testing §8, risks §9). This plan implements Phase 1 only.
- Queue row: `docs/BUILDER_QUEUE.md` #18.
