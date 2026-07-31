// SPDX-License-Identifier: Apache-2.0
import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { DEFAULT_SERVER_CLAUDE_MODEL } from '../../../../server/generation/providers/ClaudeObservationProvider.js';
import { logger } from '../../../../utils/logger.js';

export interface ServerGenerationConfig {
  provider: string;
  model: string;
  keyPresent: boolean;
  keySource: string | null;
}

/**
 * Read the server's effective generation config from env — the same vars
 * create-server-service.ts reads (CLAUDE_MEM_SERVER_PROVIDER / _MODEL,
 * ANTHROPIC_API_KEY). The key VALUE is never returned — only presence + source.
 * The model default is surfaced EXPLICITLY (DEFAULT_SERVER_CLAUDE_MODEL, the
 * cheap-by-default Haiku tier as of #19) rather than left implicit, so the UI can
 * show the resolved model and flag the pricier Sonnet opt-in (handoff §6.2/§12.3).
 */
export function readServerGenerationConfig(env: NodeJS.ProcessEnv): ServerGenerationConfig {
  const provider = (env.CLAUDE_MEM_SERVER_PROVIDER ?? '').trim().toLowerCase() || 'claude';
  const model = env.CLAUDE_MEM_SERVER_MODEL?.trim() || DEFAULT_SERVER_CLAUDE_MODEL;

  let keyPresent = false;
  let keySource: string | null = null;
  if (env.ANTHROPIC_API_KEY) { keyPresent = true; keySource = 'ANTHROPIC_API_KEY'; }
  else if (env.CLAUDE_MEM_ANTHROPIC_API_KEY) { keyPresent = true; keySource = 'CLAUDE_MEM_ANTHROPIC_API_KEY'; }
  else if (provider === 'gemini' && (env.GEMINI_API_KEY || env.CLAUDE_MEM_GEMINI_API_KEY)) { keyPresent = true; keySource = env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : 'CLAUDE_MEM_GEMINI_API_KEY'; }
  else if (provider === 'openrouter' && (env.OPENROUTER_API_KEY || env.CLAUDE_MEM_OPENROUTER_API_KEY)) { keyPresent = true; keySource = env.OPENROUTER_API_KEY ? 'OPENROUTER_API_KEY' : 'CLAUDE_MEM_OPENROUTER_API_KEY'; }

  return { provider, model, keyPresent, keySource };
}

export class ServerConfigRoutes extends BaseRouteHandler {
  setupRoutes(app: express.Application): void {
    app.get('/api/server-config', this.handleGet.bind(this));
  }

  private handleGet = this.wrapHandler((_req: Request, res: Response): void => {
    const config = readServerGenerationConfig(process.env);
    // The recurring operator questions are "why is my server on Sonnet?" and
    // "why does it say my key is missing?" — both answerable only from the
    // RESOLVED triple plus which env var supplied the key. keySource is a
    // variable NAME, never the key value (see this file's contract above).
    logger.debug('HTTP', 'server-config: resolved generation config', undefined, {
      provider: config.provider,
      model: config.model,
      keyPresent: config.keyPresent,
      keySource: config.keySource,
      modelIsDefault: config.model === DEFAULT_SERVER_CLAUDE_MODEL,
    });
    res.json(config);
  });
}
