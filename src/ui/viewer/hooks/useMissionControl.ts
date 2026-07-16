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
export interface NextStepItem { memorySessionId: string; project: string; createdAtEpoch: number; text: string; }

export interface MissionControlData {
  attention: AttentionItem[];
  ghAvailable: boolean;
  // True when the Proposed-spec-review + doc-Open-Questions sources are gated off
  // (repo-root resolution deferred to Backlog #24). Escalations + open-PR reviews
  // still populate the Attention pane; velocity is a deferred 4th pane (#24).
  specMiningDeferred: boolean;
  progress: ProgressBucket[];
  nextSteps: NextStepItem[];
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Phase 1 ships 3 panes — Attention (SQLite escalations + gh PR reviews),
      // Progress (SQLite), Next-steps (SQLite). Velocity is deferred to #24, so it
      // is not fetched here (its route stays registered, gated, for #24).
      const [a, p, n] = await Promise.all([
        fetch(API_ENDPOINTS.MC_ATTENTION).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_PROGRESS).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_NEXT_STEPS).then(r => r.json()),
      ]);
      setAttention(a.items ?? []);
      setGhAvailable(a.ghAvailable ?? true);
      setSpecMiningDeferred(a.specMiningDeferred ?? false);
      setProgress(p.buckets ?? []);
      setNextSteps(n.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { attention, ghAvailable, specMiningDeferred, progress, nextSteps, loading, error, refresh: load };
}
