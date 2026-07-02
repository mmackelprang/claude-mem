---
Title: Fix plan — server-beta scope-vocabulary mismatch: local hook key is rejected by /v1
Status: Planned (Builder to implement on Mark's fork)
Related: ADR 0001 §7 (Gap 4, auth reconciliation), §7.1; WS2 server-beta arc
---

## Bug Report

**Summary:** The local hook API-key bootstrap mints keys with a **worker-era scope vocabulary** (`events:write`, `sessions:write`, `observations:read`, `jobs:read`), but every `/v1/*` route gates on `memories:read` / `memories:write` (or the `*` wildcard). A bootstrap key therefore satisfies **none** of the `/v1` routes and is rejected with `403 Forbidden` — so a `CLAUDE_MEM_RUNTIME=server` install cannot ingest events, start sessions, read jobs, or search against its own local Postgres.

**Severity:** High — this is a total auth break for the local-hook server-mode path. Hooks cannot write a single event to `/v1/events`.

**Scope:** correctness bug on existing OPEN server-beta code. Independent of the IP-boundary question (ADR §11). The change is confined to the Postgres server-mode bootstrap; worker-runtime auth is not on this path and is unaffected.

---

## Root Cause (verified against current `main`)

**Mint side** — `src/services/hooks/server-bootstrap.ts:39-44`:

```ts
export const HOOK_API_KEY_SCOPES: readonly string[] = Object.freeze([
  'events:write',
  'sessions:write',
  'observations:read',
  'jobs:read',
]);
```

These scopes are written into the Postgres `api_keys` row (`bootstrapServerApiKey` → `PostgresAuthRepository.createApiKey`, `server-bootstrap.ts:72-79`).

**Enforcement side** — `src/server/routes/v1/ServerV1PostgresRoutes.ts:160-169` builds exactly two auth middlewares, and every route uses one of them:

```ts
const baseWrite = requirePostgresServerAuth(this.options.pool, { ..., requiredScopes: ['memories:write'] });
const baseRead  = requirePostgresServerAuth(this.options.pool, { ..., requiredScopes: ['memories:read'] });
```

Route audit (`ServerV1PostgresRoutes.ts`): `/v1/events` (:251, writeAuth), `/v1/events/batch` (:326, writeAuth), `/v1/sessions/start` (:757, writeAuth), `/v1/sessions/:id/end` (:858, writeAuth), `/v1/search` (:945, readAuth), `/v1/context` (:987, readAuth), `/v1/jobs/:id` (:684, readAuth), `/v1/memories` (:911, writeAuth). **All** of them require `memories:read` or `memories:write`.

**The predicate** — `verifyPostgresApiKey` → `hasRequiredScopes` (`src/server/middleware/postgres-auth.ts:164-169`):

```ts
function hasRequiredScopes(grantedScopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0 || grantedScopes.includes('*')) {
    return true;
  }
  return requiredScopes.every(scope => grantedScopes.includes(scope));
}
```

A bootstrap key holds `['events:write','sessions:write','observations:read','jobs:read']`. It does not include `memories:write`, `memories:read`, or `*` → `hasRequiredScopes` returns `false` → `verifyPostgresApiKey` returns `null` → the middleware responds `403 Forbidden: Invalid API key or insufficient scope` (`postgres-auth.ts:82-84`). The hook path is dead.

**Corroborating evidence that `memories:*` is already the canonical vocabulary everywhere else:**
- Worker-side `/v1` (bun:sqlite store) also requires `memories:read` / `memories:write` (`src/server/routes/v1/ServerV1Routes.ts:65-70`).
- The `/v1/keys` mint endpoint issues `['memories:read']` keys (`ServerV1PostgresRoutes.ts:221,229`).
- The entire server test suite standardizes on `memories:read` / `memories:write` (`tests/server/v1-routes.test.ts`, `auth-api-key.test.ts`, `data-deletion.test.ts`, `connect-keys.test.ts`, `runtime/*`, `server-service.test.ts`, `server-keys-cli.test.ts:16,26`, etc.).

`server-bootstrap.ts` is the **lone outlier** still emitting the worker-era vocabulary. No production code path reads `events:*` / `observations:*` / `jobs:*` as an authorization scope — they are dead tokens.

---

## Decision — Direction A: bootstrap adopts `memories:*`

The ADR (§7.1) offers three directions; this plan recommends **A**.

| Direction | What it does | Verdict |
|---|---|---|
| **A. Bootstrap mints `memories:*`** | Change `HOOK_API_KEY_SCOPES` to `['memories:read','memories:write']` | **Chosen** |
| B. `/v1` also accepts `events:*` / `observations:*` | Teach every route/middleware a second vocabulary + mapping | Rejected |
| C. Scope-mapping/normalization layer | Normalize `events:write`→`memories:write` at verify time | Rejected |

**Rationale for A:**
1. **Single canonical vocabulary, minimal blast radius.** Everything else in the codebase — both `/v1` surfaces, the mint endpoint, all tests — already speaks `memories:*`. Direction A brings the one outlier into line and changes exactly one frozen array plus its doc comment. Directions B and C would *spread* a second vocabulary across the enforcement path that many routes depend on (higher risk, exactly the "status quo confusion" the ADR §2.3 warns against).
2. **No change to the hot enforcement path.** `hasRequiredScopes` / `verifyPostgresApiKey` stay untouched, so there is zero risk of a scope-check regression affecting real production keys.
3. **Least privilege preserved.** The hook needs both read (`/v1/search`, `/v1/jobs/:id`) and write (`/v1/events`, `/v1/sessions/*`); `['memories:read','memories:write']` is exactly that, and no more (no `*`, no `memories:admin`).
4. **Worker-runtime auth is not on this path.** The bootstrap key is a Postgres key used only when `CLAUDE_MEM_RUNTIME=server`; worker runtime routes hooks to the unauthenticated loopback `/api/*` and uses a *separate* bun:sqlite key store (ADR §2.3). Changing this array cannot break worker-mode auth.

**Replace vs. additive:** replace the four worker-era scopes with the two canonical ones (do **not** keep the dead tokens additively). Keeping them would re-create the illusion of a second working vocabulary that in fact authorizes nothing, defeating the "one scope language" goal. No test asserts on `HOOK_API_KEY_SCOPES` (grep-verified), so replacement breaks nothing.

---

## Implementation Tasks (bite-sized, literal code)

### Task 1 — Mint the canonical scopes

In `src/services/hooks/server-bootstrap.ts`, replace the scope constant (`:39-44`):

```ts
export const HOOK_API_KEY_SCOPES: readonly string[] = Object.freeze([
  'memories:read',
  'memories:write',
]);
```

Update the bootstrapping doc comment (`server-bootstrap.ts:13-15`) so it no longer advertises the retired vocabulary:

```ts
//   3. Generate a `cmem_<random>` key, hash with SHA-256, insert into
//      `api_keys` with the scopes hooks need on the canonical /v1 surface:
//      memories:read (search, context, job status) and memories:write
//      (events, sessions). These are the SAME scopes every /v1 route gates on
//      (ServerV1PostgresRoutes.ts / ServerV1Routes.ts); the legacy
//      events:*/observations:*/jobs:* vocabulary authorized nothing and was
//      removed. See docs/bug-fixes/serverbeta-scope-vocabulary-reconciliation.md.
```

### Task 2 — Export the enforcement predicate for contract testing

`hasRequiredScopes` is the single source of truth for "does this key satisfy this route." Export it so the test can bind the mint to the real predicate. In `src/server/middleware/postgres-auth.ts:164`, change:

```ts
export function hasRequiredScopes(grantedScopes: string[], requiredScopes: string[]): boolean {
```

(Body unchanged. This is a visibility-only change — no behavior change, no new logic.)

### Task 3 — Contract test: minted scopes satisfy every /v1 route

Create `tests/server/server-bootstrap-scopes.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// The local hook bootstrap must mint an API key whose scopes satisfy the
// scope the /v1 routes actually enforce. This binds the MINT
// (HOOK_API_KEY_SCOPES) to the ENFORCEMENT predicate (hasRequiredScopes) so a
// future edit to either side that breaks the hook path fails here — the exact
// regression that made a server-mode install unable to POST /v1/events.

import { describe, it, expect } from 'bun:test';
import { HOOK_API_KEY_SCOPES } from '../../src/services/hooks/server-bootstrap.js';
import { hasRequiredScopes } from '../../src/server/middleware/postgres-auth.js';

const minted = [...HOOK_API_KEY_SCOPES];

describe('hook bootstrap scopes satisfy /v1 enforcement', () => {
  it('mints the canonical memories:* vocabulary', () => {
    expect(minted).toEqual(['memories:read', 'memories:write']);
  });

  it('satisfies readAuth routes (memories:read): /v1/search, /v1/context, /v1/jobs/:id', () => {
    expect(hasRequiredScopes(minted, ['memories:read'])).toBe(true);
  });

  it('satisfies writeAuth routes (memories:write): /v1/events, /v1/sessions/*', () => {
    expect(hasRequiredScopes(minted, ['memories:write'])).toBe(true);
  });

  it('does NOT carry the retired worker-era vocabulary', () => {
    expect(minted).not.toContain('events:write');
    expect(minted).not.toContain('observations:read');
    expect(minted).not.toContain('jobs:read');
    expect(minted).not.toContain('sessions:write');
  });

  it('is least-privilege — no wildcard or admin scope', () => {
    expect(minted).not.toContain('*');
    expect(minted).not.toContain('memories:admin');
  });

  // Regression guard: the exact pre-fix mint would fail /v1 auth.
  it('the pre-fix worker-era scopes would NOT satisfy /v1 (proves the bug)', () => {
    const preFix = ['events:write', 'sessions:write', 'observations:read', 'jobs:read'];
    expect(hasRequiredScopes(preFix, ['memories:write'])).toBe(false);
    expect(hasRequiredScopes(preFix, ['memories:read'])).toBe(false);
  });
});
```

---

## Verification

- `bunx tsc --noEmit` clean.
- `bun test tests/server/server-bootstrap-scopes.test.ts` green.
- Full server auth suite unaffected: `bun test tests/server/auth-api-key.test.ts tests/server/v1-routes.test.ts tests/server/server-keys-cli.test.ts` green (none assert on `HOOK_API_KEY_SCOPES`; grep-verified).
- Integration (where a local Postgres is available): run the bootstrap (`claude-mem server keys rotate` or install with `runtime: server`), then `POST /v1/events` with the minted key → `2xx` (previously `403`).

## Self-review

- **No placeholders / TBD** — every task carries literal code.
- **Spec coverage** — mint alignment (Task 1), testability seam (Task 2), behavioral + regression test (Task 3).
- **Type consistency** — `HOOK_API_KEY_SCOPES: readonly string[]`; `hasRequiredScopes(string[], string[]): boolean` unchanged.
- **Prime-invariant** — worker/local mode is unaffected: it does not use Postgres api_keys and routes hooks to unauthenticated `/api/*`.
- **Blast radius** — one constant, one `export` keyword, one new test file. No enforcement-path logic changes.

## Open decision for Mark (before Builder implements)

- **Q1.** Confirm Direction A (replace with `memories:*`) over keeping the legacy tokens additively. Recommendation: replace — the legacy tokens authorize nothing and additive-keep only re-muddies the vocabulary. (This is a one-line difference in Task 1 if Mark prefers additive.)
- **Q2 (out of scope, flagged).** ADR §7.2 (the `better-auth` org/team → Postgres `teams` bridge / cold-start mint) and §7.3 (Chroma `CHROMA_API_KEY` in team mode) are the *larger* Gap-4 reconciliation and partly sit on the reserved-commercial boundary (§11). This plan deliberately fixes only the correctness bug (§7.1) and leaves those as separate arc items.
