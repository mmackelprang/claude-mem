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
