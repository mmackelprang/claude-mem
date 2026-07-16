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
  let sawQueueHeading = false;
  let sawBacklogHeading = false;
  let sawShippedHeading = false;
  let section: SectionKind = 'other';

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.*)$/);
    if (headingMatch) {
      sawHeading = true;
      section = classifyHeading(headingMatch[1].trim());
      if (section === 'queue') sawQueueHeading = true;
      else if (section === 'backlog') sawBacklogHeading = true;
      else if (section === 'shipped') sawShippedHeading = true;
      continue;
    }

    if (!isTableRow(line)) continue;
    const cells = splitCells(line);
    if (cells.length === 0 || isSeparatorRow(cells)) continue;

    if (section === 'queue' || section === 'backlog') {
      const first = cells[0];
      // Skip the header row (`# | Status | Item ...` etc.).
      if (/^#$/.test(first) || first === '') continue;
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

  // LOUD per-section drift guards: a single heading rename (e.g. `## Queue` ->
  // `## Active Queue`) silently drops that section's rows while the whole-doc
  // total stays > 0, so the checks above never fire. Guard the mandatory,
  // always-populated sections (Queue and Recently shipped) individually. Backlog
  // may legitimately be empty, so it is intentionally not guarded here.
  if (!sawQueueHeading) {
    throw new BuilderQueueParseError('no recognizable "## Queue" section heading found — the heading text may have drifted');
  }
  if (sawQueueHeading && queueRows.length === 0) {
    throw new BuilderQueueParseError('the Queue section heading was found but no queue rows were extracted — the table format may have drifted');
  }
  // The Recently-shipped section is always populated in practice, so a missing
  // heading means it drifted (e.g. `## Recently shipped` -> `## Recently Merged`)
  // and its rows were silently dropped. Guard both the rename and the row loss.
  if (!sawShippedHeading) {
    throw new BuilderQueueParseError('no recognizable "## Recently shipped" section heading found — the heading text may have drifted');
  }
  if (sawShippedHeading && shippedRows.length === 0) {
    throw new BuilderQueueParseError('the "## Recently shipped" section heading was found but no shipped rows were extracted — the section may have drifted');
  }

  return { queueRows, backlogRows, shippedRows, tombstones, openRows };
}
