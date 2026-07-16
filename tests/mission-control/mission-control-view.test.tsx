// tests/mission-control/mission-control-view.test.tsx
import { describe, it, expect } from 'bun:test';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { AttentionPane } from '../../src/ui/viewer/components/MissionControl';
import { AttentionItem, EscalationContext } from '../../src/ui/viewer/hooks/useMissionControl';

const escalation: AttentionItem = {
  id: 1, type: 'escalation', summary: 'Error signature detected: eaddrinuse',
  blockedOn: null, urgency: 'high', source: 'mine', ref: 'error:eaddrinuse',
  status: 'open', project: 'proj', createdAtEpoch: 1000,
};

// Fail-closed (Mark's locked decision): an escalation renders ONLY when its
// error key resolves an escalationContext entry, which the /attention route
// joins from the server-side remediation catalog. `eaddrinuse` IS cataloged
// (src/services/mission-control/escalation-catalog.ts), so a valid context for
// it produces the actionable What/Where/When/Fix card. Mirrors the shipped payload.
const eaddrinuseContext: Record<string, EscalationContext> = {
  eaddrinuse: {
    key: 'eaddrinuse',
    whatTitle: 'Port already in use',
    fixText: 'A stale worker holds the port. Restart, or kill the PID on :37777.',
    fixCommand: 'claude-mem restart',
    docHref: 'https://docs.claude-mem.ai/troubleshooting#port',
    errorLine: 'Error: listen EADDRINUSE :::37777',
    count: 3,
    latestEpoch: 1000,
    latestProject: 'claude-mem',
    latestAgentType: 'builder',
    latestSessionId: 'abcdef1234567890',
    otherTeamsCount: 1,
  },
};

describe('Mission Control view', () => {
  it('the MissionControl component module imports without throwing', () => {
    expect(() => require('../../src/ui/viewer/components/MissionControl')).not.toThrow();
  });

  it('AttentionPane shows the gh-unavailable note when gh is down', () => {
    const html = renderToString(
      React.createElement(AttentionPane, {
        items: [], ghAvailable: false, specMiningDeferred: false,
        escalationContext: {}, repoWebBase: null, defaultBranch: null,
      })
    );
    expect(html).toContain('PR mining unavailable');
  });

  it('AttentionPane shows the spec/doc-mining deferred note (#24) + a fail-closed actionable escalation card when gated', () => {
    const html = renderToString(
      React.createElement(AttentionPane, {
        items: [escalation], ghAvailable: true, specMiningDeferred: true,
        escalationContext: eaddrinuseContext, repoWebBase: null, defaultBranch: null,
      })
    );
    expect(html).toContain('deferred'); // repo-root-gated sources labeled, not silently missing
    expect(html).toContain('#24');
    // Fail-closed, actionable-only escalation (Mark's locked decision): because
    // `eaddrinuse` resolves a catalog+context entry, it renders as the actionable
    // What/Where/When/Fix card — NOT the old raw `error:eaddrinuse` ref dump.
    expect(html).toContain('mc-escalation');                  // the actionable card, not a bare list item
    expect(html).toContain('Port already in use');            // What — catalog title
    expect(html).toContain('EADDRINUSE');                     // the resolved error line
    expect(html).toContain('builder team');                   // Where — latest team
    expect(html).toContain('+1 others');                      // Where — "+N others" aggregate
    expect(html).toContain('3 times in last 7d');             // When — occurrence count
    expect(html).toContain('claude-mem restart');             // Fix — catalog command
  });

  it('AttentionPane is fail-closed: an escalation whose error key has NO context does not render a card', () => {
    // Same escalation item, but escalationContext is empty (route emits only
    // catalog keys that actually occurred). The card must be suppressed entirely.
    const html = renderToString(
      React.createElement(AttentionPane, {
        items: [escalation], ghAvailable: true, specMiningDeferred: false,
        escalationContext: {}, repoWebBase: null, defaultBranch: null,
      })
    );
    expect(html).not.toContain('mc-escalation');
    expect(html).not.toContain('Escalations (');
  });

  it('renders a Velocity pane (Phase 1b re-enables velocity via repo-root resolution)', () => {
    // Phase 1b re-enables velocity: the shipped view is 4 panes — Attention,
    // Velocity, Progress, Next-steps. The component must now carry the
    // mc-velocity testid (previously deferred to #24, now landed).
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/ui/viewer/components/MissionControl.tsx'),
      'utf8'
    );
    expect(src).toContain('data-testid="mc-velocity"');
    expect(src).toContain('data-testid="mc-progress"');
    expect(src).toContain('data-testid="mc-next-steps"');
  });

  it('renders a type-specific link for a PR review row (github ↗) when repoWebBase is present', () => {
    // Polish §2 / K6: PR rows get a typed `github ↗` affordance; files/specs get `view ↗`.
    const item: AttentionItem = {
      id: 2, type: 'review', summary: 'PR #22 awaiting review: X', blockedOn: null,
      urgency: 'normal', source: 'mine', ref: 'pr:22', status: 'open',
      project: 'claude-mem', createdAtEpoch: 1000,
    };
    const html = renderToString(
      React.createElement(AttentionPane, {
        items: [item], ghAvailable: true, specMiningDeferred: false,
        escalationContext: {}, repoWebBase: 'https://github.com/acme/repo', defaultBranch: 'main',
      })
    );
    expect(html).toContain('href="https://github.com/acme/repo/pull/22"');
    expect(html).toContain('github');
  });
});
