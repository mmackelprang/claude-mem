// SPDX-License-Identifier: Apache-2.0
//
// Single source of truth for the Chroma document shape of a server/team-mode
// (UUID-keyed) observation. Consumed by the server-beta BullMQ generation
// worker (src/server/generation/ProviderObservationGenerator.ts), so
// index-time metadata can never drift from what the read-side `where` filter
// (ChromaObservationRecall.buildWhere) expects.
// (The former cmem-sdk write path, src/sdk/index.ts indexObservationsToChroma,
// was deleted upstream in v13.11.0. See ADR 0002 §4.4.)
//
// OVERRIDE-C: import the ChromaDocument shape TYPE-ONLY so this module never
// pulls ChromaSync's runtime graph (bun:sqlite via lazy require) into the SDK
// bundle. Do NOT add any value-level import from ChromaSync.ts here.
import type { ChromaDocument } from './ChromaSync.js';

export interface ChromaIndexableObservation {
  id: string;
  content: string;
  kind: string;
  actorId: string | null;
  serverSessionId: string | null;
  createdAtEpoch: number;
  // Phase 2 (visibility) is LIVE: PostgresObservation.visibility always carries
  // a value (NOT NULL, default 'team'). Read structurally so this builder needs
  // no change and always emits metadata.visibility for a real Postgres row.
  visibility?: string | null;
}

export function buildObservationChromaDocs(
  observations: ChromaIndexableObservation[],
  scope: { projectId: string; teamId: string },
): ChromaDocument[] {
  return observations.map((observation) => {
    const metadata: Record<string, string | number> = {
      projectId: scope.projectId,
      teamId: scope.teamId,
      kind: observation.kind,
      observationId: observation.id,
      observationType: observation.kind,
      // Empty string collapses to metadata-absent via ChromaSync's clean step
      // (ChromaSync.ts:312-316), so a null/local author indexes as absent.
      actorId: observation.actorId ?? '',
      serverSessionId: observation.serverSessionId ?? '',
      createdAt: new Date(observation.createdAtEpoch).toISOString(),
    };
    // Phase 2 visibility seam: written whenever the row carries a value. Live
    // Postgres rows always do, so metadata.visibility is always present and the
    // read-side `where` visibility mirror (ChromaObservationRecall.buildWhere)
    // can enforce the same predicate as PostgresObservationRepository.search().
    const visibility = observation.visibility;
    if (typeof visibility === 'string' && visibility.length > 0) {
      metadata.visibility = visibility;
    }
    return { id: observation.id, document: observation.content, metadata };
  });
}
