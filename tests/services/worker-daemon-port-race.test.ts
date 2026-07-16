import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const WORKER_SERVICE_PATH = join(import.meta.dir, '../../src/services/worker-service.ts');
const source = readFileSync(WORKER_SERVICE_PATH, 'utf-8');

describe('Worker daemon port-race guard (#1447)', () => {
  it('detects EADDRINUSE error code in the port-conflict check', () => {
    expect(source).toContain("code === 'EADDRINUSE'");
  });

  it('detects Bun port-in-use message via regex in the port-conflict check', () => {
    expect(source).toContain('/port.*in use|address.*in use/i.test(error.message)');
  });

  it('calls waitForHealth before exiting on a port conflict', () => {
    // #17 re-scope: the port-conflict handling was split into nested ifs so the
    // dead-but-bound branch can reap orphaned chroma-mcp and retry. Assert both
    // the guard and the health check independently rather than the old combined
    // single-line conditional.
    expect(source).toContain('if (isPortConflict)');
    expect(source).toContain('await waitForHealth(port, 3000)');
  });

  it('reaps orphaned chroma-mcp and retries once on a dead-but-bound port (#17)', () => {
    expect(source).toContain('reapOrphanedChroma()');
    expect(source).toContain('retrying worker start once');
  });

  it('uses async catch handler to allow awaiting waitForHealth', () => {
    expect(source).toContain('worker.start().catch(async (error) =>');
  });

  it('logs info (not error) when cleanly exiting after port race', () => {
    expect(source).toContain("logger.info('SYSTEM', 'Duplicate daemon exiting");
  });
});
