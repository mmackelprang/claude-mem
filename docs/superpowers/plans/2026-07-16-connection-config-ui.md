# Plan — Connection Profiles + Server-Config Wizard (Settings UI, Phase 1)

- **Date:** 2026-07-16
- **Author:** Planner
- **Status:** Ready for Builder (one PR).
- **Spec (source of truth):** [`docs/superpowers/specs/2026-07-16-connection-config-ui-design.md`](../specs/2026-07-16-connection-config-ui-design.md) — D1–D6, the manager-over-existing-keys seam, phasing.
- **Design handoff (UX contract):** [`docs/design-handoffs/2026-07-16-connection-config-ui.md`](../../design-handoffs/2026-07-16-connection-config-ui.md) — anatomy, copy deck, states, the E1–E6 endpoint shapes.
- **Branch:** `feat/connection-config-ui` (branch from `main`). One PR → `fork/main`.
- **Coverage:** E1 (`POST /api/connection/test`), E2 (`GET /api/runtime-role`), E3 (`/api/settings` allow-list + `SettingsDefaults`), E4 (`GET /api/server-config`), E5 (`GET /api/ingest-status`), E6 (`ConnectionStore`), the Connection panel, the test stepper, the server-config wizard, context-aware rendering.

---

## 0. Orientation — how this maps onto the real code (read first)

Everything below is grounded in the current tree. The load-bearing facts the plan is built on:

| Fact (verified) | Location | Consequence for this plan |
|---|---|---|
| The worker's Express app serves **both** the `/api/*` viewer routes **and** the `/v1/*` + `/healthz` server routes. `ServerV1Routes` is registered on the worker. | `src/services/worker-service.ts:368`; routes in `src/server/routes/v1/ServerV1Routes.ts` | All six new endpoints (E1–E5) register on the same worker app, next to `SettingsRoutes`. The remote collection server (`claude-mem-server`) runs the **same** `ServerV1Routes` code, so the test-endpoint probe targets are guaranteed to exist on the far end. |
| `SettingsDefaultsManager.loadFromFile()` rebuilds settings by iterating **`Object.keys(this.DEFAULTS)`** and copying only those keys. | `src/shared/SettingsDefaultsManager.ts:249-254` | **Any key not in `DEFAULTS` is silently dropped on read.** `CLAUDE_MEM_CONNECTIONS` / `CLAUDE_MEM_ACTIVE_CONNECTION` MUST be added to the `SettingsDefaults` interface + `DEFAULTS` or `GET /api/settings` never returns them and the whole panel round-trips to empty. This is the first task. |
| The 4 canonical keys already exist in defaults. | `SettingsDefaultsManager.ts:86,93,94,95,180,185-187` (`CLAUDE_MEM_RUNTIME`, `CLAUDE_MEM_SERVER_URL/API_KEY/PROJECT_ID`) | The seam only has to *write* these; consumption is unchanged (D6). |
| The POST allow-list (`settingKeys`) does **not** include any connection key. | `SettingsRoutes.ts:77-107` | E3: extend it, or Save fails closed (handoff §12.2). |
| `requireServerAuth` returns **401 only when the key is absent**, **403 for an invalid key or insufficient scope**. | `src/server/middleware/auth.ts:70-82` | **Correction to the handoff's copy assumption** (it assumed wrong-key → 401). The test-endpoint mapping below is built on the real semantics: empty key → 401 `missing_key`; wrong key → 403 → treat as auth failure. See Task 5. |
| Read-only authed probe targets on `ServerV1Routes`: `GET /v1/projects` (`readAuth`, scope `memories:read`) and `GET /v1/projects/:id` (`readAuth`, returns 200 / 404 / 403 via `ensureProjectAllowed`). | `ServerV1Routes.ts:86-93,105-115,279-285` | **These are the scoped read-only calls that back test steps 2 and 3** — both GET, no mutation. §Task 5 picks them explicitly. |
| `DEFAULT_SERVER_CLAUDE_MODEL = 'claude-sonnet-4-6'`; server reads `CLAUDE_MEM_SERVER_MODEL` (not `CLAUDE_MEM_MODEL`) and passes it through as a full model id. | `src/server/generation/providers/ClaudeObservationProvider.ts:22`; `create-server-service.ts:243,261,268,275` | The wizard emits **full ids** + the 3× warning + the explicit Haiku default (handoff §12.3). |
| Worker SQLite has an `observations` table with `created_at_epoch` (int). | `src/services/worker/http/routes/DataRoutes.ts:225` (`FROM observations`); `src/ui/viewer/types.ts:1-19` | E5 ingest recency queries this table. |
| The Settings modal binds a **global** `window` `Esc`→`onClose`. | `src/ui/viewer/components/ContextSettingsModal.tsx:162-170` | The inline editor/confirm must `stopPropagation` or scope `Esc`, or cancelling a field closes the modal (handoff §12.4). Task 12. |
| The modal's UI primitives (`CollapsibleSection`, `FormField`, `ToggleSwitch`) are defined **inline** in `ContextSettingsModal.tsx:16-119`, not shared. | same file | New components import from an extracted shared module (Task 8) so both the modal and the new panel use them. |
| Profile Save reuses the **existing settings save flow** (`useSettings.saveSettings` → `POST /api/settings`). | `src/ui/viewer/hooks/useSettings.ts:28-64`; handoff §4.6 "reuse the footer save flow" | Persistence path is `/api/settings` (hence E3 is the hard dependency). Activation is a server-side reconcile, not a UI computation. See the architecture decision below. |

### 0.1 Architecture decision the plan locks in (resolves a doc ambiguity)

The spec says *"`ConnectionStore` is the only writer of the connection keys; the UI never writes `settings.json` directly — it calls the store via the settings API."* The handoff says profile Save *"reuse[s] the footer save flow"* (`POST /api/settings`). Reconciling both:

- **The UI never computes canonical keys.** Add/edit/delete/activate all mutate the in-memory `CLAUDE_MEM_CONNECTIONS` (a JSON string) + `CLAUDE_MEM_ACTIVE_CONNECTION`, and persist through the **existing `POST /api/settings`**.
- **`ConnectionStore` owns the derivation** and is invoked **inside** `SettingsRoutes.handleUpdateSettings`, after the allow-listed keys are merged and **before** the single atomic write. It (a) seeds the undeletable Local worker if absent, and (b) derives the 4 canonical keys from the *active* profile and writes them into the same settings object. So the persisted file always has canonical keys consistent with the active profile — computed server-side, in one place. "Activate" = "set `CLAUDE_MEM_ACTIVE_CONNECTION` to the chosen id and save"; the server does the canonical-key write.

This keeps one persistence path (`/api/settings`), one owner of canonical-key derivation (`ConnectionStore`), and makes E3 genuinely the hard dependency the handoff flagged. **Builder: do not add separate `/api/connections` CRUD routes — that is explicitly out of scope for this plan.**

### 0.2 Ordering & the E3 hard-dependency

E3 is sequenced **first** (Tasks 1–2) so every later persistence-dependent task builds on a working seam. The dependency chain: **E3 (Task 1) → E6 (Task 2, invoked by the E3 handler) → E2/E1/E4/E5 (Tasks 3–6, independent endpoints) → UI foundation (Task 7–8) → UI surfaces (Tasks 9–12).** E4/E5 are the lowest-priority tail — the wizard degrades to output-only if they slip (handoff §9), but they are in scope for this PR.

### 0.3 Conventions

- **TDD**: every task writes the test first (`bun test <file>`), watches it fail, then implements. Test files live under `tests/` mirroring existing layout.
- **No new provider calls, no viewer auth, no live server mutation, no `ANTHROPIC_API_KEY` stored on the server** (Phase-2 boundaries, spec §9).
- **Tokens**: new UI uses the real `--color-accent-*` / `--color-bg-*` / `--color-text-*` tokens (handoff §2.1), never the phantom `--accent-color` fallbacks. The `.modal-footer` phantom-token cleanup (handoff §12.1) is **out of scope** — note it for a separate Polisher row.
- **Verification (run before PR):** `bun test` (no new failures vs the documented baseline), `npm run typecheck` (both tsconfigs), `npm run build`.

---

## Task 1 — E3: register the connection keys in `SettingsDefaults` + allow-list + validation

**Why:** `loadFromFile` strips unknown keys (§0), and the POST allow-list rejects them (§0). Without this, Save fails closed and reads round-trip to empty.

**Files:** `src/shared/SettingsDefaultsManager.ts`, `src/services/worker/http/routes/SettingsRoutes.ts`, tests.

### 1.1 Test first

`tests/shared/connection-settings-roundtrip.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('connection settings round-trip', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  function tmpSettings(contents: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-settings-'));
    dirs.push(dir);
    const p = join(dir, 'settings.json');
    writeFileSync(p, JSON.stringify(contents));
    return p;
  }

  it('preserves CLAUDE_MEM_CONNECTIONS and CLAUDE_MEM_ACTIVE_CONNECTION through loadFromFile', () => {
    const connections = JSON.stringify([{ id: 'local-worker', name: 'Local worker', runtime: 'worker', url: '', apiKey: '', projectId: '' }]);
    const p = tmpSettings({ CLAUDE_MEM_CONNECTIONS: connections, CLAUDE_MEM_ACTIVE_CONNECTION: 'local-worker' });
    const loaded = SettingsDefaultsManager.loadFromFile(p, false);
    expect(loaded.CLAUDE_MEM_CONNECTIONS).toBe(connections);
    expect(loaded.CLAUDE_MEM_ACTIVE_CONNECTION).toBe('local-worker');
  });

  it('defaults CLAUDE_MEM_CONNECTIONS to "[]" when absent', () => {
    const p = tmpSettings({});
    const loaded = SettingsDefaultsManager.loadFromFile(p, false);
    expect(loaded.CLAUDE_MEM_CONNECTIONS).toBe('[]');
    expect(loaded.CLAUDE_MEM_ACTIVE_CONNECTION).toBe('local-worker');
  });
});
```

