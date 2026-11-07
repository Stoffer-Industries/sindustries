#!/usr/bin/env node
/**
 * platform-supervisor.test.mjs — unit tests for the consolidated platform
 * supervisor (task 219fb673).
 *
 * The supervisor is the piece of the consolidation that owns real failure
 * modes: a child that crashes on boot, a secret that was never registered,
 * a deploy that sends SIGTERM and expects a clean drain. All three are
 * exercised here against a fake child process — no real service is started
 * and no port is bound.
 *
 * Run:
 *   node --test infra/cloud/platform/tests/
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import {
  CHILDREN,
  backoffDelay,
  buildChildEnv,
  missingRequiredSources,
} from '../platform-services.mjs';
import { Child, createSupervisor } from '../platform-supervisor.mjs';

/**
 * A fake child process: an EventEmitter with the surface the supervisor
 * uses (pid, stdout, stderr, kill).
 */
class FakeChild extends EventEmitter {
  constructor(command, options = {}) {
    super();
    this.command = command;
    this.pid = 4242;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killedWith = [];
    this.exited = false;
    // A real process exits after SIGTERM; the fake can be told not to, so
    // the drain timeout is testable.
    this.exitOnKill = options.exitOnKill ?? true;
    this.exitDelayMs = options.exitDelayMs ?? 0;
    this.kill = (signal) => {
      this.killedWith.push(signal);
      if (this.exitOnKill && !this.exited) {
        this.exited = true;
        setTimeout(() => this.emit('exit', 0, signal), this.exitDelayMs);
      }
      return true;
    };
  }
}

/**
 * Build a spawn stub that records every launch.
 */
function fakeSpawner(options = {}) {
  const launched = [];
  const spawn = (file, args, spawnOptions) => {
    const command = [file, ...args];
    const child = new FakeChild(command, options);
    launched.push({ file, args, command, options: spawnOptions, child });
    return child;
  };
  return { spawn, launched };
}

/**
 * A parent environment with every required source populated.
 */
function fullParentEnv() {
  const env = {
    PATH: '/usr/bin',
    NODE_ENV: 'production',
    // App-level secrets.
    PLATFORM_TASKS_API_DATABASE_URL: 'postgres://host/db?schema=tasks_api',
    PLATFORM_BUDGET_API_DATABASE_URL: 'postgres://host/db?schema=budget_api',
    PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL: 'postgres://host/db?schema=content_scheduler',
    PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS: 'https://tasks.staging.sindustries.co.nz',
    PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS: 'https://mission-control.staging.sindustries.co.nz',
    PLATFORM_CONTENT_SCHEDULER_API_CORS_ALLOWED_ORIGINS: 'https://mission-control.staging.sindustries.co.nz',
    PLATFORM_TASKS_API_REDIS_URL: 'redis://tasks:6379',
    PLATFORM_CONTENT_SCHEDULER_API_REDIS_URL: 'redis://scheduler:6379',
    PLATFORM_AUTO_POST_WORKER_REDIS_URL: 'redis://worker:6379',
  };
  return env;
}

