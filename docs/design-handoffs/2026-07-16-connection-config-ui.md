# Design Handoff — Connection Profiles + Server-Config Wizard (Settings UI, Phase 1)

- **Date:** 2026-07-16
- **Author:** Designer
- **Status:** For Planner. UX locked pending Mark sign-off on the two open questions in §13.
- **Consumes (source of truth):** `docs/superpowers/specs/2026-07-16-connection-config-ui-design.md` (approved; D1–D6, phasing, the seam) — this handoff owns the UX only, not the architecture.
- **Extends (visual language):** the existing viewer Settings modal — `src/ui/viewer/components/ContextSettingsModal.tsx` + the inline CSS in `src/ui/viewer-template.html`. There was **no** prior `docs/design-handoffs/` package; this establishes the directory. There is no Claude Design mockup for this surface — ASCII wireframes below are the reference, annotated with the real class names and tokens they reuse.

## `follows / extends / deviates`

- **follows** — the Settings modal's whole idiom: `CollapsibleSection`, `FormField` (label + `?` tooltip), `ToggleSwitch`, the `.form-field input/select` control styling, the `.modal-footer` save flow with `✓ / ✗` status strings, and the full CSS custom-property token set in `viewer-template.html` `:root`.
- **extends** — adds one **context-aware top section** to the Settings modal (Connection *or* Server), plus three new *composite* patterns built only from existing primitives: the **profile list row** (radio + badges), the **3-step test stepper**, and the **wizard output block**. No new modal, no new route surface for the user — everything lives inside the Settings modal that already opens from the Header.
- **deviates** — none from the spec. Two small **corrections against the current code** are called out in §12 (a phantom-token drift in the existing footer that new components must not inherit, and a model-id naming mismatch the wizard must sidestep). Two **enhancements beyond the spec's letter** are flagged inline: a `warn` state for "new project" in the test result (§5), and a "Save without activating" escape hatch for unreachable profiles (§4/§5). Both are additive and consistent with D3.

---

## 1. Where this lives

The user reaches all of this through the **existing Settings modal** (`ContextSettingsModal`), opened from the Header's context-preview toggle (`App.tsx:104`). No new entry point.

Inside the modal's right-hand **settings column** (`.settings-column`, the `30fr` pane of `.modal-body`), add **one new `CollapsibleSection` at the very top**, above "Loading". Its title and body are **context-aware** (D5):

| Detected role | Section title | Body |
|---|---|---|
| `worker` (local) | **Connection** | Connection profiles (§4) + test-before-activate (§5) |
| `server` | **Server configuration** | Read-only current generation config + ingest status + the wizard (§6) |

`defaultOpen={true}` — it is the highest-value new surface and the one a first-run user needs. All other sections (Loading, Display, Advanced) keep their current order and default states.

**Layout decision (recorded):** everything renders **inline in the right settings column**, exactly like the Advanced section. I considered mirroring the test log / wizard output into the left terminal pane (`.preview-content` is literally a dark monospace surface and is idle while you configure a connection). I **deferred** that: it couples two panes and overloads the "context preview" mental model, for a pane the user isn't looking at mid-config. The column is ~360px; the two wide artifacts (test log, env block) are monospace and live inside their own `overflow-x: auto` container, so width is not a blocker. If Planner wants the roomier read later, the left-pane mirror is a clean Phase-1.5 add — not required now.

---

## 2. Design-system compliance

### 2.1 Tokens to reuse (these exist in `viewer-template.html` `:root` / `[data-theme]`)

| Purpose | Token | Light | Dark |
|---|---|---|---|
| Section/card surface | `--color-bg-card` | `#ffffff` | `#252320` |
| Input surface | `--color-bg-input` | `#ffffff` | `#252320` |
| Hover surface | `--color-bg-card-hover` | `#f6f8fa` | `#2d2a26` |
| Inset/monospace surface | `--color-bg-stat` / `--color-bg-tertiary` | `#f6f8fa` / `#f0f0f0` | `#252320` / `#1f1d1a` |
| Primary text | `--color-text-primary` | `#2b2520` | `#dcd6cc` |
| Muted text | `--color-text-muted` | `#8f8a7e` | `#7a7266` |
| Accent (primary/active/focus) | `--color-accent-primary` | `#0969da` | `#58a6ff` |
| Success (pass) | `--color-accent-success` | `#1a7f37` | `#16c60c` |
| Error (fail) | `--color-accent-error` | `#d1242f` | `#e74856` |
| Warn (amber — reuse summary accent) | `--color-accent-summary` | `#9a6700` | `#d4b888` |
| Border | `--color-border-primary` | `#d0d7de` | `#3a3834` |
| Focus ring | `box-shadow: 0 0 0 3px rgba(9,105,218,0.1)` (as `.form-field *:focus` already uses) | | |

Radii: **6px** for controls/rows/output block (matches `.form-field input`), **11px** for the toggle, **12px** only for the modal shell. Motion: reuse the existing `0.15s ease` / `0.2s cubic-bezier(0.4,0,0.2,1)` transitions; do not introduce new easings.

### 2.2 New tokens

**Aim: zero.** The four status colors map to existing accents (success/error/summary-amber/muted). One **optional** convenience is a status-tint background for the test banners — if Planner wants tinted banners rather than left-border + icon, add:

```
--color-status-pass-bg:  rgba(26,127,55,0.10);   /* light */  rgba(22,198,12,0.12) dark
--color-status-fail-bg:  rgba(209,36,47,0.10);   /* light */  rgba(231,72,86,0.12) dark
--color-status-warn-bg:  rgba(154,103,0,0.10);   /* light */  rgba(212,184,136,0.12) dark
```

