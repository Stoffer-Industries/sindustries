#!/usr/bin/env node
/**
 * platform-supervisor.mjs — the entrypoint of the consolidated Fly staging
 * platform (task 219fb673).
 *
 * Fly gives each process group its own Machine, so the cost saving only
 * exists if all four services live in ONE Machine. That means one process
 * group whose entrypoint is this supervisor: it spawns the four services
 * plus the nginx router inside the container and stays in the foreground
 * (when the entrypoint exits, Fly kills the Machine).
 *
 * Responsibilities:
 *   - build each child's environment from the app-level secrets (see
 *     platform-services.mjs for the mapping and why it exists);
 *   - restart a crashed child with exponential backoff;
 *   - forward SIGTERM/SIGINT to every child so a deploy drains cleanly;
 *   - expose a status payload on 127.0.0.1:<status port>/status with each
 *     child's pid, state, restart count, last exit code, RSS and heartbeat.
 *
 * The status payload is what the nginx router exposes publicly at
 * /__status, and it is what the Fly http_check targets — the platform's
 * liveness is "the router is up and the supervisor can answer", not "any one
 * service happens to be listening".
 *
 * No runtime dependencies: this file runs on the plain Node in the image.
 *
 * Usage:
 *   node infra/cloud/platform/platform-supervisor.mjs [--help]
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import process from 'node:process';

import {
  CHILDREN,
  PLATFORM_APP,
  ROUTER,
  ROUTER_PORT,
  ROUTER_STATUS_PATH,
  STATUS_PATH,
  STATUS_PORT,
  backoffDelay,
  buildChildEnv,
  missingRequiredSources,
} from './platform-services.mjs';

const HELP = `platform-supervisor — supervisor for the consolidated Fly staging platform

Usage:
  node infra/cloud/platform/platform-supervisor.mjs [--help]

Environment:
  PLATFORM_*_DATABASE_URL   app-level database URLs, one per schema
                            (mapped to each child's own DATABASE_URL)
  PLATFORM_*_REDIS_URL      app-level Redis URLs, one per service
  PLATFORM_*_CORS_ALLOWED_ORIGINS
                            per-service CORS allow-lists
  PLATFORM_ROUTER_PORT      router listen port (default ${ROUTER_PORT})
  PLATFORM_STATUS_PORT      supervisor status port (default ${STATUS_PORT})
  PLATFORM_APP_DIR          working directory for the children (default: cwd)

Endpoints:
  http://127.0.0.1:${STATUS_PORT}${STATUS_PATH}   supervisor status (loopback only)
  http://<router>:${ROUTER_PORT}${ROUTER_STATUS_PATH}   status via the router (public)
`;

/**
 * Read a child's resident set size in kilobytes.
 *
 * Linux (the image's platform) exposes it in /proc. Returns null when the
 * process is gone or the platform does not expose it — RSS is diagnostic
 * output, never a gate.
 *
 * @param {number|null} pid
 * @returns {number|null}
 */
