import { describe, it, expect } from 'bun:test';
import { renderEnv, renderCompose, isCostlyModel, DEFAULT_WIZARD_MODEL } from '../../src/ui/viewer/lib/wizard.js';

const base = { provider: 'claude' as const, model: DEFAULT_WIZARD_MODEL, apiKey: 'sk-ant-x' };

describe('wizard generator', () => {
  it('env uses CLAUDE_MEM_SERVER_MODEL (not CLAUDE_MEM_MODEL) and a full id', () => {
    const out = renderEnv(base);
    expect(out).toContain('CLAUDE_MEM_SERVER_MODEL=claude-haiku-4-5-20251001');
    expect(out).not.toContain('CLAUDE_MEM_MODEL=');
  });
  it('compose emits valid indented YAML', () => {
    expect(renderCompose(base)).toContain('  CLAUDE_MEM_SERVER_MODEL: claude-haiku-4-5-20251001');
  });
  it('placeholders the key when empty', () => {
    expect(renderEnv({ ...base, apiKey: '' })).toContain('ANTHROPIC_API_KEY=<paste your key>');
  });
  it('flags sonnet as costly, haiku as not', () => {
    expect(isCostlyModel('claude-sonnet-4-6')).toBe(true);
    expect(isCostlyModel(DEFAULT_WIZARD_MODEL)).toBe(false);
  });
});
