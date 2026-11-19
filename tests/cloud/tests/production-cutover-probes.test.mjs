import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

import {
  checkContentScheduler,
  checkTasksApi,
  request,
} from '../production-cutover-probes.mjs';

const observed = {
  prodlike: [],
  production: [],
};

const servers = {};

async function startServer(name) {
  const server = createServer((incoming, response) => {
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      observed[name].push({
        method: incoming.method,
        url: incoming.url,
        authorization: incoming.headers.authorization ?? null,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': `${name}-request`,
      });
      response.end(JSON.stringify({ data: [] }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  servers[name] = server;
  return `http://127.0.0.1:${address.port}/api/v1`;
}

let manifest;
let originalTasksToken;
let originalSchedulerToken;

before(async () => {
  const prodlikeBaseUrl = await startServer('prodlike');
  const productionBaseUrl = await startServer('production');
  manifest = {
    surfaces: [
      {
        id: 'tasks-api',
        prodlikeBaseUrl,
        productionBaseUrl,
      },
      {
        id: 'content-scheduler-api',
        prodlikeBaseUrl,
        productionBaseUrl,
      },
    ],
  };
  originalTasksToken = process.env.CUTOVER_PROBE_TASKS_TOKEN;
  originalSchedulerToken = process.env.CUTOVER_PROBE_SCHEDULER_TOKEN;
  process.env.CUTOVER_PROBE_TASKS_TOKEN = 'tasks-probe-secret';
  process.env.CUTOVER_PROBE_SCHEDULER_TOKEN = 'scheduler-probe-secret';
});

after(async () => {
  if (originalTasksToken === undefined) delete process.env.CUTOVER_PROBE_TASKS_TOKEN;
  else process.env.CUTOVER_PROBE_TASKS_TOKEN = originalTasksToken;
  if (originalSchedulerToken === undefined) delete process.env.CUTOVER_PROBE_SCHEDULER_TOKEN;
  else process.env.CUTOVER_PROBE_SCHEDULER_TOKEN = originalSchedulerToken;
  await Promise.all(
    Object.values(servers).map(
      (server) => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

test('GET sends no body and puts the token only in the Authorization header', async () => {
  observed.prodlike.length = 0;
  const token = 'local-http-regression-token';
  const result = await request(`${manifest.surfaces[0].prodlikeBaseUrl}/health`, {
    token,
    timeoutMs: 2000,
  });

  assert.equal(result.ok, true);
  assert.equal(observed.prodlike.length, 1);
  assert.equal(observed.prodlike[0].method, 'GET');
  assert.equal(observed.prodlike[0].body, '');
  assert.equal(observed.prodlike[0].authorization, `Bearer ${token}`);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
});

test('authenticated workflow reads follow the requested binding', async () => {
  observed.prodlike.length = 0;
  observed.production.length = 0;

  const prodlikeTasks = await checkTasksApi(manifest, 'run-prodlike', false, 'prodlike');
  const prodlikeScheduler = await checkContentScheduler(
    manifest,
    'run-prodlike',
    false,
    'prodlike',
  );
  assert.equal(prodlikeTasks.ok, true);
  assert.equal(prodlikeScheduler.ok, true);
  assert.equal(observed.prodlike.length, 2);
  assert.equal(observed.production.length, 0);

  const productionTasks = await checkTasksApi(manifest, 'run-production', false, 'production');
  const productionScheduler = await checkContentScheduler(
    manifest,
    'run-production',
    false,
    'production',
  );
  assert.equal(productionTasks.ok, true);
  assert.equal(productionScheduler.ok, true);
  assert.equal(observed.production.length, 2);
});
