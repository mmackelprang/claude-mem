// SPDX-License-Identifier: Apache-2.0
import express, { Request, Response } from 'express';
import { paths } from '../../../../shared/paths.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../../../shared/SettingsDefaultsManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

export type RuntimeRole = 'worker' | 'server' | 'unknown';

/** Authoritative role from the worker's own config (env override + settings.json). */
export function resolveRuntimeRole(settings: Pick<SettingsDefaults, 'CLAUDE_MEM_RUNTIME'>): RuntimeRole {
  const value = (settings.CLAUDE_MEM_RUNTIME ?? '').trim().toLowerCase();
  if (value === 'worker') return 'worker';
  if (value === 'server') return 'server';
  return 'unknown';
}

export class RuntimeRoleRoutes extends BaseRouteHandler {
  setupRoutes(app: express.Application): void {
    app.get('/api/runtime-role', this.handleGetRole.bind(this));
  }

  private handleGetRole = this.wrapHandler((_req: Request, res: Response): void => {
    let role: RuntimeRole = 'unknown';
    try {
      const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
      role = resolveRuntimeRole(settings);
    } catch {
      role = 'unknown'; // UI shows the manual toggle (handoff §3)
    }
    res.json({ role });
  });
}
