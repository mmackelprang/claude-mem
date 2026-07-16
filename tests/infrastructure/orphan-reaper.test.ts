// tests/infrastructure/orphan-reaper.test.ts
import { describe, it, expect } from 'bun:test';
import { filterChromaOrphans, type ChromaProcess } from '../../src/services/infrastructure/orphan-reaper.js';

const OLD = 1_000; // epoch ms far in the past → always older than the age guard
const rows: ChromaProcess[] = [
  { pid: 1001, name: 'python.exe', commandLine: 'python ... chroma-mcp --client-type persistent --data-dir C:/Users/x/.claude-mem/chroma', createdEpochMs: OLD },
  { pid: 1002, name: 'uv.exe',     commandLine: 'uv run --from chroma-mcp==0.2.6 chroma-mcp', createdEpochMs: OLD },
  { pid: 1003, name: 'python.exe', commandLine: 'python my_unrelated_script.py', createdEpochMs: OLD },
  { pid: 1004, name: 'node.exe',   commandLine: 'node something', createdEpochMs: OLD },
];

describe('filterChromaOrphans', () => {
  it('selects only chroma-mcp processes by command-line signature', () => {
    const picked = filterChromaOrphans(rows).map((p) => p.pid).sort();
    expect(picked).toEqual([1001, 1002]); // NOT the unrelated python or node
  });

  it('returns empty for no matches', () => {
    expect(filterChromaOrphans([rows[2], rows[3]])).toEqual([]);
  });

  it('does NOT match an incidental "chroma-mcp" mention with no invocation token', () => {
    // e.g. a grep/ripgrep over the source, an editor, a shell history line —
    // has the string but neither --client-type nor --from chroma-mcp.
    const grep: ChromaProcess = { pid: 9001, name: 'rg.exe', commandLine: 'rg --files chroma-mcp', createdEpochMs: OLD };
    const editor: ChromaProcess = { pid: 9002, name: 'Code.exe', commandLine: 'Code.exe orphan-reaper.ts chroma-mcp', createdEpochMs: OLD };
    expect(filterChromaOrphans([grep, editor])).toEqual([]);
  });

  it('matches the running-server form (chroma-mcp.exe --client-type http, remote mode)', () => {
    // Mark's real config: remote http client, NO --data-dir in the command line.
    const httpClient: ChromaProcess = {
      pid: 9101, name: 'chroma-mcp.exe',
      commandLine: '"C:/…/chroma-mcp.exe" --client-type http --host fw.appserver.lan --port 8000 --ssl false',
      createdEpochMs: OLD,
    };
    expect(filterChromaOrphans([httpClient]).map((p) => p.pid)).toEqual([9101]);
  });

  it('does NOT reap a chroma-mcp process younger than the age guard', () => {
    const now = 1_000_000;
    const fresh: ChromaProcess = {
      pid: 2001, name: 'python.exe',
      commandLine: 'uv run --from chroma-mcp chroma-mcp --client-type persistent',
      createdEpochMs: now - 500, // 0.5s old — below the 2s guard
    };
    const stale: ChromaProcess = { ...fresh, pid: 2002, createdEpochMs: now - 60_000 }; // 60s old
    const picked = filterChromaOrphans([fresh, stale], now).map((p) => p.pid);
    expect(picked).toEqual([2002]); // only the stale one
  });

  it('reaps a chroma-mcp process whose age is unknown (createdEpochMs=0, fail-open)', () => {
    const unknown: ChromaProcess = { pid: 3001, name: 'python.exe', commandLine: 'uvx --from chroma-mcp chroma-mcp --client-type http', createdEpochMs: 0 };
    expect(filterChromaOrphans([unknown], 1_000_000).map((p) => p.pid)).toEqual([3001]);
  });
});
