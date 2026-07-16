// src/ui/viewer/hooks/useMissionControl.ts
import { useState, useEffect, useCallback } from 'react';
import { API_ENDPOINTS } from '../constants/api';

export interface AttentionItem {
  id: number; type: string; summary: string; blockedOn: string | null;
  urgency: string; source: string; ref: string; status: string; project: string | null; createdAtEpoch: number;
}
export interface ProgressBucket {
  project: string | null; agentType: string | null; agentId: string | null; bucket: string; total: number; byType: Record<string, number>;
}
export interface NextStepItem { memorySessionId: string; project: string; createdAtEpoch: number; text: string; }

export interface VelocityResult {
  deferred?: boolean; reason?: string; error?: string;
  openCount: number | null; shippedCount: number | null;
  shippedByWeek: { week: string; shipped: number }[];
}
export interface EscalationContext {
  key: string; whatTitle: string; fixText: string; fixCommand?: string; docHref: string;
  errorLine: string; count: number; latestEpoch: number;
  latestProject: string | null; latestAgentType: string | null; latestSessionId: string | null; otherTeamsCount: number;
}
export interface TeamSessions { project: string | null; agentType: string | null; sessions: number; }
export interface TeamPrs { project: string | null; agentType: string | null; prNumbers: number[]; }

export type ProgressRange = 'since-last-opened' | 'today' | '7d' | 'all';
const LAST_OPENED_KEY = 'mc-progress-last-opened';

/** Resolve a range to a sinceEpoch (or undefined = all history). */
function rangeToSince(range: ProgressRange, lastOpened: number | null): number | undefined {
  const now = Date.now();
  switch (range) {
    case 'all': return undefined;
    case 'today': { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
    case '7d': return now - 7 * 24 * 60 * 60 * 1000;
    case 'since-last-opened': return lastOpened ?? now - 7 * 24 * 60 * 60 * 1000; // fallback 7d on first ever open
  }
}

export interface MissionControlData {
  attention: AttentionItem[];
  ghAvailable: boolean;
  // True when the Proposed-spec-review + doc-Open-Questions sources are gated off
  // (repo-root resolution deferred to Backlog #24). Escalations + open-PR reviews
  // still populate the Attention pane; velocity is a deferred 4th pane (#24).
  specMiningDeferred: boolean;
  repoWebBase: string | null;
  defaultBranch: string | null;
  escalationContext: Record<string, EscalationContext>;
  progress: ProgressBucket[];
  progressSessions: TeamSessions[];
  progressPrs: TeamPrs[];
  velocity: VelocityResult | null;
  nextSteps: NextStepItem[];
  range: ProgressRange;
  setRange: (r: ProgressRange) => void;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useMissionControl(): MissionControlData {
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [ghAvailable, setGhAvailable] = useState(true);
  const [specMiningDeferred, setSpecMiningDeferred] = useState(false);
  const [progress, setProgress] = useState<ProgressBucket[]>([]);
  const [nextSteps, setNextSteps] = useState<NextStepItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [velocity, setVelocity] = useState<VelocityResult | null>(null);
  const [repoWebBase, setRepoWebBase] = useState<string | null>(null);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [escalationContext, setEscalationContext] = useState<Record<string, EscalationContext>>({});
  const [progressSessions, setProgressSessions] = useState<TeamSessions[]>([]);
  const [progressPrs, setProgressPrs] = useState<TeamPrs[]>([]);
  const [range, setRange] = useState<ProgressRange>('since-last-opened');

  const [lastOpened] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(LAST_OPENED_KEY);
      const prev = raw ? Number(raw) : null;
      localStorage.setItem(LAST_OPENED_KEY, String(Date.now())); // advance for next visit
      return prev && Number.isFinite(prev) ? prev : null;
    } catch { return null; }
  });

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const since = rangeToSince(range, lastOpened);
      const progressUrl = since === undefined
        ? API_ENDPOINTS.MC_PROGRESS
        : `${API_ENDPOINTS.MC_PROGRESS}?since=${since}`;
      const [a, p, v, n] = await Promise.all([
        fetch(API_ENDPOINTS.MC_ATTENTION).then(r => r.json()),
        fetch(progressUrl).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_VELOCITY).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_NEXT_STEPS).then(r => r.json()),
      ]);
      setAttention(a.items ?? []);
      setGhAvailable(a.ghAvailable ?? true);
      setSpecMiningDeferred(a.specMiningDeferred ?? false);
      setRepoWebBase(a.repoWebBase ?? null);
      setDefaultBranch(a.defaultBranch ?? null);
      setEscalationContext(a.escalationContext ?? {});
      setProgress(p.buckets ?? []);
      setProgressSessions(p.sessions ?? []);
      setProgressPrs(p.prs ?? []);
      setVelocity(v ?? null);
      setNextSteps(n.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [range, lastOpened]);

  useEffect(() => { load(); }, [load]);

  return {
    attention, ghAvailable, specMiningDeferred, repoWebBase, defaultBranch, escalationContext,
    progress, progressSessions, progressPrs, velocity, nextSteps,
    range, setRange, loading, error, refresh: load,
  };
}
