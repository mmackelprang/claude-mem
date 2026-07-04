// SPDX-License-Identifier: Apache-2.0

/**
 * Humanize an actor_id for display (Designer handoff §6.2).
 *  human:alice@org  -> "Alice"  (email localpart, title-cased)
 *  system:ci-runner -> "CI"     (system label, upper-cased short token)
 *  unparseable/null -> raw actorId or ""
 * When `viewerActorId` matches, callers may prefer "You" (viewer-side concern).
 */
export function humanizeActor(actorId: string | null | undefined): string {
  if (!actorId) return '';
  const [scheme, rest] = actorId.includes(':')
    ? [actorId.slice(0, actorId.indexOf(':')), actorId.slice(actorId.indexOf(':') + 1)]
    : ['', actorId];
  if (scheme === 'human') {
    const local = rest.split('@')[0] ?? rest;
    if (!local) return actorId;
    return local.charAt(0).toUpperCase() + local.slice(1);
  }
  if (scheme === 'system') {
    const token = (rest.split(/[-_]/)[0] ?? rest);
    return token.length <= 3 ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1);
  }
  return actorId;
}
