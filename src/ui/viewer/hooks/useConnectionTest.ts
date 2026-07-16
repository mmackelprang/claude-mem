import { useState, useCallback } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import type { ConnectionProfile } from '../lib/connections';

export interface StepResult { step: 'reachable' | 'authenticated' | 'project'; status: 'pass' | 'warn' | 'fail' | 'skipped'; code: string; http?: number; latencyMs?: number; message: string; }
export interface ProbeResult { ok: boolean; runtime: 'worker' | 'server'; steps: StepResult[]; checkedAt: string; totalMs: number; timeoutSeconds: number; }

export function useConnectionTest() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTest = useCallback(async (profile: ConnectionProfile) => {
    setRunning(true); setResult(null); setError(null);
    try {
      const res = await fetch(API_ENDPOINTS.CONNECTION_TEST, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime: profile.runtime, url: profile.url, apiKey: profile.apiKey, projectId: profile.projectId }),
      });
      if (!res.ok) { setError(`Test failed (${res.status})`); return; }
      setResult(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setRunning(false);
    }
  }, []);

  const reset = useCallback(() => { setResult(null); setError(null); }, []);
  return { running, result, error, runTest, reset };
}
