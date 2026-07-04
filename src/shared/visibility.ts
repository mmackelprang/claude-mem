// SPDX-License-Identifier: Apache-2.0

import { logger } from '../utils/logger.js';

/** The persisted enum. `org` is forward-compatible / inert in Phase 2 (§5 of the handoff). */
export const VISIBILITY_LEVELS = ['private', 'team', 'org'] as const;
export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];

/** Values a user-facing control may SET. `org` is never settable in Phase 2. */
export const SETTABLE_VISIBILITY = ['private', 'team'] as const;
export type SettableVisibility = (typeof SETTABLE_VISIBILITY)[number];

export const DEFAULT_VISIBILITY_ENV = 'CLAUDE_MEM_DEFAULT_VISIBILITY';

/** The built-in go-forward default when nothing overrides it. */
export const BUILTIN_DEFAULT_VISIBILITY: SettableVisibility = 'team';

export function isVisibilityLevel(value: unknown): value is VisibilityLevel {
  return typeof value === 'string' && (VISIBILITY_LEVELS as readonly string[]).includes(value);
}

function coerceSettable(value: unknown): SettableVisibility | null {
  return value === 'private' || value === 'team' ? value : null;
}

/**
 * Resolve the go-forward default visibility for a new capture.
 * Resolution order (most specific wins): per-project override → env → built-in 'team'.
 * `org` and any junk are rejected and fall back to 'team' (never throws) — the
 * default stream must always classify to a settable value, and 'org' must not
 * leak in as a default.
 */
export function resolveDefaultVisibility(input: {
  projectDefault?: string | null;
  envValue?: string | null;
}): SettableVisibility {
  const project = coerceSettable(input.projectDefault?.trim().toLowerCase());
  if (project) return project;

  const raw = input.envValue?.trim().toLowerCase();
  if (raw) {
    const env = coerceSettable(raw);
    if (env) return env;
    logger.warn('SYSTEM', `${DEFAULT_VISIBILITY_ENV} has an invalid value; falling back to '${BUILTIN_DEFAULT_VISIBILITY}'`, undefined, {
      value: raw,
      accepted: SETTABLE_VISIBILITY,
    });
  }
  return BUILTIN_DEFAULT_VISIBILITY;
}

/**
 * Self-closing proactive switch (Task 6). MUST be self-closing only — the
 * wrapping form of any `private*` tag is redaction (Task 5 fail-safe), never a
 * visibility switch. `\/>` with no captured content is what distinguishes it.
 */
export const PRIVATE_SESSION_MARKER = /<private-session\s*\/>/i;

export function hasPrivateSessionMarker(text: string): boolean {
  return typeof text === 'string' && PRIVATE_SESSION_MARKER.test(text);
}
