// src/ui/viewer/components/MissionControl.tsx
import React from 'react';
import { useMissionControl, AttentionItem } from '../hooks/useMissionControl';

export function AttentionPane({ items, ghAvailable, specMiningDeferred }: {
  items: AttentionItem[]; ghAvailable: boolean; specMiningDeferred: boolean;
}) {
  const byType = (type: string) => items.filter(i => i.type === type);
  const order = ['escalation', 'blocker', 'review', 'question'];
  return (
    <section className="mc-pane" data-testid="mc-attention">
      <h2>Attention — what needs you now</h2>
      {!ghAvailable && (
        <p className="mc-note" data-testid="mc-gh-unavailable">PR mining unavailable (gh not authenticated) — showing escalations only.</p>
      )}
      {specMiningDeferred && (
        <p className="mc-note" data-testid="mc-spec-mining-deferred">Spec-review &amp; doc-question mining deferred — needs repo root (follow-up #24). Showing escalations + open-PR reviews.</p>
      )}
      {items.length === 0 && <p className="mc-empty">Nothing is gated on you right now.</p>}
      {order.map(type => {
        const group = byType(type);
        if (group.length === 0) return null;
        return (
          <div key={type} className="mc-attention-group">
            <h3>{type} ({group.length})</h3>
            <ul>
              {group.map(item => (
                <li key={item.id} className={`mc-item mc-urgency-${item.urgency}`}>
                  {item.summary}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

export function MissionControl() {
  const { attention, ghAvailable, specMiningDeferred, progress, nextSteps, loading, error, refresh } = useMissionControl();

  if (loading) return <div className="mc-loading">Loading Mission Control…</div>;
  if (error) return <div className="mc-error">Failed to load Mission Control: {error}</div>;

  // Phase 1 = 3 panes that resolve from the deployed worker's environment
  // (SQLite + gh). Velocity (reads docs/BUILDER_QUEUE.md) is deferred to #24 and
  // intentionally not rendered — its route stays registered, gated, for re-enable.
  return (
    <div className="mission-control" data-testid="mission-control">
      <div className="mc-header">
        <button className="mc-refresh" onClick={refresh}>Refresh</button>
      </div>

      <AttentionPane items={attention} ghAvailable={ghAvailable} specMiningDeferred={specMiningDeferred} />

      <section className="mc-pane" data-testid="mc-progress">
        <h2>Progress (by agent × time)</h2>
        {progress.length === 0 && <p className="mc-empty">No agent activity in range.</p>}
        <ul>
          {progress.map(b => (
            <li key={`${b.agentType}-${b.agentId}-${b.bucket}`}>
              {b.bucket} · {b.agentType ?? 'unknown'} · {b.total} obs
            </li>
          ))}
        </ul>
      </section>

      <section className="mc-pane" data-testid="mc-next-steps">
        <h2>Suggested next steps <span className="mc-badge">Unsynthesized</span></h2>
        {nextSteps.length === 0 && <p className="mc-empty">No next-steps captured yet.</p>}
        <ul>
          {nextSteps.map(item => (
            <li key={item.memorySessionId}>{item.text}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