export function readRssKb(pid) {
  if (!pid) return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * A supervised child process.
 */
class Child {
  /**
   * @param {object} spec  a CHILDREN entry
   * @param {object} deps  injected dependencies (spawn, env, now, logger)
   */
  constructor(spec, deps) {
    this.spec = spec;
    this.name = spec.name;
    this.role = spec.role ?? 'service';
    this.deps = deps;
    this.state = 'pending';
    this.pid = null;
    this.restarts = 0;
    this.exitCode = null;
    this.lastExitAt = null;
    this.startedAt = null;
    this.lastOutputAt = null;
    this.heartbeatAt = null;
    this.proc = null;
    this.restartTimer = null;
  }

  /** The environment this child runs with. */
  env() {
    return buildChildEnv(this.spec, this.deps.env);
  }

  /** Spawn the child (first boot). */
  start() {
    this.clearRestartTimer();
    const env = this.env();
    const child = this.deps.spawn(this.spec.command, {
      env,
      cwd: this.deps.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = child;
    this.pid = child.pid ?? null;
    this.state = 'running';
    this.startedAt = this.deps.now();
    this.lastOutputAt = this.startedAt;
    this.exitCode = null;

    this.attachStream(child.stdout, 'out');
    this.attachStream(child.stderr, 'err');

    child.on('error', (err) => {
      this.deps.logger(`[${this.name}] failed to start: ${err.message}`);
      this.state = 'crashed';
    });

    child.on('exit', (code, signal) => {
      this.pid = null;
      this.exitCode = code;
      this.lastExitAt = this.deps.now();
      this.deps.logger(`[${this.name}] exited (code=${code} signal=${signal})`);
      if (this.deps.shuttingDown) {
        this.state = 'stopped';
        return;
      }
      this.state = 'crashed';
      this.scheduleRestart();
    });
  }

  /** Attach a child output stream and prefix each line with the child name. */
  attachStream(stream, kind) {
    if (!stream) return;
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        this.lastOutputAt = this.deps.now();
        if (line.trim()) this.deps.logger(`[${this.name}] ${line}`);
      }
    });
    stream.on('end', () => {
      if (buffer.trim()) {
        this.lastOutputAt = this.deps.now();
        this.deps.logger(`[${this.name}] ${buffer}`);
      }
      void kind;
    });
  }

  /** Schedule a restart with exponential backoff. */
  scheduleRestart() {
    this.restarts += 1;
    const delay = backoffDelay(this.restarts);
    this.state = 'restarting';
    this.deps.logger(`[${this.name}] restarting in ${delay}ms (restart #${this.restarts})`);
    this.restartTimer = this.deps.setTimeout(() => {
      this.restartTimer = null;
      if (!this.deps.shuttingDown) this.start();
    }, delay);
  }

  /** Cancel a pending restart. */
  clearRestartTimer() {
    if (this.restartTimer) {
      this.deps.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  /** The status fragment for this child. */
  status() {
    return {
      name: this.name,
      role: this.role,
      state: this.state,
      pid: this.pid,
      port: this.spec.port ?? null,
      restarts: this.restarts,
      exitCode: this.exitCode,
      startedAt: this.startedAt,
      lastExitAt: this.lastExitAt,
      lastOutputAt: this.lastOutputAt,
      heartbeatAt: this.heartbeatAt,
      rssKb: readRssKb(this.pid),
    };
  }

  /** Ask the child to stop. */
  stop(signal = 'SIGTERM') {
    this.clearRestartTimer();
    if (this.proc && this.pid) {
      try {
        this.proc.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Create the supervisor.
 *
 * Every dependency is injectable so the unit test can drive the supervisor
 * without spawning real services.
 *
 * @param {object} [options]
 * @param {object} [options.env]       app-level environment
 * @param {object} [options.children]   child specs (defaults to CHILDREN)
 * @param {object} [options.router]     router spec (defaults to ROUTER)
 * @param {Function} [options.spawn]    child_process.spawn
 * @param {Function} [options.now]      clock
 * @param {Function} [options.logger]   log sink
 * @param {Function} [options.setTimeout]
 * @param {Function} [options.clearTimeout]
 * @returns {object} the supervisor
 */
export function createSupervisor(options = {}) {
  const env = options.env ?? process.env;
  const deps = {
    env,
    cwd: env.PLATFORM_APP_DIR ?? process.cwd(),
    spawn: options.spawn ?? spawn,
    now: options.now ?? (() => new Date().toISOString()),
    logger: options.logger ?? ((line) => process.stdout.write(`${line}\n`)),
    setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout,
    shuttingDown: false,
  };

  const childSpecs = options.children ?? CHILDREN;
  const routerSpec = options.router ?? ROUTER;

  const children = childSpecs.map((spec) => new Child(spec, deps));
  const router = new Child(
    { ...routerSpec, defaults: {}, envMap: {}, requiredSources: [] },
    deps,
  );

  const supervisor = {
    children,
    router,
    deps,
    statusServer: null,

    /** Validate that every child has the app-level secrets it needs. */
    validate() {
      const missing = [];
      for (const child of children) {
        for (const source of missingRequiredSources(child.spec, env)) {
          missing.push(`${child.name} requires ${source}`);
        }
      }
      return missing;
    },

    /** Start the router and every child. */
    start() {
      const missing = supervisor.validate();
      if (missing.length) {
        deps.logger(
          `[platform] refusing to start: missing app-level secrets:\n  - ${missing.join('\n  - ')}`,
        );
        return false;
      }
      router.start();
      for (const child of children) child.start();
      return true;
    },

    /** The status payload. */
    status() {
      const childStatus = children.map((child) => child.status());
      return {
        app: PLATFORM_APP,
        generatedAt: deps.now(),
        ready: childStatus.every((c) => c.state === 'running') && router.state === 'running',
        router: router.status(),
        children: childStatus,
      };
    },

    /** Serve the status payload on the loopback status port. */
    listen(port = Number(env.PLATFORM_STATUS_PORT ?? STATUS_PORT)) {
      supervisor.statusServer = createServer((req, res) => {
        if (req.url === STATUS_PATH || req.url === `${STATUS_PATH}/`) {
          const payload = JSON.stringify(supervisor.status(), null, 2);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(payload);
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found', path: STATUS_PATH }));
      });
      supervisor.statusServer.listen(port, '127.0.0.1', () => {
        deps.logger(`[platform] status endpoint on http://127.0.0.1:${port}${STATUS_PATH}`);
      });
      return supervisor.statusServer;
    },

    /** Stop every child and the router, then resolve once they are down. */
    async stop(signal = 'SIGTERM') {
      deps.shuttingDown = true;
      for (const child of children) child.stop(signal);
      router.stop(signal);
      if (supervisor.statusServer) {
        await new Promise((resolve) => supervisor.statusServer.close(resolve));
      }
    },
  };

  return supervisor;
}

/**
 * Entry point. Only runs when the file is executed directly, so the unit
 * test can import it without spawning anything.
 *
 * @returns {Promise<void>}
 */
async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  const supervisor = createSupervisor();
  supervisor.listen();

  const missing = supervisor.validate();
  if (missing.length) {
    process.stderr.write(
      `[platform] refusing to start: missing app-level secrets:\n  - ${missing.join('\n  - ')}\n` +
        '[platform] see infra/cloud/env/platform.env.example and the runbook ' +
        'docs/runbooks/platform-consolidation-rollback.md\n',
    );
    process.exit(1);
  }

  supervisor.start();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`[platform] received ${signal}; draining children\n`);
    await supervisor.stop(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // The supervisor must stay in the foreground: when the entrypoint exits,
  // Fly kills the Machine.
  await new Promise(() => {});
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[platform] fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}

export { Child, HELP, ROUTER_STATUS_PATH };
