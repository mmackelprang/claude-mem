// tests/mission-control/shell.test.ts
import { describe, it, expect } from 'bun:test';
import { runCommand, createGitGhBoundary } from '../../src/services/mission-control/shell.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

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

describe('runCommand cwd', () => {
  it('runs the command in the provided working directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mc-cwd-'));
    try {
      // Portable cwd probe (no git init needed): node prints process.cwd().
      const result = runCommand(['node', '-e', 'process.stdout.write(process.cwd())'], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(path.basename(result.stdout)).toBe(path.basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still works with cwd omitted (no regression)', () => {
    const result = runCommand(['node', '-e', 'process.stdout.write("ok")']);
    expect(result.stdout).toBe('ok');
  });
});
