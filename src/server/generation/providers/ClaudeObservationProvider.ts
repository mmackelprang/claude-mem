// SPDX-License-Identifier: Apache-2.0

import { logger } from '../../../utils/logger.js';
import {
  ServerClassifiedProviderError,
  parseRetryAfterMs,
} from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// #19 — server generation is cheap-by-default. The default is the Haiku tier
// (~1/3 the Sonnet input/output cost); Sonnet becomes an explicit opt-in via
// CLAUDE_MEM_SERVER_MODEL. This id is the same one the worker path already
// defaults to (CLAUDE_MEM_MODEL in src/shared/SettingsDefaultsManager.ts), so
// it is a known-valid model id on the current Anthropic Messages API — the
// prior default-change 404 risk (#2554, when the stale
// `claude-3-5-sonnet-latest` was the default) does not apply here.
export const DEFAULT_SERVER_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MODEL = DEFAULT_SERVER_CLAUDE_MODEL;

export interface ClaudeObservationProviderOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
}

interface AnthropicMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

export class ClaudeObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClaudeObservationProviderOptions) {
    if (!options.apiKey) {
      throw new ServerClassifiedProviderError('Anthropic API key not configured', {
        kind: 'auth_invalid',
        cause: new Error('apiKey is required'),
      });
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get modelId(): string {
    return this.model;
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
  ): Promise<ServerGenerationResult> {
    const { prompt, skippedAll, skipReason } = buildServerGenerationPrompt(context);
    if (skippedAll) {
      // Nothing worth summarizing — either a zero-event batch (#21) or every
      // event scrubbed by privacy stripping. Don't bill the provider; return a
      // synthetic skip response the parser accepts, tagged with the reason.
      const reason = skipReason ?? 'all_private';
      logger.info('SDK', 'server generation skipped without billing provider', {
        provider: this.providerLabel,
        jobId: context.job.id,
        reason,
      });
      return {
        rawText: `<skip_summary reason="${reason}" />`,
        providerLabel: this.providerLabel,
        modelId: this.modelId,
      };
    }

    let response: Response;
    try {
      response = await this.postMessages(prompt, signal);
    } catch (networkError) {
      const err = networkError instanceof Error ? networkError : new Error(String(networkError));
      throw classifyClaudeServerError({
        cause: err,
      });
    }

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      throw classifyClaudeServerError({
        status: response.status,
        bodyText,
        headers: response.headers,
        cause: new Error(`Anthropic API error: ${response.status} - ${bodyText}`),
      });
    }

    let data: AnthropicMessagesResponse;
    try {
      data = (await response.json()) as AnthropicMessagesResponse;
    } catch (parseError) {
      const err = parseError instanceof Error ? parseError : new Error(String(parseError));
      throw new ServerClassifiedProviderError('Anthropic returned invalid JSON', {
        kind: 'parse_error',
        cause: err,
      });
    }

    if (data.error) {
      throw classifyClaudeServerError({
        status: response.status,
        bodyText: `${data.error.type ?? ''} ${data.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`Anthropic API error: ${data.error.type} - ${data.error.message}`),
      });
    }

    const blocks = Array.isArray(data.content) ? data.content : [];
    const rawText = blocks
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text!)
      .join('\n')
      .trim();

    if (!rawText) {
      logger.warn('SDK', 'Anthropic returned empty content array', {
        provider: 'claude',
        model: this.model,
      });
    }

    const usage = data.usage ?? {};
    const tokensUsed =
      typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number'
        ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
        : undefined;

    return {
      rawText,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      providerLabel: this.providerLabel,
      modelId: this.modelId,
    };
  }

  private postMessages(prompt: string, signal?: AbortSignal): Promise<Response> {
    return this.fetchImpl(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxOutputTokens,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });
  }
}

interface ClassifyInput {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
}

/**
 * Anthropic-specific HTTP error classification. Mirrors worker
 * `classifyClaudeError`, but extracted for server-beta and rebound to
 * Anthropic Messages REST semantics rather than SDK error classes.
 */
export function classifyClaudeServerError(input: ClassifyInput): ServerClassifiedProviderError {
  const status = input.status;
  const body = input.bodyText ?? '';
  const lower = body.toLowerCase();
  const retryAfterMs = input.headers ? parseRetryAfterMs(input.headers.get('retry-after')) : undefined;

  if (lower.includes('overloaded')) {
    return new ServerClassifiedProviderError(
      `Anthropic overloaded${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'transient', cause: input.cause },
    );
  }

  if (status === 401 || status === 403 || lower.includes('invalid api key')) {
    return new ServerClassifiedProviderError(
      `Anthropic auth invalid${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }

  if (status === 429) {
    return new ServerClassifiedProviderError('Anthropic rate limit (429)', {
      kind: 'rate_limit',
      cause: input.cause,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  if (lower.includes('quota exceeded')) {
    return new ServerClassifiedProviderError('Anthropic quota exhausted', {
      kind: 'quota_exhausted',
      cause: input.cause,
    });
  }

  if (
    lower.includes('prompt is too long') ||
    lower.includes('context window') ||
    lower.includes('max_tokens')
  ) {
    return new ServerClassifiedProviderError('Anthropic context overflow', {
      kind: 'unrecoverable',
      cause: input.cause,
    });
  }

  if (status === 529) {
    return new ServerClassifiedProviderError('Anthropic overloaded (529)', {
      kind: 'transient',
      cause: input.cause,
    });
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ServerClassifiedProviderError(`Anthropic upstream error (status ${status})`, {
      kind: 'transient',
      cause: input.cause,
    });
  }

  if (status === 400) {
    return new ServerClassifiedProviderError('Anthropic bad request (400)', {
      kind: 'unrecoverable',
      cause: input.cause,
    });
  }

  if (status === undefined) {
    const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
    return new ServerClassifiedProviderError(`Anthropic network error: ${message}`, {
      kind: 'transient',
      cause: input.cause,
    });
  }

  return new ServerClassifiedProviderError(
    `Anthropic API error: ${status}${body ? ` - ${body.substring(0, 200)}` : ''}`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('SDK', 'Failed to read Anthropic error response body', {
      provider: 'claude',
      status: response.status,
    }, err);
    return '';
  }
}
