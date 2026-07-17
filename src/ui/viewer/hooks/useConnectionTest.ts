import { useState, useCallback, useRef } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import type { ConnectionProfile } from '../lib/connections';

export interface StepResult { step: 'reachable' | 'authenticated' | 'project'; status: 'pass' | 'warn' | 'fail' | 'skipped'; code: string; http?: number; latencyMs?: number; message: string; }
export interface ProbeResult { ok: boolean; runtime: 'worker' | 'server'; steps: StepResult[]; checkedAt: string; totalMs: number; timeoutSeconds: number; }

export function useConnectionTest() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Monotonic token so an earlier probe that resolves after a newer one (each
  // step has its own up-to-5s timeout, so back-to-back tests on different
  // profiles overlap easily) can't misattribute its result to the current row.
  // Only the latest call is allowed to write state.
  const tokenRef = useRef(0);

  const runTest = useCallback(async (profile: ConnectionProfile) => {
    const token = ++tokenRef.current;
    setRunning(true); setResult(null); setError(null);
    try {
      const res = await fetch(API_ENDPOINTS.CONNECTION_TEST, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime: profile.runtime, url: profile.url, apiKey: profile.apiKey, projectId: profile.projectId }),
      });
      if (token !== tokenRef.current) return; // superseded by a newer test
      if (!res.ok) { setError(`Test failed (${res.status})`); return; }
      setResult(await res.json());
    } catch (e) {
      if (token !== tokenRef.current) return; // superseded by a newer test
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      if (token === tokenRef.current) setRunning(false);
    }
  }, []);

  // Bump the token so any in-flight probe is discarded when the caller resets.
  const reset = useCallback(() => { tokenRef.current++; setRunning(false); setResult(null); setError(null); }, []);
  return { running, result, error, runTest, reset };
}
