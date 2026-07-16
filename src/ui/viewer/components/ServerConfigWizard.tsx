import React, { useEffect, useState } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import {
  SERVER_MODELS, DEFAULT_WIZARD_MODEL, COST_WARNING, renderOutput, isCostlyModel, OutputFormat,
} from '../lib/wizard';

interface ServerConfig { provider: string; model: string; keyPresent: boolean; keySource: string | null; }
interface IngestStatus { lastObservationAt: number | null; countLastWindow: number; window: string; }

/** `serverContext` = full CURRENT + ingest block; false = worker helper (generator only). */
export function ServerConfigWizard({ serverContext }: { serverContext: boolean }) {
  const [current, setCurrent] = useState<ServerConfig | null>(null);
  const [ingest, setIngest] = useState<IngestStatus | null>(null);
  const [model, setModel] = useState(DEFAULT_WIZARD_MODEL);
  const [apiKey, setApiKey] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [format, setFormat] = useState<OutputFormat>('compose'); // Mark's default: Compose (TrueNAS)
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!serverContext) return;
    fetch(API_ENDPOINTS.SERVER_CONFIG).then(r => r.ok ? r.json() : null).then(setCurrent).catch(() => {});
    fetch(API_ENDPOINTS.INGEST_STATUS).then(r => r.ok ? r.json() : null).then(setIngest).catch(() => {});
  }, [serverContext]);

  const output = renderOutput({ provider: 'claude', model, apiKey }, format);
  const displayOutput = revealKey ? output : maskKey(output);

  const copy = async () => {
    await navigator.clipboard.writeText(output); // always the real value
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="wizard">
      {serverContext && (
        <>
          <div className="context-chip"><span className="context-dot" />This viewer — Collection server</div>
          <div className="subsection-label">CURRENT (read-only)</div>
          {current ? (
            <div className="current-config">
              <div>Provider <b>{current.provider}</b> · Model <b>{current.model}</b></div>
              <div>API key {current.keyPresent ? `set (${current.keySource})` : 'not set'}</div>
              <div className="ingest-line">{ingestLabel(ingest)}</div>
            </div>
          ) : <div className="current-config">— no data yet</div>}
          <p className="section-description">
            Set at container creation. Generate updated values below, then recreate the container to apply —
            live editing arrives with server auth (Phase 2).
          </p>
        </>
      )}

      <div className="subsection-label">GENERATE UPDATED CONFIG</div>
      <label className="form-field">Model
        <select value={model} onChange={e => setModel(e.target.value)} aria-describedby="cost-warning">
          {SERVER_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>
      {isCostlyModel(model) && <p id="cost-warning" className="cost-warning">⚠ {COST_WARNING}</p>}

      <label className="form-field">API key <span className="key-hint">(stays in your browser)</span>
        <span className="key-input">
          <input type={revealKey ? 'text' : 'password'} value={apiKey} placeholder="sk-ant-…" onChange={e => setApiKey(e.target.value)} />
          <button type="button" className="reveal-toggle" aria-pressed={revealKey} aria-label="Show API key"
            onClick={() => setRevealKey(r => !r)}>{revealKey ? 'Hide' : 'Reveal'}</button>
        </span>
      </label>

      <div className="output-toggle" role="tablist">
        <button type="button" role="tab" aria-selected={format === 'compose'} className={`cm-btn ${format === 'compose' ? 'cm-btn-primary' : ''}`} onClick={() => setFormat('compose')}>Compose</button>
        <button type="button" role="tab" aria-selected={format === 'env'} className={`cm-btn ${format === 'env' ? 'cm-btn-primary' : ''}`} onClick={() => setFormat('env')}>Env vars</button>
      </div>

      <div className="output-block">
        <pre>{displayOutput}</pre>
        <button type="button" className="copy-btn" onClick={copy} aria-live="polite">{copied ? 'Copied ✓' : 'Copy'}</button>
      </div>

      <ol className="apply-steps">
        <li>Open the claude-mem app in TrueNAS → <b>Edit</b> → Environment (or your compose’s <code>environment:</code>).</li>
        <li className="gotcha">Paste the block above. Use <code>CLAUDE_MEM_SERVER_MODEL</code>, not <code>CLAUDE_MEM_MODEL</code> (the latter is ignored by the server).</li>
        <li>Save and <b>recreate/restart</b> the container so it picks up the new env.</li>
        <li className="gotcha">Verify ingest for real: trigger a capture, then confirm a new observation appears — <code>/healthz</code> returning 200 is not proof of capture.</li>
      </ol>
    </div>
  );
}

function maskKey(output: string): string {
  // Match the whole value to end-of-line (not \S+, which stops at the first
  // space and would mangle the multi-word "<paste your key>" placeholder into
  // "sk-ant-… your key>"). A real key has no spaces, so .+ captures it fully.
  return output.replace(/(ANTHROPIC_API_KEY[=:]\s*)(.+)/, (_m, p1, val) =>
    val === '<paste your key>' ? `${p1}${val}` : `${p1}sk-ant-…`);
}
function ingestLabel(s: IngestStatus | null): string {
  if (!s || s.lastObservationAt === null) return '— no data yet';
  const ageMin = Math.round((Date.now() / 1000 - s.lastObservationAt) / 60);
  if (s.countLastWindow > 0) return `✓ capturing — last observation ${ageMin} min ago`;
  return `✗ no observations in ${s.window}`;
}