`tests/services/settings-routes-connection-keys.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';

// Reach the private validator via a thin subclass so we don't stand up Express.
class TestableSettingsRoutes extends SettingsRoutes {
  public runValidate(body: unknown) {
    // @ts-expect-error — exercising the private validator directly.
    return this.validateSettings(body);
  }
}
const routes = new TestableSettingsRoutes({} as any);

describe('validateSettings — connection keys', () => {
  it('accepts a well-formed CLAUDE_MEM_CONNECTIONS array', () => {
    const body = { CLAUDE_MEM_CONNECTIONS: JSON.stringify([{ id: 'a', name: 'A', runtime: 'server', url: 'http://x:1', apiKey: 'k', projectId: 'p' }]) };
    expect(routes.runValidate(body).valid).toBe(true);
  });
  it('rejects CLAUDE_MEM_CONNECTIONS that is not JSON', () => {
    expect(routes.runValidate({ CLAUDE_MEM_CONNECTIONS: 'not json' }).valid).toBe(false);
  });
  it('rejects CLAUDE_MEM_CONNECTIONS that is not an array', () => {
    expect(routes.runValidate({ CLAUDE_MEM_CONNECTIONS: JSON.stringify({ id: 'x' }) }).valid).toBe(false);
  });
  it('rejects a profile with an invalid runtime', () => {
    const body = { CLAUDE_MEM_CONNECTIONS: JSON.stringify([{ id: 'a', name: 'A', runtime: 'nope', url: '', apiKey: '', projectId: '' }]) };
    expect(routes.runValidate(body).valid).toBe(false);
  });
  it('rejects an invalid CLAUDE_MEM_RUNTIME', () => {
    expect(routes.runValidate({ CLAUDE_MEM_RUNTIME: 'banana' }).valid).toBe(false);
  });
  it('accepts CLAUDE_MEM_RUNTIME server|worker', () => {
    expect(routes.runValidate({ CLAUDE_MEM_RUNTIME: 'server' }).valid).toBe(true);
    expect(routes.runValidate({ CLAUDE_MEM_RUNTIME: 'worker' }).valid).toBe(true);
  });
});
```

### 1.2 Implement — `SettingsDefaultsManager.ts`

Add to the `SettingsDefaults` interface (near the canonical server keys, after line 95):

```ts
  // Connection profiles (manager-over-canonical-keys seam). Stored as a
  // JSON-stringified ConnectionProfile[] (same pattern as CLAUDE_MEM_FOLDER_MD_EXCLUDE).
  // Activating a profile writes its values into the 4 canonical keys above.
  CLAUDE_MEM_CONNECTIONS: string;
  CLAUDE_MEM_ACTIVE_CONNECTION: string;
```

Add to `DEFAULTS` (after the `CLAUDE_MEM_SERVER_PROJECT_ID` default, line 187):

```ts
    // Connection profiles: seeded lazily to the undeletable Local worker by
    // ConnectionStore on first write. '[]' here keeps loadFromFile round-tripping.
    CLAUDE_MEM_CONNECTIONS: '[]',
    CLAUDE_MEM_ACTIVE_CONNECTION: 'local-worker',
```

### 1.3 Implement — `SettingsRoutes.ts`

Add the six keys to `settingKeys` (after line 106, inside the array):

```ts
      'CLAUDE_MEM_CONNECTIONS',
      'CLAUDE_MEM_ACTIVE_CONNECTION',
      'CLAUDE_MEM_RUNTIME',
      'CLAUDE_MEM_SERVER_URL',
      'CLAUDE_MEM_SERVER_API_KEY',
      'CLAUDE_MEM_SERVER_PROJECT_ID',
```

Add validation inside `validateSettings` (before the final `return { valid: true };`, line 237):

```ts
    if (settings.CLAUDE_MEM_RUNTIME) {
      if (!['worker', 'server'].includes(settings.CLAUDE_MEM_RUNTIME)) {
        return { valid: false, error: 'CLAUDE_MEM_RUNTIME must be "worker" or "server"' };
      }
    }

    if (settings.CLAUDE_MEM_CONNECTIONS !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(settings.CLAUDE_MEM_CONNECTIONS);
      } catch {
        return { valid: false, error: 'CLAUDE_MEM_CONNECTIONS must be a JSON array of connection profiles' };
      }
      if (!Array.isArray(parsed)) {
        return { valid: false, error: 'CLAUDE_MEM_CONNECTIONS must be a JSON array' };
      }
      for (const profile of parsed as Array<Record<string, unknown>>) {
        if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string') {
          return { valid: false, error: 'Each connection profile needs a string id and name' };
        }
        if (profile.runtime !== 'worker' && profile.runtime !== 'server') {
          return { valid: false, error: `Connection profile "${profile.name}" has an invalid runtime (must be worker|server)` };
        }
      }
    }
```