These are tints of tokens that already exist (they mirror the existing `--color-type-badge-bg` pattern of `rgba(accent, 0.12)`). Justification for `tokens.md`: they are *derived*, not novel hues; they keep the pass/fail/warn banners theme-correct without hardcoding rgba in components. If Planner prefers icon-plus-left-border banners (no fill), **skip these entirely** — no new tokens at all.

### 2.3 Drift to avoid (see §12.1)

The existing `.modal-footer` save button references tokens that **do not exist** (`--accent-color`, `--success-color`, `--modal-border`, …) and silently falls back to generic hex (`#3b82f6`, `#22c55e`). **New components must use the real `--color-accent-*` tokens above**, not those fallbacks, or the Connection panel's blue won't match the rest of the app.

---

## 3. Context-aware rendering (D5) + the context signal (R2)

The panel asks the worker its own role and renders one of two bodies. **Do not guess or probe** — read the authoritative role from the worker (R2).

**Context signal.** At the top of the section body, a small muted context chip (styled like `.section-description` / a badge) states which viewer this is, so the two states are never ambiguous:

- worker → `● This viewer — Local worker`
- server → `● This viewer — Collection server`

The leading dot uses `--color-accent-primary`. The chip is informational, not a control.

**Ambiguous / probe-unavailable fallback (R2).** If the role endpoint is missing or returns `unknown`, render a **manual segmented toggle** in place of the chip:

```
Viewing:  [ Local worker • ]  [ Server ]
```

