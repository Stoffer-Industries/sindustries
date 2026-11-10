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

const lokiTargets = dashboard.panels.flatMap((panel) =>
  (panel.targets ?? []).map((target) => ({
    panel: panel.title,
    type: panel.type,
    expr: target.expr ?? ''
  }))
);

describe('GymTrack browser errors dashboard — label contract', () => {
  it('has Loki targets to assert against', () => {
    expect(lokiTargets.length).toBeGreaterThan(0);
  });

  it('selects every panel on the indexed service_name label', () => {
    for (const { panel, expr } of lokiTargets) {
      expect(expr, `panel "${panel}" must select on service_name`).toContain(
        '{service_name="gymtrack"}'
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

  it('reads the per-event fields from the JSON body with | json', () => {
    // The hosted tenant indexes service_name only; errorCode /
    // operation / route / source are read out of the sanitized JSON body
    // the relay pushes. The raw-logs panel is exempt — it shows the
    // unparsed line on purpose.
    for (const { panel, type, expr } of lokiTargets) {
      if (type === 'logs') continue;
      expect(expr, `panel "${panel}" must parse the JSON body`).toContain('| json');
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
    expect(resourceKeys['service.name']).toBe('gymtrack');
    expect(resourceKeys.service_name).toBe('gymtrack');

    const loki = _testInternals.buildLokiPayload({
      environment: 'production',
      release: 'relay-test',
      route: '/login',
      operation: 'signin',
      timestamp: '2026-11-11T00:00:00.000Z',
      source: 'auth'
    });
    expect(loki.streams[0].stream.service_name).toBe('gymtrack');
  });
});