**Note (write-only key reality — surface in the PR):** `GET /api/settings` returns the full settings object today, including `CLAUDE_MEM_GEMINI_API_KEY` etc. in plaintext (`SettingsRoutes.ts:37-42`) — the existing provider keys are **not** redacted. `CLAUDE_MEM_CONNECTIONS` (which embeds per-profile `apiKey`) will be returned the same way. This matches current behavior and is **not** made worse by this change; the UI treats the key field as write-only in the editor (Task 9). True at-rest redaction of `GET /api/settings` is a separate hardening item (ties to queue #23 file perms) and is **out of scope**. The **test endpoint** (Task 5) has a stricter, enforced contract: it never echoes or logs the key.

### 1.4 Verify
`bun test tests/shared/connection-settings-roundtrip.test.ts tests/services/settings-routes-connection-keys.test.ts` → green. `npm run typecheck` → clean.

---

## Task 2 — E6: `ConnectionStore` (seed + derive canonical keys), wired into the settings write

**Why:** single owner of canonical-key derivation (§0.1). Pure functions → trivially testable; `SettingsRoutes` calls `applyToSettings` before its atomic write.

**Files:** `src/services/worker/ConnectionStore.ts` (new), `src/services/worker/http/routes/SettingsRoutes.ts`, tests.

### 2.1 Test first

`tests/services/connection-store.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { ConnectionStore, LOCAL_WORKER_ID } from '../../src/services/worker/ConnectionStore.js';

const server = { id: 'nas', name: 'NAS', runtime: 'server' as const, url: 'https://nas:37700', apiKey: 'sk-123', projectId: 'proj' };

describe('ConnectionStore.applyToSettings', () => {
  it('seeds an undeletable Local worker profile when connections is empty', () => {
    const out = ConnectionStore.applyToSettings({ CLAUDE_MEM_CONNECTIONS: '[]', CLAUDE_MEM_ACTIVE_CONNECTION: '' } as any);
    const conns = JSON.parse(out.CLAUDE_MEM_CONNECTIONS);
    expect(conns).toHaveLength(1);
    expect(conns[0].id).toBe(LOCAL_WORKER_ID);
    expect(conns[0].runtime).toBe('worker');
    expect(out.CLAUDE_MEM_ACTIVE_CONNECTION).toBe(LOCAL_WORKER_ID);
  });

  it('writes canonical keys from the active server profile', () => {
    const out = ConnectionStore.applyToSettings({
      CLAUDE_MEM_CONNECTIONS: JSON.stringify([server]),
      CLAUDE_MEM_ACTIVE_CONNECTION: 'nas',
    } as any);
    expect(out.CLAUDE_MEM_RUNTIME).toBe('server');
    expect(out.CLAUDE_MEM_SERVER_URL).toBe('https://nas:37700');
    expect(out.CLAUDE_MEM_SERVER_API_KEY).toBe('sk-123');
    expect(out.CLAUDE_MEM_SERVER_PROJECT_ID).toBe('proj');
  });

  it('clears server canonical keys when the active profile is the local worker', () => {
    const out = ConnectionStore.applyToSettings({
      CLAUDE_MEM_CONNECTIONS: JSON.stringify([server]),
      CLAUDE_MEM_ACTIVE_CONNECTION: LOCAL_WORKER_ID, // seeded worker + nas
    } as any);
    expect(out.CLAUDE_MEM_RUNTIME).toBe('worker');
    expect(out.CLAUDE_MEM_SERVER_URL).toBe('');
    expect(out.CLAUDE_MEM_SERVER_API_KEY).toBe('');
    expect(out.CLAUDE_MEM_SERVER_PROJECT_ID).toBe('');
  });

  it('falls back to the local worker when the active id is unknown', () => {
    const out = ConnectionStore.applyToSettings({
      CLAUDE_MEM_CONNECTIONS: JSON.stringify([server]),
      CLAUDE_MEM_ACTIVE_CONNECTION: 'ghost',
    } as any);
    expect(out.CLAUDE_MEM_ACTIVE_CONNECTION).toBe(LOCAL_WORKER_ID);
    expect(out.CLAUDE_MEM_RUNTIME).toBe('worker');
  });

  it('is idempotent — re-applying does not duplicate the local worker', () => {
    const once = ConnectionStore.applyToSettings({ CLAUDE_MEM_CONNECTIONS: '[]', CLAUDE_MEM_ACTIVE_CONNECTION: '' } as any);
    const twice = ConnectionStore.applyToSettings(once);
    expect(JSON.parse(twice.CLAUDE_MEM_CONNECTIONS)).toHaveLength(1);
  });
});
```

### 2.2 Implement — `src/services/worker/ConnectionStore.ts`

```ts
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

    // Resolve active; fall back to the Local worker when the id is unknown/blank.
    const requestedId = settings.CLAUDE_MEM_ACTIVE_CONNECTION ?? '';
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
```

### 2.3 Wire into `SettingsRoutes.handleUpdateSettings`

Add the import at the top:

```ts
import { ConnectionStore } from '../../ConnectionStore.js';
```

Replace the merge-then-write block (currently `SettingsRoutes.ts:109-115`):

```ts
    for (const key of settingKeys) {
      if (req.body[key] !== undefined) {
        settings[key] = req.body[key];
      }
    }

    // ConnectionStore is the single owner of canonical-key derivation: seed the
    // Local worker + reconcile CLAUDE_MEM_RUNTIME/SERVER_* from the active
    // profile, in-memory, so the file is written once and stays consistent.
    settings = ConnectionStore.applyToSettings(settings);

    writeJsonFileAtomic(settingsPath, settings);
```

(`settings` is already declared `let settings: any = {}` at `SettingsRoutes.ts:60`, so reassignment is fine.)

### 2.4 Verify
`bun test tests/services/connection-store.test.ts` → green. The round-trip test (Task 1) plus this unit coverage cover the seam; if a live-Express settings harness exists in the tree, add one POST→GET assertion that a saved server profile makes `GET /api/settings` return `CLAUDE_MEM_RUNTIME=server`.

---

## Task 3 — E2: `GET /api/runtime-role`

**Why:** context-aware rendering (D5/R2). Authoritative from the worker's own config, not a guess.

**Files:** `src/services/worker/http/routes/RuntimeRoleRoutes.ts` (new), register in `worker-service.ts`, test.

### 3.1 Test first — `tests/services/runtime-role-route.test.ts`

```ts
import { describe, it, expect } from 'bun:test';
import { resolveRuntimeRole } from '../../src/services/worker/http/routes/RuntimeRoleRoutes.js';

describe('resolveRuntimeRole', () => {
  it('returns worker for CLAUDE_MEM_RUNTIME=worker', () => {
    expect(resolveRuntimeRole({ CLAUDE_MEM_RUNTIME: 'worker' } as any)).toBe('worker');
  });
  it('returns server for CLAUDE_MEM_RUNTIME=server', () => {
    expect(resolveRuntimeRole({ CLAUDE_MEM_RUNTIME: 'server' } as any)).toBe('server');
  });
  it('returns unknown for an unrecognized value', () => {
    expect(resolveRuntimeRole({ CLAUDE_MEM_RUNTIME: 'weird' } as any)).toBe('unknown');
  });
});
```

### 3.2 Implement — `RuntimeRoleRoutes.ts`

```ts
// SPDX-License-Identifier: Apache-2.0
import express, { Request, Response } from 'express';
import { paths } from '../../../../shared/paths.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../../../shared/SettingsDefaultsManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

export type RuntimeRole = 'worker' | 'server' | 'unknown';

/** Authoritative role from the worker's own config (env override + settings.json). */
export function resolveRuntimeRole(settings: Pick<SettingsDefaults, 'CLAUDE_MEM_RUNTIME'>): RuntimeRole {
  const value = (settings.CLAUDE_MEM_RUNTIME ?? '').trim().toLowerCase();
  if (value === 'worker') return 'worker';
  if (value === 'server') return 'server';
  return 'unknown';
}

export class RuntimeRoleRoutes extends BaseRouteHandler {
  setupRoutes(app: express.Application): void {
    app.get('/api/runtime-role', this.handleGetRole.bind(this));
  }

  private handleGetRole = this.wrapHandler((_req: Request, res: Response): void => {
    let role: RuntimeRole = 'unknown';
    try {
      const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
      role = resolveRuntimeRole(settings);
    } catch {
      role = 'unknown'; // UI shows the manual toggle (handoff §3)
    }
    res.json({ role });
  });
}
```

### 3.3 Register in `worker-service.ts`

Import (near the other route imports, ~line 108):

```ts
import { RuntimeRoleRoutes } from './worker/http/routes/RuntimeRoleRoutes.js';
```

Register (in `registerRoutes()`, after the `SettingsRoutes` registration, `worker-service.ts:365`):

```ts
    this.server.registerRoutes(new RuntimeRoleRoutes());
```

**Recommended:** add `req.path === '/runtime-role'` to the init-guard bypass list (`worker-service.ts:330-335`, alongside `/version`) so the panel can pick its context immediately on load rather than waiting for `initializationCompleteFlag`.

### 3.4 Verify
`bun test tests/services/runtime-role-route.test.ts` → green.

---

## Task 4 — E4: `GET /api/server-config` (read-only current generation config)

**Why:** the CURRENT read-only block (handoff §6.5). Key value never returned.

**Files:** `src/services/worker/http/routes/ServerConfigRoutes.ts` (new), register, test.

### 4.1 Test first — `tests/services/server-config-route.test.ts`

```ts
import { describe, it, expect, afterEach } from 'bun:test';
import { readServerGenerationConfig } from '../../src/services/worker/http/routes/ServerConfigRoutes.js';

describe('readServerGenerationConfig', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('reports keyPresent=false and the explicit default model when ANTHROPIC_API_KEY is unset', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_MEM_SERVER_MODEL;
    process.env.CLAUDE_MEM_SERVER_PROVIDER = 'claude';
    const cfg = readServerGenerationConfig(process.env);
    expect(cfg.provider).toBe('claude');
    expect(cfg.keyPresent).toBe(false);
    expect(cfg.model).toBe('claude-sonnet-4-6'); // DEFAULT_SERVER_CLAUDE_MODEL, surfaced explicitly
  });

  it('reports keyPresent=true and never returns the key value', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-secret';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'claude-haiku-4-5-20251001';
    const cfg = readServerGenerationConfig(process.env);
    expect(cfg.keyPresent).toBe(true);
    expect(cfg.keySource).toBe('ANTHROPIC_API_KEY');
    expect(cfg.model).toBe('claude-haiku-4-5-20251001');
    expect(JSON.stringify(cfg)).not.toContain('sk-secret');
  });
});
```

### 4.2 Implement — `ServerConfigRoutes.ts`

```ts
// SPDX-License-Identifier: Apache-2.0
import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { DEFAULT_SERVER_CLAUDE_MODEL } from '../../../../server/generation/providers/ClaudeObservationProvider.js';

export interface ServerGenerationConfig {
  provider: string;
  model: string;
  keyPresent: boolean;
  keySource: string | null;
}

/**
 * Read the server's effective generation config from env — the same vars
 * create-server-service.ts reads (CLAUDE_MEM_SERVER_PROVIDER / _MODEL,
 * ANTHROPIC_API_KEY). The key VALUE is never returned — only presence + source.
 * The model default is surfaced EXPLICITLY (claude-sonnet-4-6) rather than left
 * implicit, so the UI can flag the silent 3× default (handoff §6.2/§12.3).
 */
export function readServerGenerationConfig(env: NodeJS.ProcessEnv): ServerGenerationConfig {
  const provider = (env.CLAUDE_MEM_SERVER_PROVIDER ?? '').trim().toLowerCase() || 'claude';
  const model = env.CLAUDE_MEM_SERVER_MODEL?.trim() || DEFAULT_SERVER_CLAUDE_MODEL;

  let keyPresent = false;
  let keySource: string | null = null;
  if (env.ANTHROPIC_API_KEY) { keyPresent = true; keySource = 'ANTHROPIC_API_KEY'; }
  else if (env.CLAUDE_MEM_ANTHROPIC_API_KEY) { keyPresent = true; keySource = 'CLAUDE_MEM_ANTHROPIC_API_KEY'; }
  else if (provider === 'gemini' && (env.GEMINI_API_KEY || env.CLAUDE_MEM_GEMINI_API_KEY)) { keyPresent = true; keySource = env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : 'CLAUDE_MEM_GEMINI_API_KEY'; }
  else if (provider === 'openrouter' && (env.OPENROUTER_API_KEY || env.CLAUDE_MEM_OPENROUTER_API_KEY)) { keyPresent = true; keySource = env.OPENROUTER_API_KEY ? 'OPENROUTER_API_KEY' : 'CLAUDE_MEM_OPENROUTER_API_KEY'; }

  return { provider, model, keyPresent, keySource };
}

export class ServerConfigRoutes extends BaseRouteHandler {
  setupRoutes(app: express.Application): void {
    app.get('/api/server-config', this.handleGet.bind(this));
  }

  private handleGet = this.wrapHandler((_req: Request, res: Response): void => {
    res.json(readServerGenerationConfig(process.env));
  });
}
```

### 4.3 Register + verify
Import + `this.server.registerRoutes(new ServerConfigRoutes());` alongside Task 3's registration. `bun test tests/services/server-config-route.test.ts` → green.

---

## Task 5 — E1: `POST /api/connection/test` (the 3-step probe) — security-critical

**Why:** the whole test-before-activate interaction (handoff §5). **This is the highest-risk task.** Design the security explicitly.

**Files:** `src/services/worker/http/routes/ConnectionTestRoutes.ts` (new) with a pure `probeConnection` core, register, tests.

### 5.0 Security design (explicit — required by the deliverable)

1. **No key in responses.** The response DTO has no `apiKey` field. A test asserts the serialized response contains no substring of the key.
2. **No key in logs.** The probe never passes `apiKey` to `logger.*`. It logs only `{ host, step, status, code, http }`. A test spies on the logger and asserts no call argument contains the key.
3. **Scoped, read-only backing calls** (the two the deliverable asks me to pick):
   - **Step 2 (authenticated):** `GET {url}/v1/projects` — `readAuth`, scope `memories:read` (`ServerV1Routes.ts:86`). A pure read; the lightest authed GET. Returns **200** on a good key, **401** on a *missing* key, **403** on an *invalid* key or insufficient scope (`auth.ts:70-82`). No write path is touched.
   - **Step 3 (project valid):** `GET {url}/v1/projects/{projectId}` — `readAuth` (`ServerV1Routes.ts:105-115`). Returns **200** when the project exists and the key may use it, **404** when it does not exist (→ `warn`, "created on first capture"), **403** via `ensureProjectAllowed` when the key is scoped to a *different* project (→ `fail`). This single GET cleanly separates all three step-3 outcomes.
4. **Per-step timeout** via `AbortController` (5s reachable / 5s auth / 5s project). The timeout value is echoed in the response so `{timeout}` interpolates in the copy.
5. **Short-circuit:** the first hard `fail` marks all downstream steps `skipped` (`skipped_upstream_failed`) without making the call.
6. **URL hygiene / SSRF (R3):** reject non-http(s) schemes and unparseable URLs as `bad_url` (this also blocks `file://` etc.). Phase-1 is localhost-initiated; the endpoint is scoped strictly to this probe. No host allow/deny-list in Phase 1 (would break LAN/Tailscale by design) — flagged for the Architect under Phase-2 auth.

**Correction to the handoff's HTTP-code assumption (§5.4):** the handoff maps "wrong key → 401". The real server (`auth.ts`) returns **401 only for a *missing* key** and **403 for an *invalid* key or insufficient scope**. The mapping below honors the real semantics: empty profile key → `missing_key`; wrong key → 403 → `unauthorized` copy ("the server rejected the API key"). The handoff's `forbidden` code (403 "key accepted but lacks access") is **not distinguishable at step 2** from a wrong key on this server (both 403, same body), so step 2 emits `unauthorized` for any 4xx; genuine project-scope `forbidden` surfaces at **step 3** as `project_forbidden`, which is where it's actionable. This is the "small backend design task" the handoff (§5.5) left to the Planner — resolved here.

### 5.1 Test first — `tests/services/connection-test-probe.test.ts`

```ts
import { describe, it, expect, mock } from 'bun:test';
import { probeConnection } from '../../src/services/worker/http/routes/ConnectionTestRoutes.js';

// A fetch stub keyed by URL suffix so each step is controllable.
function stubFetch(map: Record<string, { status: number; body?: unknown; throws?: string }>) {
  return mock(async (input: string) => {
    const match = Object.keys(map).find(k => input.endsWith(k));
    if (!match) throw new Error(`unexpected fetch ${input}`);
    const entry = map[match];
    if (entry.throws) { const e = new Error(entry.throws); (e as any).name = entry.throws; throw e; }
    return { status: entry.status, ok: entry.status < 400, json: async () => entry.body ?? {} } as Response;
  });
}

const base = { runtime: 'server' as const, url: 'https://nas:37700', apiKey: 'sk-good', projectId: 'proj' };

describe('probeConnection', () => {
  it('worker runtime returns ok with no steps', async () => {
    const r = await probeConnection({ ...base, runtime: 'worker' }, { fetchImpl: stubFetch({}) as any });
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(0);
  });

  it('all-pass path activates', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({
        '/healthz': { status: 200, body: { status: 'ok' } },
        '/v1/projects': { status: 200, body: { projects: [] } },
        '/v1/projects/proj': { status: 200, body: { project: { id: 'proj' } } },
      }) as any,
    });
    expect(r.ok).toBe(true);
    expect(r.steps.map(s => s.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('unknown project → warn (still ok)', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({
        '/healthz': { status: 200, body: { status: 'ok' } },
        '/v1/projects': { status: 200, body: { projects: [] } },
        '/v1/projects/proj': { status: 404, body: { error: 'NotFound' } },
      }) as any,
    });
    expect(r.ok).toBe(true);
    const project = r.steps.find(s => s.step === 'project')!;
    expect(project.status).toBe('warn');
    expect(project.code).toBe('project_will_be_created');
  });

  it('wrong key → 403 → auth fail, project skipped, not ok', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({
        '/healthz': { status: 200, body: { status: 'ok' } },
        '/v1/projects': { status: 403, body: { error: 'Forbidden' } },
      }) as any,
    });
    expect(r.ok).toBe(false);
    expect(r.steps.find(s => s.step === 'authenticated')!.code).toBe('unauthorized');
    expect(r.steps.find(s => s.step === 'project')!.status).toBe('skipped');
  });

  it('empty key → missing_key (no auth call made)', async () => {
    const r = await probeConnection({ ...base, apiKey: '' }, {
      fetchImpl: stubFetch({ '/healthz': { status: 200, body: { status: 'ok' } } }) as any,
    });
    expect(r.steps.find(s => s.step === 'authenticated')!.code).toBe('missing_key');
  });

  it('unreachable → step 1 fail, rest skipped', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({ '/healthz': { status: 0, throws: 'FetchError' } }) as any,
    });
    expect(r.steps[0].status).toBe('fail');
    expect(r.steps[0].code).toBe('unreachable');
  });

  it('bad url → bad_url, no fetch attempted', async () => {
    const r = await probeConnection({ ...base, url: 'file:///etc/passwd' }, { fetchImpl: stubFetch({}) as any });
    expect(r.steps[0].code).toBe('bad_url');
  });

  it('never echoes the apiKey in the response', async () => {
    const r = await probeConnection({ ...base, apiKey: 'sk-TOP-SECRET' }, {
      fetchImpl: stubFetch({
        '/healthz': { status: 200, body: { status: 'ok' } },
        '/v1/projects': { status: 200, body: {} },
        '/v1/projects/proj': { status: 200, body: {} },
      }) as any,
    });
    expect(JSON.stringify(r)).not.toContain('sk-TOP-SECRET');
  });
});
```

### 5.2 Implement — `ConnectionTestRoutes.ts`

```ts
// SPDX-License-Identifier: Apache-2.0
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';

export type StepStatus = 'pass' | 'warn' | 'fail' | 'skipped';
export type StepName = 'reachable' | 'authenticated' | 'project';

export interface StepResult {
  step: StepName;
  status: StepStatus;
  code: string;
  http?: number;
  latencyMs?: number;
  message: string;
}

export interface ProbeResult {
  ok: boolean;
  runtime: 'worker' | 'server';
  steps: StepResult[];
  checkedAt: string;
  totalMs: number;
  timeoutSeconds: number;
}

export const connectionTestSchema = z.object({
  runtime: z.enum(['worker', 'server']),
  url: z.string(),
  apiKey: z.string(),
  projectId: z.string(),
}).passthrough();

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** Join a base URL and a path without double slashes. */
function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

function isClaudeMemHealth(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as any).status === 'ok';
}

/** GET with a hard per-step timeout; classifies transport failures. */
async function timedGet(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: any; latencyMs: number } | { error: 'timeout' | 'tls' | 'network' }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    const latencyMs = Date.now() - started;
    let body: any = {};
    try { body = await res.json(); } catch { body = {}; }
    return { status: res.status, body, latencyMs };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    if (name === 'AbortError') return { error: 'timeout' };
    if (msg.includes('certificate') || msg.includes('tls') || msg.includes('ssl')) return { error: 'tls' };
    return { error: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pure 3-step probe. No persistence. The apiKey is used ONLY to build the
 * Authorization header — it is never returned in ProbeResult and never logged.
 */
export async function probeConnection(
  input: { runtime: 'worker' | 'server'; url: string; apiKey: string; projectId: string },
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSeconds = Math.round(timeoutMs / 1000);
  const startedAll = Date.now();
  const steps: StepResult[] = [];
  const host = hostOf(input.url);

  const finish = (): ProbeResult => {
    const ok = steps.every(s => s.status === 'pass' || s.status === 'warn');
    // Structured log — NEVER includes apiKey.
    logger.info('WORKER', 'connection test probe', { host, ok, codes: steps.map(s => `${s.step}:${s.code}`) });
    return { ok, runtime: 'server', steps, checkedAt: new Date().toISOString(), totalMs: Date.now() - startedAll, timeoutSeconds };
  };

  if (input.runtime === 'worker') {
    return { ok: true, runtime: 'worker', steps: [], checkedAt: new Date().toISOString(), totalMs: 0, timeoutSeconds };
  }

  const skip = (step: StepName): StepResult => ({
    step, status: 'skipped', code: 'skipped_upstream_failed', message: 'Skipped — fix the step above first.',
  });

  // ---- Step 1: reachable ----
  let scheme = '';
  try { scheme = new URL(input.url).protocol; } catch { /* handled below */ }
  if (scheme !== 'http:' && scheme !== 'https:') {
    steps.push({ step: 'reachable', status: 'fail', code: 'bad_url', message: 'That doesn’t look like a valid URL. Expected e.g. http://nas.lan:37700.' });
    steps.push(skip('authenticated'), skip('project'));
    return finish();
  }

  const health = await timedGet(fetchImpl, joinUrl(input.url, '/healthz'), {}, timeoutMs);
  if ('error' in health) {
    const code = health.error === 'timeout' ? 'timeout' : health.error === 'tls' ? 'tls_error' : 'unreachable';
    const message =
      code === 'timeout' ? `${host} didn’t respond in ${timeoutSeconds}s. Check the address and that it’s reachable from here.`
      : code === 'tls_error' ? `Reached ${host} but its TLS certificate was rejected.`
      : `Couldn’t reach ${host}. Is the server running and on this network?`;
    steps.push({ step: 'reachable', status: 'fail', code, message });
    steps.push(skip('authenticated'), skip('project'));
    return finish();
  }
  if (health.status !== 200 || !isClaudeMemHealth(health.body)) {
    steps.push({ step: 'reachable', status: 'fail', code: 'not_claude_mem', http: health.status, message: `Reached ${host}, but it doesn’t look like a claude-mem server.` });
    steps.push(skip('authenticated'), skip('project'));
    return finish();
  }
  steps.push({ step: 'reachable', status: 'pass', code: 'ok', http: 200, latencyMs: health.latencyMs, message: `Server responded (200) in ${health.latencyMs} ms.` });

  // ---- Step 2: authenticated (GET /v1/projects, scope memories:read) ----
  if (!input.apiKey) {
    steps.push({ step: 'authenticated', status: 'fail', code: 'missing_key', message: 'This server requires an API key. Add one to continue.' });
    steps.push(skip('project'));
    return finish();
  }
  const authHeaders = { Authorization: `Bearer ${input.apiKey}`, 'X-Api-Key': input.apiKey };
  const auth = await timedGet(fetchImpl, joinUrl(input.url, '/v1/projects'), authHeaders, timeoutMs);
  if ('error' in auth) {
    const code = auth.error === 'timeout' ? 'timeout' : 'unreachable';
    steps.push({ step: 'authenticated', status: 'fail', code, message: `Couldn’t complete the auth check against ${host}.` });
    steps.push(skip('project'));
    return finish();
  }
  if (auth.status === 401) {
    steps.push({ step: 'authenticated', status: 'fail', code: 'missing_key', http: 401, message: 'This server requires an API key. Add one to continue.' });
    steps.push(skip('project'));
    return finish();
  }
  if (auth.status >= 400) {
    // Real server: 403 = invalid key OR insufficient scope (indistinguishable here).
    steps.push({ step: 'authenticated', status: 'fail', code: 'unauthorized', http: auth.status, message: `The server rejected the API key (${auth.status}). Double-check the key.` });
    steps.push(skip('project'));
    return finish();
  }
  steps.push({ step: 'authenticated', status: 'pass', code: 'ok', http: auth.status, message: 'API key accepted.' });

  // ---- Step 3: project valid (GET /v1/projects/:id) ----
  if (!input.projectId) {
    steps.push({ step: 'project', status: 'fail', code: 'missing_project', message: 'Enter a project ID for this connection.' });
    return finish();
  }
  const proj = await timedGet(fetchImpl, joinUrl(input.url, `/v1/projects/${encodeURIComponent(input.projectId)}`), authHeaders, timeoutMs);
  if ('error' in proj) {
    steps.push({ step: 'project', status: 'fail', code: 'timeout', message: `Couldn’t verify the project against ${host}.` });
    return finish();
  }
  if (proj.status === 200) {
    steps.push({ step: 'project', status: 'pass', code: 'ok', http: 200, message: `Project “${input.projectId}” is ready.` });
  } else if (proj.status === 404) {
    steps.push({ step: 'project', status: 'warn', code: 'project_will_be_created', http: 404, message: `Project “${input.projectId}” is new — it’ll be created on the first capture.` });
  } else if (proj.status === 403) {
    steps.push({ step: 'project', status: 'fail', code: 'project_forbidden', http: 403, message: `This key can’t write to project “${input.projectId}” (403).` });
  } else {
    steps.push({ step: 'project', status: 'fail', code: 'project_forbidden', http: proj.status, message: `Couldn’t verify project “${input.projectId}” (${proj.status}).` });
  }
  return finish();
}

export class ConnectionTestRoutes extends BaseRouteHandler {
  setupRoutes(app: express.Application): void {
    app.post('/api/connection/test', validateBody(connectionTestSchema), this.handleTest.bind(this));
  }

  private handleTest = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { runtime, url, apiKey, projectId } = req.body as z.infer<typeof connectionTestSchema>;
    const result = await probeConnection({ runtime, url, apiKey, projectId });
    res.json(result); // ProbeResult carries no apiKey field by construction.
  });
}
```

### 5.3 Register + no-leak test
Import + `this.server.registerRoutes(new ConnectionTestRoutes());` alongside Task 3.

`tests/services/connection-test-no-key-leak.test.ts`:

```ts
import { describe, it, expect, spyOn } from 'bun:test';
import { probeConnection } from '../../src/services/worker/http/routes/ConnectionTestRoutes.js';
import { logger } from '../../src/utils/logger.js';

describe('connection test — no key in logs', () => {
  it('never passes the apiKey to the logger', async () => {
    const spy = spyOn(logger, 'info');
    await probeConnection(
      { runtime: 'server', url: 'https://nas:1', apiKey: 'sk-LEAKME', projectId: 'p' },
      { fetchImpl: (async () => ({ status: 200, ok: true, json: async () => ({ status: 'ok' }) })) as any },
    );
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('sk-LEAKME');
    }
  });
});
```

`bun test tests/services/connection-test-probe.test.ts tests/services/connection-test-no-key-leak.test.ts` → green.

---

## Task 6 — E5: `GET /api/ingest-status` (the anti-silent-failure signal)

**Why:** "verify ingest for real, not `/healthz`" (handoff §6.4/§6.5).

**Files:** `src/services/worker/http/routes/IngestStatusRoutes.ts` (new), register late (after DB init, like `SearchRoutes`), test.

### 6.1 Design note (backend-boundary flag)
The worker stores observations in **SQLite** (`observations` table, `created_at_epoch`). The route queries that. **On a genuine Postgres server deployment**, ingest recency lives in Postgres `memory_items` — a different source. Phase-1 scope: the worker route reads SQLite (the store the viewer's own worker uses). Flag for the Architect: a true server-context ingest signal needs a Postgres-backed variant (fast-follow / Phase 2). Documented, not silently wrong.

### 6.2 Test first — `tests/services/ingest-status-query.test.ts`

```ts
import { Database } from 'bun:sqlite';
import { describe, it, expect } from 'bun:test';
import { queryIngestStatus } from '../../src/services/worker/http/routes/IngestStatusRoutes.js';

function seed(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE observations (id INTEGER PRIMARY KEY, created_at_epoch INTEGER)`);
  return db;
}

