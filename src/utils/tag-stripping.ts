
import { logger } from './logger.js';

const TAG_NAMES = [
  'claude-mem-context',
  'system_instruction',
  'system-instruction',
  'persisted-output',
  'system-reminder',
] as const;
type TagName = (typeof TAG_NAMES)[number];

const STRIP_REGEX = new RegExp(
  `<(${TAG_NAMES.join('|')})\\b[^>]*>[\\s\\S]*?</\\1>`,
  'g'
);

// Phase 2 fail-safe (Designer handoff §2): the WRAPPING form of ANY
// `private`-prefixed tag redacts — <private>…</private>,
// <private-session>…</private-session>, <private-anything>…</private-anything>.
// The backreference `</\1>` requires a closing tag, so the self-closing
// visibility switch `<private-session />` never matches here. This guarantees
// the dangerous confusion direction always fails toward redaction (safe).
const PRIVATE_WRAP_REGEX = /<(private[a-z0-9_-]*)\b[^>]*>[\s\S]*?<\/\1>/gi;

export const SYSTEM_REMINDER_REGEX = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const MAX_TAG_COUNT = 100;

export function stripTags(input: string): { stripped: string; counts: Record<string, number> } {
  const counts: Record<string, number> = Object.fromEntries(
    TAG_NAMES.map(name => [name, 0])
  ) as Record<string, number>;
  counts.private = 0;

  PRIVATE_WRAP_REGEX.lastIndex = 0;
  let total = 0;
  const withoutPrivate = input.replace(PRIVATE_WRAP_REGEX, () => {
    counts.private += 1;
    total += 1;
    return '';
  });

  STRIP_REGEX.lastIndex = 0;
  const stripped = withoutPrivate.replace(STRIP_REGEX, (_, name: TagName) => {
    counts[name] = (counts[name] ?? 0) + 1;
    total += 1;
    return '';
  });

  if (total > MAX_TAG_COUNT) {
    logger.warn('SYSTEM', 'tag count exceeds limit', undefined, {
      tagCount: total,
      maxAllowed: MAX_TAG_COUNT,
      contentLength: input.length,
    });
  }

  return { stripped: stripped.trim(), counts };
}

export function stripMemoryTagsFromJson(content: string): string {
  return stripTags(content).stripped;
}

export function stripMemoryTagsFromPrompt(content: string): string {
  return stripTags(content).stripped;
}

const PROTOCOL_ONLY_TAGS = ['task-notification'] as const;

const PROTOCOL_ONLY_REGEX = new RegExp(
  `^\\s*<(${PROTOCOL_ONLY_TAGS.join('|')})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`,
);

const MAX_PROTOCOL_PAYLOAD_BYTES = 256 * 1024;

export function isInternalProtocolPayload(text: string): boolean {
  if (!text) return false;
  if (text.length > MAX_PROTOCOL_PAYLOAD_BYTES) return false;
  return PROTOCOL_ONLY_REGEX.test(text);
}
