# Unit C — settings.json file-mode hardening (Backlog #23)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Close the *real* residual `settings.json` file-mode gaps (the original "no chmod" claim is **STALE** — a
chmod 0600 already exists) without re-adding what exists:
1. **Regression-guard** the existing 0600 on the key-holding writer (`persistServerSettings`), so a future refactor
   can't silently drop it.
2. **Close the POSIX pre-chmod window** on the *other* writer: `mergeSettings` (`install.ts`) applies **no** chmod, so
   a newly-created `settings.json` opens at process umask (~0644). Tighten it to 0600.
3. **Close/document the Windows gap:** `chmodSync` is a POSIX no-op inside a silent `catch {}` on Windows
   (`server-bootstrap.ts:172-174`), so the 0600 guarantee is effectively absent there; protection falls back to
   user-profile ACLs. Add a **best-effort** Windows ACL tightening and **document** the profile-ACL reliance.

**Verified starting state (current `main`):**
- `persistServerSettings` writes the API key into `~/.claude-mem/settings.json` (`server-bootstrap.ts:161-167`) then
  **immediately `chmodSync(settingsPath, 0o600)`** (`:171`) in a silent `catch {}` (`:172-174`). Installer logs
  "Settings saved with mode 0600." (`install.ts:931`). **Do NOT re-add this chmod.**
- Provider keys (`ANTHROPIC_API_KEY`) are **not** in settings.json — they go to `.env` via `EnvManager`, written
  `{mode:0o600}` + `chmodSync(0o600)` (`EnvManager.ts:165-166`) with the data dir at 0700 (`:138,140`). Out of scope.
- `mergeSettings` (`install.ts:761-789`) → `writeSettingsJsonAtomic` applies **no** chmod (`:783`).
- `writeJsonFileAtomic` **preserves an existing file's mode** (`atomic-json.ts:77-86`) and applies umask only when the
  file does not yet exist. So on POSIX the key-holding file still ends at 0600 (either order works); the exposure is a
  **brief window** between a first `mergeSettings` create (0644) and the API-key write+chmod, plus **Windows always**.

**Tech stack:** TypeScript, Bun test runner, Node `fs` (`chmodSync`, `statSync`), `child_process` (`spawnSync` for the
best-effort Windows `icacls`). No new dependencies.

## Design decision (folded here — too small for a standalone spec): enforce vs document the Windows ACL

The Windows residual is genuinely low-risk on a standard single-user box: `~/.claude-mem` lives under the user profile,
which Windows already ACLs to that user by default — the practical exposure is a multi-user Windows host. Options:

- **(a) Document only** — state that Windows relies on user-profile ACLs. Zero risk, zero new install-path behavior.
- **(b) Best-effort `icacls` tightening + document (CHOSEN)** — additionally run a non-fatal `icacls` that strips
  inheritance and grants only the current user, wrapped in try/catch so a failure never breaks install. Belt-and-
  suspenders; no hard dependency on `icacls` succeeding.
- **(c) Hard-enforce ACLs** — reject install if the ACL can't be set. **Rejected** — turns a hygiene nicety into an
  install blocker on a surface that's usually already protected.

**Decision: (b).** Primary protection is documented profile-ACL reliance; the `icacls` call is a best-effort
tightening that is safe to fail. This touches the **host-mutating install path** — flag for the coordinator.

## Global constraints

- **Do not re-add the existing `persistServerSettings` chmod** (`server-bootstrap.ts:171`) — it's there. Guard it,
  don't duplicate it.
- **`mergeSettings` change must be POSIX-correct and Windows-safe.** `chmodSync(0o600)` in a try/catch (mirroring
  `persistServerSettings` and `EnvManager`); the Windows no-op is expected and swallowed.
- **Best-effort only on Windows.** The `icacls` helper must never throw out of the install path; a failure logs at
  debug/warn and continues.