describe('queryIngestStatus', () => {
  it('reports no data when empty', () => {
    const r = queryIngestStatus(seed() as any, 24 * 3600, 1_000_000);
    expect(r.lastObservationAt).toBeNull();
    expect(r.countLastWindow).toBe(0);
  });
  it('counts only observations inside the window and returns the latest epoch', () => {
    const db = seed();
    const now = 1_000_000;
    db.run(`INSERT INTO observations (created_at_epoch) VALUES (?)`, [now - 10]);       // in window
    db.run(`INSERT INTO observations (created_at_epoch) VALUES (?)`, [now - 100_000]);  // outside 1h window
    const r = queryIngestStatus(db as any, 3600, now); // 1h window
    expect(r.countLastWindow).toBe(1);
    expect(r.lastObservationAt).toBe(now - 10);
  });
});
```

### 6.3 Implement — `IngestStatusRoutes.ts`

```ts
// SPDX-License-Identifier: Apache-2.0
import express, { Request, Response } from 'express';
import type { Database } from 'bun:sqlite';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

export interface IngestStatus {
  lastObservationAt: number | null; // epoch seconds (created_at_epoch)
  countLastWindow: number;
  window: string;
}

const WINDOW_SECONDS = 24 * 3600;

/** Pure query so it unit-tests against an in-memory DB. */
export function queryIngestStatus(db: Database, windowSeconds: number, nowEpoch: number): IngestStatus {
  const since = nowEpoch - windowSeconds;
  const row = db
    .query(`SELECT MAX(created_at_epoch) AS last,
                   SUM(CASE WHEN created_at_epoch >= ? THEN 1 ELSE 0 END) AS cnt
            FROM observations`)
    .get(since) as { last: number | null; cnt: number | null };
  return {
    lastObservationAt: row?.last ?? null,
    countLastWindow: Number(row?.cnt ?? 0),
    window: windowSeconds === WINDOW_SECONDS ? '24h' : `${Math.round(windowSeconds / 3600)}h`,
  };
}

