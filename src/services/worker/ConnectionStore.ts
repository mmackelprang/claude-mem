// SPDX-License-Identifier: Apache-2.0

/**
 * ConnectionStore — the single owner of connection-profile → canonical-key
 * derivation (spec D6 / §6). It does not do IO: it operates on the in-memory
 * settings object so SettingsRoutes can reconcile in one atomic write.
 *
 * Seam invariant: activating a profile means writing its runtime/url/apiKey/
 * projectId into the 4 canonical keys the hooks already read. Config
 * *consumption* is unchanged — this is purely a manager on top.
 */

export const LOCAL_WORKER_ID = 'local-worker';

/**
 * Stable id for the profile synthesized from a pre-existing runtime=server
 * install's canonical keys (see the adoption logic in applyToSettings). Fixed
 * so adoption is idempotent — a second reconcile finds the profile and does
 * not duplicate it.
 */
export const IMPORTED_SERVER_ID = 'imported-server';

export type ConnectionRuntime = 'worker' | 'server';

export interface ConnectionProfile {
  id: string;
  name: string;
  runtime: ConnectionRuntime;
  url: string;
  apiKey: string;
  projectId: string;
}

/** The undeletable built-in fallback (Q1 = yes). */
function localWorkerProfile(): ConnectionProfile {
  return { id: LOCAL_WORKER_ID, name: 'Local worker', runtime: 'worker', url: '', apiKey: '', projectId: '' };
}

/** Minimal shape ConnectionStore reads/writes; a subset of SettingsDefaults. */
interface ConnectionSettingsSlice {
  CLAUDE_MEM_CONNECTIONS: string;
  CLAUDE_MEM_ACTIVE_CONNECTION: string;
  CLAUDE_MEM_RUNTIME: string;
  CLAUDE_MEM_SERVER_URL: string;
  CLAUDE_MEM_SERVER_API_KEY: string;
  CLAUDE_MEM_SERVER_PROJECT_ID: string;
}

export class ConnectionStore {
  static parse(raw: string | undefined): ConnectionProfile[] {
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

  /**
   * Reconcile a settings object: ensure the Local worker exists, resolve the
   * active profile (falling back to Local worker), and write the 4 canonical
   * keys from it. Returns a NEW object; never mutates the input.
   */
  static applyToSettings<T extends Partial<ConnectionSettingsSlice>>(settings: T): T & ConnectionSettingsSlice {
    const profiles = this.parse(settings.CLAUDE_MEM_CONNECTIONS);

    // Seed the undeletable Local worker if missing.
    if (!profiles.some(p => p.id === LOCAL_WORKER_ID)) {
      profiles.unshift(localWorkerProfile());
    }

    // Back-compat adoption (do NOT remove): a pre-existing runtime=server
    // install writes CLAUDE_MEM_RUNTIME/SERVER_* directly to settings.json
    // (installer's setupServerRuntimeNonInteractive) and has NO
    // CLAUDE_MEM_CONNECTIONS. On such a file loadFromFile synthesizes the
    // defaults active='local-worker' + connections='[]', so the derivation
    // below would resolve the Local worker as active and SILENTLY wipe the
    // server keys on the next settings save — the exact silent-fallback this
    // feature exists to eliminate. If the canonical keys say "server" with a
    // URL but no server profile represents them, adopt those keys into an
    // active server profile so the connection is preserved (and surfaced in
    // the panel). Idempotent: once adopted, a server profile exists and this
    // block is skipped.
    const canonicalRuntime = (settings.CLAUDE_MEM_RUNTIME ?? '').trim().toLowerCase();
    const canonicalUrl = (settings.CLAUDE_MEM_SERVER_URL ?? '').trim();
    let adoptedActiveId: string | null = null;
    if (!profiles.some(p => p.runtime === 'server') && canonicalRuntime === 'server' && canonicalUrl !== '') {
      profiles.push({
        id: IMPORTED_SERVER_ID,
        name: 'Server',
        runtime: 'server',
        url: settings.CLAUDE_MEM_SERVER_URL ?? '',
        apiKey: settings.CLAUDE_MEM_SERVER_API_KEY ?? '',
        projectId: settings.CLAUDE_MEM_SERVER_PROJECT_ID ?? '',
      });
      adoptedActiveId = IMPORTED_SERVER_ID;
    }

    // Resolve active; a freshly-adopted server profile wins, otherwise the
    // requested id, otherwise fall back to the Local worker (unknown/blank id).
    const requestedId = adoptedActiveId ?? settings.CLAUDE_MEM_ACTIVE_CONNECTION ?? '';
    const active = profiles.find(p => p.id === requestedId) ?? profiles.find(p => p.id === LOCAL_WORKER_ID)!;

    const canonical =
      active.runtime === 'server'
        ? {
            CLAUDE_MEM_RUNTIME: 'server',
            CLAUDE_MEM_SERVER_URL: active.url,
            CLAUDE_MEM_SERVER_API_KEY: active.apiKey,
            CLAUDE_MEM_SERVER_PROJECT_ID: active.projectId,
          }
        : {
            CLAUDE_MEM_RUNTIME: 'worker',
            CLAUDE_MEM_SERVER_URL: '',
            CLAUDE_MEM_SERVER_API_KEY: '',
            CLAUDE_MEM_SERVER_PROJECT_ID: '',
          };

    return {
      ...settings,
      CLAUDE_MEM_CONNECTIONS: JSON.stringify(profiles),
      CLAUDE_MEM_ACTIVE_CONNECTION: active.id,
      ...canonical,
    } as T & ConnectionSettingsSlice;
  }
}
