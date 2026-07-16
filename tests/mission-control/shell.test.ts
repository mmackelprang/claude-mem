// tests/mission-control/shell.test.ts
import { describe, it, expect } from 'bun:test';
import { runCommand, createGitGhBoundary } from '../../src/services/mission-control/shell.js';

describe('runCommand', () => {
  it('returns exit code 127 when the binary does not exist (graceful, no throw)', () => {
    const result = runCommand(['definitely-not-a-real-binary-xyz', '--version']);
    expect(result.exitCode).toBe(127);
  });
});

describe('createGitGhBoundary', () => {
  it('reports ghAvailable() as a boolean without throwing', () => {
    const boundary = createGitGhBoundary();
    expect(typeof boundary.ghAvailable()).toBe('boolean');
  });

  it('returns [] from listOpenPrs() when gh is unavailable rather than throwing', () => {
    const boundary = createGitGhBoundary();
    // Regardless of environment, listOpenPrs must never throw.
    expect(Array.isArray(boundary.listOpenPrs())).toBe(true);
  });
});
