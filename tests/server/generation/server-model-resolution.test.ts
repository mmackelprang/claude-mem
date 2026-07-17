// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { describeServerModelResolution } from '../../../src/server/runtime/create-server-service.js';
import {
  ClaudeObservationProvider,
  DEFAULT_SERVER_CLAUDE_MODEL,
} from '../../../src/server/generation/providers/ClaudeObservationProvider.js';

// #19 — Mark's override (2026-07-17): server generation is cheap-by-default.
// The Claude provider default is the Haiku tier; Sonnet is an explicit
// CLAUDE_MEM_SERVER_MODEL opt-in. These tests lock the new default and the
// override seam, plus the pure startup describer used to log the resolved model.
describe('server generation model default (#19 cheap-by-default)', () => {
  it('the Claude server default is the cheap Haiku tier', () => {
    expect(DEFAULT_SERVER_CLAUDE_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  it('a Claude provider with no model option resolves to the Haiku default', () => {
    const p = new ClaudeObservationProvider({ apiKey: 'k' });
    expect(p.modelId).toBe(DEFAULT_SERVER_CLAUDE_MODEL);
    expect(p.modelId).toBe('claude-haiku-4-5-20251001');
  });

  it('CLAUDE_MEM_SERVER_MODEL (via the model option) still overrides the default', () => {
    const p = new ClaudeObservationProvider({ apiKey: 'k', model: 'claude-sonnet-4-6' });
    expect(p.modelId).toBe('claude-sonnet-4-6');
  });
});

describe('describeServerModelResolution (#19)', () => {
  it('reports the provider default when no env override is set', () => {
    const r = describeServerModelResolution({
      providerLabel: 'claude',
      modelId: DEFAULT_SERVER_CLAUDE_MODEL,
      envOverride: undefined,
    });
    expect(r.overridden).toBe(false);
    expect(r.message).toContain(DEFAULT_SERVER_CLAUDE_MODEL);
    expect(r.message).toContain('provider default');
  });

  it('reports an env override when CLAUDE_MEM_SERVER_MODEL is set', () => {
    const r = describeServerModelResolution({
      providerLabel: 'claude',
      modelId: 'claude-sonnet-4-6',
      envOverride: 'claude-sonnet-4-6',
    });
    expect(r.overridden).toBe(true);
    expect(r.message).toContain('claude-sonnet-4-6');
    expect(r.message).toContain('CLAUDE_MEM_SERVER_MODEL');
  });

  it('treats a blank/whitespace env override as not overridden', () => {
    const r = describeServerModelResolution({
      providerLabel: 'claude',
      modelId: DEFAULT_SERVER_CLAUDE_MODEL,
      envOverride: '   ',
    });
    expect(r.overridden).toBe(false);
    expect(r.message).toContain('provider default');
  });

  it('describes non-claude providers the same way (provider label threaded through)', () => {
    const r = describeServerModelResolution({
      providerLabel: 'gemini',
      modelId: 'gemini-2.5-flash',
      envOverride: undefined,
    });
    expect(r.overridden).toBe(false);
    expect(r.message).toContain('gemini-2.5-flash');
    expect(r.message).toContain('provider=gemini');
  });
});
