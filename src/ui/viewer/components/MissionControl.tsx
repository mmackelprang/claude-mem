// src/ui/viewer/components/MissionControl.tsx
import React, { useMemo } from 'react';
import {
  useMissionControl, AttentionItem, EscalationContext, ProgressBucket, TeamSessions, TeamPrs, ProgressRange,
} from '../hooks/useMissionControl';

// Outcome types only (process types session/prompt/change are excluded from the outcome line).
const OUTCOME_ICONS: Record<string, string> = { feature: '◆', bugfix: '●', decision: '⚖', refactor: '↻', discovery: '○' };
const OUTCOME_ORDER = ['feature', 'bugfix', 'decision', 'refactor', 'discovery'];
const OUTCOME_LABELS: Record<string, string> = { feature: 'feature', bugfix: 'bugfix', decision: 'decision', refactor: 'refactor', discovery: 'discovery' };

function plural(n: number, word: string) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

/** Link an attention item by ref. Returns { href, kind } or null (no link). K1: question uses the file, no #L. */
function attentionLink(item: AttentionItem, repoWebBase: string | null, defaultBranch: string | null): { href: string; kind: 'github' | 'view' } | null {
  if (!repoWebBase) return null;
  if (item.ref.startsWith('pr:')) {
    const n = item.ref.slice(3);
    return /^\d+$/.test(n) ? { href: `${repoWebBase}/pull/${n}`, kind: 'github' } : null;
  }
  const branch = defaultBranch ?? 'main';
  if (item.ref.startsWith('spec:')) return { href: `${repoWebBase}/blob/${branch}/${item.ref.slice(5)}`, kind: 'view' };
  if (item.ref.startsWith('question:')) {
    // ref = question:<path>#<bulletIndex>; the #<n> is a bullet ordinal, NOT a file line — link the file only (K1).
    const path = item.ref.slice('question:'.length).split('#')[0];
    return { href: `${repoWebBase}/blob/${branch}/${path}`, kind: 'view' };
  }
  return null;
}

function EscalationCard({ ctx }: { ctx: EscalationContext }) {
  const where = ctx.otherTeamsCount > 0
    ? `${ctx.latestProject ?? '—'} · ${ctx.latestAgentType ?? 'unknown'} team · +${ctx.otherTeamsCount} others`
    : `${ctx.latestProject ?? '—'} · ${ctx.latestAgentType ?? 'unknown'} team`;
  const when = `${plural(ctx.count, 'time')} in last 7d · latest ${new Date(ctx.latestEpoch).toLocaleString()}`;
  return (
    <div className="mc-escalation" data-testid="mc-escalation">
      <span className="mc-urgency mc-urgency-high">{'●'} HIGH</span>
      <span className="mc-escalation-title">{ctx.whatTitle}</span>
      <div className="mc-escalation-line">{ctx.errorLine}</div>
      <div className="mc-field"><span className="mc-field-label">where</span><span>{where}{ctx.latestSessionId ? ` · session ${ctx.latestSessionId.slice(0, 8)}` : ''}</span></div>
      <div className="mc-field"><span className="mc-field-label">when</span><span>{when}</span></div>
      <div className="mc-field">
        <span className="mc-field-label">fix</span>
        <span>
          {ctx.fixText}{' '}
          {ctx.fixCommand && (
            <button className="mc-copy" onClick={() => { try { navigator.clipboard?.writeText(ctx.fixCommand!); } catch { /* noop */ } }} aria-label={`Copy command: ${ctx.fixCommand}`}>
              {ctx.fixCommand} {'⧉'}
            </button>
          )}{' '}
          <a className="mc-link" href={ctx.docHref} target="_blank" rel="noopener noreferrer">docs {'↗'}</a>
        </span>
      </div>
    </div>
  );
}