export class IngestStatusRoutes extends BaseRouteHandler {
  constructor(private readonly getDatabase: () => Database) { super(); }

  setupRoutes(app: express.Application): void {
    app.get('/api/ingest-status', this.handleGet.bind(this));
  }

  private handleGet = this.wrapHandler((_req: Request, res: Response): void => {
    const nowEpoch = Math.floor(Date.now() / 1000);
    res.json(queryIngestStatus(this.getDatabase(), WINDOW_SECONDS, nowEpoch));
  });
}
```

### 6.4 Register (late, after DB init)
In `worker-service.ts` `initializeBackground()`, after `this.dbManager.initialize()` (near the `SearchRoutes` registration, ~line 526):

```ts
      this.server.registerRoutes(new IngestStatusRoutes(() => this.dbManager.getConnection()));
```

Import at top. `bun test tests/services/ingest-status-query.test.ts` → green.

---

## Task 7 — UI foundation: types, constants, connection serialization helper

**Files:** `src/ui/viewer/types.ts`, `src/ui/viewer/constants/settings.ts`, `src/ui/viewer/constants/api.ts`, new `src/ui/viewer/lib/connections.ts`, test.

### 7.1 Extend `Settings` (types.ts, inside the interface, after line 93)

```ts
  CLAUDE_MEM_CONNECTIONS?: string;         // JSON-stringified ConnectionProfile[]
  CLAUDE_MEM_ACTIVE_CONNECTION?: string;
```

### 7.2 Extend UI `DEFAULT_SETTINGS` (constants/settings.ts, inside the object)

```ts
  CLAUDE_MEM_CONNECTIONS: '[]',
  CLAUDE_MEM_ACTIVE_CONNECTION: 'local-worker',
```

### 7.3 Extend `API_ENDPOINTS` (constants/api.ts)

```ts
  RUNTIME_ROLE: '/api/runtime-role',
  CONNECTION_TEST: '/api/connection/test',
  SERVER_CONFIG: '/api/server-config',
  INGEST_STATUS: '/api/ingest-status',
```

### 7.4 New `src/ui/viewer/lib/connections.ts`

```ts
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
```

### 7.5 Test — `tests/ui/connections-lib.test.ts`

```ts
import { describe, it, expect } from 'bun:test';
import { parseConnections, serializeConnections, withLocalWorker, LOCAL_WORKER_ID } from '../../src/ui/viewer/lib/connections.js';

describe('connections lib', () => {
  it('round-trips profiles', () => {
    const profiles = [{ id: 'a', name: 'A', runtime: 'server' as const, url: 'http://x:1', apiKey: 'k', projectId: 'p' }];
    expect(parseConnections(serializeConnections(profiles))).toEqual(profiles);
  });
  it('drops malformed entries', () => {
    expect(parseConnections('[{"id":1}]')).toEqual([]);
    expect(parseConnections('not json')).toEqual([]);
  });
  it('withLocalWorker prepends the undeletable worker', () => {
    const out = withLocalWorker([]);
    expect(out[0].id).toBe(LOCAL_WORKER_ID);
  });
});
```

`bun test tests/ui/connections-lib.test.ts` → green.

---

## Task 8 — Extract shared UI primitives + add `useRuntimeRole` and `useConnectionTest` hooks

**Files:** new `src/ui/viewer/components/SettingsPrimitives.tsx`, edit `ContextSettingsModal.tsx` to import them, new hooks, test.

### 8.1 Extract primitives
Move `CollapsibleSection`, `FormField`, `ToggleSwitch` (currently `ContextSettingsModal.tsx:16-119`) verbatim into `src/ui/viewer/components/SettingsPrimitives.tsx` and `export` each. In `ContextSettingsModal.tsx`, delete the inline definitions and add:

```ts
import { CollapsibleSection, FormField, ToggleSwitch } from './SettingsPrimitives';
```

(No behavior change — pure extraction so the new panel reuses the exact same primitives/classes.)

### 8.2 `src/ui/viewer/hooks/useRuntimeRole.ts`

```ts
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
```

### 8.3 `src/ui/viewer/hooks/useConnectionTest.ts`

```ts
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
```

### 8.4 Test — `tests/ui/use-runtime-role.test.ts` (pure helper)

```ts
import { describe, it, expect } from 'bun:test';
import { computeEffectiveRole } from '../../src/ui/viewer/hooks/useRuntimeRole.js';

describe('computeEffectiveRole', () => {
  it('a definite probe wins over any override', () => {
    expect(computeEffectiveRole('server', 'worker')).toBe('server');
    expect(computeEffectiveRole('worker', 'server')).toBe('worker');
  });
  it('falls back to override when the probe is unknown', () => {
    expect(computeEffectiveRole('unknown', 'server')).toBe('server');
  });
  it('defaults to worker when unknown and no override', () => {
    expect(computeEffectiveRole('unknown', null)).toBe('worker');
  });
});
```

`bun test tests/ui/use-runtime-role.test.ts` → green.

---

## Task 9 — Connection panel (worker context): list, editor, presets, action bar, delete confirm

**Files:** new `src/ui/viewer/components/ConnectionPanel.tsx`, CSS additions in `src/ui/viewer-template.html`.

The panel receives the current `Settings` + the modal's `onSave(next: Settings)` so **all persistence goes through `useSettings`** (§0.1). It never writes canonical keys — it only edits `CLAUDE_MEM_CONNECTIONS` + `CLAUDE_MEM_ACTIVE_CONNECTION`. The test stepper renders from `useConnectionTest` hook state (fire-and-forget `runTest`).

### 9.1 Component — `ConnectionPanel.tsx`

```tsx
import React, { useEffect, useMemo, useState } from 'react';
import type { Settings } from '../types';
import {
  ConnectionProfile, LOCAL_WORKER_ID, PresetKind, parseConnections, serializeConnections,
  withLocalWorker, newProfileId, presetUrl,
} from '../lib/connections';
import { useConnectionTest } from '../hooks/useConnectionTest';
import { TestStepper } from './TestStepper';

interface Props {
  settings: Settings;
  onSave: (next: Settings) => void;   // routes through useSettings → POST /api/settings
  isSaving: boolean;
}

type EditorState = { mode: 'closed' } | { mode: 'add'; preset: PresetKind } | { mode: 'edit'; id: string };

