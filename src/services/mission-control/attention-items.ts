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
