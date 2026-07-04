// SPDX-License-Identifier: Apache-2.0
//
// Regression lock for the WS2 Phase 4 UUID-drop reconciliation. queryChroma()
// (legacy, numeric) parses doc ids through the obs_<int>_ regex and silently
// drops UUID-shaped ids; queryChromaByScope() (new) must preserve them verbatim.
// We spy ChromaMcpManager.getInstance().callTool so no real chroma-mcp
// subprocess is ever spawned.

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

// Configurable synthetic Chroma query result + last query args, set per-test.
let queryResult: {
  ids?: string[][];
  metadatas?: Array<Array<Record<string, unknown> | null>>;
  distances?: number[][];
} = {};
let lastQueryArgs: Record<string, unknown> | undefined;

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (toolName: string, args: Record<string, unknown>) => {
        if (toolName === 'chroma_query_documents') {
          lastQueryArgs = args;
          return queryResult;
        }
        // chroma_create_collection (ensureCollectionExists) and anything else.
        return {};
      },
    }),
  },
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

const UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const UUID_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('ChromaSync UUID-safe scope query', () => {
  beforeEach(() => {
    queryResult = {};
    lastQueryArgs = undefined;
  });

  it('queryChromaByScope preserves a UUID-shaped doc id (the fix)', async () => {
    queryResult = {
      ids: [[UUID_A]],
      metadatas: [[{ projectId: 'p', teamId: 't' }]],
      distances: [[0.12]],
    };
    const sync = new ChromaSync('project');
    const result = await sync.queryChromaByScope({ query: 'anything', limit: 10 });
    expect(result.ids).toEqual([UUID_A]);
    expect(result.metadatas[0]).toEqual({ projectId: 'p', teamId: 't' });
    expect(result.distances[0]).toBe(0.12);
  });

  it('legacy queryChroma DROPS the same UUID id (bug is real + quarantined)', async () => {
    queryResult = {
      ids: [[UUID_A]],
      metadatas: [[{ projectId: 'p' }]],
      distances: [[0.12]],
    };
    const sync = new ChromaSync('project');
    const legacy = await sync.queryChroma('anything', 10);
    // A UUID matches none of obs_/summary_/prompt_ → silently dropped to [].
    expect(legacy.ids).toEqual([]);
  });

  it('legacy queryChroma still returns numeric ids for obs_<int>_ shapes (contract intact)', async () => {
    queryResult = {
      ids: [['obs_42_narrative']],
      metadatas: [[{ sqlite_id: 42 }]],
      distances: [[0.05]],
    };
    const sync = new ChromaSync('project');
    const legacy = await sync.queryChroma('anything', 10);
    expect(legacy.ids).toEqual([42]);
  });

  it('queryChromaByScope collapses duplicate doc ids and preserves order', async () => {
    queryResult = {
      ids: [[UUID_A, UUID_B, UUID_A]],
      metadatas: [[{ n: 1 }, { n: 2 }, { n: 3 }]],
      distances: [[0.1, 0.2, 0.3]],
    };
    const sync = new ChromaSync('project');
    const result = await sync.queryChromaByScope({ query: 'anything', limit: 10 });
    expect(result.ids).toEqual([UUID_A, UUID_B]);
    // First occurrence wins for the aligned metadata/distance.
    expect(result.metadatas).toEqual([{ n: 1 }, { n: 2 }]);
    expect(result.distances).toEqual([0.1, 0.2]);
  });

  it('queryChromaByScope forwards the where filter + query params to callTool', async () => {
    queryResult = { ids: [[UUID_A]], metadatas: [[null]], distances: [[0]] };
    const sync = new ChromaSync('project');
    const where = { $and: [{ projectId: 'p' }, { teamId: 't' }] };
    await sync.queryChromaByScope({ query: 'q', limit: 5, where });
    expect(lastQueryArgs?.where).toEqual(where);
    expect(lastQueryArgs?.n_results).toBe(5);
    expect(lastQueryArgs?.query_texts).toEqual(['q']);
  });
});