export function AttentionPane({ items, ghAvailable, specMiningDeferred, escalationContext, repoWebBase, defaultBranch }: {
  items: AttentionItem[]; ghAvailable: boolean; specMiningDeferred: boolean;
  escalationContext: Record<string, EscalationContext>; repoWebBase: string | null; defaultBranch: string | null;
}) {
  const order: Array<AttentionItem['type']> = ['escalation', 'blocker', 'review', 'question'] as any;
  const byType = (type: string) => items.filter(i => i.type === type);
  // Fail-closed: only escalation items whose error key resolved a catalog+context entry render.
  const escalations = byType('escalation')
    .map(i => ({ item: i, ctx: escalationContext[i.ref.replace(/^error:/, '')] }))
    .filter(e => e.ctx);

  return (
    <section className="mc-pane" data-testid="mc-attention">
      <h2>Attention — what needs you now</h2>
      {!ghAvailable && <p className="mc-note" data-testid="mc-gh-unavailable">PR mining unavailable (gh not authenticated) — showing escalations only.</p>}
      {specMiningDeferred && <p className="mc-note" data-testid="mc-spec-mining-deferred">Spec-review &amp; doc-question mining deferred — needs repo root (follow-up #24). Showing escalations + open-PR reviews.</p>}
      {items.length === 0 && <p className="mc-empty">Nothing is gated on you right now.</p>}

      {escalations.length > 0 && (
        <div className="mc-attention-group" data-testid="mc-escalations">
          <h3>Escalations ({escalations.length})</h3>
          {escalations.map(e => <EscalationCard key={e.item.id} ctx={e.ctx} />)}
        </div>
      )}

      {(['blocker', 'review', 'question'] as const).map(type => {
        const group = byType(type);
        if (group.length === 0) return null;
        return (
          <div key={type} className="mc-attention-group">
            <h3>{type}s ({group.length})</h3>
            <ul>
              {group.map(item => {
                const link = attentionLink(item, repoWebBase, defaultBranch);
                return (
                  <li key={item.id} className={`mc-item mc-type-${type}`}>
                    <div className="mc-item-row">
                      {link
                        ? <a className="mc-link" href={link.href} target="_blank" rel="noopener noreferrer">{item.summary} {link.kind === 'github' ? 'github ↗' : 'view ↗'}</a>
                        : <span>{item.summary}</span>}
                      {item.project && <span className="mc-meta">{item.project}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function VelocityPane({ velocity }: { velocity: ReturnType<typeof useMissionControl>['velocity'] }) {
  return (
    <section className="mc-pane" data-testid="mc-velocity">
      <h2>Velocity</h2>
      {velocity?.deferred ? (
        <p className="mc-note" data-testid="mc-velocity-deferred">Velocity deferred — set <code>CLAUDE_MEM_PROJECT_ROOT</code> to the repo containing <code>docs/BUILDER_QUEUE.md</code> (follow-up #24).</p>
      ) : velocity?.error ? (
        <p className="mc-error" data-testid="mc-velocity-error">Queue parse failed: {velocity.error}</p>
      ) : (
        <>
          <p>{velocity?.shippedCount ?? '—'} shipped · {velocity?.openCount ?? '—'} open</p>
          <ul>{(velocity?.shippedByWeek ?? []).map(pt => <li key={pt.week} className="mc-meta">{pt.week}: {pt.shipped} shipped</li>)}</ul>
        </>
      )}
    </section>
  );
}

interface TeamRow { project: string | null; agentType: string | null; byType: Record<string, number>; total: number; sessions: number; prNumbers: number[]; }

function buildTeamTree(progress: ProgressBucket[], sessions: TeamSessions[], prs: TeamPrs[]): Map<string, TeamRow[]> {
  const teamKey = (p: string | null, a: string | null) => `${p ?? ''} ${a ?? ''}`;
  const teams = new Map<string, TeamRow>();
  for (const b of progress) {
    const k = teamKey(b.project, b.agentType);
    let t = teams.get(k);
    if (!t) { t = { project: b.project, agentType: b.agentType, byType: {}, total: 0, sessions: 0, prNumbers: [] }; teams.set(k, t); }
    t.total += b.total;
    for (const [type, n] of Object.entries(b.byType)) t.byType[type] = (t.byType[type] ?? 0) + n;
  }
  for (const s of sessions) { const t = teams.get(teamKey(s.project, s.agentType)); if (t) t.sessions = s.sessions; }
  for (const p of prs) { const t = teams.get(teamKey(p.project, p.agentType)); if (t) t.prNumbers = p.prNumbers; }
  const byProject = new Map<string, TeamRow[]>();
  for (const t of teams.values()) {
    const pk = t.project ?? '(unknown)';
    if (!byProject.has(pk)) byProject.set(pk, []);
    byProject.get(pk)!.push(t);
  }
  return byProject;
}

function outcomeLine(byType: Record<string, number>): string | null {
  const parts = OUTCOME_ORDER.filter(t => (byType[t] ?? 0) > 0).map(t => `${OUTCOME_ICONS[t]} ${plural(byType[t], OUTCOME_LABELS[t])}`);
  return parts.length ? parts.join(' · ') : null;
}

function ProgressPane({ progress, sessions, prs, range, setRange, repoWebBase }: {
  progress: ProgressBucket[]; sessions: TeamSessions[]; prs: TeamPrs[];
  range: ProgressRange; setRange: (r: ProgressRange) => void; repoWebBase: string | null;
}) {
  const tree = useMemo(() => buildTeamTree(progress, sessions, prs), [progress, sessions, prs]);
  const ranges: Array<{ id: ProgressRange; label: string }> = [
    { id: 'since-last-opened', label: 'Since last open' }, { id: 'today', label: 'Today' }, { id: '7d', label: '7 days' }, { id: 'all', label: 'All' },
  ];
  return (
    <section className="mc-pane" data-testid="mc-progress">
      <h2>Progress — what teams accomplished
        <span className="mc-range">{ranges.map(r => (
          <button key={r.id} aria-pressed={range === r.id} onClick={() => setRange(r.id)}>{r.label}</button>
        ))}</span>
      </h2>
      {tree.size === 0 && <p className="mc-empty">No agent activity in range.</p>}
      {[...tree.entries()].map(([project, rows]) => {
        const totalSessions = rows.reduce((a, r) => a + r.sessions, 0);
        return (
          <details className="mc-project" key={project} open>
            <summary className="mc-project-header">{project}<span className="mc-project-rollup">{plural(rows.length, 'team')} · {plural(totalSessions, 'session')}</span></summary>
            {rows.map(t => {
              const line = outcomeLine(t.byType);
              return (
                <div className="mc-team" key={`${project}-${t.agentType}`}>
                  <span className="mc-team-name">{t.agentType ?? 'unknown'}</span>
                  <span className="mc-team-sessions">{plural(t.sessions, 'session')}</span>
                  {line ? <div className="mc-outcome">{line}</div> : <div className="mc-outcome-empty">no outcomes captured</div>}
                  <div className="mc-obs-tail">
                    {t.prNumbers.length > 0 && (
                      <>{plural(t.prNumbers.length, 'PR')} · {t.prNumbers.map((n, i) => (
                        <React.Fragment key={n}>{i > 0 ? ' ' : ''}{repoWebBase ? <a className="mc-link" href={`${repoWebBase}/pull/${n}`} target="_blank" rel="noopener noreferrer">#{n}</a> : `#${n}`}</React.Fragment>
                      ))} · </>
                    )}
                    {t.total} obs
                  </div>
                </div>
              );
            })}
          </details>
        );
      })}
    </section>
  );
}

export function MissionControl() {
  const mc = useMissionControl();
  if (mc.loading) return <div className="mc-loading">Loading Mission Control…</div>;
  if (mc.error) return <div className="mc-error">Failed to load Mission Control: {mc.error}</div>;

  // Phase 1b: 4 panes. Velocity + spec/doc mining resolve when CLAUDE_MEM_PROJECT_ROOT
  // is set (else they degrade to labeled deferred notes). No LLM, read/mine only.
  const nextByProject = mc.nextSteps.reduce((acc, item) => {
    (acc[item.project] ||= []).push(item); return acc;
  }, {} as Record<string, typeof mc.nextSteps>);

  return (
    <div className="mission-control" data-testid="mission-control">
      <div className="mc-header"><button className="mc-refresh" onClick={mc.refresh}>Refresh</button></div>

      <AttentionPane items={mc.attention} ghAvailable={mc.ghAvailable} specMiningDeferred={mc.specMiningDeferred}
        escalationContext={mc.escalationContext} repoWebBase={mc.repoWebBase} defaultBranch={mc.defaultBranch} />

      <VelocityPane velocity={mc.velocity} />

      <ProgressPane progress={mc.progress} sessions={mc.progressSessions} prs={mc.progressPrs}
        range={mc.range} setRange={mc.setRange} repoWebBase={mc.repoWebBase} />

      <section className="mc-pane" data-testid="mc-next-steps">
        <h2>Suggested next steps <span className="mc-badge">Unsynthesized</span></h2>
        {mc.nextSteps.length === 0 && <p className="mc-empty">No next-steps captured yet.</p>}
        {Object.entries(nextByProject).map(([project, items]) => (
          <div className="mc-attention-group" key={project}>
            <h3>{project} ({items.length})</h3>
            <ul>{items.slice(0, 8).map(item => <li key={item.memorySessionId} className="mc-item">{item.text}</li>)}</ul>
            {items.length > 8 && <p className="mc-meta">+{items.length - 8} more</p>}
          </div>
        ))}
      </section>
    </div>
  );
}
