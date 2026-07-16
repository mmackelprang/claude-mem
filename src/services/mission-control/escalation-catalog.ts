/**
 * Remediation catalog = the fail-closed allowlist for escalations. An error
 * class is surfaced ONLY if it has an entry here; a pattern without a
 * remediation cannot exist (the miner iterates this list). Content lives
 * server-side and ships resolved on the /attention payload — the viewer needs
 * no import from src/services (keeps server-only deps out of the browser bundle).
 */
export interface EscalationCatalogEntry {
  key: string;          // matches the `error:<key>` ref
  re: RegExp;           // qualifies an observation as this class
  whatTitle: string;    // WHAT — human error name
  fixText: string;      // FIX — one-line action
  fixCommand?: string;  // FIX — copyable command
  docHref: string;      // FIX — doc link
}

const DOCS = 'https://docs.claude-mem.ai/troubleshooting';

export const ESCALATION_CATALOG: EscalationCatalogEntry[] = [
  {
    key: 'worker-unreachable',
    re: /worker (is )?unreachable/i,
    whatTitle: 'Worker unreachable',
    fixText: 'The worker process is down. Restart it, then check the doctor.',
    fixCommand: 'claude-mem restart',
    docHref: `${DOCS}#worker`,
  },
  {
    key: 'eaddrinuse',
    re: /EADDRINUSE/i,
    whatTitle: 'Port already in use',
    fixText: 'A stale worker holds the port. Restart, or kill the PID on :37777.',
    fixCommand: 'claude-mem restart',
    docHref: `${DOCS}#port`,
  },
  {
    key: 'module-not-found',
    re: /MODULE_NOT_FOUND/i,
    whatTitle: 'Module not found',
    fixText: "A build didn't reach the running plugin. Rebuild and sync.",
    fixCommand: 'npm run build-and-sync',
    docHref: `${DOCS}#build`,
  },
  {
    key: 'swallowed-startup',
    re: /failed to start worker/i,
    whatTitle: 'Worker failed to start',
    fixText: 'A startup error was swallowed. Check the worker log, then restart.',
    fixCommand: 'claude-mem restart',
    docHref: `${DOCS}#startup`,
  },
];

export function catalogByKey(): Record<string, EscalationCatalogEntry> {
  const out: Record<string, EscalationCatalogEntry> = {};
  for (const e of ESCALATION_CATALOG) out[e.key] = e;
  return out;
}