- **Regression gate = "no new failures"** (~18 pre-existing, #7). New tests must be POSIX-gated where they assert a
  real 0600 (chmod is a no-op on Windows — assert ACL/behavior separately, or `describe`-skip off-platform, mirroring
  the project's "`.skip` off-platform, run locally" convention).
- **This unit touches the installer (`install.ts`) — a host-mutating path.** Unit tests must exercise the writers
  against a **temp dir**, never the real `~/.claude-mem`. Flag for coordinator: the live install-path change wants a
  real-Windows spot-check.
- **Branch + PR policy:** branch from `main`; PR → **`fork/main`**; never `origin`. One PR. Do not edit
  `docs/BUILDER_QUEUE.md` or `CHANGELOG.md`.

---

### Task 1: Close the POSIX pre-chmod window in `mergeSettings`

**Files:**
- Edit: `src/npx-cli/commands/install.ts`

- [ ] **Step 1: import `chmodSync`.** Extend the `fs` import at `install.ts:8`.

```ts
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
```

- [ ] **Step 2: tighten the file after the atomic write** in `mergeSettings` (`install.ts:783`).

```ts
// install.ts mergeSettings — replace the single write line (:783)
writeSettingsJsonAtomic(path, current);
// #23 — settings.json may hold CLAUDE_MEM_SERVER_API_KEY. writeJsonFileAtomic preserves an
// existing file's mode but a freshly-created file opens at umask (~0644); tighten to 0600 so
// the mergeSettings create-path matches persistServerSettings. POSIX-only; no-op on Windows
// (see restrictSettingsFileForWindows below for the Windows ACL best-effort).
try {
  chmodSync(path, 0o600);
} catch {
  // Non-POSIX / permission-denied: fall back to profile ACLs (Windows) — see Task 3.
}
restrictSettingsFileForWindows(path);
return true;
```

> `restrictSettingsFileForWindows` is added in Task 3. If sequencing Task 3 later, temporarily omit that call line and
> add it in Task 3.

---

### Task 2: Regression-guard the existing `persistServerSettings` 0600

Lock the invariant so a refactor can't silently drop it. Add a focused test that drives `persistServerSettings`
against a temp dir and asserts the file mode (POSIX) and that the key is present.

**Files:**
- Edit/Create: `tests/server/settings-mode.test.ts`

- [ ] **Step 1: POSIX-gated mode assertion for `persistServerSettings`.**

```ts
import { describe, expect, it, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { persistServerSettings } from '../../src/services/hooks/server-bootstrap.js';

const isWin = process.platform === 'win32';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

function tempSettingsPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'cmem-settings-'));
  dirs.push(d);
  return join(d, 'settings.json');
}

describe('persistServerSettings file mode (#23)', () => {
  it('writes the API key into settings.json', () => {
    const p = tempSettingsPath();
    persistServerSettings(p, { apiKey: 'cmem_test', projectId: 'proj', serverBaseUrl: 'http://localhost:37877' });
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    expect(parsed.CLAUDE_MEM_SERVER_API_KEY).toBe('cmem_test');
  });

  (isWin ? it.skip : it)('is mode 0600 on POSIX (chmod is a no-op on Windows)', () => {
    const p = tempSettingsPath();
    persistServerSettings(p, { apiKey: 'cmem_test', projectId: 'proj', serverBaseUrl: 'http://localhost:37877' });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
```

> Confirm `persistServerSettings`'s signature against `server-bootstrap.ts` (it takes `(settingsPath, values)` with
> `values.apiKey/projectId/serverBaseUrl`); adjust the call if the field names differ.

- [ ] **Step 2: POSIX-gated mode assertion for the `mergeSettings` create-path** (Task 1's fix). If `mergeSettings` is
  not exported, either export it for the test or drive it through the smallest public installer entry that calls it;
  prefer exporting `mergeSettings` (it is a module-local `function` today):

```ts
// If exported: assert the create-path lands at 0600 on POSIX.
(isWin ? it.skip : it)('mergeSettings creates settings.json at mode 0600 on POSIX (#23)', () => {
  // point USER_SETTINGS_PATH at a temp path, or test an exported helper that takes an explicit path
  // ... write via mergeSettings, then:
  // expect(statSync(path).mode & 0o777).toBe(0o600);
});
```

> `mergeSettings` currently reads the module constant `USER_SETTINGS_PATH` (`install.ts:762`). To test it in isolation
> without touching the real `~/.claude-mem`, refactor it to accept an optional path argument
> (`function mergeSettings(updates, path = USER_SETTINGS_PATH)`) — a non-behavioral seam that also makes it testable.
> Keep the change minimal; every existing caller stays valid.

---

### Task 3: Windows ACL best-effort + documentation

**Files:**
- Edit: `src/npx-cli/commands/install.ts` (add `restrictSettingsFileForWindows`)
- Edit: `src/services/hooks/server-bootstrap.ts` (call the same tightening after its chmod, so the key-holding writer
  also gets the Windows ACL best-effort)
- Docs: whichever operator doc covers settings (see Task 4)

- [ ] **Step 1: add a best-effort Windows ACL helper.** Non-fatal; POSIX path is a no-op (chmod already handled it).

```ts
// install.ts (or a small shared module imported by both writers)
import { spawnSync } from 'child_process';

/**
 * #23 — On Windows, chmod(0600) is a POSIX no-op; the key-holding settings.json falls back to
 * user-profile ACLs. Best-effort tightening: disable inheritance and grant only the current user.
 * NEVER throws — a failure leaves the file protected by the default profile ACLs.
 */
export function restrictSettingsFileForWindows(path: string): void {
  if (process.platform !== 'win32') return;
  const user = process.env.USERNAME ? `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME}`.replace(/^\\/, '') : null;
  if (!user) return;
  try {
    // /inheritance:r removes inherited ACEs; /grant:r <user>:F grants full control to just this user.
    spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], {
      windowsHide: true,
      timeout: 5000,
      stdio: 'ignore',
    });
  } catch {
    // Best-effort only; profile ACLs remain in force.
  }
}
```

- [ ] **Step 2: call it from both writers.** In `mergeSettings` (Task 1 Step 2 already adds the call). In
  `persistServerSettings` (`server-bootstrap.ts`), after the existing `chmodSync(0o600)` block (`:171-174`), add the
  same best-effort call (import the helper, or duplicate the tiny function into `server-bootstrap.ts` to avoid a
  cross-module import from hooks → npx-cli). Prefer a **shared** helper in a neutral module (e.g. `src/shared/`) that
  both import, to avoid a layering violation (`server-bootstrap` is a hook, `install` is CLI).

```ts
// server-bootstrap.ts persistServerSettings — after the chmod catch block (:174)
restrictSettingsFileForWindows(settingsPath); // best-effort Windows ACL (#23); no-op on POSIX
```

- [ ] **Step 3: Windows smoke test (skipped off-platform).**

```ts
(isWin ? it : it.skip)('restrictSettingsFileForWindows runs without throwing on Windows (#23)', () => {
  const p = tempSettingsPath();
  persistServerSettings(p, { apiKey: 'cmem_test', projectId: 'proj', serverBaseUrl: 'http://localhost:37877' });
  expect(() => restrictSettingsFileForWindows(p)).not.toThrow();
  // Optional: parse `icacls <p>` output and assert the current user has an ACE and inheritance is off.
});
```

- [ ] **Step 4: shared-helper placement.** To avoid `server-bootstrap.ts` (hooks) importing from `npx-cli/commands`,
  put `restrictSettingsFileForWindows` in a neutral module — e.g. `src/shared/settings-file-permissions.ts` — and
  import it from both `install.ts` and `server-bootstrap.ts`. Keep the function body exactly as Step 1.

---

### Task 4: Documentation

- [ ] **Step 1: document the Windows profile-ACL reliance.** Add a short note wherever settings/security is documented
  (candidates, verify which exists on `main`: `TEAM-CONFIG.md`, or `docs/ops/2026-07-15-nas-server-setup.md`). Content:
  "`~/.claude-mem/settings.json` holds `CLAUDE_MEM_SERVER_API_KEY` and is written mode 0600 on POSIX. On **Windows**,
  file-mode bits are not enforced by `chmod`; the file is protected by user-profile ACLs, and the installer
  additionally applies a best-effort `icacls` tightening (inheritance removed, current user only). On a multi-user
  Windows host, verify the ACL." Keep it factual and short; do not overstate the residual risk.

> This overlaps Backlog **#27** (docs update). Coordinate: if #27 is being worked, fold this note into it rather than
> duplicating. Flag for coordinator.

---

### Task 5: build, typecheck, targeted suite

- [ ] **Step 1:** `bun test tests/server/settings-mode.test.ts` → green (POSIX asserts 0600; Windows asserts the ACL
  helper is non-throwing).
- [ ] **Step 2:** `npm run typecheck` → clean.
- [ ] **Step 3:** `npm run build-and-sync` → passes plugin-delivery assertion (`install.ts` and `server-bootstrap.ts`
  are part of the built worker/CLI).

## Verification (before opening the PR)

- [ ] **Existing chmod not duplicated:** `persistServerSettings` still has exactly one `chmodSync(0o600)` (the original
  at `:171`); no second one was added.
- [ ] **mergeSettings create-path is 0600 on POSIX:** the create-path test proves a freshly-created settings.json lands
  at 0600 (closes the umask window). On Windows the chmod is a no-op (test skipped) and the ACL helper runs.
- [ ] **Regression guard in place:** the `persistServerSettings` 0600 invariant is now covered by a test, so a future
  refactor that drops it fails CI (on POSIX).
- [ ] **Windows best-effort is non-fatal:** `restrictSettingsFileForWindows` never throws; install proceeds if `icacls`
  is missing/denied.
- [ ] **Docs updated (or folded into #27):** the Windows profile-ACL reliance is documented; the residual risk is not
  overstated.
- [ ] **No new regressions** vs the ~18 pre-existing failures (#7); typecheck clean; tests use temp dirs only (never
  the real `~/.claude-mem`).

### Test Plan (live UAT — for the Tester, real Windows)

**Host/install-path — coordinator gate.** On a real Windows box: run the installer path that calls `mergeSettings`
(or drive `persistServerSettings` against a temp path), then `icacls <settings.json>` and confirm inheritance is
removed and only the current user has access. Confirm the installer does **not** fail if `icacls` is unavailable
(simulate by temporarily shadowing `icacls` on PATH). On POSIX, `stat -c '%a'` the file → `600`.

## Cross-references

- Finding: `docs/BUILDER_QUEUE.md` Backlog #23 (re-scoped — original "no chmod" claim STALE).
- Overlaps: #27 (docs update — fold the Windows note in if #27 is active).
- Pattern reused: `EnvManager.ts:138-166` (0700 dir + 0600 file), `atomic-json.ts:77-86` (mode preservation).

## Queue

**The coordinator files the `docs/BUILDER_QUEUE.md` row.** Do not edit `docs/BUILDER_QUEUE.md`.
