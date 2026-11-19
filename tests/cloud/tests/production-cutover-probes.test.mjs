import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

import {
  checkContentScheduler,
  checkHostedSignals,
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

/**
 * A server that answers every request with one fixed JSON payload, so a
 * probe can be driven against a response shape of its choosing.
 */
async function startSignalsServer(name, payload) {
  observed[name] = [];
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
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  servers[name] = server;
  return `http://127.0.0.1:${address.port}`;
}

const OBSERVABILITY_ENV = [
  'CUTOVER_OBSERVABILITY_BASE_URL',
  'CUTOVER_OBSERVABILITY_TOKEN',
  'GRAFANA_CLOUD_INSTANCE_URL',
  'GRAFANA_CLOUD_READER_AUTH',
];

const signalsManifest = {
  run: { abortThresholds: { activeAlertCount: 1 } },
};

let manifest;
let originalTasksToken;
let originalSchedulerToken;
const originalObservabilityEnv = {};

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
  // The hosted-observability variables are cleared for the whole file, so a
  // developer's own shell cannot decide whether the probe is configured.
  for (const name of OBSERVABILITY_ENV) {
    originalObservabilityEnv[name] = process.env[name];
    delete process.env[name];
  }
});

after(async () => {
  if (originalTasksToken === undefined) delete process.env.CUTOVER_PROBE_TASKS_TOKEN;
  else process.env.CUTOVER_PROBE_TASKS_TOKEN = originalTasksToken;
  if (originalSchedulerToken === undefined) delete process.env.CUTOVER_PROBE_SCHEDULER_TOKEN;
  else process.env.CUTOVER_PROBE_SCHEDULER_TOKEN = originalSchedulerToken;
  for (const name of OBSERVABILITY_ENV) {
    if (originalObservabilityEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalObservabilityEnv[name];
  }
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

test('the hosted signals probe reads the firing alerts from the hosted stack', async () => {
  const baseUrl = await startSignalsServer('signals-clean', []);
  process.env.GRAFANA_CLOUD_INSTANCE_URL = baseUrl;
  process.env.GRAFANA_CLOUD_READER_AUTH = 'reader-scoped-secret';

  const result = await checkHostedSignals(signalsManifest);

  assert.equal(result.ok, true);
  assert.equal(observed['signals-clean'].length, 1);
  assert.equal(
    observed['signals-clean'][0].url,
    '/api/alertmanager/grafana/api/v2/alerts',
    'the probe must read the endpoint that actually returns the firing alerts',
  );
  assert.match(result.detail, /0 active alert\(s\) against a threshold of 1/);
});

test('a firing alert at the threshold fails the hosted signals probe', async () => {
  const baseUrl = await startSignalsServer('signals-firing', [
    { labels: { alertname: 'sindustries-redis-down' } },
  ]);
  process.env.GRAFANA_CLOUD_INSTANCE_URL = baseUrl;
  process.env.GRAFANA_CLOUD_READER_AUTH = 'reader-scoped-secret';

  const result = await checkHostedSignals(signalsManifest);

  assert.equal(result.ok, false);
  assert.match(result.detail, /1 active alert\(s\) against a threshold of 1/);
});

test('a hosted signals payload that is not an alert list fails closed', async () => {
  const baseUrl = await startSignalsServer('signals-unknown', { unexpected: true });
  process.env.GRAFANA_CLOUD_INSTANCE_URL = baseUrl;
  process.env.GRAFANA_CLOUD_READER_AUTH = 'reader-scoped-secret';

  const result = await checkHostedSignals(signalsManifest);

  // An unreadable shape must NOT read as zero active alerts.
  assert.equal(result.ok, false);
  assert.match(result.detail, /not an alert list/);
});

test('the hosted signals probe fails closed when the endpoint is not configured', async () => {
  // The earlier tests point the probe at a local server; the "not
  // configured" case must start from a clean environment.
  delete process.env.GRAFANA_CLOUD_INSTANCE_URL;
  delete process.env.CUTOVER_OBSERVABILITY_BASE_URL;
  delete process.env.GRAFANA_CLOUD_READER_AUTH;
  delete process.env.CUTOVER_OBSERVABILITY_TOKEN;

  const result = await checkHostedSignals(signalsManifest);

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.match(result.detail, /GRAFANA_CLOUD_INSTANCE_URL/);
});

test('the hosted signals probe sends the read-scoped credential as a single Bearer header', async () => {
  const baseUrl = await startSignalsServer('signals-auth', []);
  process.env.GRAFANA_CLOUD_INSTANCE_URL = baseUrl;
  // The hosted stack stores this credential in the quoted `Bearer <token>`
  // form, so a probe that prefixes it again sends `Bearer Bearer <token>`.
  process.env.GRAFANA_CLOUD_READER_AUTH = 'Bearer reader-scoped-secret';

  const result = await checkHostedSignals(signalsManifest);

  assert.equal(result.ok, true);
  assert.equal(
    observed['signals-auth'][0].authorization,
    'Bearer reader-scoped-secret',
    'the Authorization header must carry exactly one Bearer prefix',
  );
  assert.doesNotMatch(JSON.stringify(result), /reader-scoped-secret/);
});
