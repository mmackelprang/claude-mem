// tests/cli/worker-start-error-message.test.ts
import { describe, it, expect } from 'bun:test';
import { describeStartFailure } from '../../src/services/worker-service.js';

describe('describeStartFailure (#17)', () => {
  it('names the held port and points at the real log file when the port is occupied', async () => {
    const net = await import('net');
    const holder = net.createServer();
    const port = 37788;
    await new Promise<void>((r) => holder.listen(port, '127.0.0.1', () => r()));
    try {
      const msg = await describeStartFailure(port);
      expect(msg).toContain(String(port));
      expect(msg.toLowerCase()).toContain('in use');
      expect(msg).toContain('claude-mem-'); // the log file the logger actually writes
      expect(msg).not.toContain('worker-2'); // NOT the empty worker-<date>.log
    } finally {
      await new Promise<void>((r) => holder.close(() => r()));
    }
  });

  it('falls back to a generic-but-logged message when the port is free', async () => {
    const msg = await describeStartFailure(37787);
    expect(msg).toContain('claude-mem-'); // still points at the real log
  });
});
