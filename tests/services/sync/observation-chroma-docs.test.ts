// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  buildObservationChromaDocs,
  type ChromaIndexableObservation,
} from '../../../src/services/sync/observation-chroma-docs.js';

const scope = { projectId: 'proj-1', teamId: 'team-1' };

function baseRow(overrides: Partial<ChromaIndexableObservation> = {}): ChromaIndexableObservation {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    content: 'the auth token refresh races on cold start',
    kind: 'discovery',
    actorId: null,
    serverSessionId: null,
    createdAtEpoch: 1_720_000_000_000,
    ...overrides,
  };
}

describe('buildObservationChromaDocs', () => {
  it('maps id + content + tenant/kind metadata one doc per observation', () => {
    const docs = buildObservationChromaDocs([baseRow()], scope);
    expect(docs).toHaveLength(1);
    const [doc] = docs;
    expect(doc.id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(doc.document).toBe('the auth token refresh races on cold start');
    expect(doc.metadata.projectId).toBe('proj-1');
    expect(doc.metadata.teamId).toBe('team-1');
    expect(doc.metadata.kind).toBe('discovery');
    expect(doc.metadata.observationType).toBe('discovery');
    expect(doc.metadata.observationId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(doc.metadata.createdAt).toBe(new Date(1_720_000_000_000).toISOString());
  });

  it('carries actorId when the row has an author', () => {
    const [doc] = buildObservationChromaDocs([baseRow({ actorId: 'human:alice@org' })], scope);
    expect(doc.metadata.actorId).toBe('human:alice@org');
  });

  it('emits empty-string actorId for a null author (collapses to metadata-absent in ChromaSync clean step)', () => {
    const [doc] = buildObservationChromaDocs([baseRow({ actorId: null })], scope);
    expect(doc.metadata.actorId).toBe('');
  });

  it('emits empty-string serverSessionId for a null session', () => {
    const [doc] = buildObservationChromaDocs([baseRow({ serverSessionId: null })], scope);
    expect(doc.metadata.serverSessionId).toBe('');
  });

  it('carries serverSessionId when present', () => {
    const [doc] = buildObservationChromaDocs([baseRow({ serverSessionId: 'sess-9' })], scope);
    expect(doc.metadata.serverSessionId).toBe('sess-9');
  });

  it('omits visibility when the row has none', () => {
    const [doc] = buildObservationChromaDocs([baseRow({ visibility: undefined })], scope);
    expect('visibility' in doc.metadata).toBe(false);
  });

  it('writes visibility when the row carries it (Phase 2 read-side mirror)', () => {
    const [doc] = buildObservationChromaDocs([baseRow({ visibility: 'team' })], scope);
    expect(doc.metadata.visibility).toBe('team');
  });

  it('writes a private visibility value verbatim', () => {
    const [doc] = buildObservationChromaDocs([baseRow({ visibility: 'private' })], scope);
    expect(doc.metadata.visibility).toBe('private');
  });
});
