export type WizardProvider = 'claude';
export const SERVER_MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — recommended', recommended: true },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', recommended: false },
] as const;

export const DEFAULT_WIZARD_MODEL = 'claude-haiku-4-5-20251001';
export const COST_WARNING = 'Sonnet 4.6 costs about 3× Haiku 4.5 per observation. Only choose it if you need higher-quality generation. Default is Haiku.';

export interface WizardInput { provider: WizardProvider; model: string; apiKey: string; }
export type OutputFormat = 'compose' | 'env';

const KEY_PLACEHOLDER = '<paste your key>';

/** Emit env-var lines. Model is a FULL id; the SERVER var (not CLAUDE_MEM_MODEL). */
export function renderEnv(input: WizardInput): string {
  const key = input.apiKey || KEY_PLACEHOLDER;
  return [
    `CLAUDE_MEM_SERVER_PROVIDER=${input.provider}`,
    `ANTHROPIC_API_KEY=${key}`,
    `CLAUDE_MEM_SERVER_MODEL=${input.model}`,
  ].join('\n');
}

/** Emit a valid docker-compose `environment:` fragment (TrueNAS default). */
export function renderCompose(input: WizardInput): string {
  const key = input.apiKey || KEY_PLACEHOLDER;
  return [
    'environment:',
    `  CLAUDE_MEM_SERVER_PROVIDER: ${input.provider}`,
    `  ANTHROPIC_API_KEY: ${key}`,
    `  CLAUDE_MEM_SERVER_MODEL: ${input.model}`,
  ].join('\n');
}

export function renderOutput(input: WizardInput, format: OutputFormat): string {
  return format === 'compose' ? renderCompose(input) : renderEnv(input);
}

export function isCostlyModel(model: string): boolean { return model === 'claude-sonnet-4-6'; }
