import { useEffect, useState } from 'react';
import { API_ENDPOINTS } from '../constants/api';

export type RuntimeRole = 'worker' | 'server' | 'unknown';
const OVERRIDE_KEY = 'claude-mem.runtime-role-override';

/** Pure helper (unit-tested): manual override wins only when the probe is unknown. */
export function computeEffectiveRole(role: RuntimeRole, override: RuntimeRole | null): RuntimeRole {
  return role !== 'unknown' ? role : (override ?? 'worker');
}

export function useRuntimeRole() {
  const [role, setRole] = useState<RuntimeRole>('unknown');
  const [override, setOverrideState] = useState<RuntimeRole | null>(
    () => (localStorage.getItem(OVERRIDE_KEY) as RuntimeRole | null) ?? null,
  );

  useEffect(() => {
    fetch(API_ENDPOINTS.RUNTIME_ROLE)
      .then(r => r.ok ? r.json() : { role: 'unknown' })
      .then((d: { role?: RuntimeRole }) => setRole(d.role ?? 'unknown'))
      .catch(() => setRole('unknown'));
  }, []);

  const setOverride = (r: RuntimeRole | null) => {
    if (r) localStorage.setItem(OVERRIDE_KEY, r); else localStorage.removeItem(OVERRIDE_KEY);
    setOverrideState(r);
  };

  return { role, effectiveRole: computeEffectiveRole(role, override), needsManualToggle: role === 'unknown', override, setOverride };
}
