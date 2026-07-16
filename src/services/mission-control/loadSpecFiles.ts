// src/services/mission-control/loadSpecFiles.ts
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import { getPackageRoot } from '../../shared/paths.js';

const SPEC_DIRS = [
  'docs/superpowers/specs',
  'docs/architecture',
  'docs/architecture/decisions',
];

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isFile() && entry.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Read spec + ADR markdown off disk for the miner. Best-effort: unreadable files are skipped. */
export function loadSpecFiles(): { path: string; content: string }[] {
  const root = getPackageRoot();
  const files: { path: string; content: string }[] = [];
  for (const rel of SPEC_DIRS) {
    for (const full of walkMarkdown(path.join(root, rel))) {
      try {
        const relPath = path.relative(root, full).split(path.sep).join('/');
        files.push({ path: relPath, content: readFileSync(full, 'utf8') });
      } catch { /* skip unreadable file */ }
    }
  }
  return files;
}
