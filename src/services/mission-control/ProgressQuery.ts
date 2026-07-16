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
    const key = `${r.agent_type ?? ''} ${r.agent_id ?? ''} ${r.bucket}`;
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
