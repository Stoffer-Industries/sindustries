// CJS preload for --require: hooks require() before ESM loaders run.
// This ensures Express/pg/etc. are patched before any application code loads them.
//
// dotenv/config is loaded first so that OTEL_* values from the service's
// .env file (pointed to by DOTENV_CONFIG_PATH) are available before SDK init.
'use strict';

require('dotenv/config');

if (process.env.OTEL_SDK_DISABLED === '1' || process.env.OTEL_SDK_DISABLED === 'true') {
  return;
}

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_NAMESPACE } = require('@opentelemetry/semantic-conventions');

const serviceName = process.env.OTEL_SERVICE_NAME || 'unknown-service';
const namespace = process.env.OTEL_SERVICE_NAMESPACE || 'sindustries';
const environment = process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || 'development';

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_NAMESPACE]: namespace,
    'deployment.environment': environment,
  }),
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 15_000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();
