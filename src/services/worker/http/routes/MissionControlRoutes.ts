// src/services/worker/http/routes/MissionControlRoutes.ts
import express, { Request, Response } from 'express';
import { DatabaseManager } from '../../DatabaseManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { queryProgress } from '../../../mission-control/ProgressQuery.js';
import { queryVelocity } from '../../../mission-control/VelocityQuery.js';
import { queryNextSteps } from '../../../mission-control/NextStepsFeed.js';
import { runAttentionMine, readOpenAttentionItems } from '../../../mission-control/AttentionMiner.js';
import { parseBuilderQueue } from '../../../mission-control/BuilderQueueParser.js';
import { createGitGhBoundary, type GitGhBoundary } from '../../../mission-control/shell.js';
import { loadSpecFiles } from '../../../mission-control/loadSpecFiles.js';
import { getPackageRoot } from '../../../../shared/paths.js';
import { logger } from '../../../../utils/logger.js';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

export class MissionControlRoutes extends BaseRouteHandler {
  private boundary: GitGhBoundary;
  private lastMineAt = 0;
  private readonly minMineIntervalMs = 60_000;

  constructor(private dbManager: DatabaseManager, boundary?: GitGhBoundary) {
    super();
    this.boundary = boundary ?? createGitGhBoundary();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/mission-control/attention', this.handleAttention.bind(this));
    app.get('/api/mission-control/progress', this.handleProgress.bind(this));
    app.get('/api/mission-control/velocity', this.handleVelocity.bind(this));
    app.get('/api/mission-control/next-steps', this.handleNextSteps.bind(this));
  }

  /** Runs a mine pass, throttled unless forced. Never throws — mining is best-effort. */
  mineOnce(force = false): boolean {
    const now = Date.now();
    if (!force && now - this.lastMineAt < this.minMineIntervalMs) return false;
    this.lastMineAt = now;
    try {
      const db = this.dbManager.getSessionStore().db;
      runAttentionMine(db, this.boundary, { specFiles: loadSpecFiles(), now });
      return true;
    } catch (error) {
      logger.warn('WORKER', 'Attention mine pass failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private handleAttention = this.wrapHandler((req: Request, res: Response): void => {
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    this.mineOnce(refresh);
    const db = this.dbManager.getSessionStore().db;
    res.json({ items: readOpenAttentionItems(db, project), ghAvailable: this.boundary.ghAvailable() });
  });

  private handleProgress = this.wrapHandler((req: Request, res: Response): void => {
    const by = req.query.by === 'human' ? 'human' : 'agent';
    const granularity = req.query.granularity === 'week' ? 'week' : 'day';
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    const db = this.dbManager.getSessionStore().db;
    res.json({ buckets: queryProgress(db, { by, granularity, project }) });
  });

  private handleVelocity = this.wrapHandler((req: Request, res: Response): void => {
    const queuePath = path.join(getPackageRoot(), 'docs', 'BUILDER_QUEUE.md');
    let parsed;
    try {
      if (!existsSync(queuePath)) throw new Error(`BUILDER_QUEUE.md not found at ${queuePath}`);
      parsed = parseBuilderQueue(readFileSync(queuePath, 'utf8'));
    } catch (error) {
      // Loud, visible failure state — never a silent empty velocity view (R3).
      res.status(200).json({ error: error instanceof Error ? error.message : String(error), openCount: null, shippedCount: null, shippedByWeek: [] });
      return;
    }
    res.json(queryVelocity(parsed, this.boundary));
  });

  private handleNextSteps = this.wrapHandler((req: Request, res: Response): void => {
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    const db = this.dbManager.getSessionStore().db;
    res.json({ items: queryNextSteps(db, { project }) });
  });
}
