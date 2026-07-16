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
