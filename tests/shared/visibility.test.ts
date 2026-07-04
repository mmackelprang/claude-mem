import { describe, it, expect } from 'bun:test';
import {
  resolveDefaultVisibility,
  isVisibilityLevel,
  hasPrivateSessionMarker,
  PRIVATE_SESSION_MARKER,
  BUILTIN_DEFAULT_VISIBILITY,
} from '../../src/shared/visibility.js';
import { humanizeActor } from '../../src/shared/actor-display.js';

describe('resolveDefaultVisibility', () => {
  it('resolves default visibility: project > env > builtin, rejecting org/junk', () => {
    expect(resolveDefaultVisibility({})).toBe('team');
    expect(resolveDefaultVisibility({ envValue: 'private' })).toBe('private');
    expect(resolveDefaultVisibility({ envValue: 'PRIVATE' })).toBe('private');
    expect(resolveDefaultVisibility({ envValue: 'org' })).toBe('team');   // never a default
    expect(resolveDefaultVisibility({ envValue: 'garbage' })).toBe('team');
    expect(resolveDefaultVisibility({ projectDefault: 'team', envValue: 'private' })).toBe('team'); // project wins
    expect(resolveDefaultVisibility({ envValue: '' })).toBe('team');       // empty = unset
    expect(BUILTIN_DEFAULT_VISIBILITY).toBe('team');
  });
});

describe('isVisibilityLevel', () => {
  it('accepts the persisted enum only', () => {
    expect(isVisibilityLevel('private')).toBe(true);
    expect(isVisibilityLevel('team')).toBe(true);
    expect(isVisibilityLevel('org')).toBe(true);
    expect(isVisibilityLevel('public')).toBe(false);
    expect(isVisibilityLevel(null)).toBe(false);
    expect(isVisibilityLevel(undefined)).toBe(false);
  });
});

describe('hasPrivateSessionMarker / PRIVATE_SESSION_MARKER', () => {
  it('matches the self-closing switch only', () => {
    expect(hasPrivateSessionMarker('please <private-session /> keep this off the team feed')).toBe(true);
    expect(hasPrivateSessionMarker('<private-session/>')).toBe(true);
    expect(hasPrivateSessionMarker('<PRIVATE-SESSION />')).toBe(true);
    // wrapping form is NOT the switch (that is redaction, Task 5)
    expect(hasPrivateSessionMarker('<private-session>secret</private-session>')).toBe(false);
    expect(hasPrivateSessionMarker('nothing here')).toBe(false);
  });

  it('PRIVATE_SESSION_MARKER is case-insensitive and non-global (single test-safe)', () => {
    expect(PRIVATE_SESSION_MARKER.test('<private-session />')).toBe(true);
    expect(PRIVATE_SESSION_MARKER.global).toBe(false);
  });
});

describe('humanizeActor', () => {
  it('humanizes actor ids', () => {
    expect(humanizeActor('human:alice@org')).toBe('Alice');
    expect(humanizeActor('system:ci-runner')).toBe('CI');
    expect(humanizeActor('system:local-hook-bootstrap')).toBe('Local');
    expect(humanizeActor(null)).toBe('');
    expect(humanizeActor(undefined)).toBe('');
    expect(humanizeActor('weird-value')).toBe('weird-value');
  });
});
