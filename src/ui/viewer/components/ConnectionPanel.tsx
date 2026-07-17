import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Settings } from '../types';
import {
  ConnectionProfile, LOCAL_WORKER_ID, PresetKind, parseConnections, serializeConnections,
  withLocalWorker, newProfileId, presetUrl,
} from '../lib/connections';
import { useConnectionTest } from '../hooks/useConnectionTest';
import { TestStepper } from './TestStepper';

interface Props {
  settings: Settings;
  onSave: (next: Settings) => void;   // routes through useSettings → POST /api/settings
  isSaving: boolean;
}

type EditorState = { mode: 'closed' } | { mode: 'add'; preset: PresetKind } | { mode: 'edit'; id: string };

export function ConnectionPanel({ settings, onSave, isSaving }: Props) {
  const profiles = useMemo(
    () => withLocalWorker(parseConnections(settings.CLAUDE_MEM_CONNECTIONS)),
    [settings.CLAUDE_MEM_CONNECTIONS],
  );
  const activeId = settings.CLAUDE_MEM_ACTIVE_CONNECTION || LOCAL_WORKER_ID;

  const [focusedId, setFocusedId] = useState<string>(activeId);
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState<string>('');
  const [testedMarks, setTestedMarks] = useState<Record<string, 'pass' | 'fail'>>({});
  const [testedId, setTestedId] = useState<string | null>(null);
  const test = useConnectionTest();

  const focused = profiles.find(p => p.id === focusedId) ?? profiles[0];
  const isLocalWorker = (p: ConnectionProfile) => p.id === LOCAL_WORKER_ID;

  // Run the probe AND record which profile it targets, so the ephemeral ✓/✗
  // marker lands on the profile that was actually tested — not on whatever row
  // happens to be `focused`. This matters for the Add flow, where the draft
  // (a new, not-yet-saved id) is under test while `focused` is still the prior
  // row (e.g. the Local worker), which must never be stamped with a result.
  const runTest = (profile: ConnectionProfile) => { setTestedId(profile.id); test.runTest(profile); };

  const persist = (nextProfiles: ConnectionProfile[], nextActiveId: string) => {
    onSave({ ...settings, CLAUDE_MEM_CONNECTIONS: serializeConnections(nextProfiles), CLAUDE_MEM_ACTIVE_CONNECTION: nextActiveId });
  };

  const saveProfile = (profile: ConnectionProfile) => {
    const exists = profiles.some(p => p.id === profile.id);
    const next = exists ? profiles.map(p => (p.id === profile.id ? profile : p)) : [...profiles, profile];
    persist(next, activeId); // Save does NOT activate (handoff §4.3)
    setEditor({ mode: 'closed' });
  };

  const activate = (profile: ConnectionProfile) => {
    persist(profiles, profile.id);
    setFocusedId(profile.id); // keep the action-bar selection (aria-checked) on the now-active row
    setToast(`✓ Activated “${profile.name}”. New captures use this connection.`);
    setTimeout(() => setToast(''), 4000);
    test.reset();
  };

  // Save the drafted profile AND make it active in a single write. Used by the
  // editor's "Activate this connection" — a bare activate(draft) would set the
  // active id to a profile not yet in the list (ConnectionStore would then fall
  // back to the Local worker), so save-then-activate must be atomic.
  const saveAndActivate = (profile: ConnectionProfile) => {
    const exists = profiles.some(p => p.id === profile.id);
    const next = exists ? profiles.map(p => (p.id === profile.id ? profile : p)) : [...profiles, profile];
    persist(next, profile.id);
    setFocusedId(profile.id); // select the now-active row so aria-checked tracks it
    setToast(`✓ Activated “${profile.name}”. New captures use this connection.`);
    setTimeout(() => setToast(''), 4000);
    setEditor({ mode: 'closed' });
    test.reset();
  };

  // Move roving focus between the radiogroup rows with arrow keys (handoff §8).
  const onRadiogroupKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const idx = Math.max(0, profiles.findIndex(p => p.id === focusedId));
    const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    const next = profiles[(idx + dir + profiles.length) % profiles.length];
    setFocusedId(next.id);
    const rows = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    rows[(idx + dir + profiles.length) % profiles.length]?.focus();
  };

  const deleteProfile = (id: string) => {
    persist(profiles.filter(p => p.id !== id), activeId);
    setConfirmDeleteId(null);
    if (focusedId === id) setFocusedId(activeId);
  };

  // Ephemeral ✓/✗ marker for the tested profile after a test run (handoff §4.1).
  useEffect(() => {
    if (test.result && testedId) {
      setTestedMarks(m => ({ ...m, [testedId]: test.result!.ok ? 'pass' : 'fail' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [test.result]);

  // Scope Esc to the inline delete-confirm so it dismisses the confirm rather
  // than bubbling to the modal's window-level Escape→onClose.
  useEffect(() => {
    if (!confirmDeleteId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setConfirmDeleteId(null); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirmDeleteId]);

  return (
    <div className="connection-panel">
      <div className="context-chip"><span className="context-dot" />This viewer — Local worker</div>

      {editor.mode !== 'closed' ? (
        <ProfileEditor
          initial={editor.mode === 'edit' ? profiles.find(p => p.id === editor.id)! : blankProfile(editor.preset)}
          onCancel={() => { setEditor({ mode: 'closed' }); test.reset(); }}
          onSave={saveProfile}
          onActivate={saveAndActivate}
          test={test}
          runTest={runTest}
        />
      ) : (
        <>
          <div className="subsection-label">ACTIVE</div>
          <ProfileRow profile={profiles.find(p => p.id === activeId)!} active focused={focusedId === activeId}
            mark={testedMarks[activeId]} onFocus={setFocusedId} />

          <div className="subsection-label">PROFILES</div>
          <div className="profile-list" role="radiogroup" aria-label="Active connection" onKeyDown={onRadiogroupKeyDown}>
            {profiles.map(p => (
              <ProfileRow key={p.id} profile={p} active={p.id === activeId} focused={focusedId === p.id}
                mark={testedMarks[p.id]} onFocus={setFocusedId} inGroup />
            ))}
          </div>

          {profiles.length === 1 && (
            <p className="section-description empty-hint">
              You're capturing locally. Add a connection to send captures to a server on your LAN or Tailscale.
            </p>
          )}

          <div className="connection-actions">
            <PresetMenu onPick={(preset) => { setEditor({ mode: 'add', preset }); test.reset(); }} />
            <button type="button" className="cm-btn" disabled={isLocalWorker(focused)}
              onClick={() => setEditor({ mode: 'edit', id: focused.id })}>Edit</button>
            <button type="button" className="cm-btn" disabled={isLocalWorker(focused) || test.running}
              onClick={() => runTest(focused)}>Test</button>
            <button type="button" className="cm-btn cm-btn-danger"
              disabled={isLocalWorker(focused) || focused.id === activeId}
              title={isLocalWorker(focused) ? "The local worker is the built-in fallback and can't be deleted."
                : focused.id === activeId ? 'Switch to another connection before deleting this one.' : undefined}
              onClick={() => setConfirmDeleteId(focused.id)}>Delete</button>
          </div>

          {isLocalWorker(focused) && !test.result && !test.running && (
            <p className="section-description">Local worker — captures to this machine. Nothing to test.</p>
          )}

          {(test.running || test.result || test.error) && !isLocalWorker(focused) && (
            <TestStepper result={test.result} running={test.running} error={test.error}
              onActivate={() => activate(focused)}
              onEditKey={() => setEditor({ mode: 'edit', id: focused.id })}
              onRetry={() => runTest(focused)}
              onSaveWithoutActivating={() => test.reset()} />
          )}

          {confirmDeleteId && (
            <div className="delete-confirm">
              Delete “{profiles.find(p => p.id === confirmDeleteId)?.name}”? This removes the saved profile and its key.
              <button type="button" className="cm-btn" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button type="button" className="cm-btn cm-btn-danger" onClick={() => deleteProfile(confirmDeleteId)}>Delete</button>
            </div>
          )}

          {toast && <div className="activation-toast" role="status">{toast}</div>}
        </>
      )}
      {isSaving && <span className="saving-hint">Saving…</span>}
    </div>
  );
}

function blankProfile(preset: PresetKind): ConnectionProfile {
  return {
    id: newProfileId(),
    name: '',
    runtime: preset === 'local' ? 'worker' : 'server',
    url: presetUrl(preset),
    apiKey: '',
    projectId: '',
  };
}

function ProfileRow({ profile, active, focused, mark, onFocus, inGroup = false }: {
  profile: ConnectionProfile; active: boolean; focused: boolean; mark?: 'pass' | 'fail';
  onFocus: (id: string) => void; inGroup?: boolean;
}) {
  const subtitle = profile.runtime === 'worker' ? 'Captures to this machine — no server' : profile.url;
  // In the radiogroup, aria-checked tracks the action-bar SELECTION (focused),
  // and only the selected row is a tab stop (roving tabindex). The `· active`
  // tag still conveys the running connection. The standalone ACTIVE summary row
  // (inGroup=false) is a plain button, kept out of the tab order.
  return (
    <button type="button"
      role={inGroup ? 'radio' : undefined}
      aria-checked={inGroup ? focused : undefined}
      tabIndex={inGroup ? (focused ? 0 : -1) : -1}
      className={`profile-row ${focused ? 'focused' : ''}`} onClick={() => onFocus(profile.id)}>
      <span className={`radio-glyph ${active ? 'on' : ''}`} aria-hidden>{active ? '◉' : '◯'}</span>
      <span className="profile-main">
        <span className="profile-name">{profile.name || '(unnamed)'}</span>
        <span className="profile-subtitle">{subtitle}</span>
      </span>
      <span className="profile-badges">
        <span className="type-badge">{profile.runtime}</span>
        {active && <span className="active-tag">· active</span>}
        {profile.id === LOCAL_WORKER_ID && <span className="default-tag">· default</span>}
        {mark === 'pass' && <span className="tested-mark pass">✓ tested</span>}
        {mark === 'fail' && <span className="tested-mark fail">✗ failed</span>}
      </span>
    </button>
  );
}

function PresetMenu({ onPick }: { onPick: (preset: PresetKind) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const options: [PresetKind, string, string][] = [
    ['local', 'Local worker', 'Capture to this machine only.'],
    ['lan', 'LAN', 'A server on your home network.'],
    ['tailscale', 'Tailscale', 'A server over your tailnet, from anywhere.'],
    ['custom', 'Custom', 'Enter the full URL yourself.'],
  ];

  // Dismiss on outside-click and on Esc — and stop the Esc from bubbling to the
  // modal's window-level Escape→onClose (else opening the preset menu and
  // hitting Esc would close the whole Settings modal).
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [open]);

  return (
    <div className="preset-menu" ref={menuRef}>
      <button type="button" className="cm-btn cm-btn-primary" onClick={() => setOpen(o => !o)}>+ Add connection</button>
      {open && (
        <div className="preset-options" role="menu">
          {options.map(([kind, label, help]) => (
            <button key={kind} type="button" className="preset-option" role="menuitem"
              onClick={() => { setOpen(false); onPick(kind); }}>
              <span className="preset-label">{label}</span>
              <span className="preset-help">{help}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileEditor({ initial, onCancel, onSave, onActivate, test, runTest }: {
  initial: ConnectionProfile; onCancel: () => void; onSave: (p: ConnectionProfile) => void;
  onActivate: (p: ConnectionProfile) => void;
  test: ReturnType<typeof useConnectionTest>; runTest: (p: ConnectionProfile) => void;
}) {
  const [draft, setDraft] = useState<ConnectionProfile>(initial);
  const [revealKey, setRevealKey] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);
  const isServer = draft.runtime === 'server';
  const set = (patch: Partial<ConnectionProfile>) => setDraft(d => ({ ...d, ...patch }));

  // Scope Esc to the editor so the modal's global Esc (ContextSettingsModal window
  // listener) doesn't fire. A React stopPropagation alone won't stop a native
  // window-level listener, so also stopImmediatePropagation on the native event
  // (Task 12.2 option a).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); onCancel(); }
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); if (isServer && !test.running) runTest(draft); }
  };

  return (
    <div className="profile-editor" onKeyDown={onKeyDown}>
      <div className="subsection-label">{initial.name ? 'Edit connection' : 'Add connection'}</div>

      <label className="form-field"><span className="form-field-label">Name</span>
        <input value={draft.name} placeholder="e.g. NAS (Tailscale)" onChange={e => set({ name: e.target.value })} />
      </label>

      <label className="form-field"><span className="form-field-label">Runtime</span>
        <select value={draft.runtime} onChange={e => set({ runtime: e.target.value as 'worker' | 'server' })}>
          <option value="server">Server</option>
          <option value="worker">Local worker</option>
        </select>
      </label>

      {isServer && (
        <>
          <label className="form-field"><span className="form-field-label">Server URL</span>
            <input value={draft.url} placeholder="https://nas.tail1234.ts.net:37700" onChange={e => set({ url: e.target.value })} />
          </label>
          <label className="form-field"><span className="form-field-label">API key</span>
            <span className="key-input">
              <input ref={keyRef} type={revealKey ? 'text' : 'password'} value={draft.apiKey} placeholder="Server API key"
                onChange={e => set({ apiKey: e.target.value })} />
              <button type="button" className="reveal-toggle" aria-pressed={revealKey} aria-label="Show API key"
                onClick={() => setRevealKey(r => !r)}>{revealKey ? 'Hide' : 'Reveal'}</button>
            </span>
          </label>
          <label className="form-field"><span className="form-field-label">Project ID</span>
            <input value={draft.projectId} placeholder="Project to capture into" onChange={e => set({ projectId: e.target.value })} />
          </label>
        </>
      )}

      <div className="editor-actions">
        {isServer && <button type="button" className="cm-btn cm-btn-primary" disabled={test.running} onClick={() => runTest(draft)}>Test connection</button>}
        <button type="button" className="cm-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="cm-btn" onClick={() => onSave(draft)} disabled={!draft.name.trim()}>Save</button>
      </div>

      {isServer && (test.running || test.result || test.error) && (
        <TestStepper result={test.result} running={test.running} error={test.error}
          onActivate={() => onActivate(draft)} onEditKey={() => keyRef.current?.focus()} onRetry={() => runTest(draft)}
          onSaveWithoutActivating={() => onSave(draft)} />
      )}
    </div>
  );
}
