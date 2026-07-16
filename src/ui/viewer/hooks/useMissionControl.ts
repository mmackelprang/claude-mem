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
export interface VelocityResult {
  openCount: number | null; shippedCount: number | null;
  shippedByWeek: { week: string; shipped: number }[]; error?: string;
}
export interface NextStepItem { memorySessionId: string; project: string; createdAtEpoch: number; text: string; }

export interface MissionControlData {
  attention: AttentionItem[];
  ghAvailable: boolean;
  progress: ProgressBucket[];
  velocity: VelocityResult | null;
  nextSteps: NextStepItem[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useMissionControl(): MissionControlData {
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [ghAvailable, setGhAvailable] = useState(true);
  const [progress, setProgress] = useState<ProgressBucket[]>([]);
  const [velocity, setVelocity] = useState<VelocityResult | null>(null);
  const [nextSteps, setNextSteps] = useState<NextStepItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, p, v, n] = await Promise.all([
        fetch(API_ENDPOINTS.MC_ATTENTION).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_PROGRESS).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_VELOCITY).then(r => r.json()),
        fetch(API_ENDPOINTS.MC_NEXT_STEPS).then(r => r.json()),
      ]);
      setAttention(a.items ?? []);
      setGhAvailable(a.ghAvailable ?? true);
      setProgress(p.buckets ?? []);
      setVelocity(v);
      setNextSteps(n.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { attention, ghAvailable, progress, velocity, nextSteps, loading, error, refresh: load };
}
