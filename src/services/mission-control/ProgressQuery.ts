// src/services/mission-control/ProgressQuery.ts
import type { Database } from 'bun:sqlite';
import { parsePrRefs } from './parsePrRefs.js';

export type GroupAxis = 'agent' | 'human';

export interface ProgressBucket {
  project: string | null;
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
  project: string | null;
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
    SELECT project, agent_type, agent_id, ${bucketExpr} AS bucket, type, COUNT(*) AS n
    FROM observations
    ${whereSql}
    GROUP BY project, agent_type, agent_id, bucket, type
    ORDER BY bucket DESC
  `;
  const rows = db.prepare(sql).all(...params) as RawRow[];

  const map = new Map<string, ProgressBucket>();
  for (const r of rows) {
    const key = `${r.project ?? ''} ${r.agent_type ?? ''} ${r.agent_id ?? ''} ${r.bucket}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { project: r.project, agentType: r.agent_type, agentId: r.agent_id, bucket: r.bucket, total: 0, byType: {} };
      map.set(key, bucket);
    }
    bucket.total += r.n;
    bucket.byType[r.type] = (bucket.byType[r.type] ?? 0) + r.n;
  }
  return [...map.values()];
}

export interface TeamSessions {
  project: string | null;
  agentType: string | null;
  sessions: number;
}

export function queryTeamSessions(db: Database, options: { project?: string; sinceEpoch?: number } = {}): TeamSessions[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.project) { where.push('project = ?'); params.push(options.project); }
  if (typeof options.sinceEpoch === 'number') { where.push('created_at_epoch >= ?'); params.push(options.sinceEpoch); }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT project, agent_type, COUNT(DISTINCT memory_session_id) AS sessions
    FROM observations
    ${whereSql}
    GROUP BY project, agent_type
  `;
  return (db.prepare(sql).all(...params) as Array<{ project: string | null; agent_type: string | null; sessions: number }>)
    .map(r => ({ project: r.project, agentType: r.agent_type, sessions: r.sessions }));
}

export interface TeamPrs {
  project: string | null;
  agentType: string | null;
  prNumbers: number[];
}

export function queryTeamPrs(db: Database, options: { project?: string; sinceEpoch?: number } = {}): TeamPrs[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.project) { where.push('project = ?'); params.push(options.project); }
  if (typeof options.sinceEpoch === 'number') { where.push('created_at_epoch >= ?'); params.push(options.sinceEpoch); }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT project, agent_type, text, title, narrative
    FROM observations
    ${whereSql}
  `).all(...params) as Array<{ project: string | null; agent_type: string | null; text: string | null; title: string | null; narrative: string | null }>;

  const groups = new Map<string, { project: string | null; agentType: string | null; prs: Set<number> }>();
  for (const r of rows) {
    const key = `${r.project ?? ''} ${r.agent_type ?? ''}`;
    let g = groups.get(key);
    if (!g) { g = { project: r.project, agentType: r.agent_type, prs: new Set() }; groups.set(key, g); }
    for (const n of parsePrRefs(`${r.text ?? ''}\n${r.title ?? ''}\n${r.narrative ?? ''}`)) g.prs.add(n);
  }
  return [...groups.values()].map(g => ({ project: g.project, agentType: g.agentType, prNumbers: [...g.prs].sort((a, b) => a - b) }));
}