describe('buildChildEnv', () => {
  it('maps the app-level PLATFORM_* secret onto the child’s own variable name', () => {
    const tasksApi = CHILDREN.find((c) => c.name === 'tasks-api');
    const env = buildChildEnv(tasksApi, fullParentEnv());

    assert.equal(env.DATABASE_URL, 'postgres://host/db?schema=tasks_api');
    assert.equal(env.PORT, '4001');
    assert.equal(env.OTEL_SERVICE_NAME, 'tasks-api');
    assert.equal(env.ALLOW_PORT_DB_MISMATCH, '1');
    assert.equal(
      env.CORS_ALLOWED_ORIGINS,
      'https://tasks.staging.sindustries.co.nz',
    );
  });

  it('gives each child its own database URL', () => {
    const byName = Object.fromEntries(
      CHILDREN.map((c) => [c.name, buildChildEnv(c, fullParentEnv())]),
    );

    assert.equal(byName['tasks-api'].DATABASE_URL, 'postgres://host/db?schema=tasks_api');
    assert.equal(byName['budget-api'].DATABASE_URL, 'postgres://host/db?schema=budget_api');
    assert.equal(
      byName['content-scheduler-api'].DATABASE_URL,
      'postgres://host/db?schema=content_scheduler',
    );
    // The worker shares the content_scheduler schema with the API.
    assert.equal(
      byName['auto-post-worker'].DATABASE_URL,
      'postgres://host/db?schema=content_scheduler',
    );
  });

  it('never leaks the PLATFORM_* indirection layer into a child', () => {
    for (const child of CHILDREN) {
      const env = buildChildEnv(child, fullParentEnv());
      const leaked = Object.keys(env).filter((key) => key.startsWith('PLATFORM_'));
      assert.deepEqual(leaked, [], `${child.name} leaked ${leaked.join(', ')}`);
    }
  });

  it('passes non-colliding app variables through unchanged', () => {
    const env = buildChildEnv(CHILDREN[0], { ...fullParentEnv(), TASKS_API_X_HANDLE: 'sindustries' });
    assert.equal(env.TASKS_API_X_HANDLE, 'sindustries');
  });

  it('leaves an optional source unset rather than setting an empty string', () => {
    const env = buildChildEnv(CHILDREN[0], fullParentEnv());
    // CONTENT_SCHEDULER_API_BASE_URL is optional for tasks-api.
    assert.equal('CONTENT_SCHEDULER_API_BASE_URL' in env, false);

    const withEmpty = buildChildEnv(CHILDREN[0], {
      ...fullParentEnv(),
      PLATFORM_CONTENT_SCHEDULER_API_BASE_URL: '',
    });
    assert.equal('CONTENT_SCHEDULER_API_BASE_URL' in withEmpty, false);
  });

  it('never inherits a bare app-level secret that a child mapping owns', () => {
    // The per-service apps each carry a plain REDIS_URL secret, so it is
    // easy to register one on the platform app. If it were inherited, a
    // missing PLATFORM_*_REDIS_URL would silently point the children at
    // the wrong instance.
    const env = {
      ...fullParentEnv(),
      REDIS_URL: 'redis://someone-elses-instance:6379',
      DATABASE_URL: 'postgres://someone-elses-instance/db',
    };
    const byName = Object.fromEntries(
      CHILDREN.map((c) => [c.name, buildChildEnv(c, env)]),
    );

    assert.equal(byName['tasks-api'].REDIS_URL, 'redis://tasks:6379');
    assert.equal(
      byName['auto-post-worker'].REDIS_URL,
      'redis://worker:6379',
    );
    // budget-api maps no Redis and no database secret of its own beyond
    // its mapping, so the bare app value must not leak into it.
    assert.equal('REDIS_URL' in byName['budget-api'], false);
  });
});

describe('missingRequiredSources', () => {
  it('reports nothing when every required source is present', () => {
    for (const child of CHILDREN) {
      assert.deepEqual(missingRequiredSources(child, fullParentEnv()), []);
    }
  });

  it('reports the missing source by name', () => {
    const env = fullParentEnv();
    delete env.PLATFORM_TASKS_API_DATABASE_URL;
    const missing = missingRequiredSources(CHILDREN[0], env);
    assert.deepEqual(missing, ['PLATFORM_TASKS_API_DATABASE_URL']);
  });

  it('reports a missing Redis source, so the platform fails at boot rather than at the first queue operation', () => {
    const env = fullParentEnv();
    delete env.PLATFORM_AUTO_POST_WORKER_REDIS_URL;
    const worker = CHILDREN.find((c) => c.name === 'auto-post-worker');
    assert.deepEqual(missingRequiredSources(worker, env), [
      'PLATFORM_AUTO_POST_WORKER_REDIS_URL',
    ]);
  });

  it('treats an empty value as missing', () => {
    const env = { ...fullParentEnv(), PLATFORM_BUDGET_API_DATABASE_URL: '' };
    assert.deepEqual(missingRequiredSources(CHILDREN[1], env), [
      'PLATFORM_BUDGET_API_DATABASE_URL',
    ]);
  });
});

