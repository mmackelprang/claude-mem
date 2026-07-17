export const LOCAL_WORKER_ID = 'local-worker';
export const DEFAULT_WORKER_PORT = '37700';

export type ConnectionRuntime = 'worker' | 'server';

export interface ConnectionProfile {
  id: string;
  name: string;
  runtime: ConnectionRuntime;
  url: string;
  apiKey: string;
  projectId: string;
}

export function parseConnections(raw: string | undefined): ConnectionProfile[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is ConnectionProfile =>
        !!p && typeof p.id === 'string' && typeof p.name === 'string' &&
        (p.runtime === 'worker' || p.runtime === 'server'),
    );
  } catch {
    return [];
  }
}

export function serializeConnections(profiles: ConnectionProfile[]): string {
  return JSON.stringify(profiles);
}

/** Ensure the undeletable Local worker exists and is first. */
export function withLocalWorker(profiles: ConnectionProfile[]): ConnectionProfile[] {
  if (profiles.some(p => p.id === LOCAL_WORKER_ID)) return profiles;
  return [{ id: LOCAL_WORKER_ID, name: 'Local worker', runtime: 'worker', url: '', apiKey: '', projectId: '' }, ...profiles];
}

export function newProfileId(): string {
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export type PresetKind = 'local' | 'lan' | 'tailscale' | 'custom';

/** Preset URL templates (handoff §4.2). <fragments> are editable placeholders. */
export function presetUrl(kind: PresetKind): string {
  switch (kind) {
    case 'lan': return `http://<hostname>.lan:${DEFAULT_WORKER_PORT}`;
    case 'tailscale': return `https://<host>.<tailnet>.ts.net:${DEFAULT_WORKER_PORT}`;
    case 'custom': return 'http://';
    case 'local': default: return '';
  }
}
