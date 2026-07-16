// scripts/repro/orphaned-socket-repro.ts
//
// Windows/Bun listening-socket inheritance reproduction.
// Run: bun scripts/repro/orphaned-socket-repro.ts            (repro the leak)
//      REPRO_APPLY_FIX=1 bun scripts/repro/orphaned-socket-repro.ts   (verify the fix)
//
// Mechanism under test: a parent binds 127.0.0.1:PORT, then spawns a child with
// piped stdio (which forces bInheritHandles=TRUE on Windows). The orchestrator
// kills ONLY the parent (taskkill /PID <parent> /F, NOT /T) to simulate an
// unexpected worker death, then probes the port. If the child kept the inherited
// listening socket alive, the port stays LISTENING held by a process that is not
// accepting -> the exact production failure.
import http from 'http';
import net from 'net';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

const PORT = 37799; // deliberately NOT 37777 so the harness never fights a real worker
const HOST = '127.0.0.1';
const PIDFILE = path.join(os.tmpdir(), 'orphaned-socket-repro.pids.json');
const SELF = path.resolve(process.argv[1]);

function probePortHeld(): Promise<boolean> {
  // Real bind probe: true == something holds the port (EADDRINUSE).
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE'));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(PORT, HOST);
  });
}

async function runParent(): Promise<void> {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve());
    server.listen(PORT, HOST);
  });

  if (process.env.REPRO_APPLY_FIX === '1') {
    // Task 2 target. Dynamic import so Task 1 runs before the module exists.
    const mod = await import('../../src/services/infrastructure/socket-inherit.js');
    mod.makeListenSocketNonInheritable(server);
    console.error('[parent] applied makeListenSocketNonInheritable');
  }

  // Spawn a stand-in "chroma-mcp": a child that sleeps, with PIPED stdio so
  // Windows uses bInheritHandles=TRUE (the condition under which an inheritable
  // socket leaks). Under Bun this mirrors StdioClientTransport's spawn.
  const child: ChildProcess = spawn(process.execPath, [SELF, 'child'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  fs.writeFileSync(PIDFILE, JSON.stringify({ parent: process.pid, child: child.pid }));
  console.error(`[parent] pid=${process.pid} child=${child.pid} listening on ${HOST}:${PORT}`);
  // Hold open until killed by the orchestrator.
  setInterval(() => {}, 1 << 30);
}

function runChild(): void {
  // The inheriting stand-in: do nothing, keep any inherited handles open.
  console.error(`[child] pid=${process.pid} alive`);
  setInterval(() => {}, 1 << 30);
}

async function orchestrate(): Promise<number> {
  if (process.platform !== 'win32') {
    console.error('SKIP: this harness only reproduces on real Windows under Bun');
    return 0;
  }
  try { fs.rmSync(PIDFILE, { force: true }); } catch { /* fine */ }

  const parent = spawn(process.execPath, [SELF, 'parent'], { stdio: 'inherit', windowsHide: true });

  // Wait for the pidfile the parent writes once it is listening + has spawned the child.
  const deadline = Date.now() + 10_000;
  let pids: { parent: number; child: number } | null = null;
  while (Date.now() < deadline) {
    try { pids = JSON.parse(fs.readFileSync(PIDFILE, 'utf-8')); if (pids?.child) break; } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!pids?.child) { console.error('FATAL: parent never became ready'); parent.kill(); return 2; }

  // Kill ONLY the parent (simulate unexpected worker death). /F not /T: the child survives.
  spawnSync('taskkill', ['/PID', String(pids.parent), '/F'], { windowsHide: true });
  await new Promise((r) => setTimeout(r, 1500)); // let the OS settle

  const held = await probePortHeld();
  let result: string;
  let code: number;
  if (held) {
    result = `RESULT: PORT_HELD_BY_ORPHAN pid=${pids.child}`;
    code = 1;
  } else {
    result = 'RESULT: PORT_FREE';
    code = 0;
  }
  console.log(result);

  // Cleanup: always kill the surviving child so the harness leaves nothing behind.
  spawnSync('taskkill', ['/PID', String(pids.child), '/T', '/F'], { windowsHide: true });
  try { fs.rmSync(PIDFILE, { force: true }); } catch { /* fine */ }
  return code;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'orchestrate';
  if (mode === 'parent') return runParent();
  if (mode === 'child') return runChild();
  process.exit(await orchestrate());
}

void main();
