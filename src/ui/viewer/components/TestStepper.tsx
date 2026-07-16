import React from 'react';
import type { ProbeResult, StepResult } from '../hooks/useConnectionTest';

const STEP_LABEL: Record<StepResult['step'], string> = {
  reachable: 'Reachable', authenticated: 'Authenticated', project: 'Project valid',
};
const GLYPH: Record<StepResult['status'], string> = { pass: '✓', warn: '!', fail: '✗', skipped: '·' };

interface Props {
  result: ProbeResult | null;
  running: boolean;
  error: string | null;
  onActivate: () => void;
  onEditKey: () => void;
  onRetry: () => void;
  onSaveWithoutActivating: () => void;
}

export function TestStepper({ result, running, error, onActivate, onEditKey, onRetry, onSaveWithoutActivating }: Props) {
  return (
    <div className="test-stepper" aria-live="polite">
      {result ? result.steps.map(s => (
        <div key={s.step} className={`test-step ${s.status}`}>
          <span className="step-glyph" aria-hidden>{GLYPH[s.status]}</span>
          <span className="step-label">{STEP_LABEL[s.step]}</span>
          <span className="step-message">{s.message}</span>
        </div>
      )) : (
        <div className="test-step running"><span className="step-glyph" aria-hidden>⟳</span><span className="step-label">Testing…</span></div>
      )}

      {error && <div className="test-banner fail">✗ Test could not run: {error}</div>}

      {result && result.ok && (
        <div className="test-banner pass">
          <span>✓ Connection verified{result.steps.some(s => s.status === 'warn') ? ' · 1 note' : ''}. Ready to activate.</span>
          <button type="button" className="cm-btn cm-btn-primary" onClick={onActivate}>Activate this connection</button>
        </div>
      )}

      {result && !result.ok && (
        <div className="test-banner fail">
          <span>✗ Not activated — {failTitle(result)}. {failBody(result)}</span>
          <span className="banner-actions">
            <button type="button" className="cm-btn" onClick={onEditKey}>Edit key</button>
            <button type="button" className="cm-btn" onClick={onRetry}>Retry test</button>
            <button type="button" className="cm-btn" onClick={onSaveWithoutActivating}>Save without activating</button>
          </span>
        </div>
      )}
    </div>
  );
}

function failedStep(r: ProbeResult): StepResult | undefined { return r.steps.find(s => s.status === 'fail'); }
function failTitle(r: ProbeResult): string {
  const f = failedStep(r);
  if (!f) return 'test failed';
  if (f.step === 'reachable') return 'can’t reach server';
  if (f.step === 'authenticated') return 'authentication failed';
  return 'project not usable';
}
function failBody(r: ProbeResult): string { return failedStep(r)?.message ?? ''; }
