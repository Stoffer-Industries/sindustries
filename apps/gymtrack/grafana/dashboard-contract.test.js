/**
 * @vitest-environment node
 *
 * Contract test between the telemetry relay and the Grafana dashboard.
 *
 * Task: e89db27f-6d78-418e-91c1-0759f8779d06 (AC4 — the operator query
 * and dashboard path must actually match what the relay emits).
 *
 * Live production evidence (Quinn, 2026-11-10) showed the hosted
 * Grafana Cloud tenant indexes `service_name` and returned
 * `service_name="unknown_service"` for events that carried no service
 * name. The dashboard shipped on the old contract
 * (`{app="gymtrack", source="browser"}`) therefore matched nothing:
 * `source` is the EVENT source (`auth`, `window.error`,
 * `unhandledrejection`) and is never the literal string `browser`.
 *
 * These assertions pin the two halves together — the relay emits
 * `service_name=gymtrack`, and every dashboard panel selects on it —
 * so the contract cannot drift apart again in silence.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { _testInternals } from '../api/telemetry.js';

const DASHBOARD_PATH = fileURLToPath(
  new URL('./dashboards/gymtrack-browser-errors.json', import.meta.url)
);

const dashboard = JSON.parse(readFileSync(DASHBOARD_PATH, 'utf8'));

// The service identity the relay actually emits. The dashboard asserts
// against this value instead of a hardcoded "gymtrack", so a coordinated
// rename breaks one test rather than needing two edits in two files.
const relayServiceName = _testInternals.buildLokiPayload({
  environment: 'production',
  release: 'relay-test',
  route: '/login',
  operation: 'signin',
  timestamp: '2026-11-11T00:00:00.000Z',
  source: 'auth'
}).streams[0].stream.service_name;

const lokiTargets = dashboard.panels.flatMap((panel) =>
  (panel.targets ?? []).map((target) => ({
    panel: panel.title,
    type: panel.type,
    expr: target.expr ?? ''
  }))
);

// A bare `| json` extracts EVERY top-level body field as a label, and
// the body carries a per-event `timestamp` — so each event becomes its
// own series and the series count explodes toward Loki's query limits.
// Selective extraction (`| json errorCode="errorCode"`) pulls out only
// the field the panel aggregates on.
const BARE_JSON = /\|\s*json\b(?!\s+[A-Za-z_][A-Za-z0-9_]*=")/;

describe('GymTrack browser errors dashboard — label contract', () => {
  it('has Loki targets to assert against', () => {
    expect(lokiTargets.length).toBeGreaterThan(0);
  });

  it('gives every panel at least one target', () => {
    for (const panel of dashboard.panels) {
      expect(
        (panel.targets ?? []).length,
        `panel "${panel.title}" must have at least one target`
      ).toBeGreaterThan(0);
    }
  });

  it('selects every panel on the indexed service_name label', () => {
    for (const { panel, expr } of lokiTargets) {
      expect(expr, `panel "${panel}" must select on service_name`).toContain(
        `{service_name="${relayServiceName}"}`
      );
    }
  });

  it('never selects on the literal source="browser" (source is the event source)', () => {
    for (const { panel, expr } of lokiTargets) {
      expect(expr, `panel "${panel}" must not select source="browser"`).not.toContain(
        'source="browser"'
      );
    }
  });

  it('reads the per-event fields from the JSON body with SELECTIVE | json', () => {
    // The hosted tenant indexes service_name only; errorCode /
    // operation / route / source are read out of the sanitized JSON body
    // the relay pushes. The raw-logs panel is exempt — it shows the
    // unparsed line on purpose.
    //
    // The extraction must be selective. A bare `| json` turns every
    // top-level body field into a label, and the per-event `timestamp`
    // makes each event its own series.
    for (const { panel, type, expr } of lokiTargets) {
      if (type === 'logs') continue;
      expect(expr, `panel "${panel}" must not use a bare | json`).not.toMatch(BARE_JSON);
    }
  });

  it('matches the service_name the relay emits', () => {
    const otlp = _testInternals.buildOtlpLogsPayload({
      environment: 'production',
      release: 'relay-test',
      route: '/login',
      operation: 'signin',
      provider: 'clerk',
      errorCode: 'form_password_incorrect',
      status: '422',
      timestamp: '2026-11-11T00:00:00.000Z',
      source: 'auth'
    });
    const resourceKeys = Object.fromEntries(
      otlp.resourceLogs[0].resource.attributes.map((a) => [a.key, a.value.stringValue])
    );
    // `service.name` is the OpenTelemetry semantic convention, and it is
    // what the hosted tenant promotes to the indexed `service_name`
    // label. The literal `service_name` resource attribute is NOT
    // emitted: it is not in the tenant's default promotion list, so it
    // lands in structured metadata where no stream selector can match
    // it — inert here, and a duplicate-label hazard if an operator ever
    // widened the promotion list.
    expect(resourceKeys['service.name']).toBe(relayServiceName);
    expect(Object.keys(resourceKeys)).not.toContain('service_name');

    const loki = _testInternals.buildLokiPayload({
      environment: 'production',
      release: 'relay-test',
      route: '/login',
      operation: 'signin',
      timestamp: '2026-11-11T00:00:00.000Z',
      source: 'auth'
    });
    // On the Loki push path `service_name` IS the literal stream-label
    // name the push API accepts.
    expect(loki.streams[0].stream.service_name).toBe(relayServiceName);
  });
});
