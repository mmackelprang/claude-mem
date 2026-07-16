// SPDX-License-Identifier: Apache-2.0
import express, { Request, Response } from 'express';
import type { Database } from 'bun:sqlite';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

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
    res.json(queryIngestStatus(this.getDatabase(), WINDOW_SECONDS, nowEpoch));
  });
}
