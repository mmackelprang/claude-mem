// SPDX-License-Identifier: Apache-2.0
//
// #23 — settings.json file-mode hardening.
//
// `~/.claude-mem/settings.json` can hold a live `CLAUDE_MEM_SERVER_API_KEY`.
// On POSIX the writers `chmod(0o600)` it so only the owner can read the key.
// On Windows `chmod` is a no-op (the POSIX permission bits are not enforced),
// so the file falls back to whatever the user-profile ACLs provide — normally
// already scoped to the current user under `%USERPROFILE%`, but a multi-user
// host is the residual exposure.
//
// This helper is a *best-effort* Windows tightening: it disables ACL
// inheritance and grants full control to only the current user via `icacls`.
// It is intentionally non-fatal — a failure (icacls missing, permission
// denied, unusual environment) leaves the file protected by the default
// profile ACLs and never breaks the install or bootstrap path.

import { spawnSync } from 'child_process';

/**
 * Best-effort Windows ACL tightening for a settings file that may hold an API key.
 *
 * On non-Windows platforms this is a no-op (POSIX `chmod(0o600)` already handled
 * the file). On Windows it disables inherited ACEs and grants full control to
 * only the current user. It NEVER throws: any failure leaves the file protected
 * by the default user-profile ACLs.
 */
export function restrictSettingsFileForWindows(path: string): void {
  if (process.platform !== 'win32') return;
  const username = process.env.USERNAME;
  if (!username) return;
  const domain = process.env.USERDOMAIN ?? '';
  const user = `${domain}\\${username}`.replace(/^\\+/, '');
  try {
    // /inheritance:r removes inherited ACEs; /grant:r <user>:F grants full
    // control to just this user (replacing any existing grant for that user).
    spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], {
      windowsHide: true,
      timeout: 5000,
      stdio: 'ignore',
    });
  } catch {
    // Best-effort only; profile ACLs remain in force.
  }
}
