// src/ui/viewer/components/MissionControl.tsx
import React from 'react';
import { useMissionControl, AttentionItem } from '../hooks/useMissionControl';

function AttentionPane({ items, ghAvailable }: { items: AttentionItem[]; ghAvailable: boolean }) {
  const byType = (type: string) => items.filter(i => i.type === type);
  const order = ['escalation', 'blocker', 'review', 'question'];
  return (
    <section className="mc-pane" data-testid="mc-attention">
      <h2>Attention — what needs you now</h2>
      {!ghAvailable && (
        <p className="mc-note" data-testid="mc-gh-unavailable">PR mining unavailable (gh not authenticated) — showing specs & escalations only.</p>
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
  const { attention, ghAvailable, progress, velocity, nextSteps, loading, error, refresh } = useMissionControl();

  if (loading) return <div className="mc-loading">Loading Mission Control…</div>;
  if (error) return <div className="mc-error">Failed to load Mission Control: {error}</div>;

  return (
    <div className="mission-control" data-testid="mission-control">
      <div className="mc-header">
        <button className="mc-refresh" onClick={refresh}>Refresh</button>
      </div>

      <AttentionPane items={attention} ghAvailable={ghAvailable} />

      <section className="mc-pane" data-testid="mc-velocity">
        <h2>Velocity</h2>
        {velocity?.error ? (
          <p className="mc-error">Queue parse failed: {velocity.error}</p>
        ) : (
          <p>{velocity?.shippedCount ?? '—'} shipped · {velocity?.openCount ?? '—'} open</p>
        )}
        <ul>
          {(velocity?.shippedByWeek ?? []).map(pt => (
            <li key={pt.week}>{pt.week}: {pt.shipped} shipped</li>
          ))}
        </ul>
      </section>

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
