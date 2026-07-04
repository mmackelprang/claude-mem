
import { basename } from 'path';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import {
  executeWithWorkerFallback as defaultExecuteWithWorkerFallback,
  isWorkerFallback as defaultIsWorkerFallback,
  getWorkerPort as defaultGetWorkerPort,
} from '../../shared/worker-utils.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { selectRuntime as defaultSelectRuntime } from '../../services/hooks/runtime-selector.js';

const defaultDependencies = {
  executeWithWorkerFallback: defaultExecuteWithWorkerFallback,
  isWorkerFallback: defaultIsWorkerFallback,
  getWorkerPort: defaultGetWorkerPort,
  selectRuntime: defaultSelectRuntime,
};

let dependencies = defaultDependencies;

export function setUserMessageDependenciesForTesting(
  overrides: Partial<typeof defaultDependencies> = {},
): void {
  dependencies = { ...defaultDependencies, ...overrides };
}

export const userMessageHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const port = dependencies.getWorkerPort();
    const project = basename(input.cwd ?? process.cwd());
    const colorsParam = input.platform === 'claude-code' ? '&colors=true' : '';
    const platformSourceParam = input.platform
      ? `&platformSource=${encodeURIComponent(normalizePlatformSource(input.platform))}`
      : '';

    const result = await dependencies.executeWithWorkerFallback<string>(
      `/api/context/inject?project=${encodeURIComponent(project)}${colorsParam}${platformSourceParam}`,
      'GET',
    );

    if (dependencies.isWorkerFallback(result)) {
      return { exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const output = typeof result === 'string' ? result : '';
    // Phase 2 — in server/team mode the redaction hint also points at the
    // dashboard Private control (stored-but-scoped) as a distinct option from
    // <private> redaction. Worker/solo mode keeps the ORIGINAL hint verbatim.
    const redactHint = dependencies.selectRuntime() === 'server'
      ? String.fromCodePoint(0x1F4A1) + " Wrap anything in <private> ... </private> to keep it off the record entirely — it's never stored or shared. To keep something for yourself but off the team feed, mark it Private in the dashboard."
      : String.fromCodePoint(0x1F4A1) + " Wrap any message with <private> ... </private> to prevent storing sensitive information.";
    // IO discipline: the banner is a USER_HINT. Return it via systemMessage so
    // the platform adapter routes it (claude-code surfaces it inline, exactly
    // like the old stderr write, but inside the HookResult contract). This
    // handler MUST stay pure — no process.stderr.write / console.* / process.exit.
    const bannerText =
      "\n\n" + String.fromCodePoint(0x1F4DD) + " Claude-Mem Context Loaded\n\n" +
      output +
      "\n\n" + redactHint + "\n" +
      "\n" + String.fromCodePoint(0x1F4AC) + " Community https://discord.gg/J4wttp9vDu" +
      `\n` + String.fromCodePoint(0x1F4FA) + ` Watch live in browser http://localhost:${port}/\n`;

    return { exitCode: HOOK_EXIT_CODES.SUCCESS, systemMessage: bannerText };
  },
};
