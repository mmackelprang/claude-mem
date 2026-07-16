// tests/mission-control/mission-control-view.test.tsx
import { describe, it, expect } from 'bun:test';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { AttentionPane } from '../../src/ui/viewer/components/MissionControl';
import { AttentionItem } from '../../src/ui/viewer/hooks/useMissionControl';

const escalation: AttentionItem = {
  id: 1, type: 'escalation', summary: 'Error signature detected: eaddrinuse',
  blockedOn: null, urgency: 'high', source: 'mine', ref: 'error:eaddrinuse',
  status: 'open', project: 'proj', createdAtEpoch: 1000,
};

describe('Mission Control view', () => {
  it('the MissionControl component module imports without throwing', () => {
    expect(() => require('../../src/ui/viewer/components/MissionControl')).not.toThrow();
  });

  it('AttentionPane shows the gh-unavailable note when gh is down', () => {
    const html = renderToString(
      React.createElement(AttentionPane, { items: [], ghAvailable: false, specMiningDeferred: false })
    );
    expect(html).toContain('PR mining unavailable');
  });

  it('AttentionPane shows the spec/doc-mining deferred note (#24) when gated', () => {
    const html = renderToString(
      React.createElement(AttentionPane, { items: [escalation], ghAvailable: true, specMiningDeferred: true })
    );
    expect(html).toContain('deferred'); // repo-root-gated sources labeled, not silently missing
    expect(html).toContain('#24');
    // Escalations still render (SQLite source ships in Phase 1).
    expect(html).toContain('eaddrinuse');
  });

  it('does not render a Velocity pane in the Phase-1 view (deferred to #24)', () => {
    // The shipped view is 3 panes: Attention, Progress, Next-steps. Velocity is
    // deferred, so the component source must not carry a mc-velocity testid.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/ui/viewer/components/MissionControl.tsx'),
      'utf8'
    );
    expect(src).not.toContain('data-testid="mc-velocity"');
    expect(src).toContain('data-testid="mc-progress"');
    expect(src).toContain('data-testid="mc-next-steps"');
  });
});
