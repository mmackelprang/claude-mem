/**
 * Extract PR numbers from free text. Matches ONLY "PR #N" and gh-resolved
 * GitHub pull URLs — never a bare "#N", which collides with roadmap row
 * numbers (Mission Control locked decision). Distinct, ascending.
 */
export function parsePrRefs(text: string): number[] {
  if (!text || typeof text !== 'string') return [];
  const nums = new Set<number>();
  // "PR #123" — tolerant of spacing: "PR#123", "pr #123", "PR   #123".
  for (const m of text.matchAll(/\bPR\s*#(\d+)\b/gi)) nums.add(Number(m[1]));
  // gh-resolved URL: github.com/<owner>/<repo>/pull/<n>
  for (const m of text.matchAll(/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/gi)) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}
