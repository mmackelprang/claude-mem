// SPDX-License-Identifier: Apache-2.0
import express, { Request, Response } from 'express';
import type { Database } from 'bun:sqlite';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { logger } from '../../../../utils/logger.js';

export interface IngestStatus {
  lastObservationAt: number | null; // epoch seconds (created_at_epoch)
  countLastWindow: number;
  window: string;
}

const WINDOW_SECONDS = 24 * 3600;

/** Pure query so it unit-tests against an in-memory DB. */
export function queryIngestStatus(db: Database, windowSeconds: number, nowEpoch: number): IngestStatus {
  const since = nowEpoch - windowSeconds;
  const row = db
    .query(`SELECT MAX(created_at_epoch) AS last,
                   SUM(CASE WHEN created_at_epoch >= ? THEN 1 ELSE 0 END) AS cnt
            FROM observations`)
    .get(since) as { last: number | null; cnt: number | null };
  return {
    lastObservationAt: row?.last ?? null,
    countLastWindow: Number(row?.cnt ?? 0),
    window: windowSeconds === WINDOW_SECONDS ? '24h' : `${Math.round(windowSeconds / 3600)}h`,
  };
}

export class IngestStatusRoutes extends BaseRouteHandler {
  constructor(private readonly getDatabase: () => Database) { super(); }

  setupRoutes(app: express.Application): void {
    app.get('/api/ingest-status', this.handleGet.bind(this));
  }

  private handleGet = this.wrapHandler((_req: Request, res: Response): void => {
    const nowEpoch = Math.floor(Date.now() / 1000);
    const status = queryIngestStatus(this.getDatabase(), WINDOW_SECONDS, nowEpoch);

    // "No observation in the whole window" is the capture-outage signature. The
    // UI shows it, but nothing lands in the log, so a post-hoc investigation has
    // no record of when capture stopped. WARN only on the dead case; the healthy
    // path stays at debug so a polling UI cannot flood the log.
    if (status.lastObservationAt === null || status.countLastWindow === 0) {
      logger.warn('INGEST', 'ingest-status: no observations ingested in the window', undefined, {
        window: status.window,
        countLastWindow: status.countLastWindow,
        lastObservationAt: status.lastObservationAt,
        secondsSinceLastObservation:
          status.lastObservationAt === null ? null : nowEpoch - status.lastObservationAt,
      });
    } else {
      logger.debug('INGEST', 'ingest-status: observations are arriving', undefined, {
        window: status.window,
        countLastWindow: status.countLastWindow,
      });
    }

    res.json(status);
  });
}
