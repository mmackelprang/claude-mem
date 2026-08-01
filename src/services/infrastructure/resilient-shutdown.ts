// src/services/infrastructure/resilient-shutdown.ts
//
// Fork-only fault-isolated teardown (#40).
//
// Upstream's performGracefulShutdown (GracefulShutdown.ts:30-58) is an
// UNGUARDED sequential await chain of six steps. There is no try/catch in the
// function, so a rejection at step N forfeits steps N+1..6.
//
// Measured on 2026-07-31: step 1 (closeHttpServer) rejects with
// ERR_SERVER_NOT_RUNNING ("Server is not running.") ~1 ms in — so step 4,
// chromaMcpManager.stop(), never runs and a ~137 MB chroma-mcp pair leaks on
// every worker restart. It failed this way on 9 of the last 9 shutdowns
// (2026-07-30 21:09 through 2026-07-31 19:34), i.e. 100%. The deadline is NOT
// involved: "Graceful shutdown deadline exceeded" appears nowhere in the logs.
//
// ROOT CAUSE OF THE REJECTION (measured, not inferred — scratch node:http
// script, Bun 1.3.14 vs Node 24.18.1, reproduced identically with zero
// connections and with a live keep-alive connection):
//
//   Bun 1.3.14   listening after closeAllConnections() -> false
//                close() -> REJECT code=ERR_SERVER_NOT_RUNNING
//   Node 24.18.1 listening after closeAllConnections() -> true
//                close() -> RESOLVE
//
// Bun's node:http shim makes server.closeAllConnections() ALSO stop the
// listener, so the subsequent server.close() at GracefulShutdown.ts:68 always
// calls back ERR_SERVER_NOT_RUNNING. This is deterministic under Bun, not a
// race, and a genuine double-close is falsified — no second close is needed to
// produce the error.
//
// This runs the same steps in the same order, each in its own try/catch, so no
// single failure can forfeit subprocess teardown. GracefulShutdown.ts is
// byte-identical to upstream f5633c1f and is deliberately NOT edited
// (ADR 0002 §9).
import http from 'http';
import { logger } from '../../utils/logger.js';
import { getSupervisor } from '../../supervisor/index.js';
import type { GracefulShutdownConfig } from './GracefulShutdown.js';

export interface ResilientShutdownResult {
  /** True when chromaMcpManager.stop() ran to completion (or there was no manager). */
  chromaStopped: boolean;
  /** Names of the steps that threw. Empty on a fully clean shutdown. */
  failedSteps: string[];
}

async function runStep(name: string, fn: () => Promise<void>, failed: string[]): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    failed.push(name);
    logger.warn('SHUTDOWN', 'Teardown step failed — continuing with the remaining steps', {
      step: name,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

export async function performResilientShutdown(
  config: GracefulShutdownConfig
): Promise<ResilientShutdownResult> {
  logger.info('SYSTEM', 'Shutdown initiated');

  const failedSteps: string[] = [];
  const server = config.server;

  if (server) {
    await runStep('closeHttpServer', async () => {
      await closeHttpServer(server);
      logger.info('SYSTEM', 'HTTP server closed');
    }, failedSteps);
  }

  await runStep('sessionManager.shutdownAll', () => config.sessionManager.shutdownAll(), failedSteps);

  const mcpClient = config.mcpClient;
  if (mcpClient) {
    await runStep('mcpClient.close', async () => {
      await mcpClient.close();
      logger.info('SYSTEM', 'MCP client closed');
    }, failedSteps);
  }

  // Step 4 — the one the leak is about. Reached unconditionally now.
  let chromaStopped = true;
  const chromaMcpManager = config.chromaMcpManager;
  if (chromaMcpManager) {
    logger.info('SHUTDOWN', 'Stopping Chroma MCP connection...');
    chromaStopped = await runStep('chromaMcpManager.stop', () => chromaMcpManager.stop(), failedSteps);
    if (chromaStopped) {
      logger.info('SHUTDOWN', 'Chroma MCP connection stopped');
    }
  }

  const dbManager = config.dbManager;
  if (dbManager) {
    await runStep('dbManager.close', () => dbManager.close(), failedSteps);
  }

  await runStep('supervisor.stop', () => getSupervisor().stop(), failedSteps);

  if (failedSteps.length > 0) {
    logger.warn('SYSTEM', 'Worker shutdown complete with failed steps', { failedSteps });
  } else {
    logger.info('SYSTEM', 'Worker shutdown complete');
  }

  return { chromaStopped, failedSteps };
}

/**
 * Fork-owned copy of GracefulShutdown.ts:60-75, plus the `!server.listening`
 * short-circuit and the ERR_SERVER_NOT_RUNNING tolerance.
 *
 * The `!server.listening` guard is not merely defensive — it is the ACTUAL FIX
 * for step 1 on Bun. Measured on Bun 1.3.14, `closeAllConnections()` also stops
 * the listener (`server.listening` flips true -> false across that one call),
 * so upstream's unconditional `close()` deterministically calls back
 * ERR_SERVER_NOT_RUNNING. Node 24.18.1 keeps the listener up and resolves,
 * which is why this never showed up upstream. Skipping `close()` when the
 * listener is already down is therefore the correct behaviour on both runtimes:
 * an already-closed server is the goal state, not a failure — treating it as one
 * is what forfeited steps 2-6.
 *
 * The err-code tolerance below is kept as belt and braces for the Node path and
 * for any other runtime that closes the listener out from under us.
 */
async function closeHttpServer(server: http.Server): Promise<void> {
  server.closeAllConnections();

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => { setTimeout(resolve, 500); });
  }

  if (!server.listening) {
    logger.info('SYSTEM', 'HTTP server already closed — skipping close()');
  } else {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => { setTimeout(resolve, 500); });
    logger.info('SYSTEM', 'Waited for Windows port cleanup');
  }
}
