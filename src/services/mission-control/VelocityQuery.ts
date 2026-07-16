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
