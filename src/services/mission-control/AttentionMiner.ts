// src/services/mission-control/AttentionMiner.ts
import type { Database } from 'bun:sqlite';
import type { GitGhBoundary } from './shell.js';
import {
  upsertMinedItem,
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

/** Only scan observations from the last 7 days for escalation signatures. */
const ESCALATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
  // Bound the scan to the recent window and cap rows — the observations table is
  // unbounded and on the hot path. Recency also drives self-resolution below.
  const errorRows = db
    .prepare(`SELECT id, project, narrative, title FROM observations
              WHERE (narrative IS NOT NULL OR title IS NOT NULL) AND created_at_epoch >= ?
              ORDER BY created_at_epoch DESC LIMIT 500`)
    .all(now - ESCALATION_WINDOW_MS) as { id: number; project: string | null; narrative: string | null; title: string | null }[];
  const liveErrorRefs = new Set<string>();
  for (const row of errorRows) {
    const haystack = `${row.title ?? ''}\n${row.narrative ?? ''}`;
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.re.test(haystack)) {
        const ref = `error:${pattern.key}`;
        liveErrorRefs.add(ref);
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
  // Self-clean (D7): an escalation whose error signature no longer appears in the
  // recent window auto-resolves (resolved_by='auto'), so a signature that merely
  // surfaced in an old analysis narrative doesn't become a permanent escalation.
  resolved += resolvePrefixed(db, 'escalation', 'error:', liveErrorRefs, now);

  return { upserted, resolved, ghAvailable };
}

/** Auto-resolve open mined items of `type` whose ref carries `prefix` and is not in `liveRefs`. */
function resolvePrefixed(db: Database, type: string, prefix: string, liveRefs: Set<string>, now: number): number {
  const open = readOpenAttentionItems(db).filter(
    i => i.type === type && i.source === 'mine' && i.ref.startsWith(prefix)
  );
  let resolved = 0;
  const update = db.prepare(
    "UPDATE attention_items SET status = 'resolved', resolved_at = ?, resolved_by = 'auto' WHERE id = ?"
  );
  for (const item of open) {
    if (!liveRefs.has(item.ref)) { update.run(now, item.id); resolved++; }
  }
  return resolved;
}
