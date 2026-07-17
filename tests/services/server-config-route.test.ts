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
