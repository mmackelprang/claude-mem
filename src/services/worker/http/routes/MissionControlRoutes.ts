// src/services/worker/http/routes/MissionControlRoutes.ts
import express, { Request, Response } from 'express';
import { DatabaseManager } from '../../DatabaseManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { queryProgress, queryTeamSessions, queryTeamPrs } from '../../../mission-control/ProgressQuery.js';
import { queryVelocity } from '../../../mission-control/VelocityQuery.js';
import { queryNextSteps } from '../../../mission-control/NextStepsFeed.js';
import { runAttentionMine, readOpenAttentionItems } from '../../../mission-control/AttentionMiner.js';
import { buildEscalationContext } from '../../../mission-control/escalationContext.js';
import { parseBuilderQueue } from '../../../mission-control/BuilderQueueParser.js';
import { createGitGhBoundary, type GitGhBoundary, type RepoWebInfo } from '../../../mission-control/shell.js';
import { loadSpecFiles } from '../../../mission-control/loadSpecFiles.js';
import { resolveRepoRoot, REPO_ROOT_DEFERRED_REASON } from '../../../mission-control/repo-root.js';
import { logger } from '../../../../utils/logger.js';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

export class MissionControlRoutes extends BaseRouteHandler {
  private boundary: GitGhBoundary;
  private lastMineAt = 0;
  private readonly minMineIntervalMs = 60_000;
  private ghAvailableCache: boolean | null = null;
  private ghAvailableCachedAt = 0;
  private repoWebInfoCache: RepoWebInfo | null | undefined;

  constructor(
    private dbManager: DatabaseManager,
    boundary?: GitGhBoundary,
    // Captured ONCE (not per-request). Default resolves the real root; tests inject
    // `null` (deferred) or a fixture dir (resolved) for determinism. Threaded as the
    // git/gh cwd so `git log` (velocity series), `gh pr list` (reviews), and
    // `gh repo view` (link base) run against the correct repo — a deployed worker's
    // cwd may be an upstream checkout. `undefined` cwd ⇒ worker cwd (Phase-1 behavior).
    private repoRoot: string | null = resolveRepoRoot(),
  ) {
    super();
    this.boundary = boundary ?? createGitGhBoundary(this.repoRoot ?? undefined);
  }

  /**
   * Memoized `ghAvailable` probe. `boundary.ghAvailable()` runs a networked
   * `gh auth status`; calling it on every request would let a slow/hung spawn
   * block the single-threaded worker. Recompute at most once per 60s.
   */
  private cachedGhAvailable(): boolean {
    if (this.ghAvailableCache !== null && Date.now() - this.ghAvailableCachedAt < 60_000) {
      return this.ghAvailableCache;
    }
    this.ghAvailableCache = this.boundary.ghAvailable();
    this.ghAvailableCachedAt = Date.now();
    return this.ghAvailableCache;
  }

  private cachedRepoWebInfo(): RepoWebInfo | null {
    if (this.repoWebInfoCache !== undefined) return this.repoWebInfoCache;
    this.repoWebInfoCache = this.boundary.repoWebInfo?.() ?? null;
    return this.repoWebInfoCache;
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
      // specMiningEnabled tracks the same repo-root gate as loadSpecFiles(): when
      // deferred (#24) the miner must NOT auto-resolve spec:/question: items it
      // never actually checked. loadSpecFiles() returns [] and mining is skipped.
      runAttentionMine(db, this.boundary, {
        specFiles: loadSpecFiles(this.repoRoot),
        specMiningEnabled: this.repoRoot !== null,
        now,
      });
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
    // `specMiningDeferred` tells the UI that the Proposed-spec-review and
    // doc-Open-Questions sources are gated off (#24) — so the pane can explain
    // why "reviews" shows PRs only and "questions" is empty, instead of looking
    // silently broken. Escalations (SQLite) + open-PR reviews (gh) still ship.
    const webInfo = this.cachedRepoWebInfo();
    res.json({
      items: readOpenAttentionItems(db, project),
      ghAvailable: this.cachedGhAvailable(),
      specMiningDeferred: this.repoRoot === null,
      repoWebBase: webInfo?.repoWebBase ?? null,
      defaultBranch: webInfo?.defaultBranch ?? null,
      escalationContext: buildEscalationContext(db, Date.now()),
    });
  });

  private handleProgress = this.wrapHandler((req: Request, res: Response): void => {
    const by = req.query.by === 'human' ? 'human' : 'agent';
    const granularity = req.query.granularity === 'week' ? 'week' : 'day';
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    const sinceRaw = typeof req.query.since === 'string' ? Number(req.query.since) : NaN;
    const sinceEpoch = Number.isFinite(sinceRaw) ? sinceRaw : undefined;
    const db = this.dbManager.getSessionStore().db;
    res.json({
      buckets: queryProgress(db, { by, granularity, project, sinceEpoch }),
      sessions: queryTeamSessions(db, { project, sinceEpoch }),
      prs: queryTeamPrs(db, { project, sinceEpoch }),
    });
  });

  private handleVelocity = this.wrapHandler((req: Request, res: Response): void => {
    // DEFERRED (#24): velocity reads docs/BUILDER_QUEUE.md, a repo-root file the
    // deployed worker cannot resolve (getPackageRoot() = plugin install root).
    // Gate to a clearly-labeled deferred state — never call getPackageRoot() for
    // a repo file, never crash. The route stays registered so #24 re-enables it
    // by implementing resolveRepoRoot() (and re-adding the UI pane).
    const root = this.repoRoot;
    if (root === null) {
      res.json({ deferred: true, reason: REPO_ROOT_DEFERRED_REASON, openCount: null, shippedCount: null, shippedByWeek: [] });
      return;
    }
    const queuePath = path.join(root, 'docs', 'BUILDER_QUEUE.md');
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