describe('backoffDelay', () => {
  it('restarts immediately the first time', () => {
    assert.equal(backoffDelay(1), 0);
  });

  it('grows exponentially and is capped', () => {
    assert.equal(backoffDelay(2), 1000);
    assert.equal(backoffDelay(3), 2000);
    assert.equal(backoffDelay(4), 4000);
    assert.equal(backoffDelay(20), 30000);
  });
});

describe('createSupervisor', () => {
  it('starts a real child through Node spawn(file, args, options)', async () => {
    const deps = {
      env: process.env,
      cwd: process.cwd(),
      spawn,
      now: () => new Date().toISOString(),
      logger: () => {},
      setTimeout,
      clearTimeout,
      shuttingDown: true,
    };
    const child = new Child(
      {
        name: 'spawn-contract',
        command: [process.execPath, '-e', 'process.exit(0)'],
      },
      deps,
    );

    child.start();
    await child.exited();

    assert.equal(child.exitCode, 0);
    assert.equal(child.state, 'stopped');
  });

  it('refuses to start when a required secret is missing', () => {
    const env = fullParentEnv();
    delete env.PLATFORM_TASKS_API_DATABASE_URL;
    const { spawn, launched } = fakeSpawner();
    const supervisor = createSupervisor({ env, spawn, logger: () => {} });

    assert.equal(supervisor.start(), false);
    assert.equal(launched.length, 0, 'no child may start without its secrets');
  });

  it('starts the router and all four children', () => {
    const { spawn, launched } = fakeSpawner();
    const supervisor = createSupervisor({
      env: fullParentEnv(),
      spawn,
      logger: () => {},
    });

    assert.equal(supervisor.start(), true);
    assert.equal(launched.length, 5, 'four children plus the router');

    for (const { file, args } of launched) {
      assert.equal(typeof file, 'string');
      assert.ok(Array.isArray(args));
    }

    const names = launched.map((l) => l.command.join(' '));
    assert.ok(names.some((n) => n.includes('services/tasks-api')));
    assert.ok(names.some((n) => n.includes('services/budget-api')));
    assert.ok(names.some((n) => n.includes('services/content-scheduler-api')));
    assert.ok(names.some((n) => n.includes('content-scheduler:worker')));
    assert.ok(names.some((n) => n.startsWith('nginx')));
  });

  it('reports the status payload shape', () => {
    const { spawn } = fakeSpawner();
    const supervisor = createSupervisor({
      env: fullParentEnv(),
      spawn,
      logger: () => {},
    });
    supervisor.start();

    const status = supervisor.status();
    assert.equal(status.app, 'sindustries-platform-staging');
    assert.equal(status.children.length, 4);
    assert.equal(status.ready, true);
    assert.equal(status.router.name, 'nginx');
    assert.equal(status.router.role, 'router');

    for (const child of status.children) {
      assert.ok(typeof child.state === 'string');
      assert.ok('pid' in child);
      assert.ok('restarts' in child);
      assert.ok('exitCode' in child);
      assert.ok('rssKb' in child);
      assert.ok('heartbeatAt' in child);
    }
  });

  it('restarts a crashed child and counts the restart', () => {
    const { spawn, launched } = fakeSpawner();
    const timers = [];
    const supervisor = createSupervisor({
      env: fullParentEnv(),
      spawn,
      logger: () => {},
      setTimeout: (fn, delay) => {
        timers.push({ fn, delay });
        return timers.length;
      },
      clearTimeout: () => {},
    });
    supervisor.start();

    const tasksApiIndex = launched.findIndex((l) =>
      l.command.join(' ').includes('services/tasks-api'),
    );
    const crashed = launched[tasksApiIndex];
    crashed.child.emit('exit', 1, null);

    const status = supervisor.status();
    const tasksApi = status.children.find((c) => c.name === 'tasks-api');
    assert.equal(tasksApi.state, 'restarting');
    assert.equal(tasksApi.restarts, 1);
    assert.equal(tasksApi.exitCode, 1);

    // The restart is scheduled with a backoff and has not fired yet.
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 0, 'the first restart is immediate');

    timers[0].fn();
    assert.equal(launched.length, 6, 'the child was relaunched');
  });

  it('does not restart a child after shutdown', () => {
    const { spawn, launched } = fakeSpawner();
    const timers = [];
    const supervisor = createSupervisor({
      env: fullParentEnv(),
      spawn,
      logger: () => {},
      setTimeout: (fn, delay) => {
        timers.push({ fn, delay });
        return timers.length;
      },
      clearTimeout: () => {},
    });
    supervisor.start();

    supervisor.deps.shuttingDown = true;
    const tasksApiIndex = launched.findIndex((l) =>
      l.command.join(' ').includes('services/tasks-api'),
    );
    launched[tasksApiIndex].child.emit('exit', 0, 'SIGTERM');

    assert.equal(timers.length, 0, 'no restart may be scheduled during shutdown');
    const status = supervisor.status();
    assert.equal(status.children.find((c) => c.name === 'tasks-api').state, 'stopped');
  });

  it('forwards the shutdown signal to every child', async () => {
    const { spawn, launched } = fakeSpawner();
    const supervisor = createSupervisor({
      env: fullParentEnv(),
      spawn,
      logger: () => {},
    });
    supervisor.start();

    await supervisor.stop('SIGTERM');

    for (const { child } of launched) {
      assert.deepEqual(child.killedWith, ['SIGTERM']);
    }
  });

  it('waits for the children to exit before the supervisor exits', async () => {
    const { spawn, launched } = fakeSpawner({ exitDelayMs: 30 });
    const supervisor = createSupervisor({
      env: fullParentEnv(),
      spawn,
      logger: () => {},
    });
    supervisor.start();

    const startedAt = Date.now();
    await supervisor.stop('SIGTERM');
    const elapsed = Date.now() - startedAt;

    assert.ok(
      elapsed >= 25,
      `stop() returned after ${elapsed}ms — it signalled the children but did not wait for them`,
    );
    for (const { child } of launched) {
      assert.equal(child.exited, true, 'every child had exited when stop() resolved');
    }
  });

  it('gives up on a child that ignores SIGTERM instead of hanging the deploy', async () => {
    const { spawn } = fakeSpawner({ exitOnKill: false });
    const supervisor = createSupervisor({
      env: fullParentEnv(),
      spawn,
      logger: () => {},
      // The drain timeout fires immediately.
      setTimeout: (fn) => {
        fn();
        return 0;
      },
      clearTimeout: () => {},
    });
    supervisor.start();

    await supervisor.stop('SIGTERM');
    assert.equal(supervisor.deps.shuttingDown, true);
  });

  it('answers 503 while a child is not running, so the Fly check gates on the children', async () => {
    const { spawn, launched } = fakeSpawner();
    const supervisor = createSupervisor({
      env: fullParentEnv(),
      spawn,
      logger: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    supervisor.start();
    supervisor.listen(0);
    await new Promise((resolve) => supervisor.statusServer.once('listening', resolve));
    const { port } = supervisor.statusServer.address();

    const ready = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(ready.status, 200);

    // A child crashes: the platform is no longer ready.
    const tasksApi = launched.find((l) =>
      l.command.join(' ').includes('services/tasks-api'),
    );
    tasksApi.child.emit('exit', 1, null);

    const notReady = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(notReady.status, 503);
    const payload = await notReady.json();
    assert.equal(payload.ready, false);

    await supervisor.stop('SIGTERM');
  });

  it('records a child’s output timestamp as its heartbeat', () => {
    const { spawn, launched } = fakeSpawner();
    const supervisor = createSupervisor({
      env: fullParentEnv(),
      spawn,
      logger: () => {},
    });
    supervisor.start();

    const tasksApi = launched.find((l) => l.command.join(' ').includes('services/tasks-api'));
    tasksApi.child.stdout.write('listening on 4001\n');

    const status = supervisor.status();
    const child = status.children.find((c) => c.name === 'tasks-api');
    assert.ok(child.lastOutputAt, 'the child reports when it last spoke');
    assert.ok(child.heartbeatAt, 'the child reports its heartbeat');
    assert.equal(child.heartbeatAt, child.lastOutputAt);
  });
});
