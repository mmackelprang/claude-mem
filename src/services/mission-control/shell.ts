// src/services/mission-control/shell.ts

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runCommand(cmd: string[], cwd?: string): ShellResult {
  try {
    const result = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
    return {
      stdout: new TextDecoder().decode(result.stdout).trim(),
      stderr: new TextDecoder().decode(result.stderr).trim(),
      exitCode: result.exitCode ?? 1,
    };
  } catch (error) {
    // Bun.spawnSync throws when the binary is missing — normalize to 127.
    return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 127 };
  }
}

export interface OpenPr {
  number: number;
  title: string;
  url: string;
}

export interface MergeCommit {
  sha: string;
  dateIso: string;
  subject: string;
}

export interface RepoWebInfo {
  repoWebBase: string;   // e.g. https://github.com/mmackelprang/claude-mem
  defaultBranch: string; // e.g. main
}

export interface GitGhBoundary {
  ghAvailable(): boolean;
  listOpenPrs(): OpenPr[];
  listMergeCommits(sinceIso?: string): MergeCommit[];
  // Optional so existing test stubs (which omit it) still satisfy the type.
  // Resolves the fork when the boundary was created with the repo-root cwd.
  repoWebInfo?(): RepoWebInfo | null;
}

// Unit-separator field delimiter for `git log --pretty` output. Using a
// non-printable delimiter lets us split each commit line into (sha, dateIso,
// subject) without a subject containing the delimiter.
const FIELD_SEP = '\x1f';

export function createGitGhBoundary(cwd?: string): GitGhBoundary {
  return {
    ghAvailable(): boolean {
      return runCommand(['gh', '--version'], cwd).exitCode === 0
        && runCommand(['gh', 'auth', 'status'], cwd).exitCode === 0;
    },

    listOpenPrs(): OpenPr[] {
      const result = runCommand(['gh', 'pr', 'list', '--state', 'open', '--json', 'number,title,url'], cwd);
      if (result.exitCode !== 0) return []; // graceful degradation (R5)
      try {
        const parsed = JSON.parse(result.stdout) as Array<{ number: number; title: string; url: string }>;
        return parsed.map(p => ({ number: p.number, title: p.title, url: p.url }));
      } catch {
        return [];
      }
    },

    listMergeCommits(sinceIso?: string): MergeCommit[] {
      const args = ['git', 'log', '--merges', `--pretty=format:%H${FIELD_SEP}%cI${FIELD_SEP}%s`];
      if (sinceIso) args.push(`--since=${sinceIso}`);
      const result = runCommand(args, cwd);
      if (result.exitCode !== 0 || result.stdout.length === 0) return [];
      return result.stdout
        .split('\n')
        .map(line => line.split(FIELD_SEP))
        .filter(parts => parts.length === 3)
        .map(([sha, dateIso, subject]) => ({ sha, dateIso, subject }));
    },

    repoWebInfo(): RepoWebInfo | null {
      const result = runCommand(['gh', 'repo', 'view', '--json', 'url,defaultBranchRef'], cwd);
      if (result.exitCode !== 0) return null;
      try {
        const parsed = JSON.parse(result.stdout) as { url?: string; defaultBranchRef?: { name?: string } };
        if (!parsed.url) return null;
        return { repoWebBase: parsed.url, defaultBranch: parsed.defaultBranchRef?.name ?? 'main' };
      } catch {
        return null;
      }
    },
  };
}
