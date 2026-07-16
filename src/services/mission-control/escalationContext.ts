import type { Database } from 'bun:sqlite';
import { ESCALATION_CATALOG } from './escalation-catalog.js';

/** Must match AttentionMiner's escalation scan window. */
const ESCALATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface EscalationContext {
  key: string;
  whatTitle: string;          // from catalog
  fixText: string;            // from catalog
  fixCommand?: string;        // from catalog
  docHref: string;            // from catalog
  errorLine: string;          // latest matching observation's title/narrative snippet
  count: number;              // total matches in window
  latestEpoch: number;        // latest occurrence
  latestProject: string | null;
  latestAgentType: string | null;
  latestSessionId: string | null;
  otherTeamsCount: number;    // distinct agent_type beyond the latest → "+N others"
}

interface Row {
  project: string | null;
  title: string | null;
  narrative: string | null;
  agent_type: string | null;
  memory_session_id: string | null;
  created_at_epoch: number;
}

/**
 * Aggregate escalation render-context per catalog error class over the recent
 * window. Read-time (not persisted): a single per-class attention_items row
 * cannot hold "+N others"/count/latest honestly, so we compute them fresh.
 * Fail-closed: only classes in ESCALATION_CATALOG can appear.
 */
export function buildEscalationContext(db: Database, now: number): Record<string, EscalationContext> {
  const rows = db.prepare(
    `SELECT project, title, narrative, agent_type, memory_session_id, created_at_epoch
     FROM observations
     WHERE (narrative IS NOT NULL OR title IS NOT NULL) AND created_at_epoch >= ?
     ORDER BY created_at_epoch DESC LIMIT 500`
  ).all(now - ESCALATION_WINDOW_MS) as Row[];

  const out: Record<string, EscalationContext> = {};
  // rows are DESC by epoch → the first match for a key is the latest.
  const teams: Record<string, Set<string>> = {};

  for (const row of rows) {
    const haystack = `${row.title ?? ''}\n${row.narrative ?? ''}`;
    for (const entry of ESCALATION_CATALOG) {
      if (!entry.re.test(haystack)) continue;
      const key = entry.key;
      if (!out[key]) {
        out[key] = {
          key,
          whatTitle: entry.whatTitle,
          fixText: entry.fixText,
          fixCommand: entry.fixCommand,
          docHref: entry.docHref,
          errorLine: (row.title ?? row.narrative ?? '').trim().slice(0, 300),
          count: 0,
          latestEpoch: row.created_at_epoch,
          latestProject: row.project,
          latestAgentType: row.agent_type,
          latestSessionId: row.memory_session_id,
          otherTeamsCount: 0,
        };
        teams[key] = new Set();
      }
      out[key].count++;
      if (row.agent_type) teams[key].add(row.agent_type);
      break; // one class per observation (matches the miner)
    }
  }

  // "+N others" = distinct teams beyond the latest one.
  for (const key of Object.keys(out)) {
    const latest = out[key].latestAgentType;
    const distinct = teams[key];
    out[key].otherTeamsCount = Math.max(0, distinct.size - (latest && distinct.has(latest) ? 1 : 0));
  }
  return out;
}