so the user forces the correct body. Default selection = `worker` (the safe, common case). Persist the manual choice in `localStorage` only (it's a display preference, not config).

---

## 4. Surface 1 — Connection panel (worker context)

### 4.1 Anatomy (default state, ≥1 server profile present)

```
┌─ Connection ───────────────────────────────────────── ⌄ ┐   ← CollapsibleSection header
│  ● This viewer — Local worker                            │   ← context chip (§3)
│                                                          │
│  ACTIVE                                                  │   ← .subsection-label idiom
│  ┌──────────────────────────────────────────────────┐   │
│  │ ◉  NAS (Tailscale)              [server] ✓ tested │   │   ← active profile summary row
│  │    https://nas.tail1234.ts.net:37700              │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  PROFILES                                                │   ← .subsection-label
│  ┌──────────────────────────────────────────────────┐   │
│  │ ◯  Local worker            [worker]  · default    │   │   ← radio rows (radiogroup)
│  │    Captures to this machine — no server           │   │
│  ├──────────────────────────────────────────────────┤   │
│  │ ◯  NAS (LAN)               [server]               │   │
│  │    http://nas.lan:37700                           │   │
│  ├──────────────────────────────────────────────────┤   │
│  │ ◉  NAS (Tailscale)         [server]  · active     │   │
│  │    https://nas.tail1234.ts.net:37700              │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  [ + Add connection ]   [ Edit ]  [ Test ]  [ Delete ]   │   ← row-scoped action bar
└──────────────────────────────────────────────────────────┘
```

- **Radio group** — one active connection (D2). Selecting a radio does **not** activate immediately; it only *focuses* that profile for the action bar. **Activation happens through Test → Activate** (§5), never by a bare radio click, so a user can never silently switch to a broken connection. The currently-active profile shows the filled radio `◉` + a `· active` tag; others show `◯`.
- **Runtime badge** — `[worker]` / `[server]` pill, reusing the `.type-badge` visual (`--color-type-badge-bg` / `-text`). Makes the runtime explicit at a glance.
- **Ephemeral test marker** — `✓ tested` (green) / `✗ failed` (red) appears on a row **only after it was tested this session**. See §4.4 for the deliberate no-background-probe decision.
- **Subtitle** — the URL for server profiles; `Captures to this machine — no server` for the worker profile.
- **Action bar** — actions apply to the **focused** (radio-selected) profile:
  - `+ Add connection` — always enabled → preset picker (§4.2).
  - `Edit` — opens the editor (§4.3) for the focused profile. Disabled when the focused profile is **Local worker** (nothing to edit — it has no URL/key).
  - `Test` — runs the probe (§5) for the focused profile. Disabled for **Local worker** (no server to test).
  - `Delete` — removes the focused profile. **Disabled (with tooltip) for Local worker** (Q1: undeletable default) and for the **currently active** profile (must switch away first). Confirm inline before deleting (§4.5).

### 4.2 Add flow — presets (D2)

`+ Add connection` opens a compact preset picker (radio cards or a segmented control) that **pre-fills the URL** so the user isn't typing scheme/port from memory:

| Preset | Pre-fills `url` | `runtime` | Copy under the option |
|---|---|---|---|
| **Local worker** | *(none — clears server keys)* | `worker` | Capture to this machine only. |
| **LAN** | `http://<hostname>.lan:37700` | `server` | A server on your home network. |
| **Tailscale** | `https://<host>.<tailnet>.ts.net:37700` | `server` | A server over your tailnet, from anywhere. |
| **Custom** | `http://` | `server` | Enter the full URL yourself. |

The `<hostname>` / `<host>.<tailnet>` fragments are **editable placeholders** (shown selected/highlighted in the URL field so the user types over them). `37700` matches `DEFAULT_SETTINGS.CLAUDE_MEM_WORKER_PORT`. Picking a preset drops the user straight into the editor (§4.3) with `url` pre-filled and the cursor on `Name`.

### 4.3 Profile editor

Inline form (expands in place of the list; it is not a nested modal), built from `FormField` primitives:

```
┌─ Add connection ─────────────────────────────────────────┐
│  Name          [ NAS (Tailscale)                       ]  │
│  Runtime       [ Server ▾ ]        (worker | server)      │
│  Server URL    [ https://nas.tail1234.ts.net:37700     ]  │   ← hidden when runtime = worker
│  API key       [ ••••••••••••••••••••  ] [ 👁 reveal ]    │   ← type=password + reveal toggle
│  Project ID    [ my-project                            ]  │
│                                                          │
│  [ Test connection ]              [ Cancel ]  [ Save ]   │
└──────────────────────────────────────────────────────────┘
```

Field rules:
- **Name** — required, unique among profiles. Free text. Placeholder: `e.g. NAS (Tailscale)`.
- **Runtime** — `Server` / `Local worker`. Choosing `Local worker` hides URL/key/project (they don't apply) and turns the editor into a name-only form.
- **Server URL** — required for `server`. Placeholder shows the preset's template. Light client-side shape check (scheme + host) feeds the `bad_url` test copy.
- **API key** — `type="password"` (masked, matching the Gemini/OpenRouter key fields at `ContextSettingsModal.tsx:369` / `:409`), plus a **reveal toggle** (eye icon, `aria-pressed`). Placeholder: `Server API key`. **Never rendered back from the server** (§7 — write-only).
- **Project ID** — required for `server`. Placeholder: `Project to capture into`. New/unknown project ids are allowed (they surface as a *warn*, not a fail — §5.3).

**Save behavior:** `Save` persists the profile into `CLAUDE_MEM_CONNECTIONS` via the store seam. Saving does **not** activate. The primary CTA is `Test connection` — see §5 for how test → activate chains.

### 4.4 Deliberate decision — no background probing of every profile

Profiles are **not** auto-tested on modal open. Rationale (state this to Mark): a `NAS (Tailscale)` profile is legitimately unreachable when you're off the tailnet; a `NAS (LAN)` profile is unreachable when you're away from home. Probing all of them on open would paint healthy profiles with alarming red dots and add latency. So the list shows **only** the authoritative `active` state and any **ephemeral** `✓/✗` marker from a test run *this session*. Reachability is verified on demand, at the moment it matters (before activating). This is the correct read of D3 — "test *before activate*," not "monitor continuously."

### 4.5 Delete confirmation

Inline, not a separate modal (keeps the one-modal idiom):

```
Delete “NAS (LAN)”?  This removes the saved profile and its key.   [ Cancel ]  [ Delete ]
```

`Delete` here uses `--color-accent-error`. Deleting a non-active profile is immediate on confirm; the active and default(worker) profiles can't reach this state (button disabled per §4.1).

### 4.6 States

| State | Presentation |
|---|---|
| **First run / empty** | `CLAUDE_MEM_CONNECTIONS` is seeded with the undeletable **Local worker** (active). Under PROFILES, a one-line hint: *"You're capturing locally. Add a connection to send captures to a server on your LAN or Tailscale."* with the `+ Add connection` button as the visual focal point. (See Q1 — Local worker always present.) |
| **Loading** | While settings load (`useSettings` fetch in flight), show 2–3 skeleton rows using `--color-skeleton-base/-highlight` (the pattern already tokenized). Section header renders immediately. |
| **Saving** | Reuse footer `Saving…` + `✓ Saved` flow. The section's own `Save` disables during the write. |
| **Save error** | Footer `✗ Error: …` (existing `useSettings` behavior). If the allow-list rejects the new keys, surface `✗ Error: connection settings not accepted` — see §12.2 (Planner must extend the allow-list or this is the failure mode). |
| **Activated** | Active row updates to `◉ · active`; a transient toast-line in the section: `✓ Activated “NAS (Tailscale)”. New captures use this connection.` |

---

## 5. Surface 2 — Test-before-activate (THE interaction) (D3)

This is the feature's reason to exist — it converts the silent 11-day fallback into a loud, legible failure. Design goal: **the user always knows *which* of the three things is wrong**, so a bad key reads as "auth failed," never a generic "can't connect."

### 5.1 The 3-step stepper

Triggered by `Test connection` (editor) or `Test` (action bar). Renders a vertical stepper directly below the editor / focused row:

```
Testing “NAS (Tailscale)”…

  ✓  Reachable        Server responded (200) in 42 ms.
  ⟳  Authenticated    Checking the API key…
  ·  Project valid    Waiting…

           [ Cancel ]
```

Steps, in order, short-circuit on the first hard failure:

1. **Reachable** — `GET {url}/healthz` → 200.
2. **Authenticated** — a scoped, read-only call with the key → 200 vs 401/403. **Variant-detecting** (verified in code): try the Postgres server-beta's `GET /v1/connect` first; on **404** fall back to the local worker's `GET /v1/projects`. Both-404 = **incompatible server** ("No compatible claude-mem server at this URL") — **never** a key error. A 404 here must not read as "the server rejected the API key."
3. **Project valid** — the `projectId` is usable on that server, using the endpoint for the matched variant: server-beta → `GET /v1/projects/:id/jobs`, worker → `GET /v1/projects/:id` (each: 200 ok / 404 project-not-found → warn / 403 → fail).

### 5.2 Per-step visual states

| State | Glyph | Color token | When |
|---|---|---|---|
| `idle` | `·` | `--color-text-muted` | not started |
| `running` | `⟳` (spinner) | `--color-accent-primary` | in flight (client-side, while awaiting response) |
| `pass` | `✓` | `--color-accent-success` | step succeeded |
| `warn` | `!` | `--color-accent-summary` (amber) | succeeded with a non-blocking caveat (§5.3) |
| `fail` | `✗` | `--color-accent-error` | step failed — carries the specific message |
| `skipped` | `·` (dim) | `--color-text-muted` | a prior step hard-failed; this one wasn't run |

Each step shows a one-line message to its right (see copy deck §5.4). The stepper is an `aria-live="polite"` region so each result is announced.

### 5.3 Overall result → what the user can do next

**All pass (or pass+warn):**
```
┌ ✓ Connection verified ────────────────────────────────┐
│ Ready to activate.                                    │
│                            [ Activate this connection ]│
└───────────────────────────────────────────────────────┘
```
`Activate` writes the profile's values into the 4 canonical keys (D6) and marks it active. Banner uses success accent (+ optional `--color-status-pass-bg`).

**Pass + warn (new project):**
```
┌ ✓ Connection verified · 1 note ───────────────────────┐
│ Project “my-project” is new — it’ll be created on the │
│ first capture.                                        │
│                            [ Activate this connection ]│
└───────────────────────────────────────────────────────┘
```
> **Enhancement beyond the spec.** The spec says "project valid." Real collection servers create a project on first write, so an *unknown* project id is normal, not an error. Distinguishing `warn` (new project, still activatable) from `fail` (forbidden / blank) avoids blocking a legitimate first-time setup. If Mark wants unknown-project to hard-block instead, collapse `warn`→`fail` for `project_will_be_created`; the stepper supports either.

**Any hard fail:**
```
┌ ✗ Not activated — authentication failed ──────────────┐
│ The server rejected the API key (401). Double-check   │
│ the key and try again.                                │
│              [ Edit key ]  [ Retry test ]  [ Save without activating ] │
└───────────────────────────────────────────────────────┘
```
- `Activate` is **absent/disabled** on any hard fail — you cannot activate a broken connection (this is the whole point of D3).
- The banner names the **failed step** in its title (`reachable`→"can't reach server", `authenticated`→"authentication failed", `project`→"project not usable"), and the body carries the specific remediation.
- **`Save without activating`** (enhancement): lets the user save a profile they can't reach *right now* (e.g. a Tailscale profile configured while off the tailnet) without forcing activation. It saves the profile but keeps the current active connection. Clearly distinct from Activate. If Mark prefers strictness, drop it — but it prevents a real dead-end during setup.

### 5.4 Copy — per step, per code (deterministic mapping)

Copy is keyed off the machine-stable `code` in the response (§5.5), so the message is specific, not generic.

**Step 1 — Reachable**
| `code` | Message |
|---|---|
| `ok` | `Server responded ({http}) in {latencyMs} ms.` |
| `unreachable` | `Couldn’t reach {host}. Is the server running and on this network?` |
| `timeout` | `{host} didn’t respond in {timeout}s. Check the address and that it’s reachable from here.` |
| `bad_url` | `That doesn’t look like a valid URL. Expected e.g. http://nas.lan:37700.` |
| `tls_error` | `Reached {host} but its TLS certificate was rejected.` |
| `not_claude_mem` | `Reached {host}, but it doesn’t look like a claude-mem server.` |

**Step 2 — Authenticated**
| `code` | Message |
|---|---|
| `ok` | `API key accepted.` |
| `unauthorized` | `The server rejected the API key (401). Double-check the key.` |
| `forbidden` | `The key was accepted but lacks access (403).` |
| `missing_key` | `This server requires an API key. Add one to continue.` |
| `auth_not_required` | *(treat as pass)* `Server didn’t require a key.` |
| `incompatible_server` | *(fail; NOT a key error — banner title "not a claude-mem server")* `No compatible claude-mem server at {host}. Check the URL — this doesn’t expose a claude-mem API.` |
| `auth_failed` | *(fail; unexpected non-4xx/404 response, e.g. 5xx — never claims a bad key)* `Couldn’t verify the API key against {host} ({http}).` |

**Step 3 — Project valid**
| `code` | Status | Message |
|---|---|---|
| `ok` | pass | `Project “{projectId}” is ready.` |
| `project_will_be_created` | warn | `Project “{projectId}” is new — it’ll be created on the first capture.` |
| `missing_project` | fail | `Enter a project ID for this connection.` |
| `project_forbidden` | fail | `This key can’t write to project “{projectId}” (403).` |
| `skipped_upstream_failed` | skipped | `Skipped — fix the step above first.` |

**Worker runtime:** for a `runtime: 'worker'` profile there is no server to probe. Replace the stepper with a single info line — `Local worker — captures to this machine. Nothing to test.` — and `Activate` is immediate (it just clears the server keys, D6/§4.1).

### 5.5 Backing endpoint the Planner must build — `POST /api/connection/test`

The stepper is designed against this shape. **This is a required new endpoint** (does not exist today).

**Request** (probe-only; nothing persisted):
```jsonc
{
  "runtime": "server",                 // 'worker' | 'server'  — 'worker' returns trivially ok
  "url": "https://nas.tail1234.ts.net:37700",
  "apiKey": "sk-...",                  // used for the probe only; MUST NOT be persisted or logged
  "projectId": "my-project"
}
```

**Response** — always HTTP 200 when the probe *ran* (the per-step `status` carries the outcome; reserve non-200 for a malformed request). The UI reads `steps[]` in order:
```jsonc
{
  "ok": false,                         // true iff every applicable step is pass or warn
  "runtime": "server",
  "steps": [
    { "step": "reachable",     "status": "pass",    "code": "ok",           "http": 200, "latencyMs": 42,
      "message": "Server responded (200) in 42 ms." },
    { "step": "authenticated", "status": "fail",    "code": "unauthorized", "http": 401,
      "message": "The server rejected the API key (401). Double-check the key." },
    { "step": "project",       "status": "skipped", "code": "skipped_upstream_failed",
      "message": "Skipped — fix the step above first." }
  ],
  "checkedAt": "2026-07-16T18:59:00Z",
  "totalMs": 130
}
```

Contract requirements for the Planner:
- **`status` ∈ `pass | warn | fail | skipped`**; **`code`** is the stable enum in §5.4 (UI may re-render copy client-side from `code` + params, or trust `message` — provide both; `message` is the fallback).
- **`ok` = no `fail` in any applicable step** (warn does not block).
- **The response MUST NOT echo `apiKey`** back, and the endpoint MUST NOT log it (spec §7, R3 — write-only, like existing key settings).
- **Short-circuit:** on the first `fail`, later steps return `skipped` (don't attempt auth if unreachable, don't check project if auth failed).
- **`runtime: 'worker'`** → return `{ ok: true, steps: [] }` (or a single informational step); the UI shows the "nothing to test" line.
- **Timeout budget** — cap each step (suggest ~5s reachable, ~5s auth) so the stepper can't hang; `timeout`/`unreachable` codes map to copy. Expose the timeout value so `{timeout}` interpolates.
- **SSRF note (R3):** the probe fetches an operator-supplied URL from the worker. Phase 1 is localhost-initiated; scope the endpoint strictly to this test purpose. Flagged for Planner/Architect, revisit under Phase 2 auth.

**Resolved (PR #30):** the scoped read-only calls for steps 2 & 3 are **variant-detecting**, because the two target types expose different auth APIs — step 2 = `GET /v1/connect` (server-beta) with fallback to `GET /v1/projects` (worker); step 3 = `GET /v1/projects/:id/jobs` (server-beta) or `GET /v1/projects/:id` (worker). Both distinguish 200 (ready) / 404 (unknown project → warn) / 403 (forbidden → fail). A double-404 on step 2 is an incompatible-server result, not a bad key. See §5.1.

---

## 6. Surface 3 — Server-config wizard (server context) (D4)

Rendered when role = `server` (and available **read-only as a helper** in the worker context per spec §4.3 — see §6.6). It **generates config; it never stores the key or calls the running server** (D4). Viewer has no auth (spec §2), so the `ANTHROPIC_API_KEY` the user types here **stays in the browser** and only appears in the copy-paste output block.

### 6.1 Anatomy

```
┌─ Server configuration ───────────────────────────────── ⌄ ┐
│  ● This viewer — Collection server                        │
│                                                           │
│  CURRENT (read-only)                                      │   ← §6.5
│  Provider  claude     Model  claude-sonnet-4-6            │
│  API key   set (ANTHROPIC_API_KEY)                        │
│  Ingest    ✓ capturing — last observation 2 min ago      │   ← §6.5 ingest status
│                                                           │
│  ── Generate updated config ──────────────────────────    │   ← the wizard
│  Provider     [ Claude ▾ ]                                 │
│  Model        [ claude-haiku-4-5-20251001 ▾ ]  ✓ recommended
│  API key      [ ••••••••••••••••  ] [ 👁 ]  (stays in your browser)
│                                                           │
│  Output       [ Env vars • ]  [ Compose ]                 │   ← format toggle (R1)
│  ┌───────────────────────────────────────────────────┐   │
│  │ CLAUDE_MEM_SERVER_PROVIDER=claude                 │📋 │   │
│  │ ANTHROPIC_API_KEY=sk-ant-…                        │   │   │
│  │ CLAUDE_MEM_SERVER_MODEL=claude-haiku-4-5-20251001 │   │   │
│  └───────────────────────────────────────────────────┘   │
│                                                           │
│  Where to apply → 1·2·3 (steps)                           │   ← §6.4
│  ⚠ After applying, verify ingest for real — not /healthz. │   ← §6.4
└───────────────────────────────────────────────────────────┘
```

### 6.2 Model picker + the inline 3× cost warning

Model select (Claude provider), **full model IDs** (see §12.3 — the server env takes a full id, not the `haiku`/`sonnet` alias the client Advanced section uses):

| `<option value>` | Label | Note |
|---|---|---|
| `claude-haiku-4-5-20251001` | `Haiku 4.5 — recommended` | **default, selected** |
| `claude-sonnet-4-6` | `Sonnet 4.6` | triggers the cost warning |

When `claude-sonnet-4-6` is selected, an **inline amber warning** appears directly under the select (associated via `aria-describedby`), using `--color-accent-summary`:

> ⚠ **Sonnet 4.6 costs about 3× Haiku 4.5** per observation. Only choose it if you need higher-quality generation. Default is Haiku.

The default (`claude-haiku-4-5-20251001`) is shown **explicitly** in the field and the output block — never left implicit. This directly counters the silent `claude-sonnet-4-6` default (`DEFAULT_SERVER_CLAUDE_MODEL`, confirmed in code, §12.3).

For **Gemini / OpenRouter** providers the model field becomes a text/select of that provider's models (mirroring the existing Advanced-section pattern) and the 3× warning does not apply; the output vars change to that provider's key var accordingly. Phase-1 focus per the spec is the Claude/`ANTHROPIC_API_KEY` path.

### 6.3 Output block (R1 — resolved) + copy/reveal

**Recommendation: emit an env-var list by default, with a one-click toggle to a Compose fragment.** See §11 for the full R1 rationale. Both render the same three vars:

- **Env vars** (default) — portable; drops into a `.env`, `docker run -e`, or a TrueNAS app env table:
  ```
  CLAUDE_MEM_SERVER_PROVIDER=claude
  ANTHROPIC_API_KEY=sk-ant-…
  CLAUDE_MEM_SERVER_MODEL=claude-haiku-4-5-20251001
  ```
- **Compose** — a valid `environment:` fragment to paste into the TrueNAS custom-app YAML:
  ```yaml
  environment:
    CLAUDE_MEM_SERVER_PROVIDER: claude
    ANTHROPIC_API_KEY: sk-ant-…
    CLAUDE_MEM_SERVER_MODEL: claude-haiku-4-5-20251001
  ```

Block behavior:
- Monospace, `--color-bg-stat` surface, `overflow-x: auto`, 6px radius.
- **Copy button** (📋) copies the **full block including the key**; on success shows `Copied ✓` (announced via `aria-live`).
- **Key masking:** the block renders the key **masked by default** (`sk-ant-…`) with a **reveal** toggle, because it's sensitive on-screen (LAN/shared-screen risk). Copy always copies the real value regardless of mask.
- If the API-key field is empty, the block shows a placeholder line `ANTHROPIC_API_KEY=<paste your key>` and a hint that the key is required before this config will work — the wizard still generates (it's output-only).

### 6.4 Where-to-apply + the "verify for real" step

A short numbered list (reuse ordered-list styling already in the template), TrueNAS-oriented but generic enough for any Docker host:

1. Open the claude-mem app in TrueNAS → **Edit** → Environment (or your compose's `environment:`).
2. Paste the block above. **Use `CLAUDE_MEM_SERVER_MODEL`, not `CLAUDE_MEM_MODEL`** (the latter is ignored by the server — §12.3).
3. Save and **recreate/restart** the container so it picks up the new env.
4. **Verify ingest for real:** trigger a capture, then confirm a new observation actually appears — **`/healthz` returning 200 is not proof of capture** (that green-but-silent state is exactly the failure this feature exists to kill). The **Ingest** line in CURRENT (§6.5) is the live signal.

Step 2's gotcha note and step 4's verify note render with the amber `--color-accent-summary` treatment.

### 6.5 CURRENT (read-only) + ingest status — backing data

Phase 1 cannot live-mutate the server (D4/§2), so the server context shows the **current effective generation config, read-only**, plus a **real ingest signal**:

- **Provider / Model / key-present** — read from the server's own env, key **redacted** (show `set (ANTHROPIC_API_KEY)` or `not set`, never the value).
- **Ingest** — the anti-silent-failure signal: `✓ capturing — last observation {relative time}` (success accent) vs `✗ no observations in {window}` (error accent) vs `— no data yet` (muted). This is what makes "green-but-capturing-nothing" impossible to miss.

Copy makes the Phase-1 constraint explicit: *"Set at container creation. Generate updated values below, then recreate the container to apply — live editing arrives with server auth (Phase 2)."*

### 6.6 Wizard as a helper in worker context (spec §4.3)

On a local worker, the wizard is available **collapsed by default** as a helper (e.g. a `Generate server config…` disclosure under the Connection section) so a user configuring a server from their laptop can produce the env block. Same generator, no CURRENT/ingest block (there's no server to read). Keep it out of the way — it is secondary to Connection profiles in this context.

---

## 7. Copy deck (consolidated)

**Section titles / chips**
- `Connection` · `Server configuration`
- `● This viewer — Local worker` · `● This viewer — Collection server`
- `Viewing:  [ Local worker ]  [ Server ]` (fallback toggle)

**Connection panel**
- Subsection labels: `ACTIVE`, `PROFILES` (uppercase, `.subsection-label` idiom)
- Buttons: `+ Add connection`, `Edit`, `Test`, `Delete`
- Local worker subtitle: `Captures to this machine — no server`
- Empty/first-run hint: `You're capturing locally. Add a connection to send captures to a server on your LAN or Tailscale.`
- Delete confirm: `Delete "{name}"? This removes the saved profile and its key.`
- Delete disabled (active): tooltip `Switch to another connection before deleting this one.`
- Delete disabled (Local worker): tooltip `The local worker is the built-in fallback and can't be deleted.`
- Activated toast: `✓ Activated "{name}". New captures use this connection.`

**Editor**
- Labels: `Name`, `Runtime`, `Server URL`, `API key`, `Project ID`
- Placeholders: `e.g. NAS (Tailscale)` · `https://nas.tail1234.ts.net:37700` · `Server API key` · `Project to capture into`
- Reveal toggle: `Reveal` / `Hide` (icon button, `aria-pressed`, `aria-label="Show API key"`)
- Buttons: `Test connection` (primary), `Save`, `Cancel`

**Test stepper** — step labels `Reachable`, `Authenticated`, `Project valid`; per-code messages in §5.4; banners in §5.3.

**Wizard** — labels `Provider`, `Model`, `API key`; hint `(stays in your browser)`; recommended tag `✓ recommended`; 3× warning in §6.2; output toggle `Env vars` / `Compose`; copy states `Copy` → `Copied ✓`; apply steps + verify note in §6.4; CURRENT constraint copy in §6.5.

**Tone:** plain, second person, one idea per line. Errors say what's wrong **and** the next action. No stack traces, no raw HTTP bodies in the primary line (a raw detail may sit in a secondary muted line if useful).

---

## 8. Interaction & accessibility

- **Profile list = a real radio group.** `role="radiogroup"` with an accessible name (`Active connection`); Up/Down (or Left/Right) move focus between profiles; `Space` selects/focuses a profile for the action bar (does **not** activate). Activation is a separate, explicit button (§5) — never a side effect of arrow-keying.
- **Action bar buttons** are standard buttons in DOM order after the group; disabled states carry a `title`/`aria-describedby` explaining *why* (e.g. Local worker delete).
- **Editor** — logical tab order Name → Runtime → URL → key → reveal → Project → Test → Save → Cancel. `Enter` in a text field triggers `Test connection` (the primary), not Save, so the user tests before saving. `Esc` cancels the editor (but the modal's existing `Esc`-to-close must not also fire — scope the editor `Esc` and `stopPropagation`, or the modal closes underneath; **flag for Planner**, since `ContextSettingsModal` binds a global `Esc` at `:163`).
- **Test stepper** — wrap in `aria-live="polite"`; announce each step's result and the final banner. On hard fail, move focus to the primary remedy button (`Edit key` / `Retry test`).
- **Cost warning** — associate with the model select via `aria-describedby` so screen readers hear it when the field is focused; it's not color-only (has the ⚠ glyph + text).
- **Output block** — the reveal toggle is `aria-pressed`; the copy button announces `Copied` via a visually-hidden live region; block is focusable and keyboard-scrollable.
- **Masked inputs** — `type="password"` for both the profile key and the wizard key; reveal toggles flip to `type="text"` and back; never auto-reveal.
- **Focus rings** — reuse the existing `box-shadow: 0 0 0 3px rgba(9,105,218,0.1)` focus treatment on every new control; do not remove outlines without a visible replacement.
- **Color independence** — every pass/warn/fail is glyph + text + color, never color alone (WCAG 1.4.1).
- **Dark mode** — all tokens above are already dual-defined in `[data-theme]`; no `dark:`-style overrides needed. New components must reference tokens, never hardcode hex (the footer's mistake, §12.1).
- **Touch** — rows and action buttons ≥ 40px target height (the toggle is already 22px tall but 40px-wide row; keep new tap targets ≥40px). The action bar wraps on the ~360px column; at the `768px` modal breakpoint (`viewer-template.html` media query) the modal goes single-column — the Connection section then has full width, which is *better* for the stepper and output block; verify wrap there.

---

## 9. Backing endpoints / data the Planner must build

Consolidated so Planner can scope the backend work. **The UX above is designed against these shapes.**

| # | Endpoint / data | Why the UX needs it | Notes |
|---|---|---|---|
| **E1** | `POST /api/connection/test` (new) | The entire test-before-activate stepper (§5). | Full request/response contract in §5.5. Per-step `status`+`code`, short-circuit, **no key echo/log**, per-step timeout. Planner must pick the scoped read-only calls that back steps 2 & 3. |
| **E2** | `GET /api/runtime-role` (new, or expose existing runtime info) | Context-aware rendering + the context chip (§3, D5/R2). | `{ "role": "worker" \| "server" }`, authoritative from the worker's own startup config — not a guess. Returns `unknown` → UI shows the manual toggle. No such route exists today (verified: `src/services/worker/http/routes/` has none). |
| **E3** | `/api/settings` POST allow-list extension | Persisting profiles + activation (§4, D6). | Add `CLAUDE_MEM_CONNECTIONS`, `CLAUDE_MEM_ACTIVE_CONNECTION`, and the 4 canonical keys `CLAUDE_MEM_RUNTIME` / `CLAUDE_MEM_SERVER_URL` / `CLAUDE_MEM_SERVER_API_KEY` / `CLAUDE_MEM_SERVER_PROJECT_ID` to `settingKeys` (`SettingsRoutes.ts:77`). **Confirmed absent today** — without this, Save silently fails. Also add validation for the new keys alongside the existing `validateSettings` block. |
| **E4** | `GET /api/server-config` (new, server context) | The CURRENT read-only display (§6.5). | `{ provider, model, keyPresent: bool, keySource: "ANTHROPIC_API_KEY" }` — **key value never returned**. |
| **E5** | `GET /api/ingest-status` (new, server context) | The "verify ingest for real, not /healthz" live signal (§6.4/§6.5) — the anti-silent-failure indicator. | e.g. `{ lastObservationAt, countLastWindow, window: "24h" }`. High value; if descoped, the wizard's verify step becomes copy-only guidance. |
| **E6** | `ConnectionStore` (new, per spec §6) | Reads/writes `CLAUDE_MEM_CONNECTIONS` + active id; `activate()` writes the 4 canonical keys (D6). | UI never writes `settings.json` directly — it calls the store via the settings API. Architecture is the spec's/Planner's; UX just relies on activate = canonical-key write. |

E1, E2, E3, E6 are **required** for Phase 1. E4, E5 power the server-context richness; if timeline-constrained they can land in a fast follow, with the wizard degrading to output-only + copy-guidance (still fully functional as a generator).

---

## 10. Screen-by-screen state matrix (quick reference for Planner)

| Surface | empty / first-run | loading | in-progress | success | error |
|---|---|---|---|---|---|
| Connection list | Seeded Local worker + add hint (§4.6) | skeleton rows | — | activated toast + `◉ active` | footer `✗ Error` (§4.6) |
| Editor | preset-prefilled fields (§4.2) | — | Save disables | `✓ Saved` (footer) | inline field validation + footer error |
| Test stepper | n/a | per-step `idle`→`running` | spinner on active step | verified banner + Activate (§5.3) | fail banner names the step (§5.3) |
| Wizard | Haiku default, empty key placeholder in block | — | — | block + Copied ✓ | (output-only; no error path — it never calls out) |
| Server CURRENT | `— no data yet` ingest | fetch skeleton | — | `✓ capturing …` | `✗ no observations in 24h` |

---

## 11. R1 resolved — wizard output format

**Question (spec R1):** env-var list, or a Compose fragment, for the wizard output?

**Recommendation: ship both, default to the env-var list, one-click toggle to Compose.** Concretely:

- **Default = env-var list** (`KEY=value` lines). It's the most portable form — it drops into a `.env` file, a `docker run -e` line, or the TrueNAS app's env-vars table, and it matches the user's mental model ("set these three env vars"). It's also the safest to hand-transcribe if needed.
- **Include Compose as a toggle**, because **TrueNAS SCALE "custom app" is Docker-Compose-based** — the operator is editing YAML. A ready-made `environment:` fragment removes the most error-prone step (hand-converting `KEY=value` into correctly-indented YAML), which is precisely the class of silent misconfiguration this whole feature exists to prevent. Emitting valid YAML the user pastes verbatim is strictly safer than making them translate.

**Why not env-only:** it pushes YAML conversion onto the user at the exact TrueNAS step where a typo silently disables generation. **Why not compose-only:** less portable, and overkill for a `.env`/`docker run` user. The toggle costs almost nothing (same three values, two renderers) and covers both apply paths. This is my flagged, concrete recommendation for Mark; if he confirms his TrueNAS app is edited as compose, **Compose could even be the default** — that's the one bit worth confirming (Q2 in §13).

Both formats must carry the same guardrails: `CLAUDE_MEM_SERVER_MODEL` (not `CLAUDE_MEM_MODEL`, §12.3), explicit Haiku default, masked key with reveal, copy-the-real-value.

---

## 12. Corrections against the current code (spec / implementation reality)

*(The task asked me to flag anything UX-infeasible or wrong against the current Settings panel. Three items — none block the design; two shape it.)*

### 12.1 Phantom footer tokens (existing drift — don't inherit it)
`.modal-footer` and its save button (`viewer-template.html:1640–1681`) reference tokens that **don't exist** in `:root`: `--modal-border`, `--modal-header-bg`, `--success-color`, `--error-color`, `--accent-color`, `--accent-hover`. They fall back to hardcoded hex (`#3b82f6`, `#22c55e`, `#ef4444`, `#2563eb`) and `border-top: 1px solid var(--modal-border)` resolves to an invalid/no border. Net effect: the Save button is a **different blue** (`#3b82f6`) than the app accent (`--color-accent-primary` = `#0969da`). **Directive for new work:** the Connection panel/wizard must use `--color-accent-primary` / `--color-accent-success` / `--color-accent-error`, not those fallbacks, so the new surface matches the app. The footer itself is a pre-existing Polisher/Builder cleanup (out of scope for this docs PR) — worth a queue row so the whole modal converges on real tokens.

### 12.2 Allow-list gap is a hard dependency, not a nice-to-have
Because `settingKeys` (`SettingsRoutes.ts:77`) does **not** list the connection keys, **Save will fail closed** until E3 lands. The UX assumes E3; without it the "Saving… → ✗ Error" path is the *only* outcome. Planner must sequence E3 with the UI, and the error copy (§4.6) should be specific if the allow-list rejects, not a generic 500.

### 12.3 Model-id naming: the wizard must use full IDs and the SERVER var
Two real gotchas confirmed in code:
- The client Advanced "Claude Model" select stores short aliases (`haiku`/`sonnet`/`opus`, `ContextSettingsModal.tsx:352`), yet `DEFAULT_SETTINGS.CLAUDE_MEM_MODEL` is the **full** `claude-sonnet-4-6` — so the select can't even display its own default (falls back to `haiku`). Don't replicate that pattern. The **wizard's** model picker must emit **full IDs** (`claude-haiku-4-5-20251001`, `claude-sonnet-4-6`), because the server env `CLAUDE_MEM_SERVER_MODEL` is passed straight through as a model id (`create-server-service.ts:261`).
- The server reads `CLAUDE_MEM_SERVER_MODEL`, **not** `CLAUDE_MEM_MODEL` (confirmed `create-server-service.ts:243–275`; default `DEFAULT_SERVER_CLAUDE_MODEL = 'claude-sonnet-4-6'`, `ClaudeObservationProvider.ts:22`). The wizard output and the apply-steps copy both call this out explicitly (§6.4 step 2). This is the "SERVER_MODEL-not-MODEL gotcha" the spec names — the wizard's job is to make it impossible to get wrong.

### 12.4 `Esc` collision (minor, flag for Planner)
`ContextSettingsModal` binds a global `Esc`-to-close (`:163`). The editor's `Esc`-to-cancel and any inline confirm must `stopPropagation` or be scoped, or cancelling a field closes the whole modal. Design intent: `Esc` cancels the *innermost* open thing (confirm → editor → modal).

---

## 13. Open questions for Mark (non-blocking; defaults chosen)

- **Q1 (from spec) — Local worker as undeletable default?** Designed as **yes**: always present, always the safe fallback, radio-selectable, Edit/Delete disabled with explanatory tooltips (§4.1/§4.6). Proceeding on yes unless told otherwise.
- **Q2 — Wizard output default format?** Designed as **env-var list default + Compose toggle** (§11). If your TrueNAS app is edited as compose YAML, I'll flip the **default to Compose** (still keeping the env-list toggle). One-word confirm and I'll note it for Planner.
- **Q3 — Unknown project = warn or hard-block?** Designed as **warn** (activatable; project created on first capture, §5.3) since that matches how collection servers behave. Say the word if you'd rather it hard-block.
- **Q4 — "Save without activating" escape hatch?** Designed **in** (§5.3), so you can save an off-network profile (Tailscale while away) without activating a connection that can't be tested right now. Removable if you'd prefer strict test-then-save-then-activate only.

---

*Handoff complete. Next: Planner writes the plan for `ConnectionStore` (E6), `POST /api/connection/test` (E1), `GET /api/runtime-role` (E2), the allow-list extension (E3), and — for the server context — `GET /api/server-config` (E4) + `GET /api/ingest-status` (E5). This handoff is the UX contract those endpoints must satisfy.*