export function ConnectionPanel({ settings, onSave, isSaving }: Props) {
  const profiles = useMemo(
    () => withLocalWorker(parseConnections(settings.CLAUDE_MEM_CONNECTIONS)),
    [settings.CLAUDE_MEM_CONNECTIONS],
  );
  const activeId = settings.CLAUDE_MEM_ACTIVE_CONNECTION || LOCAL_WORKER_ID;

  const [focusedId, setFocusedId] = useState<string>(activeId);
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState<string>('');
  const [testedMarks, setTestedMarks] = useState<Record<string, 'pass' | 'fail'>>({});
  const test = useConnectionTest();

  const focused = profiles.find(p => p.id === focusedId) ?? profiles[0];
  const isLocalWorker = (p: ConnectionProfile) => p.id === LOCAL_WORKER_ID;

  const persist = (nextProfiles: ConnectionProfile[], nextActiveId: string) => {
    onSave({ ...settings, CLAUDE_MEM_CONNECTIONS: serializeConnections(nextProfiles), CLAUDE_MEM_ACTIVE_CONNECTION: nextActiveId });
  };

  const saveProfile = (profile: ConnectionProfile) => {
    const exists = profiles.some(p => p.id === profile.id);
    const next = exists ? profiles.map(p => (p.id === profile.id ? profile : p)) : [...profiles, profile];
    persist(next, activeId); // Save does NOT activate (handoff §4.3)
    setEditor({ mode: 'closed' });
  };

  const activate = (profile: ConnectionProfile) => {
    persist(profiles, profile.id);
    setToast(`✓ Activated “${profile.name}”. New captures use this connection.`);
    setTimeout(() => setToast(''), 4000);
    test.reset();
  };

  const deleteProfile = (id: string) => {
    persist(profiles.filter(p => p.id !== id), activeId);
    setConfirmDeleteId(null);
    if (focusedId === id) setFocusedId(activeId);
  };

  // Ephemeral ✓/✗ marker for the focused row after a test run (handoff §4.1).
  useEffect(() => {
    if (test.result && focused) {
      setTestedMarks(m => ({ ...m, [focused.id]: test.result!.ok ? 'pass' : 'fail' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [test.result]);

  return (
    <div className="connection-panel">
      <div className="context-chip"><span className="context-dot" />This viewer — Local worker</div>

      {editor.mode !== 'closed' ? (
        <ProfileEditor
          initial={editor.mode === 'edit' ? profiles.find(p => p.id === editor.id)! : blankProfile(editor.preset)}
          onCancel={() => { setEditor({ mode: 'closed' }); test.reset(); }}
          onSave={saveProfile}
          test={test}
        />
      ) : (
        <>
          <div className="subsection-label">ACTIVE</div>
          <ProfileRow profile={profiles.find(p => p.id === activeId)!} active focused={focusedId === activeId}
            mark={testedMarks[activeId]} onFocus={setFocusedId} />

          <div className="subsection-label">PROFILES</div>
          <div className="profile-list" role="radiogroup" aria-label="Active connection">
            {profiles.map(p => (
              <ProfileRow key={p.id} profile={p} active={p.id === activeId} focused={focusedId === p.id}
                mark={testedMarks[p.id]} onFocus={setFocusedId} />
            ))}
          </div>

          {profiles.length === 1 && (
            <p className="section-description empty-hint">
              You're capturing locally. Add a connection to send captures to a server on your LAN or Tailscale.
            </p>
          )}

          <div className="connection-actions">
            <PresetMenu onPick={(preset) => { setEditor({ mode: 'add', preset }); test.reset(); }} />
            <button type="button" className="cm-btn" disabled={isLocalWorker(focused)}
              onClick={() => setEditor({ mode: 'edit', id: focused.id })}>Edit</button>
            <button type="button" className="cm-btn" disabled={isLocalWorker(focused)}
              onClick={() => test.runTest(focused)}>Test</button>
            <button type="button" className="cm-btn cm-btn-danger"
              disabled={isLocalWorker(focused) || focused.id === activeId}
              title={isLocalWorker(focused) ? "The local worker is the built-in fallback and can't be deleted."
                : focused.id === activeId ? 'Switch to another connection before deleting this one.' : undefined}
              onClick={() => setConfirmDeleteId(focused.id)}>Delete</button>
          </div>

          {isLocalWorker(focused) && !test.result && !test.running && (
            <p className="section-description">Local worker — captures to this machine. Nothing to test.</p>
          )}

          {(test.running || test.result || test.error) && !isLocalWorker(focused) && (
            <TestStepper result={test.result} running={test.running} error={test.error}
              onActivate={() => activate(focused)}
              onEditKey={() => setEditor({ mode: 'edit', id: focused.id })}
              onRetry={() => test.runTest(focused)}
              onSaveWithoutActivating={() => test.reset()} />
          )}

          {confirmDeleteId && (
            <div className="delete-confirm">
              Delete “{profiles.find(p => p.id === confirmDeleteId)?.name}”? This removes the saved profile and its key.
              <button type="button" className="cm-btn" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button type="button" className="cm-btn cm-btn-danger" onClick={() => deleteProfile(confirmDeleteId)}>Delete</button>
            </div>
          )}

          {toast && <div className="activation-toast" role="status">{toast}</div>}
        </>
      )}
      {isSaving && <span className="saving-hint">Saving…</span>}
    </div>
  );
}

function blankProfile(preset: PresetKind): ConnectionProfile {
  return {
    id: newProfileId(),
    name: '',
    runtime: preset === 'local' ? 'worker' : 'server',
    url: presetUrl(preset),
    apiKey: '',
    projectId: '',
  };
}

function ProfileRow({ profile, active, focused, mark, onFocus }: {
  profile: ConnectionProfile; active: boolean; focused: boolean; mark?: 'pass' | 'fail'; onFocus: (id: string) => void;
}) {
  const subtitle = profile.runtime === 'worker' ? 'Captures to this machine — no server' : profile.url;
  return (
    <button type="button" role="radio" aria-checked={active}
      className={`profile-row ${focused ? 'focused' : ''}`} onClick={() => onFocus(profile.id)}>
      <span className={`radio-glyph ${active ? 'on' : ''}`} aria-hidden>{active ? '◉' : '◯'}</span>
      <span className="profile-main">
        <span className="profile-name">{profile.name || '(unnamed)'}</span>
        <span className="profile-subtitle">{subtitle}</span>
      </span>
      <span className="profile-badges">
        <span className="type-badge">{profile.runtime}</span>
        {active && <span className="active-tag">· active</span>}
        {profile.id === LOCAL_WORKER_ID && <span className="default-tag">· default</span>}
        {mark === 'pass' && <span className="tested-mark pass">✓ tested</span>}
        {mark === 'fail' && <span className="tested-mark fail">✗ failed</span>}
      </span>
    </button>
  );
}

function PresetMenu({ onPick }: { onPick: (preset: PresetKind) => void }) {
  const [open, setOpen] = useState(false);
  const options: [PresetKind, string, string][] = [
    ['local', 'Local worker', 'Capture to this machine only.'],
    ['lan', 'LAN', 'A server on your home network.'],
    ['tailscale', 'Tailscale', 'A server over your tailnet, from anywhere.'],
    ['custom', 'Custom', 'Enter the full URL yourself.'],
  ];
  return (
    <div className="preset-menu">
      <button type="button" className="cm-btn cm-btn-primary" onClick={() => setOpen(o => !o)}>+ Add connection</button>
      {open && (
        <div className="preset-options" role="menu">
          {options.map(([kind, label, help]) => (
            <button key={kind} type="button" className="preset-option" role="menuitem"
              onClick={() => { setOpen(false); onPick(kind); }}>
              <span className="preset-label">{label}</span>
              <span className="preset-help">{help}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileEditor({ initial, onCancel, onSave, test }: {
  initial: ConnectionProfile; onCancel: () => void; onSave: (p: ConnectionProfile) => void; test: ReturnType<typeof useConnectionTest>;
}) {
  const [draft, setDraft] = useState<ConnectionProfile>(initial);
  const [revealKey, setRevealKey] = useState(false);
  const isServer = draft.runtime === 'server';
  const set = (patch: Partial<ConnectionProfile>) => setDraft(d => ({ ...d, ...patch }));

  // Scope Esc to the editor so the modal's global Esc (ContextSettingsModal:163) doesn't fire.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); if (isServer) test.runTest(draft); }
  };

  return (
    <div className="profile-editor" onKeyDown={onKeyDown}>
      <div className="subsection-label">{initial.name ? 'Edit connection' : 'Add connection'}</div>

      <label className="form-field">Name
        <input value={draft.name} placeholder="e.g. NAS (Tailscale)" onChange={e => set({ name: e.target.value })} />
      </label>

      <label className="form-field">Runtime
        <select value={draft.runtime} onChange={e => set({ runtime: e.target.value as 'worker' | 'server' })}>
          <option value="server">Server</option>
          <option value="worker">Local worker</option>
        </select>
      </label>

      {isServer && (
        <>
          <label className="form-field">Server URL
            <input value={draft.url} placeholder="https://nas.tail1234.ts.net:37700" onChange={e => set({ url: e.target.value })} />
          </label>
          <label className="form-field">API key
            <span className="key-input">
              <input type={revealKey ? 'text' : 'password'} value={draft.apiKey} placeholder="Server API key"
                onChange={e => set({ apiKey: e.target.value })} />
              <button type="button" className="reveal-toggle" aria-pressed={revealKey} aria-label="Show API key"
                onClick={() => setRevealKey(r => !r)}>{revealKey ? 'Hide' : 'Reveal'}</button>
            </span>
          </label>
          <label className="form-field">Project ID
            <input value={draft.projectId} placeholder="Project to capture into" onChange={e => set({ projectId: e.target.value })} />
          </label>
        </>
      )}

      <div className="editor-actions">
        {isServer && <button type="button" className="cm-btn cm-btn-primary" onClick={() => test.runTest(draft)}>Test connection</button>}
        <button type="button" className="cm-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="cm-btn" onClick={() => onSave(draft)} disabled={!draft.name.trim()}>Save</button>
      </div>

      {isServer && (test.running || test.result || test.error) && (
        <TestStepper result={test.result} running={test.running} error={test.error}
          onActivate={() => onSave(draft)} onEditKey={() => {}} onRetry={() => test.runTest(draft)}
          onSaveWithoutActivating={() => onSave(draft)} />
      )}
    </div>
  );
}
```

> **Builder note:** `useConnectionTest.runTest` returns `void`; the panel reads `test.result` reactively (the `useEffect` on `test.result`) for the ephemeral marker. The `runTest(...)` call sites are fire-and-forget — do not await a return value. Keyboard behavior for the radiogroup (Up/Down move focus, Space selects — handoff §8) can reuse native `role="radio"` button focus; arrow-key navigation is a nice-to-have Builder may add with a keydown handler on `.profile-list`.

### 9.2 CSS (append inside the existing `<style>` in `src/ui/viewer-template.html`)
All colors reference existing tokens (handoff §2.1):

```css
.connection-panel { display: flex; flex-direction: column; gap: 12px; }
.context-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-text-muted); }
.context-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-accent-primary); }
.subsection-label { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-muted); margin-top: 8px; }
.profile-list { display: flex; flex-direction: column; border: 1px solid var(--color-border-primary); border-radius: 6px; overflow: hidden; }
.profile-row { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 8px 10px;
  background: var(--color-bg-card); border: none; border-bottom: 1px solid var(--color-border-primary); text-align: left; cursor: pointer; }
.profile-row:last-child { border-bottom: none; }
.profile-row.focused { background: var(--color-bg-card-hover); }
.profile-row:focus-visible { box-shadow: 0 0 0 3px rgba(9,105,218,0.1); outline: none; }
.radio-glyph { color: var(--color-text-muted); }
.radio-glyph.on { color: var(--color-accent-primary); }
.profile-main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.profile-name { color: var(--color-text-primary); font-size: 13px; }
.profile-subtitle { color: var(--color-text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.profile-badges { display: flex; align-items: center; gap: 6px; }
.type-badge { background: var(--color-type-badge-bg); color: var(--color-type-badge-text); border-radius: 4px; padding: 1px 6px; font-size: 10px; }
.active-tag, .default-tag { color: var(--color-text-muted); font-size: 11px; }
.tested-mark.pass { color: var(--color-accent-success); font-size: 11px; }
.tested-mark.fail { color: var(--color-accent-error); font-size: 11px; }
.connection-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.cm-btn { min-height: 32px; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--color-border-primary);
  background: var(--color-bg-card); color: var(--color-text-primary); cursor: pointer; font-size: 12px; }
.cm-btn:hover:not(:disabled) { background: var(--color-bg-card-hover); }
.cm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.cm-btn-primary { background: var(--color-accent-primary); border-color: var(--color-accent-primary); color: #fff; }
.cm-btn-danger { color: var(--color-accent-error); border-color: var(--color-accent-error); }
.cm-btn:focus-visible, .reveal-toggle:focus-visible { box-shadow: 0 0 0 3px rgba(9,105,218,0.1); outline: none; }
.preset-menu { position: relative; }
.preset-options { position: absolute; z-index: 5; margin-top: 4px; background: var(--color-bg-card);
  border: 1px solid var(--color-border-primary); border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); min-width: 240px; }
.preset-option { display: flex; flex-direction: column; width: 100%; padding: 8px 10px; background: none; border: none; text-align: left; cursor: pointer; }
.preset-option:hover { background: var(--color-bg-card-hover); }
.preset-label { color: var(--color-text-primary); font-size: 13px; }
.preset-help { color: var(--color-text-muted); font-size: 11px; }
.profile-editor { display: flex; flex-direction: column; gap: 10px; }
.key-input { display: flex; gap: 6px; }
.reveal-toggle { border: 1px solid var(--color-border-primary); background: var(--color-bg-card); border-radius: 6px; padding: 0 10px; cursor: pointer; color: var(--color-text-primary); }
.editor-actions, .delete-confirm { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.delete-confirm { font-size: 12px; color: var(--color-text-primary); }
.activation-toast { color: var(--color-accent-success); font-size: 12px; }
.saving-hint { color: var(--color-text-muted); font-size: 12px; }
.empty-hint { font-style: italic; }
```

---

## Task 10 — Test stepper component

**Files:** new `src/ui/viewer/components/TestStepper.tsx`, CSS additions.

### 10.1 Component

```tsx
import React from 'react';
import type { ProbeResult, StepResult } from '../hooks/useConnectionTest';

const STEP_LABEL: Record<StepResult['step'], string> = {
  reachable: 'Reachable', authenticated: 'Authenticated', project: 'Project valid',
};
const GLYPH: Record<StepResult['status'], string> = { pass: '✓', warn: '!', fail: '✗', skipped: '·' };

interface Props {
  result: ProbeResult | null;
  running: boolean;
  error: string | null;
  onActivate: () => void;
  onEditKey: () => void;
  onRetry: () => void;
  onSaveWithoutActivating: () => void;
}

export function TestStepper({ result, running, error, onActivate, onEditKey, onRetry, onSaveWithoutActivating }: Props) {
  return (
    <div className="test-stepper" aria-live="polite">
      {result ? result.steps.map(s => (
        <div key={s.step} className={`test-step ${s.status}`}>
          <span className="step-glyph" aria-hidden>{GLYPH[s.status]}</span>
          <span className="step-label">{STEP_LABEL[s.step]}</span>
          <span className="step-message">{s.message}</span>
        </div>
      )) : (
        <div className="test-step running"><span className="step-glyph" aria-hidden>⟳</span><span className="step-label">Testing…</span></div>
      )}

      {error && <div className="test-banner fail">✗ Test could not run: {error}</div>}

      {result && result.ok && (
        <div className="test-banner pass">
          <span>✓ Connection verified{result.steps.some(s => s.status === 'warn') ? ' · 1 note' : ''}. Ready to activate.</span>
          <button type="button" className="cm-btn cm-btn-primary" onClick={onActivate}>Activate this connection</button>
        </div>
      )}

      {result && !result.ok && (
        <div className="test-banner fail">
          <span>✗ Not activated — {failTitle(result)}. {failBody(result)}</span>
          <span className="banner-actions">
            <button type="button" className="cm-btn" onClick={onEditKey}>Edit key</button>
            <button type="button" className="cm-btn" onClick={onRetry}>Retry test</button>
            <button type="button" className="cm-btn" onClick={onSaveWithoutActivating}>Save without activating</button>
          </span>
        </div>
      )}
    </div>
  );
}

function failedStep(r: ProbeResult): StepResult | undefined { return r.steps.find(s => s.status === 'fail'); }
function failTitle(r: ProbeResult): string {
  const f = failedStep(r);
  if (!f) return 'test failed';
  if (f.step === 'reachable') return 'can’t reach server';
  if (f.step === 'authenticated') return 'authentication failed';
  return 'project not usable';
}
function failBody(r: ProbeResult): string { return failedStep(r)?.message ?? ''; }
```

### 10.2 CSS additions

```css
.test-stepper { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--color-border-primary); border-radius: 6px; padding: 10px; }
.test-step { display: grid; grid-template-columns: 18px 110px 1fr; gap: 8px; align-items: baseline; font-size: 12px; }
.test-step .step-label { color: var(--color-text-primary); }
.test-step .step-message { color: var(--color-text-muted); }
.test-step.pass .step-glyph { color: var(--color-accent-success); }
.test-step.warn .step-glyph { color: var(--color-accent-summary); }
.test-step.fail .step-glyph { color: var(--color-accent-error); }
.test-step.skipped .step-glyph, .test-step.running .step-glyph { color: var(--color-text-muted); }
.test-banner { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between;
  padding: 8px 10px; border-radius: 6px; font-size: 12px; }
.test-banner.pass { color: var(--color-accent-success); border: 1px solid var(--color-accent-success); }
.test-banner.fail { color: var(--color-accent-error); border: 1px solid var(--color-accent-error); }
.banner-actions { display: flex; gap: 6px; flex-wrap: wrap; }
```

---

## Task 11 — Server-config wizard (server context + worker helper)

**Files:** new `src/ui/viewer/components/ServerConfigWizard.tsx`, new `src/ui/viewer/lib/wizard.ts`, CSS.

### 11.1 Generator logic — `src/ui/viewer/lib/wizard.ts` (pure, TDD)

```ts
export type WizardProvider = 'claude';
export const SERVER_MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — recommended', recommended: true },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', recommended: false },
] as const;

export const DEFAULT_WIZARD_MODEL = 'claude-haiku-4-5-20251001';
export const COST_WARNING = 'Sonnet 4.6 costs about 3× Haiku 4.5 per observation. Only choose it if you need higher-quality generation. Default is Haiku.';

export interface WizardInput { provider: WizardProvider; model: string; apiKey: string; }
export type OutputFormat = 'compose' | 'env';

const KEY_PLACEHOLDER = '<paste your key>';

/** Emit env-var lines. Model is a FULL id; the SERVER var (not CLAUDE_MEM_MODEL). */
export function renderEnv(input: WizardInput): string {
  const key = input.apiKey || KEY_PLACEHOLDER;
  return [
    `CLAUDE_MEM_SERVER_PROVIDER=${input.provider}`,
    `ANTHROPIC_API_KEY=${key}`,
    `CLAUDE_MEM_SERVER_MODEL=${input.model}`,
  ].join('\n');
}

/** Emit a valid docker-compose `environment:` fragment (TrueNAS default). */
export function renderCompose(input: WizardInput): string {
  const key = input.apiKey || KEY_PLACEHOLDER;
  return [
    'environment:',
    `  CLAUDE_MEM_SERVER_PROVIDER: ${input.provider}`,
    `  ANTHROPIC_API_KEY: ${key}`,
    `  CLAUDE_MEM_SERVER_MODEL: ${input.model}`,
  ].join('\n');
}

export function renderOutput(input: WizardInput, format: OutputFormat): string {
  return format === 'compose' ? renderCompose(input) : renderEnv(input);
}

export function isCostlyModel(model: string): boolean { return model === 'claude-sonnet-4-6'; }
```

### 11.2 Test — `tests/ui/wizard-generator.test.ts`

```ts
import { describe, it, expect } from 'bun:test';
import { renderEnv, renderCompose, isCostlyModel, DEFAULT_WIZARD_MODEL } from '../../src/ui/viewer/lib/wizard.js';

const base = { provider: 'claude' as const, model: DEFAULT_WIZARD_MODEL, apiKey: 'sk-ant-x' };

describe('wizard generator', () => {
  it('env uses CLAUDE_MEM_SERVER_MODEL (not CLAUDE_MEM_MODEL) and a full id', () => {
    const out = renderEnv(base);
    expect(out).toContain('CLAUDE_MEM_SERVER_MODEL=claude-haiku-4-5-20251001');
    expect(out).not.toContain('CLAUDE_MEM_MODEL=');
  });
  it('compose emits valid indented YAML', () => {
    expect(renderCompose(base)).toContain('  CLAUDE_MEM_SERVER_MODEL: claude-haiku-4-5-20251001');
  });
  it('placeholders the key when empty', () => {
    expect(renderEnv({ ...base, apiKey: '' })).toContain('ANTHROPIC_API_KEY=<paste your key>');
  });
  it('flags sonnet as costly, haiku as not', () => {
    expect(isCostlyModel('claude-sonnet-4-6')).toBe(true);
    expect(isCostlyModel(DEFAULT_WIZARD_MODEL)).toBe(false);
  });
});
```

`bun test tests/ui/wizard-generator.test.ts` → green.

### 11.3 Component — `ServerConfigWizard.tsx`

Default output format = **Compose** (Mark's confirmed default — TrueNAS is compose-based), with an env-var-list toggle.

```tsx
import React, { useEffect, useState } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import {
  SERVER_MODELS, DEFAULT_WIZARD_MODEL, COST_WARNING, renderOutput, isCostlyModel, OutputFormat,
} from '../lib/wizard';

interface ServerConfig { provider: string; model: string; keyPresent: boolean; keySource: string | null; }
interface IngestStatus { lastObservationAt: number | null; countLastWindow: number; window: string; }

/** `serverContext` = full CURRENT + ingest block; false = worker helper (generator only). */
export function ServerConfigWizard({ serverContext }: { serverContext: boolean }) {
  const [current, setCurrent] = useState<ServerConfig | null>(null);
  const [ingest, setIngest] = useState<IngestStatus | null>(null);
  const [model, setModel] = useState(DEFAULT_WIZARD_MODEL);
  const [apiKey, setApiKey] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [format, setFormat] = useState<OutputFormat>('compose'); // Mark's default: Compose (TrueNAS)
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!serverContext) return;
    fetch(API_ENDPOINTS.SERVER_CONFIG).then(r => r.ok ? r.json() : null).then(setCurrent).catch(() => {});
    fetch(API_ENDPOINTS.INGEST_STATUS).then(r => r.ok ? r.json() : null).then(setIngest).catch(() => {});
  }, [serverContext]);

  const output = renderOutput({ provider: 'claude', model, apiKey }, format);
  const displayOutput = revealKey ? output : maskKey(output);

  const copy = async () => {
    await navigator.clipboard.writeText(output); // always the real value
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="wizard">
      {serverContext && (
        <>
          <div className="context-chip"><span className="context-dot" />This viewer — Collection server</div>
          <div className="subsection-label">CURRENT (read-only)</div>
          {current ? (
            <div className="current-config">
              <div>Provider <b>{current.provider}</b> · Model <b>{current.model}</b></div>
              <div>API key {current.keyPresent ? `set (${current.keySource})` : 'not set'}</div>
              <div className="ingest-line">{ingestLabel(ingest)}</div>
            </div>
          ) : <div className="current-config">— no data yet</div>}
          <p className="section-description">
            Set at container creation. Generate updated values below, then recreate the container to apply —
            live editing arrives with server auth (Phase 2).
          </p>
        </>
      )}

      <div className="subsection-label">GENERATE UPDATED CONFIG</div>
      <label className="form-field">Model
        <select value={model} onChange={e => setModel(e.target.value)} aria-describedby="cost-warning">
          {SERVER_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>
      {isCostlyModel(model) && <p id="cost-warning" className="cost-warning">⚠ {COST_WARNING}</p>}

      <label className="form-field">API key <span className="key-hint">(stays in your browser)</span>
        <span className="key-input">
          <input type={revealKey ? 'text' : 'password'} value={apiKey} placeholder="sk-ant-…" onChange={e => setApiKey(e.target.value)} />
          <button type="button" className="reveal-toggle" aria-pressed={revealKey} aria-label="Show API key"
            onClick={() => setRevealKey(r => !r)}>{revealKey ? 'Hide' : 'Reveal'}</button>
        </span>
      </label>

      <div className="output-toggle" role="tablist">
        <button type="button" role="tab" aria-selected={format === 'compose'} className={`cm-btn ${format === 'compose' ? 'cm-btn-primary' : ''}`} onClick={() => setFormat('compose')}>Compose</button>
        <button type="button" role="tab" aria-selected={format === 'env'} className={`cm-btn ${format === 'env' ? 'cm-btn-primary' : ''}`} onClick={() => setFormat('env')}>Env vars</button>
      </div>

      <div className="output-block">
        <pre>{displayOutput}</pre>
        <button type="button" className="copy-btn" onClick={copy} aria-live="polite">{copied ? 'Copied ✓' : 'Copy'}</button>
      </div>

      <ol className="apply-steps">
        <li>Open the claude-mem app in TrueNAS → <b>Edit</b> → Environment (or your compose’s <code>environment:</code>).</li>
        <li className="gotcha">Paste the block above. Use <code>CLAUDE_MEM_SERVER_MODEL</code>, not <code>CLAUDE_MEM_MODEL</code> (the latter is ignored by the server).</li>
        <li>Save and <b>recreate/restart</b> the container so it picks up the new env.</li>
        <li className="gotcha">Verify ingest for real: trigger a capture, then confirm a new observation appears — <code>/healthz</code> returning 200 is not proof of capture.</li>
      </ol>
    </div>
  );
}

function maskKey(output: string): string {
  return output.replace(/(ANTHROPIC_API_KEY[=:]\s*)(\S+)/, (_m, p1, val) =>
    val === '<paste your key>' ? `${p1}${val}` : `${p1}sk-ant-…`);
}
function ingestLabel(s: IngestStatus | null): string {
  if (!s || s.lastObservationAt === null) return '— no data yet';
  const ageMin = Math.round((Date.now() / 1000 - s.lastObservationAt) / 60);
  if (s.countLastWindow > 0) return `✓ capturing — last observation ${ageMin} min ago`;
  return `✗ no observations in ${s.window}`;
}
```

### 11.4 CSS additions

```css
.wizard { display: flex; flex-direction: column; gap: 10px; }
.current-config { font-size: 12px; color: var(--color-text-primary); background: var(--color-bg-stat); border-radius: 6px; padding: 8px 10px; }
.ingest-line { margin-top: 4px; }
.cost-warning { color: var(--color-accent-summary); font-size: 12px; border-left: 3px solid var(--color-accent-summary); padding-left: 8px; }
.key-hint { color: var(--color-text-muted); font-size: 11px; }
.output-toggle { display: flex; gap: 6px; }
.output-block { position: relative; background: var(--color-bg-stat); border-radius: 6px; overflow-x: auto; }
.output-block pre { margin: 0; padding: 10px; font-family: ui-monospace, monospace; font-size: 12px; color: var(--color-text-primary); white-space: pre; }
.copy-btn { position: absolute; top: 6px; right: 6px; border: 1px solid var(--color-border-primary); background: var(--color-bg-card); border-radius: 6px; padding: 2px 8px; cursor: pointer; font-size: 11px; color: var(--color-text-primary); }
.apply-steps { font-size: 12px; color: var(--color-text-primary); padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
.apply-steps .gotcha { color: var(--color-accent-summary); }
.apply-steps code { background: var(--color-bg-tertiary); padding: 0 4px; border-radius: 3px; }
```

---

## Task 12 — Wire the context-aware section into `ContextSettingsModal`; fix the Esc collision

**Files:** `src/ui/viewer/components/ContextSettingsModal.tsx`.

### 12.1 Insert the new top section
Imports:

```tsx
import { useRuntimeRole } from '../hooks/useRuntimeRole';
import { ConnectionPanel } from './ConnectionPanel';
import { ServerConfigWizard } from './ServerConfigWizard';
```

Inside the component (after `formState` is declared):

```tsx
const { effectiveRole, needsManualToggle, override, setOverride } = useRuntimeRole();
```

At the very top of the settings column (`.settings-column`), before the first existing `CollapsibleSection` ("Loading"):

```tsx
<CollapsibleSection
  title={effectiveRole === 'server' ? 'Server configuration' : 'Connection'}
  defaultOpen={true}
>
  {needsManualToggle && (
    <div className="role-toggle" role="tablist" aria-label="Viewing">
      <span>Viewing:</span>
      <button type="button" role="tab" aria-selected={(override ?? 'worker') === 'worker'}
        className={`cm-btn ${(override ?? 'worker') === 'worker' ? 'cm-btn-primary' : ''}`}
        onClick={() => setOverride('worker')}>Local worker</button>
      <button type="button" role="tab" aria-selected={override === 'server'}
        className={`cm-btn ${override === 'server' ? 'cm-btn-primary' : ''}`}
        onClick={() => setOverride('server')}>Server</button>
    </div>
  )}
  {effectiveRole === 'server'
    ? <ServerConfigWizard serverContext={true} />
    : (
      <>
        <ConnectionPanel settings={formState} onSave={onSave} isSaving={isSaving} />
        <details className="wizard-helper"><summary>Generate server config…</summary>
          <ServerConfigWizard serverContext={false} />
        </details>
      </>
    )}
</CollapsibleSection>
```

> `ConnectionPanel` gets `formState` (the modal's live form state) and `onSave` (the modal's existing `onSave` → `useSettings.saveSettings`). Because the panel calls `onSave` with a full `Settings` object (spreading `formState`), the footer `Saving…`/`✓ Saved` flow is reused unchanged (handoff §4.6). No separate save button for connections. **Builder verify:** `onSave` here is the modal prop that calls `saveSettings` immediately (not the "Save" footer button that saves `formState` on click). If the modal's `onSave` only fires from the footer, add an explicit `onSaveNow` prop threaded from `App.tsx` → `saveSettings` so activation persists immediately; the panel needs a save-on-action, not save-on-footer-click.

### 12.2 Fix the Esc collision (handoff §12.4)
The editor already `stopPropagation`s `Escape` on its own `onKeyDown` (Task 9.1). The modal's global handler (`ContextSettingsModal.tsx:162-170`) is a `window` listener, so a React `stopPropagation` on a bubbling synthetic event will **not** by itself stop the window-level native listener. Two robust options — implement one:
- **(a)** In the editor's `onKeyDown`, call `e.nativeEvent.stopImmediatePropagation()` in addition to `e.stopPropagation()` when `Escape` is pressed and the editor is open, so the window listener never sees it. (Simplest.)
- **(b)** Change the modal's global handler to no-op when an inline editor/confirm is open (track an `editorOpen` flag lifted into the modal and guard the `handleEsc`).

Recommend (a) for locality. Add a regression note to the PR: open the editor, press `Esc` → editor closes, modal stays open.

### 12.3 CSS

```css
.role-toggle { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; }
.wizard-helper { margin-top: 12px; }
.wizard-helper summary { cursor: pointer; color: var(--color-text-muted); font-size: 12px; }
```

---

## Verification (run all before opening the PR)

```bash
bun test                 # no NEW failures vs the fork baseline (queue #7 documents the 18 pre-existing Windows failures)
npm run typecheck        # tsc --noEmit && tsc --noEmit -p src/ui/viewer/tsconfig.json — clean
npm run build            # sync-plugin-manifests + build-hooks + gen-lockfile — clean
```

New tests that must be green:
`connection-settings-roundtrip`, `settings-routes-connection-keys`, `connection-store`, `runtime-role-route`, `server-config-route`, `connection-test-probe`, `connection-test-no-key-leak`, `ingest-status-query`, `connections-lib`, `use-runtime-role`, `wizard-generator`.

**UAT (Tester, live viewer):**
1. Fresh install → Connection section shows the seeded **Local worker** (active) + empty-state hint.
2. Add → LAN preset → editor pre-filled → Test against a running local server → 3-step stepper → Activate → active row updates; confirm `settings.json` now has `CLAUDE_MEM_RUNTIME=server` + `SERVER_URL/API_KEY/PROJECT_ID` from the profile.
3. Wrong key → stepper stops at **Authenticated ✗** (403), Activate absent, **Save without activating** offered.
4. Unknown project → **Project valid !** warn, still activatable.
5. Delete guarded on active + Local worker (tooltips present).
6. `Esc` inside the editor closes the editor only (modal stays open).
7. Force server context (`CLAUDE_MEM_RUNTIME=server` in settings.json, restart) → wizard shows CURRENT + ingest + Compose-default output + 3× warning on Sonnet; Copy copies the real key; block masks by default.

---

## Scope guardrails (do NOT do in this PR)

- No viewer authentication; no live server-config mutation; no `ANTHROPIC_API_KEY` stored/sent to the server via the web UI (all Phase 2, spec §9).
- No separate `/api/connections` CRUD routes (§0.1 — persistence rides `/api/settings`).
- No redaction of existing `GET /api/settings` key returns (out of scope; Task 1.3 note — separate hardening / queue #23).
- No fix of the `.modal-footer` phantom-token drift (handoff §12.1 — separate Polisher row).
- No Postgres-backed ingest-status variant (Task 6.1 flag — fast-follow / Phase 2).

## Notes for the Coordinator

- The queue row for this item is filed by the Coordinator (a second Planner is running in parallel — this plan does **not** touch `docs/BUILDER_QUEUE.md`).
- Suggested row: **Connection Profiles + Server-Config Wizard (Phase 1)** — Spec `docs/superpowers/specs/2026-07-16-connection-config-ui-design.md` · Plan `docs/superpowers/plans/2026-07-16-connection-config-ui.md` · Depends on: none · Notes: one PR, 12 tasks (E1–E6 + UI); E4/E5 are the descope-able tail; test-endpoint backing calls chosen = `GET /v1/projects` (step 2) + `GET /v1/projects/:id` (step 3).
