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

import { spawn, spawnSync } from 'child_process';

/**
 * Resolve the current Windows user as `DOMAIN\user` (or bare `user` when no
 * domain), or null when it can't be determined. POSIX callers never reach here.
 */
function currentWindowsUser(): string | null {
  const username = process.env.USERNAME;
  if (!username) return null;
  const domain = process.env.USERDOMAIN ?? '';
  return `${domain}\\${username}`.replace(/^\\+/, '');
}

// /inheritance:r removes inherited ACEs; /grant:r <user>:F grants full control
// to just this user (replacing any existing grant for that user).
function icaclsArgs(path: string, user: string): string[] {
  return [path, '/inheritance:r', '/grant:r', `${user}:F`];
}

/**
 * Best-effort Windows ACL tightening for a settings file that may hold an API key.
 * SYNCHRONOUS — use only on one-shot paths (CLI installer, key bootstrap) where
 * blocking briefly is fine. For the worker's HTTP request handlers use
 * {@link restrictSettingsFileForWindowsAsync} so the response isn't gated on icacls.
 *
 * On non-Windows platforms this is a no-op (POSIX `chmod(0o600)` already handled
 * the file). On Windows it disables inherited ACEs and grants full control to
 * only the current user. It NEVER throws: any failure leaves the file protected
 * by the default user-profile ACLs.
 */
export function restrictSettingsFileForWindows(path: string): void {
  if (process.platform !== 'win32') return;
  const user = currentWindowsUser();
  if (!user) return;
  try {
    spawnSync('icacls', icaclsArgs(path, user), {
      windowsHide: true,
      timeout: 5000,
      stdio: 'ignore',
    });
  } catch {
    // Best-effort only; profile ACLs remain in force.
  }
}

/**
 * Non-blocking variant of {@link restrictSettingsFileForWindows} for hot paths
 * (e.g. the worker's `/api/settings` handlers): fire-and-forget so the caller
 * (and any HTTP response) is never gated on the `icacls` child. The detached,
 * unref'd child is left to finish on its own; the mandatory `error` listener
 * keeps an async spawn failure (e.g. icacls missing) from becoming an uncaught
 * exception. NEVER throws; POSIX is a no-op.
 */
export function restrictSettingsFileForWindowsAsync(path: string): void {
  if (process.platform !== 'win32') return;
  const user = currentWindowsUser();
  if (!user) return;
  try {
    const child = spawn('icacls', icaclsArgs(path, user), {
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    });
    // An unhandled 'error' event on a ChildProcess throws; swallow it.
    child.on('error', () => { /* best-effort; profile ACLs remain in force */ });
    child.unref();
  } catch {
    // Best-effort only; profile ACLs remain in force.
  }
}
